# AGENTS.md — Telegram Historical Importer

> Rules for AI agents working in this codebase. Generated from static analysis of the actual source code.
> **Do not violate these rules without an explicit user instruction to do so.**

---

## Project Overview

This is a **Node.js + TypeScript** application that:
- Connects to Telegram via GramJS (MTProto) to scrape public channel message history
- Stores cleaned message JSON in **PostgreSQL** (JSONB column)
- Streams media attachments to **S3-compatible object storage** (MinIO/AWS S3/Cloudflare R2)
- Serves a web dashboard via **Express** for monitoring and registering new channels
- Runs as a long-lived background process with graceful shutdown

**Stack:** TypeScript · GramJS · pg (native pool) · AWS SDK v3 · Express · Winston · Jest + supertest

---

## Core Architectural Rules

### 1. Service Injection via Constructor — Never Import Directly

All services are **instantiated once** in `src/index.ts` (the bootstrapper) and **injected via constructor** wherever they are needed. Consumers (`Importer`, `server.ts`) must never `import` and self-construct a service.

```
// ✅ CORRECT — receive service as constructor param
class Importer {
  constructor(dbService: DbService, s3Service: S3Service, telegramService: TelegramService, concurrency: number) { ... }
}

// ❌ WRONG — self-constructing in a consumer
import { DbService } from './services/db.service';
const db = new DbService(new Pool(...)); // Don't do this outside index.ts
```

**Files:** `src/index.ts`, `src/importer.ts`, `src/server.ts`

---

### 2. All Telegram API Calls Must Go Through `executeWithRetry()`

**Never** call `this.client.*` directly. All Telegram API calls must be wrapped in `this.executeWithRetry(async (client) => { ... }, label)`.

- **FloodWait errors** → sleep for the exact seconds specified in the error, then retry infinitely
- **Transient network errors** → retry up to 5 times with exponential backoff: `2^attempt × 1000ms`
- Always provide a meaningful `label` string for logs

```typescript
// ✅ CORRECT
return await this.executeWithRetry(
  async (client) => client.getMessages(entity, { minId, limit: 100, reverse: true }),
  `fetch messages batch for channel ${title}`
);

// ❌ WRONG
return await this.client!.getMessages(entity, { minId, limit: 100, reverse: true });
```

**File:** `src/services/telegram.service.ts`

---

### 3. Idempotent UPSERT with `COALESCE` — Never Overwrite a Valid `media_key`

All database writes for messages use `INSERT ... ON CONFLICT (channel_id, message_id) DO UPDATE`. The `media_key` column uses `COALESCE(existing, excluded)` to ensure a non-null media key is **never overwritten** by a null value from a retry.

```sql
-- ✅ CORRECT — preserves existing media_key
ON CONFLICT (channel_id, message_id)
DO UPDATE SET
  message_date = EXCLUDED.message_date,
  telegram_json = EXCLUDED.telegram_json,
  media_key = COALESCE(telegram_messages.media_key, EXCLUDED.media_key);
```

Before downloading any media, always call `dbService.getExistingMessageMediaKey()` first. If it returns a non-null string, skip the download entirely.

**File:** `src/services/db.service.ts`, `src/importer.ts`

---

### 4. Temp File Cleanup in `finally` Block — No Exceptions

Downloaded Telegram media files are written to `temp/` on disk before streaming to S3. The temp file **must always be deleted** in a `finally` block — even if the S3 upload fails.

```typescript
// ✅ CORRECT pattern
try {
  await telegramService.downloadMediaToFile(msg, tempFilePath);
  await s3Service.uploadStream(s3Key, fs.createReadStream(tempFilePath), mimeType);
  return s3Key;
} catch (err) {
  logger.error(`...`, err);
  return null;
} finally {
  // Always clean up temp file
  if (fs.existsSync(tempFilePath)) {
    await fs.promises.unlink(tempFilePath);
  }
}
```

Temp file path pattern: `temp/temp_<channelId>_<messageId>_<filename>`

