import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DbService, ChannelProgress } from './services/db.service';
import { S3Service } from './services/s3.service';
import { TelegramService, TelegramMediaInfo } from './services/telegram.service';
import { logger } from './logger';

export interface ImporterOptions {
  limitPerBatch?: number;
  bufferHours?: number;
}

export class Importer {
  private dbService: DbService;
  private s3Service: S3Service;
  private telegramService: TelegramService;
  private concurrency: number;
  private runningChannels = new Set<string>();
  private activeJobs = 0;
  private isShuttingDown = false;
  private checkTimeout: NodeJS.Timeout | null = null;
  private readonly limitPerBatch: number;
  private readonly bufferHours: number;

  constructor(
    dbService: DbService,
    s3Service: S3Service,
    telegramService: TelegramService,
    concurrency: number,
    options: ImporterOptions = {}
  ) {
    this.dbService = dbService;
    this.s3Service = s3Service;
    this.telegramService = telegramService;
    this.concurrency = concurrency;
    this.limitPerBatch = options.limitPerBatch ?? 100;
    this.bufferHours = options.bufferHours ?? 24;
  }

  /**
   * Starts the background scheduler loop.
   */
  async start(): Promise<void> {
    logger.info('Starting Telegram historical importer worker loop...');
    this.isShuttingDown = false;
    this.tick();
  }

  /**
   * Gracefully stops the scheduler and channel operations.
   */
  async stop(): Promise<void> {
    logger.info('Shutting down importer...');
    this.isShuttingDown = true;
    if (this.checkTimeout) {
      clearTimeout(this.checkTimeout);
    }
  }

  /**
   * Checks if a channel is currently being processed by the importer.
   */
  isChannelRunning(channelId: string): boolean {
    return this.runningChannels.has(channelId);
  }

  /**
   * Single tick of the background scheduler.
   * Dispatches pending channel imports.
   */
  private async tick(): Promise<void> {
    if (this.isShuttingDown) return;

    try {
      if (this.activeJobs < this.concurrency) {
        const channels = await this.dbService.getAllChannels();
        const pendingChannels = channels.filter((c) => c.status === 'pending');

        for (const channel of pendingChannels) {
          if (this.activeJobs >= this.concurrency) break;

          const channelId = channel.channel_id;
          if (!this.runningChannels.has(channelId)) {
            this.runningChannels.add(channelId);
            this.activeJobs++;

            logger.info(`Dispatcher: starting import for channel @${channel.channel_username || channelId}`);
            
            this.importChannel(channel)
              .catch((err) => {
                logger.error(`Error processing channel ${channel.channel_username || channelId}`, err);
              })
              .finally(() => {
                this.runningChannels.delete(channelId);
                this.activeJobs--;
                // Immediately check for more pending channels
                setImmediate(() => this.tick());
              });
          }
        }
      }
    } catch (error) {
      logger.error('Error during importer scheduler check', error);
    }

    // Schedule next run in 5 seconds
    this.checkTimeout = setTimeout(() => this.tick(), 5000);
  }

