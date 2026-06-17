import { parseAndValidateConfig } from '../src/config';

describe('Configuration parsing and validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should successfully parse valid configuration variables', () => {
    process.env.TELEGRAM_API_ID = '123456';
    process.env.TELEGRAM_API_HASH = 'abcdef0123456789';
    process.env.POSTGRES_HOST = 'localhost';
    process.env.POSTGRES_PORT = '5432';
    process.env.POSTGRES_DB = 'telegram_db';
    process.env.POSTGRES_USER = 'postgres';
    process.env.POSTGRES_PASSWORD = 'password';
    process.env.S3_ENDPOINT = 'http://localhost:9000';
    process.env.S3_REGION = 'us-east-1';
    process.env.S3_ACCESS_KEY = 'minioadmin';
    process.env.S3_SECRET_KEY = 'minioadmin';
    process.env.S3_BUCKET = 'telegram-media';
    process.env.CHANNELS = 'durov, telegram';
    process.env.IMPORT_CONCURRENCY = '2';
    process.env.PORT = '8080';

    const parsed = parseAndValidateConfig();

    expect(parsed.telegram.apiId).toBe(123456);
    expect(parsed.telegram.apiHash).toBe('abcdef0123456789');
    expect(parsed.postgres.host).toBe('localhost');
    expect(parsed.postgres.port).toBe(5432);
    expect(parsed.postgres.db).toBe('telegram_db');
    expect(parsed.s3.bucket).toBe('telegram-media');
    expect(parsed.importer.channels).toEqual(['durov', 'telegram']);
    expect(parsed.importer.concurrency).toBe(2);
    expect(parsed.server.port).toBe(8080);
  });

  it('should fail if required variables are missing', () => {
    // Missing TELEGRAM_API_ID
    process.env.TELEGRAM_API_HASH = 'abcdef0123456789';
    process.env.POSTGRES_HOST = 'localhost';

    expect(() => parseAndValidateConfig()).toThrow(/Missing required configuration environment variables/);
  });

  it('should fail if TELEGRAM_API_ID is not a valid integer', () => {
    process.env.TELEGRAM_API_ID = 'not-an-integer';
    process.env.TELEGRAM_API_HASH = 'abcdef0123456789';
    process.env.POSTGRES_HOST = 'localhost';
    process.env.POSTGRES_DB = 'db';
    process.env.POSTGRES_USER = 'user';
    process.env.POSTGRES_PASSWORD = 'password';
    process.env.S3_ENDPOINT = 'endpoint';
    process.env.S3_REGION = 'region';
    process.env.S3_ACCESS_KEY = 'key';
    process.env.S3_SECRET_KEY = 'secret';
    process.env.S3_BUCKET = 'bucket';
    process.env.CHANNELS = 'durov';

    expect(() => parseAndValidateConfig()).toThrow(/TELEGRAM_API_ID must be a valid integer/);
  });

  it('should use default values for optional variables', () => {
    process.env.TELEGRAM_API_ID = '123456';
    process.env.TELEGRAM_API_HASH = 'abcdef0123456789';
    process.env.POSTGRES_HOST = 'localhost';
    process.env.POSTGRES_DB = 'db';
    process.env.POSTGRES_USER = 'user';
    process.env.POSTGRES_PASSWORD = 'password';
    process.env.S3_ENDPOINT = 'endpoint';
    process.env.S3_REGION = 'region';
    process.env.S3_ACCESS_KEY = 'key';
    process.env.S3_SECRET_KEY = 'secret';
    process.env.S3_BUCKET = 'bucket';
    process.env.CHANNELS = 'durov';
    
    // Explicitly delete optional variables
    delete process.env.POSTGRES_PORT;
    delete process.env.IMPORT_CONCURRENCY;
    delete process.env.PORT;

    const parsed = parseAndValidateConfig();
    expect(parsed.postgres.port).toBe(5432);
    expect(parsed.importer.concurrency).toBe(1);
    expect(parsed.server.port).toBe(3000);
  });
});
