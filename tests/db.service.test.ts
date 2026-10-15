import { Pool } from 'pg';
import { DbService } from '../src/services/db.service';
import type { TailPlan } from '../src/batching';

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

    it('should create channel_batches and the batch_order column', async () => {
      await dbService.initializeSchema();

      const sql = clientSql().join('\n');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS channel_batches');
      expect(sql).toContain("CHECK (status IN ('open', 'frozen'))");
      expect(sql).toContain('PRIMARY KEY (channel_id, batch_no)');
      expect(sql).toContain('ALTER TABLE telegram_channels ADD COLUMN IF NOT EXISTS batch_order TEXT');
    });
  });

  describe('deleteChannel', () => {
    it('should lock the channel row, then delete mappings, messages and the channel in one transaction', async () => {
      await dbService.deleteChannel('123456789');

      // The lock comes first, so a mapping replace cannot add rows after the mappings DELETE.
      expect(clientSql()).toEqual([
        'BEGIN',
        'SELECT channel_id FROM telegram_channels WHERE channel_id = $1 FOR UPDATE',
        'DELETE FROM channel_mappings WHERE channel_id = $1',
        'DELETE FROM channel_batches WHERE channel_id = $1',
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

  describe('rebuildOpenBatches', () => {
    const completedAt = new Date('2026-07-10T12:00:00.000Z');
    const messageRows = [
      { message_id: '301', date: new Date('2026-07-01T00:00:00.000Z'), is_audio: true, has_text: false },
      { message_id: '302', date: new Date('2026-07-01T00:00:10.000Z'), is_audio: false, has_text: true },
    ];
    const plannedBatches: TailPlan['batches'] = [
      { first_message_id: '301', last_message_id: '301', message_count: 1, audio_count: 1, status: 'frozen' },
      { first_message_id: '302', last_message_id: '302', message_count: 1, audio_count: 0, status: 'open' },
    ];

    // Routes each statement of the rebuild to a canned result.
    const rebuildQueries =
      (channel: object | null, lastFrozen: object | null) =>
      async (sql: string) => {
        const s = sql.trim();
        if (s.startsWith('SELECT status, import_completed_at, batch_order')) return { rows: channel ? [channel] : [] };
        if (s.startsWith('SELECT batch_no, last_message_id::TEXT')) return { rows: lastFrozen ? [lastFrozen] : [] };
        if (s.startsWith('SELECT message_id::TEXT')) return { rows: messageRows };
        return { rows: [] };
      };
    const stepOf = (prefix: string) => clientSql().findIndex((s) => s.startsWith(prefix));
    const callOf = (prefix: string) => mockClient.query.mock.calls[stepOf(prefix)];

    it('returns null and rolls back for an untracked channel', async () => {
      mockClient.query.mockImplementation(rebuildQueries(null, null));
      const plan = jest.fn();

      await expect(dbService.rebuildOpenBatches('123', plan)).resolves.toBeNull();

      expect(plan).not.toHaveBeenCalled();
      expect(clientSql()[clientSql().length - 1]).toBe('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('freezes open batches that have mappings before planning', async () => {
      mockClient.query.mockImplementation(
        rebuildQueries({ status: 'completed', import_completed_at: completedAt, batch_order: null }, null)
      );
      const plan = jest.fn().mockReturnValue({ order: 'audio_first', batches: [] });

      await dbService.rebuildOpenBatches('123', plan);

      const freeze = stepOf("UPDATE channel_batches b SET status = 'frozen'");
      expect(freeze).toBeGreaterThan(0);
      expect(clientSql()[freeze]).toContain('channel_mappings');
      expect(freeze).toBeLessThan(stepOf('SELECT batch_no, last_message_id::TEXT'));
      expect(freeze).toBeLessThan(stepOf('SELECT message_id::TEXT'));
    });

    it('plans the tail after the last frozen batch and numbers batches after it', async () => {
      mockClient.query.mockImplementation(
        rebuildQueries(
          { status: 'completed', import_completed_at: completedAt, batch_order: 'text_first' },
          { batch_no: 7, last_message_id: '300' }
        )
      );
      const plan = jest.fn().mockReturnValue({ order: 'text_first', batches: plannedBatches });

      const result = await dbService.rebuildOpenBatches('123', plan);

      expect(result).toEqual({ order: 'text_first', batch_count: 9, open_count: 1 });
      expect(callOf('SELECT message_id::TEXT')[1]).toEqual(['123', '300']);
      expect(plan).toHaveBeenCalledWith({
        messages: messageRows,
        storedOrder: 'text_first',
        hasFrozenBatches: true,
        completedAt,
      });
      expect(clientSql()).toContain("DELETE FROM channel_batches WHERE channel_id = $1 AND status = 'open'");
      expect(stepOf('DELETE FROM channel_batches')).toBeLessThan(stepOf('INSERT INTO channel_batches'));
      const insertParams = callOf('INSERT INTO channel_batches')[1];
      expect(insertParams).toEqual([
        '123',
        [8, 9],
        ['301', '302'],
        ['301', '302'],
        [1, 1],
        [1, 0],
        ['frozen', 'open'],
      ]);
      expect(callOf('UPDATE telegram_channels SET batch_order')[1]).toEqual(['123', 'text_first']);
      expect(clientSql()[clientSql().length - 1]).toBe('COMMIT');
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('reads the tail in numeric message order', async () => {
      mockClient.query.mockImplementation(
        rebuildQueries({ status: 'completed', import_completed_at: completedAt, batch_order: null }, null)
      );

      await dbService.rebuildOpenBatches('123', jest.fn().mockReturnValue({ order: 'audio_first', batches: [] }));

      // The output column is message_id::TEXT; an unqualified ORDER BY message_id would sort it as text ('10' < '9').
      const readSql = clientSql()[stepOf('SELECT message_id::TEXT')];
      expect(readSql).toMatch(/ORDER BY tm\.message_id$/);
    });

    it('passes completedAt null when the channel is not completed', async () => {
      mockClient.query.mockImplementation(
        rebuildQueries({ status: 'running', import_completed_at: completedAt, batch_order: null }, null)
      );
      const plan = jest.fn().mockReturnValue({ order: 'audio_first', batches: [] });

      await dbService.rebuildOpenBatches('123', plan);

      expect(plan.mock.calls[0][0].completedAt).toBeNull();
    });

    it('starts from message 0 and learns the order when no frozen batch exists', async () => {
      mockClient.query.mockImplementation(
        rebuildQueries({ status: 'completed', import_completed_at: completedAt, batch_order: 'bogus' }, null)
      );
      const plan = jest.fn().mockReturnValue({ order: 'audio_first', batches: [] });

      const result = await dbService.rebuildOpenBatches('123', plan);

      expect(callOf('SELECT message_id::TEXT')[1]).toEqual(['123', '0']);
      expect(plan.mock.calls[0][0]).toMatchObject({ hasFrozenBatches: false, storedOrder: null });
      expect(clientSql().some((s) => s.startsWith('INSERT'))).toBe(false);
      expect(result).toEqual({ order: 'audio_first', batch_count: 0, open_count: 0 });
    });

    it('rolls back and rethrows when a query fails', async () => {
      mockClient.query.mockImplementation(async (sql: string) => {
        if (sql.trim().startsWith('SELECT message_id::TEXT')) throw new Error('read failed');
        return rebuildQueries({ status: 'completed', import_completed_at: completedAt, batch_order: null }, null)(sql);
      });

      await expect(dbService.rebuildOpenBatches('123', jest.fn())).rejects.toThrow('read failed');

      expect(clientSql()).toContain('ROLLBACK');
      expect(clientSql()).not.toContain('COMMIT');
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('replaceBatchMappings', () => {
    const now = new Date('2026-10-15T09:00:00.000Z');
    const lockSql = 'SELECT channel_id FROM telegram_channels WHERE channel_id = $1 FOR UPDATE';
    const batchSql = 'SELECT first_message_id::TEXT, last_message_id::TEXT FROM channel_batches WHERE channel_id = $1 AND batch_no = $2';
    const batch = { batch_no: 2, first_message_id: '41', last_message_id: '80' };
    const mappings = [{ text_message_id: '5', media_message_id: '50', source: 'manual' as const }];

    const batchQueries = (channel: boolean, range: object | null) => async (sql: string) => {
      const s = sql.trim();
      if (s === lockSql) return { rows: channel ? [{ channel_id: '123' }] : [] };
      if (s === batchSql) return { rows: range ? [range] : [] };
      if (s.startsWith('SELECT NOW()')) return { rows: [{ updated_at: now }] };
      return { rows: [] };
    };

    it('replaces only the batch range and freezes the batch', async () => {
      mockClient.query.mockImplementation(batchQueries(true, { first_message_id: '41', last_message_id: '80' }));

      const result = await dbService.replaceBatchMappings('123', batch, mappings);

      expect(result).toEqual({ status: 'ok', count: 1, updated_at: now });
      const sql = clientSql();
      expect(sql.slice(0, 4)).toEqual([
        'BEGIN',
        lockSql,
        batchSql,
        'DELETE FROM channel_mappings WHERE channel_id = $1 AND media_message_id BETWEEN $2 AND $3',
      ]);
      expect(mockClient.query.mock.calls[2][1]).toEqual(['123', 2]);
      expect(mockClient.query.mock.calls[3][1]).toEqual(['123', '41', '80']);
      expect(sql[4]).toContain('unnest($2::bigint[], $3::bigint[], $4::text[])');
      expect(sql[5]).toBe(
        "UPDATE channel_batches SET status = 'frozen', frozen_at = COALESCE(frozen_at, NOW()) WHERE channel_id = $1 AND batch_no = $2"
      );
      expect(sql[sql.length - 1]).toBe('COMMIT');
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('returns not_found for an untracked channel or a missing batch', async () => {
      mockClient.query.mockImplementation(batchQueries(false, null));
      await expect(dbService.replaceBatchMappings('123', batch, mappings)).resolves.toEqual({ status: 'not_found' });
      expect(clientSql()).toEqual(['BEGIN', lockSql, 'ROLLBACK']);

      mockClient.query.mockClear();
      mockClient.query.mockImplementation(batchQueries(true, null));
      await expect(dbService.replaceBatchMappings('123', batch, mappings)).resolves.toEqual({ status: 'not_found' });
      expect(clientSql()).toEqual(['BEGIN', lockSql, batchSql, 'ROLLBACK']);
    });

    it('returns conflict when the batch range changed', async () => {
      mockClient.query.mockImplementation(batchQueries(true, { first_message_id: '41', last_message_id: '90' }));

      await expect(dbService.replaceBatchMappings('123', batch, mappings)).resolves.toEqual({ status: 'conflict' });

      expect(clientSql()).toEqual(['BEGIN', lockSql, batchSql, 'ROLLBACK']);
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('getChannelMappings', () => {
    it('orders by the numeric audio message ID', async () => {
      await dbService.getChannelMappings('123');

      // The output column is media_message_id::TEXT; an unqualified ORDER BY would sort it as text.
      expect(String(mockPool.query.mock.calls[0][0])).toContain('ORDER BY cm.media_message_id ASC');
    });
  });

  describe('getChannelBatches', () => {
    it('reads the stored order and the batches with their dates and mapped audio count', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ batch_order: 'text_first' }] })
        .mockResolvedValueOnce({ rows: [{ batch_no: 1 }] });

      const result = await dbService.getChannelBatches('123');

      expect(result).toEqual({ order: 'text_first', batches: [{ batch_no: 1 }] });
      const batchSql = String(mockPool.query.mock.calls[1][0]);
      expect(batchSql).toContain('mapped_audio_count');
      expect(batchSql).toContain('BETWEEN b.first_message_id AND b.last_message_id');
      expect(batchSql).toContain('ORDER BY b.batch_no');
      expect(mockPool.query.mock.calls[1][1]).toEqual(['123']);
    });

    it('returns a null order when the stored value is not a known order', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ batch_order: null }] }).mockResolvedValueOnce({ rows: [] });

      await expect(dbService.getChannelBatches('123')).resolves.toEqual({ order: null, batches: [] });
    });
  });

  describe('getChannelBatch', () => {
    it('reads one batch by number, or null', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ batch_no: 2 }] }).mockResolvedValueOnce({ rows: [] });

      await expect(dbService.getChannelBatch('123', 2)).resolves.toEqual({ batch_no: 2 });
      await expect(dbService.getChannelBatch('123', 3)).resolves.toBeNull();
      expect(mockPool.query.mock.calls[0][1]).toEqual(['123', 2]);
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

    it('should include batch_count in getAllChannels and listChannels', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ total: 0 }] });

      await dbService.getAllChannels();
      await dbService.listChannels({ limit: 50, offset: 0 });

      const listSql = mockPool.query.mock.calls.map(([sql]) => String(sql)).filter((sql) => sql.includes('message_count'));
      expect(listSql).toHaveLength(2);
      listSql.forEach((sql) =>
        expect(sql).toContain('(SELECT COUNT(*) FROM channel_batches cb WHERE cb.channel_id = c.channel_id)::INTEGER as batch_count')
      );
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
      // Whitespace-only text is not text: the regex needs one non-whitespace character.
      expect(sql).toContain("COALESCE(telegram_json->>'text', '') ~ '\\S' AS has_text");
      expect(sql).not.toContain("<> '' AS has_text");
      expect(params).toEqual(['123456789', ['55', '67', '68']]);
    });
  });
});
