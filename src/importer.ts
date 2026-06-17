import fs from 'fs';
import path from 'path';
import { DbService, ChannelProgress } from './services/db.service';
import { S3Service } from './services/s3.service';
import { TelegramService, TelegramMediaInfo } from './services/telegram.service';
import { logger } from './logger';

export class Importer {
  private dbService: DbService;
  private s3Service: S3Service;
  private telegramService: TelegramService;
  private concurrency: number;
  private runningChannels = new Set<string>();
  private activeJobs = 0;
  private isShuttingDown = false;
  private checkTimeout: NodeJS.Timeout | null = null;

  constructor(
    dbService: DbService,
    s3Service: S3Service,
    telegramService: TelegramService,
    concurrency: number
  ) {
    this.dbService = dbService;
    this.s3Service = s3Service;
    this.telegramService = telegramService;
    this.concurrency = concurrency;
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
   * Processes a single channel from oldest to newest message.
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
      if (!fs.existsSync(tempDir)) {
        await fs.promises.mkdir(tempDir, { recursive: true });
      }

      let currentMinId = lastProcessedId;
      let batchCount = 0;

      while (!this.isShuttingDown) {
        logger.debug(`[Channel ${resolvedTitle}] Fetching message batch with minId ${currentMinId}`);

        const messages = await this.telegramService.executeWithRetry(
          async (client) => {
            return await client.getMessages(channelEntity, {
              minId: currentMinId,
              limit: 100,
              reverse: true,
            });
          },
          `fetch messages batch for channel ${resolvedTitle}`
        );

        if (!messages || messages.length === 0) {
          logger.info(`[Channel ${resolvedTitle}] Import complete. No new messages found.`);
          await this.dbService.updateChannelStatus(resolvedId, 'completed');
          return;
        }

        let maxBatchId = currentMinId;

        for (const msg of messages) {
          if (this.isShuttingDown) break;

          try {
            const messageId = msg.id;
            if (messageId > maxBatchId) {
              maxBatchId = messageId;
            }

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
              mediaKey
            );

          } catch (msgErr) {
            logger.error(`[Channel ${resolvedTitle}] Error processing message ID ${msg.id}:`, msgErr);
            // Log and continue processing the rest of the batch
          }
        }

        currentMinId = maxBatchId;
        await this.dbService.updateChannelProgress(resolvedId, currentMinId);
        batchCount++;

        logger.info(
          `[Channel ${resolvedTitle}] Processed batch ${batchCount}. Up to message ID: ${currentMinId}`
        );
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
