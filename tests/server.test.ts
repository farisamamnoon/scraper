import request from 'supertest';
import { createServer } from '../src/server';
import { DbService } from '../src/services/db.service';
import { Importer } from '../src/importer';
import { TelegramService } from '../src/services/telegram.service';

describe('Express API Server Endpoints', () => {
  let mockDbService: jest.Mocked<DbService>;
  let mockImporter: jest.Mocked<Importer>;
  let mockTelegramService: jest.Mocked<TelegramService>;
  let app: any;

  beforeEach(() => {
    mockDbService = {
      getAllChannels: jest.fn(),
      getGlobalStats: jest.fn(),
      upsertChannel: jest.fn(),
      getChannelByUsername: jest.fn(),
    } as unknown as jest.Mocked<DbService>;

    mockImporter = {} as unknown as jest.Mocked<Importer>;

    mockTelegramService = {
      getChannelEntity: jest.fn(),
    } as unknown as jest.Mocked<TelegramService>;

    app = createServer(mockDbService, mockImporter, mockTelegramService);
  });

  describe('GET /api/progress', () => {
    it('should return channels list and database global statistics', async () => {
      const mockChannels = [
        {
          channel_id: '123456789',
          channel_username: 'durov',
          title: 'Durov Channel',
          import_started_at: new Date(),
          import_completed_at: null,
          last_processed_message_id: '4560',
          status: 'running',
          message_count: 50,
        },
      ];

      const mockStats = {
        total_messages: 50,
        total_channels: 1,
        active_imports: 1,
      };

      mockDbService.getAllChannels.mockResolvedValue(mockChannels as any);
      mockDbService.getGlobalStats.mockResolvedValue(mockStats);

      const response = await request(app)
        .get('/api/progress')
        .expect('Content-Type', /json/)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.stats).toEqual(mockStats);
      expect(response.body.channels).toHaveLength(1);
      expect(response.body.channels[0].channel_username).toBe('durov');
    });
  });

  describe('POST /api/channels', () => {
    it('should successfully register a valid public channel username', async () => {
      const mockEntity = {
        id: 123456789n,
        title: 'Telegram News',
        username: 'telegram',
      };

      mockTelegramService.getChannelEntity.mockResolvedValue(mockEntity as any);
      mockDbService.upsertChannel.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/channels')
        .send({ username: 'telegram' })
        .expect('Content-Type', /json/)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.channel.channel_username).toBe('telegram');
      expect(response.body.channel.title).toBe('Telegram News');
      expect(response.body.channel.channel_id).toBe('123456789');

      expect(mockTelegramService.getChannelEntity).toHaveBeenCalledWith('telegram');
      expect(mockDbService.upsertChannel).toHaveBeenCalledWith('123456789', 'telegram', 'Telegram News', 'pending');
    });

    it('should return 400 error if username is empty or missing', async () => {
      const response = await request(app)
        .post('/api/channels')
        .send({ username: '' })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('username is required');
    });

    it('should return 400 error if telegram channel resolution fails', async () => {
      mockTelegramService.getChannelEntity.mockRejectedValue(new Error('Channel not found'));

      const response = await request(app)
        .post('/api/channels')
        .send({ username: 'some_invalid_channel' })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Could not resolve Telegram channel');
    });
  });
});
