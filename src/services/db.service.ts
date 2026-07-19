import { Pool } from 'pg';
import { logger } from '../logger';

export type ChannelStatus = 'pending' | 'running' | 'completed' | 'failed';
export type ProcessingStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface ChannelProgress {
  channel_id: string;
  channel_username: string | null;
  title: string | null;
  import_started_at: Date | null;
  import_completed_at: Date | null;
  last_processed_message_id: string | null;
  status: ChannelStatus;
}

export interface ChannelProgressWithCount extends ChannelProgress {
  message_count: number;
}

export interface ChannelListOptions {
  status?: ChannelStatus;
  limit: number;
  offset: number;
}

export interface ChannelListResult {
  channels: ChannelProgressWithCount[];
  total: number;
}

export interface ProcessingChunk {
  id: string;
  channel_id: string;
  status: ProcessingStatus;
  start_time: Date;
  end_time: Date;
  message_count: number;
  created_at: Date;
}

export class DbService {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Initializes the PostgreSQL schema by creating tables and indexes if they do not exist.
   */
  async initializeSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      logger.info('Initializing PostgreSQL database schema...');
      await client.query('BEGIN');

      await client.query(`
        CREATE TABLE IF NOT EXISTS telegram_channels (
            channel_id BIGINT PRIMARY KEY,
            channel_username TEXT,
            title TEXT,
            import_started_at TIMESTAMP,
            import_completed_at TIMESTAMP,
            last_processed_message_id BIGINT,
            status TEXT
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS telegram_messages (
            id BIGSERIAL PRIMARY KEY,
            channel_id BIGINT NOT NULL,
            message_id BIGINT NOT NULL,
            message_date TIMESTAMP NOT NULL,
            telegram_json JSONB NOT NULL,
            media_key TEXT,
            imported_at TIMESTAMP NOT NULL DEFAULT NOW(),
            UNIQUE(channel_id, message_id)
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS processing_chunk (
            id TEXT PRIMARY KEY,
            channel_id BIGINT NOT NULL REFERENCES telegram_channels(channel_id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT 'pending',
            start_time TIMESTAMP NOT NULL,
            end_time TIMESTAMP NOT NULL,
            message_count INTEGER NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT NOW()
        );
      `);

      await client.query(`
        ALTER TABLE telegram_messages
        ADD COLUMN IF NOT EXISTS processing_chunk_id TEXT REFERENCES processing_chunk(id) ON DELETE SET NULL;
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_telegram_messages_channel_id_message_id 
        ON telegram_messages (channel_id, message_id);
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_processing_chunk_channel_id_created_at
        ON processing_chunk (channel_id, created_at DESC);
      `);

      await client.query('COMMIT');
      logger.info('Database schema initialized successfully.');
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to initialize database schema', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Upserts a channel to register it in our progress tracker.
   */
  async upsertChannel(
    channelId: string | number | bigint,
    username: string | null,
    title: string | null,
    status: ChannelStatus
  ): Promise<void> {
    const query = `
      INSERT INTO telegram_channels (channel_id, channel_username, title, status)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (channel_id) 
      DO UPDATE SET 
        channel_username = COALESCE($2, telegram_channels.channel_username),
        title = COALESCE($3, telegram_channels.title);
    `;
    await this.pool.query(query, [channelId.toString(), username, title, status]);
  }

  /**
   * Updates channel status.
   */
  async updateChannelStatus(
    channelId: string | number | bigint,
    status: ChannelStatus
  ): Promise<void> {
    let query = '';
    const now = new Date();

    if (status === 'running') {
      query = `
        UPDATE telegram_channels 
        SET status = $1, import_started_at = COALESCE(import_started_at, $2)
        WHERE channel_id = $3
      `;
      await this.pool.query(query, [status, now, channelId.toString()]);
    } else if (status === 'completed') {
      query = `
        UPDATE telegram_channels 
        SET status = $1, import_completed_at = $2
        WHERE channel_id = $3
      `;
      await this.pool.query(query, [status, now, channelId.toString()]);
    } else {
      query = `
        UPDATE telegram_channels 
        SET status = $1
        WHERE channel_id = $2
      `;
      await this.pool.query(query, [status, channelId.toString()]);
    }
  }