  /**
   * Processes a single channel from oldest to newest, grouped into time-window chunks.
   */
  async importChannel(channel: ChannelProgress): Promise<void> {
    const channelIdStr = channel.channel_id;
    logger.info(`[Channel ${channelIdStr}] Beginning import process...`);

    try {
      await this.dbService.updateChannelStatus(channelIdStr, 'running');

      // Resolve Telegram Channel Entity
      const channelEntity = await this.telegramService.getChannelEntity(
        channel.channel_username || channelIdStr
      );

      const resolvedTitle = channelEntity.title || '';
      const resolvedUsername = channelEntity.username || null;
      const resolvedId = channelEntity.id.toString();

      // Upsert the channel details to save the resolved ID and title
      await this.dbService.upsertChannel(
        resolvedId,
        resolvedUsername,
        resolvedTitle,
        'running'
      );

      // Fetch the latest state to see if progress exists
      const progress = await this.dbService.getChannelProgress(resolvedId);
      const lastProcessedId = progress?.last_processed_message_id
        ? parseInt(progress.last_processed_message_id, 10)
        : 0;

      logger.info(`[Channel ${resolvedTitle}] Resuming import from message ID ${lastProcessedId}`);

      const tempDir = path.join(process.cwd(), 'temp');
      let currentMinId = lastProcessedId;
      let batchCount = 0;
      const bufferMs = this.bufferHours * 60 * 60 * 1000;

      while (!this.isShuttingDown) {
        logger.debug(`[Channel ${resolvedTitle}] Fetching message batch with minId ${currentMinId}`);

        const messages = await this.telegramService.executeWithRetry(
          async (client) => {
            return await client.getMessages(channelEntity, {
              minId: currentMinId,
              limit: this.limitPerBatch,
              reverse: true,
            });
          },
          `fetch messages batch for channel ${resolvedTitle}`
        ) as any[];

        if (!messages || messages.length === 0) {
          logger.info(`[Channel ${resolvedTitle}] Import complete. No new messages found.`);
          await this.dbService.updateChannelStatus(resolvedId, 'completed');
          return;
        }

        const gapIndices: number[] = [];
        for (let i = 0; i < messages.length - 1; i++) {
          const currentDate = messages[i].date;
          const nextDate = messages[i + 1].date;
          if (!currentDate || !nextDate) continue;

          const diff = Math.abs(currentDate * 1000 - nextDate * 1000);
          if (diff > bufferMs) {
            gapIndices.push(i);
          }
        }

        let cutIndex = messages.length - 1;
        const foundGap = gapIndices.length > 0;
        if (foundGap) {
          cutIndex = gapIndices[gapIndices.length - 1];
        }

        const controlledChunk = messages.slice(0, cutIndex + 1);
        const oldestMessage = controlledChunk[0];
        const newestMessage = controlledChunk[controlledChunk.length - 1];
        const chunkId = crypto.randomUUID();
        const chunkStartTime = oldestMessage.date ? new Date(oldestMessage.date * 1000) : new Date();
        const chunkEndTime = newestMessage.date ? new Date(newestMessage.date * 1000) : chunkStartTime;

        await this.dbService.createProcessingChunk(
          chunkId,
          resolvedId,
          chunkStartTime,
          chunkEndTime,
          controlledChunk.length,
          'running'
        );

        let processedInChunk = 0;

        for (const msg of controlledChunk) {
          if (this.isShuttingDown) break;

          try {
            const messageId = msg.id;

            // Check if message is already recorded and has a media key
            const existingMediaKey = await this.dbService.getExistingMessageMediaKey(
              resolvedId,
              messageId
            );

            let mediaKey: string | null = null;
            let mediaInfo: TelegramMediaInfo | undefined;

            if (this.telegramService.hasDownloadableMedia(msg)) {
              mediaInfo = this.telegramService.extractMediaMetadata(msg);

              if (existingMediaKey !== undefined) {
                // Message exists in DB
                if (existingMediaKey) {
                  mediaKey = existingMediaKey;
                  logger.debug(`[Channel ${resolvedTitle}] Skipping S3 upload for message ${messageId} (media exists)`);
                } else {
                  // Exists but no media key recorded (possibly failed previously)
                  mediaKey = await this.downloadAndUploadMedia(
                    resolvedId,
                    messageId,
                    msg,
                    mediaInfo,
                    tempDir
                  );
                }
              } else {
                // New message with media
                mediaKey = await this.downloadAndUploadMedia(
                  resolvedId,
                  messageId,
                  msg,
                  mediaInfo,
                  tempDir
                );
              }
            }

            // Extract clean JSON payload
            const telegramJson = this.extractCleanJson(msg, mediaInfo);
            const messageDate = msg.date ? new Date(msg.date * 1000) : new Date();

            // Store message details
            await this.dbService.upsertMessage(
              resolvedId,
              messageId,
              messageDate,
              telegramJson,
              mediaKey,
              chunkId
            );
            processedInChunk++;

          } catch (msgErr) {
            logger.error(`[Channel ${resolvedTitle}] Error processing message ID ${msg.id}:`, msgErr);
            // Log and continue processing the rest of the batch
          }
        }

        await this.dbService.updateProcessingChunkStatus(
          chunkId,
          processedInChunk === controlledChunk.length ? 'completed' : 'failed',
          processedInChunk
        );

        currentMinId = newestMessage.id;
        await this.dbService.updateChannelProgress(resolvedId, currentMinId);
        batchCount++;

        logger.info(
          `[Channel ${resolvedTitle}] Processed chunk ${batchCount}. Up to message ID: ${currentMinId}`
        );

        if (!foundGap && messages.length === this.limitPerBatch) {
          logger.warn(
            `[Channel ${resolvedTitle}] No gap found in batch of ${this.limitPerBatch}. Forcing split to maintain progress.`
          );
        }
      }
    } catch (error: any) {
      logger.error(`[Channel ${channelIdStr}] Import failed:`, error);
      await this.dbService.updateChannelStatus(channelIdStr, 'failed');
    }
  }

