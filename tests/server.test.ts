import request from 'supertest';
import crypto from 'crypto';
import { createServer } from '../src/server';
import { DbService } from '../src/services/db.service';
import { Importer } from '../src/importer';
import { TelegramService } from '../src/services/telegram.service';
import { S3Service } from '../src/services/s3.service';

const testPassword = 'testpassword';
const testToken = crypto.createHash('sha256').update(testPassword).digest('hex');
const authCookie = `dashboard_token=${testToken}`;

describe('Express API Server Endpoints', () => {
  let mockDbService: jest.Mocked<DbService>;
  let mockImporter: jest.Mocked<Importer>;
  let mockTelegramService: jest.Mocked<TelegramService>;
  let mockS3Service: jest.Mocked<S3Service>;
  let app: any;

  beforeEach(() => {
    mockDbService = {
      getAllChannels: jest.fn(),
      getGlobalStats: jest.fn(),
      upsertChannel: jest.fn(),
      getChannelByUsername: jest.fn().mockResolvedValue(null),
      getChannelProgress: jest.fn().mockResolvedValue(null),
      getChannelMessages: jest.fn(),
      deleteChannel: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<DbService>;

    mockImporter = {
      isChannelRunning: jest.fn().mockReturnValue(false),
    } as unknown as jest.Mocked<Importer>;

    mockTelegramService = {
      getChannelEntity: jest.fn(),
    } as unknown as jest.Mocked<TelegramService>;

    mockS3Service = {
      getObjectStream: jest.fn(),
    } as unknown as jest.Mocked<S3Service>;

    app = createServer(mockDbService, mockImporter, mockTelegramService, mockS3Service, testPassword);
  });

  describe('Authentication Enforcement', () => {
    it('should redirect unauthenticated request for root / to /login.html', async () => {
      await request(app)
        .get('/')
        .expect(302)
        .expect('Location', '/login.html');
    });

    it('should redirect unauthenticated request for /index.html to /login.html', async () => {
      await request(app)
        .get('/index.html')
        .expect(302)
        .expect('Location', '/login.html');
    });

    it('should redirect authenticated request for /login.html to /', async () => {
      await request(app)
        .get('/login.html')
        .set('Cookie', authCookie)
        .expect(302)
        .expect('Location', '/');
    });

    it('should return 401 Unauthorized for unauthenticated API requests', async () => {
      const response = await request(app)
        .get('/api/progress')
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Unauthorized');
    });
  });

  describe('POST /api/auth/login', () => {
    it('should return success and Set-Cookie header for correct password', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({ password: testPassword })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.headers['set-cookie']).toBeDefined();
      expect(response.headers['set-cookie'][0]).toContain(`dashboard_token=${testToken}`);
    });

    it('should return 401 Unauthorized for incorrect password', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({ password: 'wrongpassword' })
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Incorrect password.');
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('should return 400 Bad Request for missing password', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({})
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Password is required.');
    });
  });

  describe('GET /api/progress', () => {
    it('should return channels list and database global statistics when authenticated', async () => {
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
        .set('Cookie', authCookie)
        .expect('Content-Type', /json/)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.stats).toEqual(mockStats);
      expect(response.body.channels).toHaveLength(1);
      expect(response.body.channels[0].channel_username).toBe('durov');
    });
  });

  describe('POST /api/channels', () => {
    it('should successfully register a valid public channel username when authenticated', async () => {
      const mockEntity = {
        id: 123456789n,
        title: 'Telegram News',
        username: 'telegram',
      };

      mockTelegramService.getChannelEntity.mockResolvedValue(mockEntity as any);
      mockDbService.upsertChannel.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/channels')
        .set('Cookie', authCookie)
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

    it('should return 400 error if username is empty or missing when authenticated', async () => {
      const response = await request(app)
        .post('/api/channels')
        .set('Cookie', authCookie)
        .send({ username: '' })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('username is required');
    });

    it('should return 400 error if telegram channel resolution fails when authenticated', async () => {
      mockTelegramService.getChannelEntity.mockRejectedValue(new Error('Channel not found'));

      const response = await request(app)
        .post('/api/channels')
        .set('Cookie', authCookie)
        .send({ username: 'some_invalid_channel' })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Could not resolve Telegram channel');
    });

    it('should return 409 Conflict if channel username is already tracked when authenticated', async () => {
      mockDbService.getChannelByUsername.mockResolvedValue({
        channel_id: '123456789',
        channel_username: 'telegram',
        title: 'Telegram News',
        status: 'completed',
      } as any);

      const response = await request(app)
        .post('/api/channels')
        .set('Cookie', authCookie)
        .send({ username: 'telegram' })
        .expect(409);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Channel @telegram is already being tracked.');
      expect(mockTelegramService.getChannelEntity).not.toHaveBeenCalled();
    });

    it('should return 409 Conflict if resolved channel ID is already tracked when authenticated', async () => {
      const mockEntity = {
        id: 123456789n,
        title: 'Telegram News',
        username: 'telegram',
      };

      mockTelegramService.getChannelEntity.mockResolvedValue(mockEntity as any);
      mockDbService.getChannelProgress.mockResolvedValue({
        channel_id: '123456789',
        channel_username: 'telegram',
        title: 'Telegram News',
        status: 'completed',
      } as any);

      const response = await request(app)
        .post('/api/channels')
        .set('Cookie', authCookie)
        .send({ username: 'telegram' })
        .expect(409);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Channel "Telegram News" (@telegram) is already being tracked.');
      expect(mockDbService.upsertChannel).toHaveBeenCalledWith('123456789', 'telegram', 'Telegram News', 'completed');
    });

    it('should return 400 error if username format is invalid when authenticated', async () => {
      const response = await request(app)
        .post('/api/channels')
        .set('Cookie', authCookie)
        .send({ username: 'ab' })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Invalid Telegram username');
    });

    it('should successfully register multiple valid public channels when authenticated', async () => {
      const mockTelegramEntity = {
        id: 123n,
        title: 'Telegram News',
        username: 'telegram',
      };
      const mockDurovEntity = {
        id: 456n,
        title: 'Durov Channel',
        username: 'durov',
      };

      mockTelegramService.getChannelEntity
        .mockResolvedValueOnce(mockTelegramEntity as any)
        .mockResolvedValueOnce(mockDurovEntity as any);

      const response = await request(app)
        .post('/api/channels')
        .set('Cookie', authCookie)
        .send({ username: 'telegram, durov' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.results).toBeDefined();
      expect(response.body.results).toHaveLength(2);

      expect(response.body.results[0]).toEqual({
        username: 'telegram',
        success: true,
        channel: {
          channel_id: '123',
          channel_username: 'telegram',
          title: 'Telegram News',
          status: 'pending',
        },
      });

      expect(response.body.results[1]).toEqual({
        username: 'durov',
        success: true,
        channel: {
          channel_id: '456',
          channel_username: 'durov',
          title: 'Durov Channel',
          status: 'pending',
        },
      });

      expect(mockTelegramService.getChannelEntity).toHaveBeenCalledWith('telegram');
      expect(mockTelegramService.getChannelEntity).toHaveBeenCalledWith('durov');
      expect(mockDbService.upsertChannel).toHaveBeenCalledWith('123', 'telegram', 'Telegram News', 'pending');
      expect(mockDbService.upsertChannel).toHaveBeenCalledWith('456', 'durov', 'Durov Channel', 'pending');
    });

    it('should handle mixed success and failure when registering multiple channels', async () => {
      const mockTelegramEntity = {
        id: 123n,
        title: 'Telegram News',
        username: 'telegram',
      };

      // telegram resolves, invalid_chan rejects
      mockTelegramService.getChannelEntity
        .mockResolvedValueOnce(mockTelegramEntity as any)
        .mockRejectedValueOnce(new Error('Channel not found'));

      // already_tracked is mock-resolved in DB
      mockDbService.getChannelByUsername.mockImplementation(async (username) => {
        if (username === 'already_tracked') {
          return {
            channel_id: '789',
            channel_username: 'already_tracked',
            title: 'Tracked',
            status: 'completed',
          } as any;
        }
        return null;
      });

      const response = await request(app)
        .post('/api/channels')
        .set('Cookie', authCookie)
        .send({ username: 'telegram, already_tracked, invalid_chan' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.results).toHaveLength(3);

      // Index 0: telegram (Success)
      expect(response.body.results[0]).toEqual({
        username: 'telegram',
        success: true,
        channel: {
          channel_id: '123',
          channel_username: 'telegram',
          title: 'Telegram News',
          status: 'pending',
        },
      });

      // Index 1: already_tracked (Conflict)
      expect(response.body.results[1].username).toBe('already_tracked');
      expect(response.body.results[1].success).toBe(false);
      expect(response.body.results[1].error).toContain('already being tracked');

      // Index 2: invalid_chan (Not found)
      expect(response.body.results[2].username).toBe('invalid_chan');
      expect(response.body.results[2].success).toBe(false);
      expect(response.body.results[2].error).toContain('Could not resolve');
    });
  });

  describe('DELETE /api/channels/:channelId', () => {
    it('should successfully delete an idle channel when authenticated', async () => {
      mockImporter.isChannelRunning.mockReturnValue(false);
      mockDbService.getChannelProgress.mockResolvedValue({
        channel_id: '123456789',
        channel_username: 'telegram',
        title: 'Telegram News',
        status: 'completed',
      } as any);

      const response = await request(app)
        .delete('/api/channels/123456789')
        .set('Cookie', authCookie)
        .expect('Content-Type', /json/)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Channel deleted successfully.');
      expect(mockDbService.deleteChannel).toHaveBeenCalledWith('123456789');
    });

    it('should return 400 Bad Request when deleting a running channel when authenticated', async () => {
      mockImporter.isChannelRunning.mockReturnValue(true);

      const response = await request(app)
        .delete('/api/channels/123456789')
        .set('Cookie', authCookie)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Cannot delete a channel while its import is in progress');
      expect(mockDbService.deleteChannel).not.toHaveBeenCalled();
    });

    it('should return 404 Not Found when deleting a non-existent channel when authenticated', async () => {
      mockImporter.isChannelRunning.mockReturnValue(false);
      mockDbService.getChannelProgress.mockResolvedValue(null);

      const response = await request(app)
        .delete('/api/channels/999999')
        .set('Cookie', authCookie)
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Channel not found');
      expect(mockDbService.deleteChannel).not.toHaveBeenCalled();
    });
  });
});
