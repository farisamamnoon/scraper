import fs from 'fs';
import path from 'path';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
// @ts-ignore
import input from 'input';
import { logger } from '../logger';

export interface TelegramMediaInfo {
  fileName: string;
  mimeType: string;
  fileSize: number;
  mediaType: string;
}

export class TelegramService {
  private client: TelegramClient | null = null;
  private apiId: number;
  private apiHash: string;
  private customSession?: string;
  private sessionFilePath: string;

  constructor(apiId: number, apiHash: string, customSession?: string, sessionFilePath?: string) {
    this.apiId = apiId;
    this.apiHash = apiHash;
    this.customSession = customSession;
    this.sessionFilePath = sessionFilePath || path.join(process.cwd(), '.session');
  }

  /**
   * Initializes and connects the GramJS client.
   * Prompts for auth if no session exists and runs in a TTY environment.
   */
  async connect(): Promise<void> {
    let sessionString = '';

    if (this.customSession) {
      sessionString = this.customSession;
      logger.info('Using Telegram session string provided via environment variables.');
    } else if (fs.existsSync(this.sessionFilePath)) {
      sessionString = fs.readFileSync(this.sessionFilePath, 'utf8').trim();
      logger.info('Loaded Telegram session from local .session file.');
    }

    const session = new StringSession(sessionString);
    this.client = new TelegramClient(session, this.apiId, this.apiHash, {
      connectionRetries: 5,
    });

    logger.info('Connecting to Telegram API...');
    
    await this.client.start({
      phoneNumber: async () => {
        if (!process.stdin.isTTY) {
          throw new Error(
            'Telegram authentication required: No valid session found, and terminal is running in a non-interactive (headless) mode. ' +
            'Please run the importer locally first to generate the ".session" file.'
          );
        }
        return await input.text('Enter your Telegram phone number (e.g. +1234567890): ');
      },
      password: async () => {
        if (!process.stdin.isTTY) {
          throw new Error('Telegram 2FA Password requested in a non-interactive environment.');
        }
        return await input.text('Enter your Telegram 2FA password: ');
      },
      phoneCode: async () => {
        if (!process.stdin.isTTY) {
          throw new Error('Telegram Verification Code requested in a non-interactive environment.');
        }
        return await input.text('Enter the Telegram verification code: ');
      },
      onError: (err) => {
        logger.error('GramJS Client encountered an authentication error:', err);
      },
    });

    logger.info('Connected to Telegram successfully.');

    // Persist session string if it changed or was newly created
    const currentSessionString = this.client.session.save() as any as string;
    if (!this.customSession) {
      fs.writeFileSync(this.sessionFilePath, currentSessionString, 'utf8');
      logger.debug('Telegram session successfully saved to disk.');
    }
  }

