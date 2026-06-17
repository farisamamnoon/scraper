import dotenv from 'dotenv';
import path from 'path';

// Load env variables
dotenv.config();

export interface Config {
  telegram: {
    apiId: number;
    apiHash: string;
    session?: string;
    sessionFilePath?: string;
  };
  postgres: {
    host: string;
    port: number;
    db: string;
    user: string;
    pass: string;
  };
  s3: {
    endpoint: string;
    region: string;
    accessKey: string;
    secretKey: string;
    bucket: string;
  };
  importer: {
    channels: string[];
    concurrency: number;
  };
  server: {
    port: number;
  };
}

export function parseAndValidateConfig(): Config {
  const missingVars: string[] = [];

  const getRequired = (key: string): string => {
    const val = process.env[key];
    if (!val) {
      missingVars.push(key);
      return '';
    }
    return val;
  };

  const getOptional = (key: string, fallback: string): string => {
    return process.env[key] || fallback;
  };

  const telegramApiIdStr = getRequired('TELEGRAM_API_ID');
  const telegramApiHash = getRequired('TELEGRAM_API_HASH');
  const sessionFilePath = getOptional('TELEGRAM_SESSION_FILE_PATH', path.join(process.cwd(), '.session'));

  const pgHost = getRequired('POSTGRES_HOST');
  const pgPortStr = getOptional('POSTGRES_PORT', '5432');
  const pgDb = getRequired('POSTGRES_DB');
  const pgUser = getRequired('POSTGRES_USER');
  const pgPass = getRequired('POSTGRES_PASSWORD');

  const s3Endpoint = getRequired('S3_ENDPOINT');
  const s3Region = getRequired('S3_REGION');
  const s3AccessKey = getRequired('S3_ACCESS_KEY');
  const s3SecretKey = getRequired('S3_SECRET_KEY');
  const s3Bucket = getRequired('S3_BUCKET');

  const channelsStr = getOptional('CHANNELS', '');
  const concurrencyStr = getOptional('IMPORT_CONCURRENCY', '1');
  const portStr = getOptional('PORT', '3000');

  if (missingVars.length > 0) {
    throw new Error(`Missing required configuration environment variables: ${missingVars.join(', ')}`);
  }

  const apiId = parseInt(telegramApiIdStr, 10);
  if (isNaN(apiId)) {
    throw new Error(`TELEGRAM_API_ID must be a valid integer, got "${telegramApiIdStr}"`);
  }

  const pgPort = parseInt(pgPortStr, 10);
  if (isNaN(pgPort)) {
    throw new Error(`POSTGRES_PORT must be a valid integer, got "${pgPortStr}"`);
  }

  const concurrency = parseInt(concurrencyStr, 10);
  if (isNaN(concurrency) || concurrency < 1) {
    throw new Error(`IMPORT_CONCURRENCY must be a positive integer, got "${concurrencyStr}"`);
  }

  const port = parseInt(portStr, 10);
  if (isNaN(port)) {
    throw new Error(`PORT must be a valid integer, got "${portStr}"`);
  }

  const channels = channelsStr
    .split(',')
    .map(c => c.trim())
    .filter(c => c.length > 0);

  return {
    telegram: {
      apiId,
      apiHash: telegramApiHash,
      session: process.env.TELEGRAM_SESSION,
      sessionFilePath
    },
    postgres: {
      host: pgHost,
      port: pgPort,
      db: pgDb,
      user: pgUser,
      pass: pgPass
    },
    s3: {
      endpoint: s3Endpoint,
      region: s3Region,
      accessKey: s3AccessKey,
      secretKey: s3SecretKey,
      bucket: s3Bucket
    },
    importer: {
      channels,
      concurrency
    },
    server: {
      port
    }
  };
}

export const config = process.env.NODE_ENV !== 'test' ? parseAndValidateConfig() : {} as Config;
