import { Pool } from 'pg';
import { logger } from '../logger';

export interface ChannelProgress {
  channel_id: string;
  channel_username: string | null;
  title: string | null;
  import_started_at: Date | null;
  import_completed_at: Date | null;
  last_processed_message_id: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

export interface ChannelProgressWithCount extends ChannelProgress {
  message_count: number;
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
        CREATE INDEX IF NOT EXISTS idx_telegram_messages_channel_id_message_id 
        ON telegram_messages (channel_id, message_id);
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
    status: 'pending' | 'running' | 'completed' | 'failed'
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
    status: 'pending' | 'running' | 'completed' | 'failed'
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
   * Inserts or updates a telegram message details.
   */
  async upsertMessage(
    channelId: string | number | bigint,
    messageId: string | number | bigint,
    messageDate: Date,
    telegramJson: any,
    mediaKey: string | null
  ): Promise<void> {
    const query = `
      INSERT INTO telegram_messages (channel_id, message_id, message_date, telegram_json, media_key)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (channel_id, message_id)
      DO UPDATE SET
        message_date = EXCLUDED.message_date,
        telegram_json = EXCLUDED.telegram_json,
        media_key = COALESCE(telegram_messages.media_key, EXCLUDED.media_key);
    `;
    await this.pool.query(query, [
      channelId.toString(),
      messageId.toString(),
      messageDate,
      JSON.stringify(telegramJson),
      mediaKey
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
}
