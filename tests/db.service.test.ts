import { Pool } from 'pg';
import { DbService } from '../src/services/db.service';

describe('DbService', () => {
  let mockClient: { query: jest.Mock; release: jest.Mock };
  let mockPool: { connect: jest.Mock; query: jest.Mock };
  let dbService: DbService;

  const clientSql = (): string[] => mockClient.query.mock.calls.map(([sql]) => String(sql).trim());

  beforeEach(() => {
    mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    };
    mockPool = {
      connect: jest.fn().mockResolvedValue(mockClient),
      query: jest.fn().mockResolvedValue({ rows: [] }),
    };
    dbService = new DbService(mockPool as unknown as Pool);
  });

  describe('initializeSchema', () => {
    it('should create the channel_mappings table and its text index', async () => {
      await dbService.initializeSchema();

      const sql = clientSql().join('\n');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS channel_mappings');
      expect(sql).toContain('PRIMARY KEY (channel_id, media_message_id)');
      expect(sql).toContain("CHECK (source IN ('manual', 'auto', 'unknown'))");
      expect(sql).toContain('updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
      expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS \w+\s+ON channel_mappings \(channel_id, text_message_id\)/);
      expect(clientSql()[clientSql().length - 1]).toBe('COMMIT');
    });
  });

  describe('deleteChannel', () => {
    it('should delete mappings, messages and the channel in one transaction', async () => {
      await dbService.deleteChannel('123456789');

      expect(clientSql()).toEqual([
        'BEGIN',
        'DELETE FROM channel_mappings WHERE channel_id = $1',
        'DELETE FROM telegram_messages WHERE channel_id = $1',
        'DELETE FROM telegram_channels WHERE channel_id = $1',
        'COMMIT',
      ]);
      expect(mockClient.query).toHaveBeenCalledWith('DELETE FROM channel_mappings WHERE channel_id = $1', ['123456789']);
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('replaceChannelMappings', () => {
    const now = new Date('2026-10-14T18:00:00.000Z');
    const lockSql = 'SELECT channel_id FROM telegram_channels WHERE channel_id = $1 FOR UPDATE';

    // A tracked channel: the lock finds its row, and NOW() returns the write time.
    const trackedChannelQueries = async (sql: string) => {
      if (sql.startsWith('SELECT NOW()')) return { rows: [{ updated_at: now }] };
      if (sql === lockSql) return { rows: [{ channel_id: '123456789' }] };
      return { rows: [] };
    };

    it('should lock the channel row, then delete and bulk insert with unnest in one transaction', async () => {
      mockClient.query.mockImplementation(trackedChannelQueries);

      const result = await dbService.replaceChannelMappings('123456789', [
        { text_message_id: '55', media_message_id: '67', source: 'manual' },
        { text_message_id: '55', media_message_id: '68', source: 'auto' },
      ]);

      expect(result).toEqual({ count: 2, updated_at: now });
      const sql = clientSql();
      expect(sql[0]).toBe('BEGIN');
      expect(sql[1]).toBe(lockSql);
      expect(mockClient.query.mock.calls[1][1]).toEqual(['123456789']);
      expect(sql[2]).toBe('DELETE FROM channel_mappings WHERE channel_id = $1');
      expect(sql[3]).toContain('unnest($2::bigint[], $3::bigint[], $4::text[])');
      expect(sql[sql.length - 1]).toBe('COMMIT');
      expect(mockClient.query.mock.calls[3][1]).toEqual([
        '123456789',
        ['67', '68'],
        ['55', '55'],
        ['manual', 'auto'],
      ]);
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('should only delete when the set is empty', async () => {
      mockClient.query.mockImplementation(trackedChannelQueries);

      const result = await dbService.replaceChannelMappings('123456789', []);

      expect(result?.count).toBe(0);
      expect(clientSql().some((s) => s.startsWith('INSERT'))).toBe(false);
      expect(clientSql()).toContain('DELETE FROM channel_mappings WHERE channel_id = $1');
    });

    it('should return null and write nothing when the channel is not tracked', async () => {
      // The lock finds no row: the channel was never tracked or a delete removed it first.
      const result = await dbService.replaceChannelMappings('123456789', [
        { text_message_id: '55', media_message_id: '67', source: 'manual' },
      ]);

      expect(result).toBeNull();
      expect(clientSql()).toEqual(['BEGIN', lockSql, 'ROLLBACK']);
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('should roll back and release the client when the insert fails', async () => {
      mockClient.query.mockImplementation(async (sql: string) => {
        if (sql.trim().startsWith('INSERT')) throw new Error('insert failed');
        return trackedChannelQueries(sql);
      });

      await expect(
        dbService.replaceChannelMappings('123456789', [
          { text_message_id: '55', media_message_id: '67', source: 'manual' },
        ])
      ).rejects.toThrow('insert failed');

      expect(clientSql()).toContain('ROLLBACK');
      expect(clientSql()).not.toContain('COMMIT');
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('channel lists', () => {
    it('should include mapping_count in getAllChannels and listChannels', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ total: 0 }] });

      await dbService.getAllChannels();
      await dbService.listChannels({ limit: 50, offset: 0 });

      const listSql = mockPool.query.mock.calls.map(([sql]) => String(sql)).filter((sql) => sql.includes('message_count'));
      expect(listSql).toHaveLength(2);
      listSql.forEach((sql) => expect(sql).toContain('as mapping_count'));
    });
  });

  describe('getMappableMessageInfo', () => {
    it('should look up all IDs in one set-based query', async () => {
      await dbService.getMappableMessageInfo('123456789', ['55', '67', '68']);

      expect(mockPool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockPool.query.mock.calls[0];
      expect(sql).toContain('message_id = ANY($2::bigint[])');
      expect(sql).toContain("telegram_json->'media'->>'media_type' IN ('audio', 'voice')");
      expect(sql).toContain("telegram_json->'media'->>'mime_type' LIKE 'audio/%'");
      expect(params).toEqual(['123456789', ['55', '67', '68']]);
    });
  });
});