  /**
   * Disconnect the client.
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.disconnect();
      logger.info('Telegram client disconnected.');
    }
  }

  /**
   * Helper wrapper to handle FloodWait rate limiting and transient network errors.
   */
  async executeWithRetry<T>(fn: (client: TelegramClient) => Promise<T>, label?: string): Promise<T> {
    if (!this.client) {
      throw new Error('Telegram client is not connected. Call connect() first.');
    }

    const maxRetries = 5;
    let attempt = 0;

    while (true) {
      try {
        return await fn(this.client);
      } catch (error: any) {
        const errorMsg = error.message || '';
        const errorClass = error.className || '';

        // Match FloodWait syntax: "FLOOD_WAIT_X" or "wait X seconds"
        const floodMatch = errorMsg.match(/FLOOD_WAIT_(\d+)/i) || errorMsg.match(/wait (\d+) seconds/i);

        if (errorClass === 'FloodWaitError' || error.name === 'FloodWaitError' || floodMatch) {
          const waitSeconds = floodMatch ? parseInt(floodMatch[1], 10) : (error.seconds || 3600);
          logger.warn(
            `[FloodWaitError] Rate limit hit during ${label || 'API request'}. ` +
            `Must sleep for ${waitSeconds} seconds before resuming.`
          );
          
          await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
          logger.info('FloodWait sleep period complete. Retrying request...');
          continue;
        }

        // Handle general network errors with exponential backoff
        attempt++;
        if (attempt >= maxRetries) {
          logger.error(`Operation failed after ${maxRetries} attempts: ${errorMsg}`);
          throw error;
        }

        const backoffMs = Math.pow(2, attempt) * 1000;
        logger.warn(
          `Transient error during ${label || 'API request'}: "${errorMsg}". ` +
          `Retrying in ${backoffMs}ms... (Attempt ${attempt}/${maxRetries})`
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  /**
   * Resolves a public channel username or username string to a Telegram channel entity.
   */
  async getChannelEntity(username: string): Promise<Api.Channel> {
    const cleanUsername = username.replace('@', '').trim();
    return await this.executeWithRetry(
      async (client) => {
        const entity = await client.getEntity(cleanUsername);
        if (entity instanceof Api.Channel || entity.constructor.name === 'Channel') {
          return entity as Api.Channel;
        }
        throw new Error(`Resolved entity for "${username}" is not a Channel type.`);
      },
      `Resolve channel @${cleanUsername}`
    );
  }

  /**
   * Checks if a message contains downloadable media.
   */
  hasDownloadableMedia(message: any): boolean {
    if (!message || !message.media) return false;
    
    // GramJS type names represent media types
    const typeName = message.media.className || message.media.constructor.name;
    return typeName === 'MessageMediaPhoto' || typeName === 'MessageMediaDocument';
  }

  /**
   * Extracts clean metadata from media fields.
   */
  extractMediaMetadata(message: any): TelegramMediaInfo {
    if (!message || !message.media) {
      throw new Error('No media details found in the message.');
    }

    const media = message.media;
    const typeName = media.className || media.constructor.name;

    if (typeName === 'MessageMediaPhoto') {
      return {
        fileName: `photo_${message.id}.jpg`,
        mimeType: 'image/jpeg',
        fileSize: 0, // Will be filled with actual size after downloading
        mediaType: 'photo',
      };
    }

    if (typeName === 'MessageMediaDocument' && media.document) {
      const doc = media.document;
      const mimeType = doc.mimeType || 'application/octet-stream';
      let fileName = '';

      // Find filename attribute
      if (doc.attributes) {
        const fileAttr = doc.attributes.find(
          (attr: any) =>
            attr.className === 'DocumentAttributeFilename' ||
            attr.constructor.name === 'DocumentAttributeFilename' ||
            attr.fileName !== undefined
        );
        if (fileAttr) {
          fileName = fileAttr.fileName;
        }
      }

      // If filename is empty, build a fallback based on mimeType/attributes
      if (!fileName) {
        let ext = 'bin';
        const parts = mimeType.split('/');
        if (parts.length === 2) ext = parts[1];
        
        // Check for specific document attributes (audio, video)
        const isVoice = doc.attributes?.some(
          (a: any) => a.className === 'DocumentAttributeAudio' && a.voice
        );
        
        if (isVoice) {
          fileName = `voice_${message.id}.ogg`;
        } else {
          fileName = `document_${message.id}.${ext}`;
        }
      }

      // Safe parse for bigint document sizes
      const sizeStr = doc.size ? doc.size.toString() : '0';
      const fileSize = parseInt(sizeStr, 10);

      // Deduce clean media type
      let mediaType = 'document';
      if (mimeType.startsWith('image/')) mediaType = 'photo';
      else if (mimeType.startsWith('video/')) mediaType = 'video';
      else if (mimeType.startsWith('audio/')) {
        const isVoice = doc.attributes?.some(
          (a: any) => a.className === 'DocumentAttributeAudio' && a.voice
        );
        mediaType = isVoice ? 'voice' : 'audio';
      }

      return {
        fileName,
        mimeType,
        fileSize,
        mediaType,
      };
    }

    return {
      fileName: `attachment_${message.id}.bin`,
      mimeType: 'application/octet-stream',
      fileSize: 0,
      mediaType: 'other',
    };
  }

  /**
   * Downloads a message's media directly to a local file.
   * Note: This keeps memory usage low because GramJS streams chunk-by-chunk directly to disk.
   */
  async downloadMediaToFile(message: any, tempFilePath: string): Promise<void> {
    await this.executeWithRetry(
      async (client) => {
        await client.downloadMedia(message, {
          outputFile: tempFilePath,
        });
      },
      `Downloading media for message ${message.id}`
    );
  }
}
