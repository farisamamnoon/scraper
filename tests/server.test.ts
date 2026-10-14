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
      listChannels: jest.fn(),
      getGlobalStats: jest.fn(),
      upsertChannel: jest.fn(),
      getChannelByUsername: jest.fn().mockResolvedValue(null),
      getChannelProgress: jest.fn().mockResolvedValue(null),
      getChannelMessages: jest.fn(),
      deleteChannel: jest.fn().mockResolvedValue(undefined),
      getMappableMessageInfo: jest.fn(),
      replaceChannelMappings: jest.fn(),
      getChannelMappings: jest.fn(),
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

  describe('GET /api/channels', () => {
    it('should return paginated channels with optional status filter when authenticated', async () => {
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

      mockDbService.listChannels.mockResolvedValue({
        channels: mockChannels as any,
        total: 75
      });

      const response = await request(app)
        .get('/api/channels?status=running&page=2&limit=25')
        .set('Cookie', authCookie)
        .expect('Content-Type', /json/)
        .expect(200);

      expect(mockDbService.listChannels).toHaveBeenCalledWith({
        status: 'running',
        limit: 25,
        offset: 25
      });
      expect(response.body.success).toBe(true);
      expect(response.body.channels).toHaveLength(1);
      expect(response.body.pagination).toEqual({
        page: 2,
        limit: 25,
        total: 75,
        total_pages: 3
      });
    });

    it('should default pagination and cap limit when no query parameters are provided', async () => {
      mockDbService.listChannels.mockResolvedValue({
        channels: [],
        total: 0
      });

      const response = await request(app)
        .get('/api/channels?limit=500')
        .set('Cookie', authCookie)
        .expect(200);

      expect(mockDbService.listChannels).toHaveBeenCalledWith({
        status: undefined,
        limit: 100,
        offset: 0
      });
      expect(response.body.pagination).toEqual({
        page: 1,
        limit: 100,
        total: 0,
        total_pages: 0
      });
    });

    it('should return 400 for invalid status filters', async () => {
      const response = await request(app)
        .get('/api/channels?status=unknown')
        .set('Cookie', authCookie)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Invalid status');
      expect(mockDbService.listChannels).not.toHaveBeenCalled();
    });

    it('should return 400 for invalid pagination parameters', async () => {
      const response = await request(app)
        .get('/api/channels?page=0&limit=abc')
        .set('Cookie', authCookie)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('positive integers');
      expect(mockDbService.listChannels).not.toHaveBeenCalled();
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

  describe('PUT /api/channels/:channelId/mappings', () => {
    const channel = {
      channel_id: '123456789',
      channel_username: 'telegram',
      title: 'Telegram News',
      status: 'running',
    } as any;
    const updatedAt = new Date('2026-10-14T18:00:00.000Z');

    // 55, 56: text posts. 67, 68: audio. 69: audio with caption. 70: photo with caption.
    const storedMessages: Record<string, { is_audio: boolean; has_text: boolean }> = {
      '55': { is_audio: false, has_text: true },
      '56': { is_audio: false, has_text: true },
      '67': { is_audio: true, has_text: false },
      '68': { is_audio: true, has_text: false },
      '69': { is_audio: true, has_text: true },
      '70': { is_audio: false, has_text: true },
    };

    beforeEach(() => {
      mockDbService.getChannelProgress.mockResolvedValue(channel);
      mockDbService.getMappableMessageInfo.mockImplementation(async (_channelId, ids) =>
        ids.filter((id) => storedMessages[id]).map((id) => ({ message_id: id, ...storedMessages[id] }))
      );
      mockDbService.replaceChannelMappings.mockImplementation(async (_channelId, mappings) => ({
        count: mappings.length,
        updated_at: updatedAt,
      }));
    });

    const put = (body: any) =>
      request(app).put('/api/channels/123456789/mappings').set('Cookie', authCookie).send(body);

    it('should return 401 Unauthorized without the auth cookie', async () => {
      const response = await request(app)
        .put('/api/channels/123456789/mappings')
        .send({ mappings: [] })
        .expect(401);

      expect(response.body).toEqual({ success: false, error: 'Unauthorized' });
      expect(mockDbService.replaceChannelMappings).not.toHaveBeenCalled();
    });

    it('should replace the mappings and normalize IDs and source', async () => {
      const response = await put({
        mappings: [
          { text_message_id: '55', media_message_id: '67', source: 'manual' },
          { text_message_id: 55, media_message_id: 68, source: 'auto' },
          { text_message_id: '69', media_message_id: '69' },
        ],
      }).expect(200);

      expect(response.body).toEqual({
        success: true,
        channel_id: '123456789',
        count: 3,
        updated_at: updatedAt.toISOString(),
      });
      expect(mockDbService.getMappableMessageInfo).toHaveBeenCalledTimes(1);
      expect(mockDbService.replaceChannelMappings).toHaveBeenCalledWith('123456789', [
        { text_message_id: '55', media_message_id: '67', source: 'manual' },
        { text_message_id: '55', media_message_id: '68', source: 'auto' },
        { text_message_id: '69', media_message_id: '69', source: 'unknown' },
      ]);
    });

    it('should clear the mappings for an empty array', async () => {
      const response = await put({ mappings: [] }).expect(200);

      expect(response.body.count).toBe(0);
      expect(mockDbService.getMappableMessageInfo).not.toHaveBeenCalled();
      expect(mockDbService.replaceChannelMappings).toHaveBeenCalledWith('123456789', []);
    });

    it('should return 404 for an unknown channel', async () => {
      mockDbService.getChannelProgress.mockResolvedValue(null);

      const response = await put({ mappings: [] }).expect(404);

      expect(response.body).toEqual({ success: false, error: 'Channel not found.' });
      expect(mockDbService.replaceChannelMappings).not.toHaveBeenCalled();
    });

    it('should return 400 for a malformed channel ID', async () => {
      const response = await request(app)
        .put('/api/channels/abc/mappings')
        .set('Cookie', authCookie)
        .send({ mappings: [] })
        .expect(400);

      expect(response.body.error).toBe('Invalid channel ID.');
      expect(mockDbService.getChannelProgress).not.toHaveBeenCalled();
    });

    it('should return 400 when mappings is not an array', async () => {
      const response = await put({ mappings: { text_message_id: '55' } }).expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'mappings must be an array.',
        details: [{ field: 'mappings', reason: 'must be an array.' }],
      });
      expect(mockDbService.replaceChannelMappings).not.toHaveBeenCalled();
    });

    it.each([
      ['a non-digit string', 'abc'],
      ['zero', 0],
      ['a negative number', -5],
      ['a decimal', 1.5],
      ['a value beyond BIGINT', '9223372036854775808'],
      ['a missing value', undefined],
    ])('should return 400 for %s as message ID', async (_label, badId) => {
      const response = await put({
        mappings: [
          { text_message_id: '55', media_message_id: '67' },
          { text_message_id: '55', media_message_id: badId },
        ],
      }).expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('mappings[1].media_message_id must be a positive integer message ID.');
      expect(response.body.details).toEqual([
        { index: 1, field: 'media_message_id', reason: 'must be a positive integer message ID.' },
      ]);
      expect(mockDbService.getMappableMessageInfo).not.toHaveBeenCalled();
      expect(mockDbService.replaceChannelMappings).not.toHaveBeenCalled();
    });

    it('should return 400 for a duplicate media_message_id', async () => {
      const response = await put({
        mappings: [
          { text_message_id: '55', media_message_id: '67' },
          { text_message_id: '56', media_message_id: '067' },
        ],
      }).expect(400);

      expect(response.body.details).toEqual([
        { index: 1, field: 'media_message_id', reason: 'duplicate of index 0; an audio can map to one text only.' },
      ]);
      expect(mockDbService.replaceChannelMappings).not.toHaveBeenCalled();
    });

    it('should return 400 for an invalid source', async () => {
      const response = await put({
        mappings: [{ text_message_id: '55', media_message_id: '67', source: 'robot' }],
      }).expect(400);

      expect(response.body.error).toBe('mappings[0].source must be one of: manual, auto, unknown.');
      expect(mockDbService.replaceChannelMappings).not.toHaveBeenCalled();
    });

    it('should return 400 for message IDs not stored in the channel', async () => {
      const response = await put({
        mappings: [
          { text_message_id: '55', media_message_id: '67' },
          { text_message_id: '999', media_message_id: '998' },
        ],
      }).expect(400);

      expect(response.body.error).toBe('mappings[1].media_message_id is not a stored message of this channel.');
      expect(response.body.details).toEqual([
        { index: 1, field: 'media_message_id', reason: 'is not a stored message of this channel.' },
        { index: 1, field: 'text_message_id', reason: 'is not a stored message of this channel.' },
      ]);
      expect(mockDbService.replaceChannelMappings).not.toHaveBeenCalled();
    });

    it('should return 400 when the media message is not audio', async () => {
      const response = await put({
        mappings: [{ text_message_id: '55', media_message_id: '70' }],
      }).expect(400);

      expect(response.body.error).toBe('mappings[0].media_message_id is not an audio or voice message.');
      expect(mockDbService.replaceChannelMappings).not.toHaveBeenCalled();
    });

    it('should return 400 when the text message has no text', async () => {
      const response = await put({
        mappings: [{ text_message_id: '68', media_message_id: '67' }],
      }).expect(400);

      expect(response.body.error).toBe('mappings[0].text_message_id has no text.');
      expect(mockDbService.replaceChannelMappings).not.toHaveBeenCalled();
    });

    it('should cap details at 20 entries', async () => {
      const mappings = Array.from({ length: 30 }, (_, i) => ({ text_message_id: 'x', media_message_id: String(1000 + i) }));

      const response = await put({ mappings }).expect(400);

      expect(response.body.details).toHaveLength(20);
      expect(response.body.error).toBe('mappings[0].text_message_id must be a positive integer message ID.');
    });

    it('should return 400 for more than 50,000 mappings', async () => {
      const mappings = Array.from({ length: 50001 }, (_, i) => ({ text_message_id: 1, media_message_id: i + 1 }));

      const response = await put({ mappings }).expect(400);

      expect(response.body.error).toBe('mappings must contain at most 50000 items.');
      expect(mockDbService.replaceChannelMappings).not.toHaveBeenCalled();
    });

    it('should accept a 5,000-item body larger than the default 100 KB limit', async () => {
      const mappings = Array.from({ length: 5000 }, (_, i) => ({
        text_message_id: '55',
        media_message_id: String(1000000000 + i),
        source: 'manual',
      }));
      const body = { mappings };
      expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(100 * 1024);
      mockDbService.getMappableMessageInfo.mockImplementation(async (_channelId, ids) =>
        ids.map((id) => ({ message_id: id, is_audio: id !== '55', has_text: id === '55' }))
      );

      const response = await put(body).expect(200);

      expect(response.body.count).toBe(5000);
      expect(mockDbService.getMappableMessageInfo).toHaveBeenCalledTimes(1);
    });

    it('should keep the default 100 KB limit for unauthenticated requests', async () => {
      const mappings = Array.from({ length: 5000 }, (_, i) => ({ text_message_id: '55', media_message_id: String(i + 1) }));

      await request(app).put('/api/channels/123456789/mappings').send({ mappings }).expect(500);

      expect(mockDbService.replaceChannelMappings).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/channels/:channelId/mappings', () => {
    it('should return 401 Unauthorized without the auth cookie', async () => {
      const response = await request(app).get('/api/channels/123456789/mappings').expect(401);

      expect(response.body).toEqual({ success: false, error: 'Unauthorized' });
    });

    it('should return the stored mappings with the latest update time', async () => {
      mockDbService.getChannelProgress.mockResolvedValue({ channel_id: '123456789' } as any);
      mockDbService.getChannelMappings.mockResolvedValue([
        { text_message_id: '55', media_message_id: '67', source: 'manual', updated_at: new Date('2026-10-14T18:00:00.000Z') },
        { text_message_id: '55', media_message_id: '68', source: 'auto', updated_at: new Date('2026-10-14T19:00:00.000Z') },
      ]);

      const response = await request(app)
        .get('/api/channels/123456789/mappings')
        .set('Cookie', authCookie)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        channel_id: '123456789',
        updated_at: '2026-10-14T19:00:00.000Z',
        mappings: [
          { text_message_id: '55', media_message_id: '67', source: 'manual', updated_at: '2026-10-14T18:00:00.000Z' },
          { text_message_id: '55', media_message_id: '68', source: 'auto', updated_at: '2026-10-14T19:00:00.000Z' },
        ],
      });
      expect(mockDbService.getChannelMappings).toHaveBeenCalledWith('123456789');
    });

    it('should return an empty list with a null update time', async () => {
      mockDbService.getChannelProgress.mockResolvedValue({ channel_id: '123456789' } as any);
      mockDbService.getChannelMappings.mockResolvedValue([]);

      const response = await request(app)
        .get('/api/channels/123456789/mappings')
        .set('Cookie', authCookie)
        .expect(200);

      expect(response.body).toEqual({ success: true, channel_id: '123456789', updated_at: null, mappings: [] });
    });

    it('should return 404 for an unknown channel', async () => {
      mockDbService.getChannelProgress.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/channels/999999/mappings')
        .set('Cookie', authCookie)
        .expect(404);

      expect(response.body).toEqual({ success: false, error: 'Channel not found.' });
      expect(mockDbService.getChannelMappings).not.toHaveBeenCalled();
    });
  });
});
