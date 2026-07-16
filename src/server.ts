import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import crypto from 'crypto';
import { DbService } from './services/db.service';
import { Importer } from './importer';
import { TelegramService } from './services/telegram.service';
import { S3Service } from './services/s3.service';
import { logger } from './logger';

export function createServer(
  dbService: DbService,
  importer: Importer,
  telegramService: TelegramService,
  s3Service: S3Service,
  dashboardPassword: string
) {
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

  // API auth middleware
  const apiAuthMiddleware = (req: Request, res: Response, next: NextFunction) => {
    if (!isAuthed(req)) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
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
   * POST /api/channels
   * Resolves a public Telegram channel by username, registers it, and schedules it for import.
   */
  app.post('/api/channels', apiAuthMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { username } = req.body;
      if (!username || typeof username !== 'string') {
        res.status(400).json({ success: false, error: 'Channel username is required.' });
        return;
      }

      const cleanUsername = username.trim()
        .replace(/^(https?:\/\/)?(www\.)?t\.me\//, '')
        .replace(/^@/, '')
        .trim();

      const usernameRegex = /^[a-zA-Z0-9_]{5,32}$/;
      if (!usernameRegex.test(cleanUsername)) {
        res.status(400).json({
          success: false,
          error: 'Invalid Telegram username. It must be between 5 and 32 characters and contain only letters, numbers, and underscores.'
        });
        return;
      }

      logger.info(`REST API: Request to add channel "${cleanUsername}"`);

      // Check if the channel username is already being tracked
      const existingChannel = await dbService.getChannelByUsername(cleanUsername);
      if (existingChannel) {
        res.status(409).json({
          success: false,
          error: `Channel @${existingChannel.channel_username || cleanUsername} is already being tracked.`
        });
        return;
      }

      // Try resolving entity on Telegram to ensure correctness
      let channelEntity;
      try {
        channelEntity = await telegramService.getChannelEntity(cleanUsername);
      } catch (err: any) {
        logger.error(`REST API: Failed to resolve channel "${cleanUsername}": ${err.message}`);
        res.status(400).json({
          success: false,
          error: `Could not resolve Telegram channel "${cleanUsername}". Check if username exists and is public.`
        });
        return;
      }

      const channelId = channelEntity.id.toString();
      const title = channelEntity.title || '';
      const finalUsername = channelEntity.username || cleanUsername;

      // Check if the resolved channel ID is already being tracked
      const existingById = await dbService.getChannelProgress(channelId);
      if (existingById) {
        await dbService.upsertChannel(channelId, finalUsername, title, existingById.status);
        res.status(409).json({
          success: false,
          error: `Channel "${title}" (@${finalUsername}) is already being tracked.`
        });
        return;
      }

      // Register the channel in postgres as pending
      await dbService.upsertChannel(channelId, finalUsername, title, 'pending');

      logger.info(`REST API: Channel @${finalUsername} (${title}) registered successfully.`);

      res.json({
        success: true,
        channel: {
          channel_id: channelId,
          channel_username: finalUsername,
          title,
          status: 'pending'
        }
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
   * Deletes a channel and all its stored messages.
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