  /**
   * Updates progress of a channel during import.
   */
  async updateChannelProgress(
    channelId: string | number | bigint,
    lastProcessedId: string | number | bigint
  ): Promise<void> {
    const query = `
      UPDATE telegram_channels
      SET last_processed_message_id = $1
      WHERE channel_id = $2;
    `;
    await this.pool.query(query, [lastProcessedId.toString(), channelId.toString()]);
  }

  /**
   * Retrieves import progress metrics for a channel.
   */
  async getChannelProgress(channelId: string | number | bigint): Promise<ChannelProgress | null> {
    const query = `
      SELECT channel_id, channel_username, title, import_started_at, import_completed_at, last_processed_message_id, status
      FROM telegram_channels
      WHERE channel_id = $1;
    `;
    const res = await this.pool.query(query, [channelId.toString()]);
    if (res.rows.length === 0) return null;
    return res.rows[0];
  }

  /**
   * Tries to find a channel by username in tracking table.
   */
  async getChannelByUsername(username: string): Promise<ChannelProgress | null> {
    const query = `
      SELECT channel_id, channel_username, title, import_started_at, import_completed_at, last_processed_message_id, status
      FROM telegram_channels
      WHERE LOWER(channel_username) = LOWER($1);
    `;
    const res = await this.pool.query(query, [username]);
    if (res.rows.length === 0) return null;
    return res.rows[0];
  }

  /**
   * Checks if a message already has a media key in the database.
   */
  async getExistingMessageMediaKey(
    channelId: string | number | bigint,
    messageId: string | number | bigint
  ): Promise<string | null | undefined> {
    const query = `
      SELECT media_key 
      FROM telegram_messages
      WHERE channel_id = $1 AND message_id = $2;
    `;
    const res = await this.pool.query(query, [channelId.toString(), messageId.toString()]);
    if (res.rows.length === 0) return undefined; // Message doesn't exist
    return res.rows[0].media_key; // Might be null or a string
  }

  /**
   * Creates a processing chunk that groups a contiguous Telegram batch by time window.
   */
  async createProcessingChunk(
    chunkId: string,
    channelId: string | number | bigint,
    startTime: Date,
    endTime: Date,
    messageCount: number,
    status: ProcessingStatus = 'running'
  ): Promise<ProcessingChunk> {
    const query = `
      INSERT INTO processing_chunk (id, channel_id, start_time, end_time, message_count, status)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, channel_id::TEXT, status, start_time, end_time, message_count, created_at;
    `;
    const res = await this.pool.query(query, [
      chunkId,
      channelId.toString(),
      startTime,
      endTime,
      messageCount,
      status
    ]);
    return res.rows[0];
  }

  /**
   * Updates processing status for a previously created chunk.
   */
  async updateProcessingChunkStatus(
    chunkId: string,
    status: ProcessingStatus,
    messageCount?: number
  ): Promise<void> {
    const params: Array<string | number> = [status, chunkId];
    let countSql = '';
    if (messageCount !== undefined) {
      params.push(messageCount);
      countSql = `, message_count = $${params.length}`;
    }

    const query = `
      UPDATE processing_chunk
      SET status = $1${countSql}
      WHERE id = $2;
    `;
    await this.pool.query(query, params);
  }

  /**
   * Inserts or updates a telegram message details.
   */
  async upsertMessage(
    channelId: string | number | bigint,
    messageId: string | number | bigint,
    messageDate: Date,
    telegramJson: any,
    mediaKey: string | null,
    processingChunkId: string | null = null
  ): Promise<void> {
    const query = `
      INSERT INTO telegram_messages (channel_id, message_id, message_date, telegram_json, media_key, processing_chunk_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (channel_id, message_id)
      DO UPDATE SET
        message_date = EXCLUDED.message_date,
        telegram_json = EXCLUDED.telegram_json,
        media_key = COALESCE(telegram_messages.media_key, EXCLUDED.media_key),
        processing_chunk_id = COALESCE(telegram_messages.processing_chunk_id, EXCLUDED.processing_chunk_id);
    `;
    await this.pool.query(query, [
      channelId.toString(),
      messageId.toString(),
      messageDate,
      JSON.stringify(telegramJson),
      mediaKey,
      processingChunkId
    ]);
  }

