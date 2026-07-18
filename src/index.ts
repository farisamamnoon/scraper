import { Pool } from 'pg';
import { S3Client } from '@aws-sdk/client-s3';
import { config } from './config';
import { logger } from './logger';
import { DbService } from './services/db.service';
import { S3Service } from './services/s3.service';
import { TelegramService } from './services/telegram.service';
import { Importer } from './importer';
import { createServer } from './server';

async function bootstrap() {
  logger.info('Starting Telegram Historical Importer Application...');

  const pgPool = new Pool({
    host: config.postgres.host,
    port: config.postgres.port,
    database: config.postgres.db,
    user: config.postgres.user,
    password: config.postgres.pass,
    ssl: { rejectUnauthorized: true },
    max: 10, // Max connection pool size
    idleTimeoutMillis: 30000,
  });

  pgPool.on('error', (err) => {
    logger.error('Unexpected error on idle PostgreSQL client:', err);
  });

  const dbService = new DbService(pgPool);

  // 2. Initialize S3 Storage Client
  const s3Client = new S3Client({
    endpoint: config.s3.endpoint,
    region: config.s3.region,
    credentials: {
      accessKeyId: config.s3.accessKey,
      secretAccessKey: config.s3.secretKey,
    },
  });

  const s3Service = new S3Service(s3Client, config.s3.bucket);

  // 3. Initialize Telegram Service Client
  const telegramService = new TelegramService(
    config.telegram.apiId,
    config.telegram.apiHash,
    config.telegram.session,
    config.telegram.sessionFilePath,
    config.telegram.proxy
  );

  // Initialize Importer Instance
  const importer = new Importer(
    dbService,
    s3Service,
    telegramService,
    config.importer.concurrency,
    {
      limitPerBatch: config.importer.limitPerBatch,
      bufferHours: config.importer.bufferHours
    }
  );

  let serverInstance: any;

  // Graceful shutdown helper
  const shutdown = async (signal: string) => {
    logger.warn(`Received ${signal}. Starting graceful shutdown...`);

    if (serverInstance) {
      serverInstance.close(() => {
        logger.info('HTTP server closed.');
      });
    }

    await importer.stop();
    await telegramService.disconnect();

    try {
      await pgPool.end();
      logger.info('PostgreSQL connection pool drained.');
    } catch (dbErr) {
      logger.error('Error during PostgreSQL pool shutdown:', dbErr);
    }

    logger.info('Graceful shutdown completed. Exiting.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    // 4. Initialize Database Schema
    await dbService.initializeSchema();

    // 5. Initialize S3 Bucket
    // await s3Service.ensureBucketExists();

    // 6. Connect to Telegram API
    await telegramService.connect();

    // 7. Reset active channels that were interrupted by a crash/restart
    await pgPool.query(`
      UPDATE telegram_channels 
      SET status = 'pending' 
      WHERE status = 'running';
    `);
    logger.info('Successfully reset any active running channel states back to pending.');


    // 9. Start background importer loop
    await importer.start();

    // 10. Start Express Server
    const app = createServer(dbService, importer, telegramService, s3Service, config.dashboardPassword);
    serverInstance = app.listen(config.server.port, () => {
      logger.info(`Web Dashboard API running on http://localhost:${config.server.port}`);
    });

  } catch (err) {
    logger.error('Uncaught exception during application boot:', err);
    process.exit(1);
  }
}

bootstrap();
