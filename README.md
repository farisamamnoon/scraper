# Telegram Historical Importer & Archiver

A production-ready Node.js TypeScript application designed to perform historical imports of Telegram public channels' message archives. Messages are cleaned, normalized, and stored in **PostgreSQL** (JSONB), and all media attachments are streamed directly to **S3-compatible object storage** (such as MinIO, AWS S3, Cloudflare R2, or Backblaze B2). 

The application features a gorgeous glassmorphic web dashboard to monitor import progress, display global ingestion statistics, and dynamically register new channels.

---

## Technical Stack
- **Core**: Node.js & TypeScript
- **Telegram Client**: GramJS (MTProto client)
- **Database**: PostgreSQL (using native `pg` client pool)
- **Storage**: AWS SDK S3 v3 with multipart streaming upload (`@aws-sdk/lib-storage`)
- **Dashboard Interface**: Glassmorphic HTML, CSS, and Vanilla JavaScript
- **Testing**: Jest with `ts-jest` and `supertest`

---

## Directory Structure
```text
.
├── package.json
├── tsconfig.json
├── jest.config.js
├── Dockerfile
├── docker-compose.yml
├── schema.sql
├── README.md
├── .env.example
├── public/
│   └── index.html            # Web dashboard page
├── src/
│   ├── index.ts              # System bootstrapper and lifecycle manager
│   ├── config.ts             # Configuration parser and strict validator
│   ├── importer.ts           # Sequential/concurrent import worker coordinator
│   ├── server.ts             # Express REST API server
│   ├── logger.ts             # Winston structured logger setup
│   └── services/
│       ├── db.service.ts     # Postgres transaction client
│       ├── s3.service.ts     # S3 bucket manager and upload stream helper
│       └── telegram.service.ts # GramJS wrapper, media parser, and FloodWait controller
└── tests/
    ├── config.test.ts        # Config validation unit tests
    ├── importer.test.ts      # Data extraction & normalization unit tests
    └── server.test.ts        # Express routing and API unit tests
```

---

## 1. Setup Instructions

### Get Telegram API Credentials
1. Go to [my.telegram.org](https://my.telegram.org) and log in.
2. Navigate to **API development tools**.
3. Create a new application (if you don't have one) to retrieve your `api_id` (integer) and `api_hash` (string).

### Configuration Setup
Copy the configuration template:
```bash
cp .env.example .env
```
Open `.env` and fill in:
- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`
- `CHANNELS` (comma-separated list of usernames to ingest on startup, e.g. `durov,telegram`)

---

## 2. Execution Instructions

### Option A: Local Run (Recommended for First Run / Auth)
Since Telegram requires interactive login (SMS/Telegram code) on its first run, it is easiest to run the initial connection locally to generate the session file.

1. **Install Dependencies**:
   ```bash
   npm install
   ```
2. **Launch Postgres & MinIO (Dockerized)**:
   ```bash
   docker-compose up -d postgres minio
   ```
3. **Execute Importer in Terminal**:
   ```bash
   npm run start
   ```
4. **Interactive Login**:
   Follow the terminal prompt to enter your phone number, password (if 2FA is active), and verification code.
   Once logged in, a local `.session` file is saved to your root directory. The scraper and dashboard will boot immediately.
5. **Access Dashboard**:
   Open [http://localhost:3000](http://localhost:3000) in your browser.

---

### Option B: Docker Compose Setup (Production Ready)
Once you have generated a session string or have the `.session` file, you can run the entire system headless.

1. Create a `session` directory:
   ```bash
   mkdir -p session
   ```
2. If you already ran the script locally, copy the `.session` file into it:
   ```bash
   cp .session session/
   ```
3. Build and launch the container stack:
   ```bash
   docker-compose up -d --build
   ```
4. Monitor logs:
   ```bash
   docker-compose logs -f app
   ```

---

## 3. Recovery & Resume Behavior

### Robustness & Restart-Safety
The application is engineered to handle failures, crashes, and network terminations safely:
1. **Crash Recovery**: If the scraper crashes, restarting the application will query PostgreSQL for any channels with a status of `running` and reset them to `pending`. They are immediately queued to be picked up by the worker thread.
2. **Resumable Ingestion**: When processing a channel, the worker loads its `last_processed_message_id`. The Telegram query fetches new messages starting *from* this ID (chronologically oldest-to-newest, where `id > last_processed_message_id`).
3. **Idempotence / UPSERT**: Database writes use `INSERT ... ON CONFLICT (channel_id, message_id) DO UPDATE`. Rerunning an import will never create duplicate message rows.
4. **Media Check**: Before downloading files from Telegram and uploading to S3, the scraper performs a lookup. If the message exists in PostgreSQL and already has a `media_key` assigned, the download/upload is skipped. This prevents unnecessary network usage and duplicates in S3 storage.
5. **File Cleanup**: Downloads from Telegram are written directly to disk in chunks to keep memory usage constant. Once uploaded to S3, the temporary file is unlinked immediately in a `finally` block, ensuring no disk bloat.

### Telegram FloodWait Handling
Telegram imposes rate limits on aggressive pagination and media downloading.
- If a `FloodWaitError` occurs, the application extracts the wait duration from the API error message.
- The thread logs the occurrence showing the required sleep period.
- The worker sleeps for the exact duration and automatically resumes imports once the rate limit clears.
- The channel is **not** marked as failed during a FloodWait pause.

---

## 4. Ingestion Data Structure
The application processes messages and extracts a clean, non-circular, database-friendly payload for PostgreSQL's `JSONB` column, keeping searches and AI processing extremely fast.

### Database Row Example
- `channel_id`: `123456789`
- `message_id`: `4567`
- `message_date`: `2026-06-17 08:00:00`
- `media_key`: `telegram/123456789/4567/audio.ogg`
- `telegram_json`:
```json
{
  "message_id": 4567,
  "channel_id": "123456789",
  "date": "2026-06-17T08:00:00.000Z",
  "text": "Hello world, check out this audio track!",
  "views": 2500,
  "forwards": 32,
  "edit_date": null,
  "reply_to": null,
  "media": {
    "media_type": "audio",
    "file_name": "audio.ogg",
    "mime_type": "audio/ogg",
    "file_size": 1024567
  }
}
```

---

## 5. Development & Running Tests
To run unit tests in isolation (no Postgres/MinIO needed):
```bash
npm run test
```
The test suite utilizes Jest mocks to ensure parser reliability, configuration constraints, and Express route validation.