  /**
   * Gets list of all tracked channels and their progress metrics.
   */
  async getAllChannels(): Promise<ChannelProgressWithCount[]> {
    const query = `
      SELECT 
        c.channel_id::TEXT, 
        c.channel_username, 
        c.title, 
        c.import_started_at, 
        c.import_completed_at, 
        c.last_processed_message_id::TEXT, 
        c.status,
        COALESCE(COUNT(m.id), 0)::INTEGER as message_count
      FROM telegram_channels c
      LEFT JOIN telegram_messages m ON c.channel_id = m.channel_id
      GROUP BY c.channel_id, c.channel_username, c.title, c.import_started_at, c.import_completed_at, c.last_processed_message_id, c.status
      ORDER BY c.import_started_at DESC NULLS LAST, c.channel_username ASC;
    `;
    const res = await this.pool.query(query);
    return res.rows;
  }

  /**
   * Lists tracked channels with optional filtering and pagination.
   */
  async listChannels(options: ChannelListOptions): Promise<ChannelListResult> {
    const whereClauses: string[] = [];
    const params: Array<string | number> = [];

    if (options.status) {
      params.push(options.status);
      whereClauses.push(`c.status = $${params.length}`);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countQuery = `
      SELECT COUNT(*)::INTEGER as total
      FROM telegram_channels c
      ${whereSql};
    `;
    const countRes = await this.pool.query(countQuery, params);

    const listParams = [...params, options.limit, options.offset];
    const limitPlaceholder = `$${listParams.length - 1}`;
    const offsetPlaceholder = `$${listParams.length}`;
    const listQuery = `
      SELECT
        c.channel_id::TEXT,
        c.channel_username,
        c.title,
        c.import_started_at,
        c.import_completed_at,
        c.last_processed_message_id::TEXT,
        c.status,
        COALESCE(COUNT(m.id), 0)::INTEGER as message_count
      FROM telegram_channels c
      LEFT JOIN telegram_messages m ON c.channel_id = m.channel_id
      ${whereSql}
      GROUP BY c.channel_id, c.channel_username, c.title, c.import_started_at, c.import_completed_at, c.last_processed_message_id, c.status
      ORDER BY c.import_started_at DESC NULLS LAST, c.channel_username ASC
      LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder};
    `;
    const listRes = await this.pool.query(listQuery, listParams);

    return {
      channels: listRes.rows,
      total: countRes.rows[0].total
    };
  }

  /**
   * Fetch total stats across the database.
   */
  async getGlobalStats(): Promise<{ total_messages: number; total_channels: number; active_imports: number }> {
    const query = `
      SELECT 
        (SELECT COUNT(*) FROM telegram_messages)::INTEGER as total_messages,
        (SELECT COUNT(*) FROM telegram_channels)::INTEGER as total_channels,
        (SELECT COUNT(*) FROM telegram_channels WHERE status = 'running')::INTEGER as active_imports;
    `;
    const res = await this.pool.query(query);
    return res.rows[0];
  }

  /**
   * Retrieves all messages for a specific channel.
   */
  async getChannelMessages(channelId: string | number | bigint): Promise<any[]> {
    const query = `
      SELECT id, channel_id::TEXT, message_id::TEXT, message_date, telegram_json, media_key, imported_at
      FROM telegram_messages
      WHERE channel_id = $1
      ORDER BY message_date DESC;
    `;
    const res = await this.pool.query(query, [channelId.toString()]);
    return res.rows;
  }

  /**
   * Deletes a channel and all its stored messages in a transaction.
   */
  async deleteChannel(channelId: string | number | bigint): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM telegram_messages WHERE channel_id = $1', [channelId.toString()]);
      await client.query('DELETE FROM processing_chunk WHERE channel_id = $1', [channelId.toString()]);
      await client.query('DELETE FROM telegram_channels WHERE channel_id = $1', [channelId.toString()]);
      await client.query('COMMIT');
      logger.info(`Deleted channel ${channelId} and its messages from database.`);
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Failed to delete channel ${channelId} from database`, error);
      throw error;
    } finally {
      client.release();
    }
  }
}
