import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import crypto from 'crypto';
import { matchedData, param, query, validationResult } from 'express-validator';
import { DbService } from './services/db.service';
import type { ChannelProgress, ChannelStatus } from './services/db.service';
import { Importer } from './importer';
import { TelegramService } from './services/telegram.service';
import { S3Service } from './services/s3.service';
import { logger } from './logger';
import {
  MAPPINGS_BODY_LIMIT,
  MAX_MAPPING_PROBLEMS,
  describeMappingProblem,
  parseMappingsBody,
  parseTelegramId
} from './mappings';

const MAPPINGS_PATH = '/api/channels/:channelId/mappings';

export function createServer(
  dbService: DbService,
  importer: Importer,
  telegramService: TelegramService,
  s3Service: S3Service,
  dashboardPassword: string
) {
  const channelStatuses: ChannelStatus[] = ['pending', 'running', 'completed', 'failed'];
  const expectedToken = crypto.createHash('sha256').update(dashboardPassword).digest('hex');

  const isAuthed = (req: Request): boolean => {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return false;
    const cookies = cookieHeader.split(';').map(c => c.trim());
    for (const cookie of cookies) {
      const [k, v] = cookie.split('=');
      if (k === 'dashboard_token' && v === expectedToken) {
        return true;
      }
    }
    return false;
  };

  const app = express();

  // API auth middleware
  const apiAuthMiddleware = (req: Request, res: Response, next: NextFunction) => {
    if (!isAuthed(req)) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    next();
  };

  // Mapping sets exceed the default 100 KB JSON limit. Authenticate first, then parse with a
  // larger limit; the global parser skips a body that is already parsed. Body errors get their
  // own statuses here, so the mapper UI can tell them apart from server errors.
  const mappingsJsonParser = express.json({ limit: MAPPINGS_BODY_LIMIT });
  app.put(MAPPINGS_PATH, apiAuthMiddleware, (req: Request, res: Response, next: NextFunction) => {
    mappingsJsonParser(req, res, (err?: any) => {
      if (err?.type === 'entity.too.large') {
        res.status(413).json({ success: false, error: 'Request body exceeds the 5 MB limit.' });
        return;
      }
      if (err?.type === 'entity.parse.failed') {
        res.status(400).json({ success: false, error: 'Request body is not valid JSON.' });
        return;
      }
      next(err);
    });
  });

  app.use(express.json());

  // Static route authentication middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/' || req.path === '/index.html') {
      if (!isAuthed(req)) {
        return res.redirect('/login.html');
      }
    } else if (req.path === '/login.html') {
      if (isAuthed(req)) {
        return res.redirect('/');
      }
    }
    next();
  });

  // Serve static UI assets
  app.use(express.static(path.join(process.cwd(), 'public')));

  // Login endpoint
  app.post('/api/auth/login', (req: Request, res: Response) => {
    const { password } = req.body;
    if (!password || typeof password !== 'string') {
      res.status(400).json({ success: false, error: 'Password is required.' });
      return;
    }

    if (password === dashboardPassword) {
      // Set HttpOnly cookie for 30 days
      res.setHeader('Set-Cookie', `dashboard_token=${expectedToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`);
      res.json({ success: true });
    } else {
      res.status(401).json({ success: false, error: 'Incorrect password.' });
    }
  });

  const handleValidationErrors = (req: Request, res: Response, next: NextFunction) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({
        success: false,
        error: errors.array()[0].msg
      });
      return;
    }
    next();
  };

  /**
   * GET /api/progress
   * Returns progress of all channels and global database statistics.
   */
  app.get('/api/progress', apiAuthMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const channels = await dbService.getAllChannels();
      const stats = await dbService.getGlobalStats();

      res.json({
        success: true,
        stats,
        channels
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/channels
   * Returns tracked channels with optional status filtering and pagination.
   */
  app.get(
    '/api/channels',
    apiAuthMiddleware,
    [
      query('status')
        .optional({ values: 'falsy' })
        .isIn(channelStatuses)
        .withMessage(`Invalid status. Expected one of: ${channelStatuses.join(', ')}.`),
      query('page')
        .optional({ values: 'falsy' })
        .isInt({ min: 1 })
        .withMessage('Pagination query parameters page and limit must be positive integers.')
        .toInt(),
      query('limit')
        .optional({ values: 'falsy' })
        .isInt({ min: 1 })
        .withMessage('Pagination query parameters page and limit must be positive integers.')
        .toInt(),
      handleValidationErrors
    ],
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const queryParams = matchedData<{
          status?: ChannelStatus;
          page?: number;
          limit?: number;
        }>(req, { locations: ['query'] });
        const status = queryParams.status;
        const page = queryParams.page ?? 1;
        const rawLimit = queryParams.limit ?? 50;
        const limit = Math.min(rawLimit, 100);
        const offset = (page - 1) * limit;
        const result = await dbService.listChannels({
          status,
          limit,
          offset
        });
        const totalPages = Math.ceil(result.total / limit);

        res.json({
          success: true,
          channels: result.channels,
          pagination: {
            page,
            limit,
            total: result.total,
            total_pages: totalPages
          }
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * POST /api/channels
   * Resolves public Telegram channel(s) by username(s), registers them, and schedules them for import.
   * Supports comma, newline, or space-separated lists of usernames.
   */
  app.post('/api/channels', apiAuthMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { username } = req.body;
      if (!username || typeof username !== 'string') {
        res.status(400).json({ success: false, error: 'Channel username is required.' });
        return;
      }

      // Parse comma, space, or newline-separated usernames
      const rawUsernames = username.split(/[\s,]+/).map(u => u.trim()).filter(Boolean);
      if (rawUsernames.length === 0) {
        res.status(400).json({ success: false, error: 'Channel username is required.' });
        return;
      }

      const isMulti = rawUsernames.length > 1;
      const results: Array<{
        username: string;
        success: boolean;
        channel?: {
          channel_id: string;
          channel_username: string;
          title: string;
          status: string;
        };
        error?: string;
        statusCode?: number;
      }> = [];

      for (let i = 0; i < rawUsernames.length; i++) {
        const u = rawUsernames[i];

        // Introduce a small 1s delay between sequential resolutions to avoid Telegram rate limits
        if (i > 0 && process.env.NODE_ENV !== 'test') {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        const cleanUsername = u
          .replace(/^(https?:\/\/)?(www\.)?t\.me\//, '')
          .replace(/^@/, '')
          .trim();

        const usernameRegex = /^[a-zA-Z0-9_]{5,32}$/;
        if (!usernameRegex.test(cleanUsername)) {
          results.push({
            username: u,
            success: false,
            error: `Invalid Telegram username "${u}". It must be between 5 and 32 characters and contain only letters, numbers, and underscores.`,
            statusCode: 400
          });
          continue;
        }

        logger.info(`REST API: Request to add channel "${cleanUsername}"`);

        // Check if the channel username is already being tracked
        try {
          const existingChannel = await dbService.getChannelByUsername(cleanUsername);
          if (existingChannel) {
            results.push({
              username: cleanUsername,
              success: false,
              error: `Channel @${existingChannel.channel_username || cleanUsername} is already being tracked.`,
              statusCode: 409
            });
            continue;
          }
        } catch (dbErr: any) {
          results.push({
            username: cleanUsername,
            success: false,
            error: `Database error checking username: ${dbErr.message}`,
            statusCode: 500
          });
          continue;
        }

        // Try resolving entity on Telegram to ensure correctness
        let channelEntity;
        try {
          channelEntity = await telegramService.getChannelEntity(cleanUsername);
        } catch (err: any) {
          logger.error(`REST API: Failed to resolve channel "${cleanUsername}": ${err.message}`);
          results.push({
            username: cleanUsername,
            success: false,
            error: `Could not resolve Telegram channel "${cleanUsername}". Check if username exists and is public.`,
            statusCode: 400
          });
          continue;
        }

        const channelId = channelEntity.id.toString();
        const title = channelEntity.title || '';
        const finalUsername = channelEntity.username || cleanUsername;

        try {
          // Check if the resolved channel ID is already being tracked
          const existingById = await dbService.getChannelProgress(channelId);
          if (existingById) {
            await dbService.upsertChannel(channelId, finalUsername, title, existingById.status);
            results.push({
              username: finalUsername,
              success: false,
              error: `Channel "${title}" (@${finalUsername}) is already being tracked.`,
              statusCode: 409
            });
            continue;
          }

          // Register the channel in postgres as pending
          await dbService.upsertChannel(channelId, finalUsername, title, 'pending');
        } catch (dbErr: any) {
          results.push({
            username: finalUsername,
            success: false,
            error: `Database error registering channel: ${dbErr.message}`,
            statusCode: 500
          });
          continue;
        }

        logger.info(`REST API: Channel @${finalUsername} (${title}) registered successfully.`);

        results.push({
          username: finalUsername,
          success: true,
          channel: {
            channel_id: channelId,
            channel_username: finalUsername,
            title,
            status: 'pending'
          }
        });
      }

      // Backward compatible single channel response format
      if (!isMulti) {
        const singleResult = results[0];
        if (singleResult.success) {
          res.json({
            success: true,
            channel: singleResult.channel
          });
        } else {
          res.status(singleResult.statusCode || 400).json({
            success: false,
            error: singleResult.error
          });
        }
        return;
      }

      // Multi-channel response format
      res.json({
        success: true,
        results: results.map(r => ({
          username: r.username,
          success: r.success,
          channel: r.channel,
          error: r.error
        }))
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/channels/:channelId/messages
   * Returns all stored messages for a specific channel.
   */
  app.get('/api/channels/:channelId/messages', apiAuthMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { channelId } = req.params;
      const messages = await dbService.getChannelMessages(channelId);
      res.json({
        success: true,
        messages
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * DELETE /api/channels/:channelId
   * Deletes a channel, all its stored messages and all its mappings.
   */
  app.delete('/api/channels/:channelId', apiAuthMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { channelId } = req.params;
      if (!channelId) {
        res.status(400).json({ success: false, error: 'Channel ID is required.' });
        return;
      }

      // Check if channel is currently importing
      if (importer.isChannelRunning(channelId)) {
        res.status(400).json({
          success: false,
          error: 'Cannot delete a channel while its import is in progress.'
        });
        return;
      }

      // Check if channel exists in DB
      const progress = await dbService.getChannelProgress(channelId);
      if (!progress) {
        res.status(404).json({ success: false, error: 'Channel not found.' });
        return;
      }

      await dbService.deleteChannel(channelId);
      logger.info(`REST API: Channel @${progress.channel_username || channelId} (${progress.title}) deleted.`);

      res.json({
        success: true,
        message: 'Channel deleted successfully.'
      });
    } catch (err) {
      next(err);
    }
  });

  const channelIdParam = param('channelId')
    .custom((value) => parseTelegramId(value) !== null)
    .withMessage('Invalid channel ID.');

  /**
   * Resolves :channelId to a tracked channel. Sends 400 or 404 and returns null when it is invalid or not tracked.
   */
  const findTrackedChannel = async (
    req: Request,
    res: Response
  ): Promise<{ channelId: string; channel: ChannelProgress } | null> => {
    // channelIdParam already rejects bad IDs; this check keeps the type narrow without a cast.
    const channelId = parseTelegramId(req.params.channelId);
    if (!channelId) {
      res.status(400).json({ success: false, error: 'Invalid channel ID.' });
      return null;
    }
    const channel = await dbService.getChannelProgress(channelId);
    if (!channel) {
      res.status(404).json({ success: false, error: 'Channel not found.' });
      return null;
    }
    return { channelId, channel };
  };

  /**
   * PUT /api/channels/:channelId/mappings
   * Replaces the full set of text↔audio mappings for a channel. All-or-nothing: any invalid item rejects the request.
   */
  app.put(
    MAPPINGS_PATH,
    apiAuthMiddleware,
    [channelIdParam, handleValidationErrors],
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tracked = await findTrackedChannel(req, res);
        if (!tracked) return;
        const { channelId, channel } = tracked;

        // Hand-validated, not express-validator: the checks are all-or-nothing over up to
        // 50,000 items, report per-item details, and end in one set-based DB lookup.
        const { mappings, problems } = parseMappingsBody(req.body);

        if (problems.length === 0 && mappings.length > 0) {
          const messageIds = new Set<string>();
          mappings.forEach((mapping) => {
            messageIds.add(mapping.text_message_id);
            messageIds.add(mapping.media_message_id);
          });
          const messageInfo = await dbService.getMappableMessageInfo(channelId, [...messageIds]);
          const messagesById = new Map(messageInfo.map((row) => [row.message_id, row]));

          mappings.forEach((mapping, index) => {
            const media = messagesById.get(mapping.media_message_id);
            if (!media) {
              problems.push({ index, field: 'media_message_id', reason: 'is not a stored message of this channel.' });
            } else if (!media.is_audio) {
              problems.push({ index, field: 'media_message_id', reason: 'is not an audio or voice message.' });
            }
            const text = messagesById.get(mapping.text_message_id);
            if (!text) {
              problems.push({ index, field: 'text_message_id', reason: 'is not a stored message of this channel.' });
            } else if (!text.has_text) {
              problems.push({ index, field: 'text_message_id', reason: 'has no text.' });
            }
          });
        }

        if (problems.length > 0) {
          res.status(400).json({
            success: false,
            error: describeMappingProblem(problems[0]),
            details: problems.slice(0, MAX_MAPPING_PROBLEMS)
          });
          return;
        }

        // The channel can be deleted after the check above. The write checks it again under a lock.
        const result = await dbService.replaceChannelMappings(channelId, mappings);
        if (!result) {
          res.status(404).json({ success: false, error: 'Channel not found.' });
          return;
        }
        logger.info(`REST API: Stored ${result.count} mappings for channel @${channel.channel_username || channelId}.`);

        res.json({
          success: true,
          channel_id: channelId,
          count: result.count,
          updated_at: result.updated_at
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /api/channels/:channelId/mappings
   * Returns the stored text↔audio mappings for a channel, ordered by audio message ID.
   */
  app.get(
    MAPPINGS_PATH,
    apiAuthMiddleware,
    [channelIdParam, handleValidationErrors],
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tracked = await findTrackedChannel(req, res);
        if (!tracked) return;
        const { channelId } = tracked;

        const mappings = await dbService.getChannelMappings(channelId);
        const latestMs = mappings.reduce((max, mapping) => Math.max(max, mapping.updated_at.getTime()), -Infinity);

        res.json({
          success: true,
          channel_id: channelId,
          updated_at: mappings.length > 0 ? new Date(latestMs) : null,
          mappings
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /api/media
   * Streams a media object from S3. Supports inline display or download.
   */
  app.get('/api/media', apiAuthMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = req.query.key as string;
      if (!key) {
        res.status(400).json({ success: false, error: 'Key query parameter is required.' });
        return;
      }

      const { stream, contentType, contentLength } = await s3Service.getObjectStream(key);
      if (contentType) {
        res.setHeader('Content-Type', contentType);
      }
      if (contentLength) {
        res.setHeader('Content-Length', contentLength);
      }
      if (req.query.download === 'true') {
        const filename = path.basename(key);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      } else {
        res.setHeader('Content-Disposition', 'inline');
      }
      stream.pipe(res);
    } catch (err: any) {
      logger.error(`Failed to fetch media from S3 key "${req.query.key}":`, err);
      res.status(404).json({ success: false, error: 'Media not found.' });
    }
  });

  // Global error handler
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    logger.error('API Server Error:', err);
    res.status(500).json({
      success: false,
      error: 'An internal server error occurred.'
    });
  });

  return app;
}