  /**
   * Helper that handles local download of Telegram media and streaming it to S3.
   */
  private async downloadAndUploadMedia(
    channelId: string,
    messageId: number,
    msg: any,
    mediaInfo: TelegramMediaInfo,
    tempDir: string
  ): Promise<string | null> {
    if (!fs.existsSync(tempDir)) {
      await fs.promises.mkdir(tempDir, { recursive: true });
    }

    const tempFilePath = path.join(
      tempDir,
      `temp_${channelId}_${messageId}_${mediaInfo.fileName}`
    );

    try {
      logger.debug(`Downloading media for message ${messageId} to ${tempFilePath}`);
      await this.telegramService.downloadMediaToFile(msg, tempFilePath);

      // Recalculate file size based on the actual downloaded file size
      if (fs.existsSync(tempFilePath)) {
        const stats = await fs.promises.stat(tempFilePath);
        mediaInfo.fileSize = stats.size;
      }

      // Stream file upload to S3
      const s3Key = `telegram/${channelId}/${messageId}/${mediaInfo.fileName}`;
      logger.debug(`Uploading media stream to S3: ${s3Key}`);
      
      const fileStream = fs.createReadStream(tempFilePath);
      await this.s3Service.uploadStream(s3Key, fileStream, mediaInfo.mimeType);

      return s3Key;
    } catch (err) {
      logger.error(`Media import failed for message ID ${messageId} in channel ${channelId}`, err);
      return null;
    } finally {
      // Immediate cleanup of temporary files
      if (fs.existsSync(tempFilePath)) {
        try {
          await fs.promises.unlink(tempFilePath);
          logger.debug(`Deleted temp file: ${tempFilePath}`);
        } catch (unlinkErr) {
          logger.error(`Failed to delete temp file ${tempFilePath}`, unlinkErr);
        }
      }
    }
  }

  /**
   * Extracts clean, application-facing properties from raw GramJS message object.
   * Excludes circular references, transport-layer details, and non-serializable objects.
   */
  public extractCleanJson(message: any, mediaInfo?: TelegramMediaInfo): any {
    const cleanJson: any = {
      message_id: message.id,
      channel_id: message.peerId?.channelId ? message.peerId.channelId.toString() : null,
      date: message.date ? new Date(message.date * 1000).toISOString() : null,
      text: message.message || '',
      views: message.views || 0,
      forwards: message.forwards || 0,
      edit_date: message.editDate ? new Date(message.editDate * 1000).toISOString() : null,
    };

    if (message.replyTo) {
      cleanJson.reply_to = {
        reply_to_msg_id: message.replyTo.replyToMsgId,
      };
    }

    if (mediaInfo) {
      cleanJson.media = {
        media_type: mediaInfo.mediaType,
        file_name: mediaInfo.fileName,
        mime_type: mediaInfo.mimeType,
        file_size: mediaInfo.fileSize,
      };
    }

    return cleanJson;
  }
}