**File:** `src/importer.ts` — `downloadAndUploadMedia()`

---

### 5. S3 Media Key Convention: `telegram/{channelId}/{messageId}/{filename}`

All media objects stored in S3 **must** follow this exact key format:

```
telegram/<channel_id>/<message_id>/<original_filename>
```

Examples:
- `telegram/123456789/4567/audio.ogg`
- `telegram/123456789/4568/photo_4568.jpg`
- `telegram/123456789/4569/document_4569.pdf`

This key is stored verbatim in the `media_key` column and used by `/api/media?key=<media_key>` to proxy files.

**File:** `src/importer.ts` — `downloadAndUploadMedia()`

---

### 6. Environment-Aware Config + Test Isolation Guard

Config is parsed **only** when `NODE_ENV !== 'test'`. In tests, **all services must be mocked** via `jest.fn()`. Tests must never import `config` directly or make real network calls.

```typescript
// src/config.ts — existing pattern, do not change
export const config = process.env.NODE_ENV !== 'test' ? parseAndValidateConfig() : {} as Config;

// ✅ CORRECT test setup
const mockDbService = {
  upsertMessage: jest.fn(),
  getExistingMessageMediaKey: jest.fn(),
} as unknown as jest.Mocked<DbService>;
```

Run tests with: `npm run test`

**Files:** `src/config.ts`, `tests/*.test.ts`

---

## Development Workflow

### Running Locally (First Run / Interactive Auth)
```bash
cp .env.example .env          # fill in credentials
docker-compose up -d postgres minio
npm run start                 # interactive Telegram auth on first run
open http://localhost:3000    # dashboard
```

### Running in Docker (After Session Auth)
```bash
docker-compose up -d --build
docker-compose logs -f app
```

### Tests (No external services needed)
```bash
npm run test
```

---

## Common Gotchas

- **BigInt IDs:** Telegram channel/message IDs are BigInt. Always call `.toString()` before storing or comparing. Never use `Number()` on a BigInt Telegram ID — precision is lost.
- **Session File:** `.session` is in `.gitignore`. In Docker it is mounted at `/app/session/.session`. Always use `config.telegram.sessionFilePath`, never hardcode the path.
- **Non-TTY Error:** If Telegram auth is required in a headless environment, the app throws an intentional error. This is by design — run locally first to generate the session file.
- **Channel Status Reset on Boot:** Any channel with `status = 'running'` is reset to `'pending'` on startup (crash recovery). Never rely on `running` persisting across restarts.
- **Concurrency:** `IMPORT_CONCURRENCY` controls parallel channel imports (default: 1). The `Importer` uses an in-memory `runningChannels: Set<string>` to prevent duplicate processing.
- **S3 endpoint must include protocol:** `http://minio:9000` — not just `minio:9000`.
- **Schema is auto-initialized:** `DbService.initializeSchema()` is called on every boot with `IF NOT EXISTS` — it is safe and idempotent.

---

## Extending the Project

### New Service
1. Create `src/services/<name>.service.ts` with a class
2. Instantiate in `src/index.ts`
3. Inject via constructor; never self-construct in consumers
4. Add mock in relevant test files

### New API Endpoint
1. Add route in `src/server.ts` inside `createServer()`
2. Use `try/catch/next(err)` pattern — errors propagate to the global error handler
3. Add supertest coverage in `tests/server.test.ts`

### New DB Column or Table
1. Add DDL inside `DbService.initializeSchema()` using `IF NOT EXISTS`
2. Add a typed method to `DbService` with JSDoc
3. Update `ChannelProgress` interface or add a new typed interface

### Logging Convention
All files import `logger` from `../logger` (or `./logger`). Log levels:
- `logger.info` — normal lifecycle events
- `logger.warn` — recoverable issues (FloodWait, retries, resets)
- `logger.error` — failures (always pass error object as 2nd argument)
- `logger.debug` — verbose internals (S3 keys, temp paths, batch IDs)
