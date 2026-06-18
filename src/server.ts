import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { DbService } from './services/db.service';
import { Importer } from './importer';
import { TelegramService } from './services/telegram.service';
import { S3Service } from './services/s3.service';
import { logger } from './logger';

export function createServer(
  dbService: DbService,
  importer: Importer,
  telegramService: TelegramService,
  s3Service: S3Service
) {
  const app = express();

  app.use(express.json());

  // Serve static UI assets
  app.use(express.static(path.join(process.cwd(), 'public')));

  /**
   * GET /api/progress
   * Returns progress of all channels and global database statistics.
   */
  app.get('/api/progress', async (req: Request, res: Response, next: NextFunction) => {
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
  app.post('/api/channels', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { username } = req.body;
      if (!username || typeof username !== 'string') {
        res.status(400).json({ success: false, error: 'Channel username is required.' });
        return;
      }

      const cleanUsername = username.trim().replace(/^https:\/\/t\.me\//, '').replace('@', '');
      if (cleanUsername.length === 0) {
        res.status(400).json({ success: false, error: 'Invalid channel username.' });
        return;
      }

      logger.info(`REST API: Request to add channel "${cleanUsername}"`);

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
  app.get('/api/channels/:channelId/messages', async (req: Request, res: Response, next: NextFunction) => {
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
   * GET /api/media
   * Streams a media object from S3. Supports inline display or download.
   */
  app.get('/api/media', async (req: Request, res: Response, next: NextFunction) => {
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
