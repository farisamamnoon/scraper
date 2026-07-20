import { Importer } from '../src/importer';
import { DbService } from '../src/services/db.service';
import { S3Service } from '../src/services/s3.service';
import { TelegramService } from '../src/services/telegram.service';

describe('Importer message extraction and logic', () => {
  let mockDbService: jest.Mocked<DbService>;
  let mockS3Service: jest.Mocked<S3Service>;
  let mockTelegramService: jest.Mocked<TelegramService>;
  let importer: Importer;

  beforeEach(() => {
    mockDbService = {
      upsertChannel: jest.fn(),
      updateChannelStatus: jest.fn(),
      updateChannelProgress: jest.fn(),
      getChannelProgress: jest.fn(),
      getChannelByUsername: jest.fn(),
      getExistingMessageMediaKey: jest.fn(),
      upsertMessage: jest.fn(),
      getAllChannels: jest.fn(),
      getGlobalStats: jest.fn(),
    } as unknown as jest.Mocked<DbService>;

    mockS3Service = {
      ensureBucketExists: jest.fn(),
      uploadStream: jest.fn(),
    } as unknown as jest.Mocked<S3Service>;

    mockTelegramService = {
      connect: jest.fn(),
      disconnect: jest.fn(),
      executeWithRetry: jest.fn(),
      getChannelEntity: jest.fn(),
      hasDownloadableMedia: jest.fn(),
      extractMediaMetadata: jest.fn(),
      downloadMediaToFile: jest.fn(),
    } as unknown as jest.Mocked<TelegramService>;

    importer = new Importer(mockDbService, mockS3Service, mockTelegramService, 1);
  });

  describe('extractCleanJson', () => {
    it('should extract clean application-facing fields from a raw message', () => {
      const mockRawMessage = {
        id: 4567,
        peerId: {
          className: 'PeerChannel',
          channelId: 123456789n,
        },
        date: 1781683200, // 2026-06-17T08:00:00.000Z
        message: 'Hello, this is a channel post!',
        views: 125,
        forwards: 5,
        editDate: 1781683500, // 2026-06-17T08:05:00.000Z
        replyTo: {
          className: 'MessageReplyHeader',
          replyToMsgId: 4560,
        },
        // internal transport properties that should be omitted
        _client: {},
        _senderMap: {},
      };

      const cleanJson = importer.extractCleanJson(mockRawMessage);

      // Verify structure and values
      expect(cleanJson.message_id).toBe(4567);
      expect(cleanJson.channel_id).toBe('123456789');
      expect(cleanJson.date).toBe(new Date(1781683200 * 1000).toISOString());
      expect(cleanJson.text).toBe('Hello, this is a channel post!');
      expect(cleanJson.views).toBe(125);
      expect(cleanJson.forwards).toBe(5);
      expect(cleanJson.edit_date).toBe(new Date(1781683500 * 1000).toISOString());
      expect(cleanJson.reply_to).toEqual({
        reply_to_msg_id: 4560,
      });

      // Verify internal properties are excluded
      expect(cleanJson._client).toBeUndefined();
      expect(cleanJson._senderMap).toBeUndefined();
    });

    it('should include media details if mediaInfo is provided', () => {
      const mockRawMessage = {
        id: 4568,
        peerId: {
          channelId: 123456789n,
        },
        date: 1781683200,
        message: 'Here is a document!',
      };

      const mockMediaInfo = {
        fileName: 'document.pdf',
        mimeType: 'application/pdf',
        fileSize: 2048576,
        mediaType: 'document',
      };

      const cleanJson = importer.extractCleanJson(mockRawMessage, mockMediaInfo);

      expect(cleanJson.media).toBeDefined();
      expect(cleanJson.media.media_type).toBe('document');
      expect(cleanJson.media.file_name).toBe('document.pdf');
      expect(cleanJson.media.mime_type).toBe('application/pdf');
      expect(cleanJson.media.file_size).toBe(2048576);
    });

    it('should process messages with empty text or null properties gracefully', () => {
      const mockRawMessage = {
        id: 4569,
        peerId: null,
        date: null,
        message: null,
      };

      const cleanJson = importer.extractCleanJson(mockRawMessage);

      expect(cleanJson.message_id).toBe(4569);
      expect(cleanJson.channel_id).toBeNull();
      expect(cleanJson.date).toBeNull();
      expect(cleanJson.text).toBe('');
      expect(cleanJson.views).toBe(0);
      expect(cleanJson.forwards).toBe(0);
      expect(cleanJson.edit_date).toBeNull();
      expect(cleanJson.reply_to).toBeUndefined();
    });
  });
});
