# Telegram Historical Importer

Copies the full message history of public Telegram channels into **PostgreSQL** (one cleaned JSONB row per message) and streams every photo and document to **S3-compatible storage**. A small password-protected dashboard lets you queue channels, watch progress, and browse what was imported.

It's Stage 1 of a four-stage pipeline that migrates audio lectures out of Telegram. It also stores the text↔audio mappings that Stage 2 produces. [docs/pipeline.md](docs/pipeline.md) explains the stages and which service owns each.

The mapper UI lives in [`salsabeel-workflow-frontend`](https://github.com/al-fikra-labs/salsabeel-workflow-frontend), checked out next to this repo as `../telegram-pipeline-ui`. For where the project stands, read [docs/status.md](docs/status.md) first.

**Stack:** Node 20 · TypeScript · [GramJS](https://gram.js.org) (MTProto) · `pg` · AWS SDK v3 · Express · Winston · Jest

## How it works

1. You register channel handles in the dashboard (or with `POST /api/channels`). Each one is resolved on Telegram and stored as `pending`.
2. A background loop picks up pending channels (`IMPORT_CONCURRENCY` at a time) and pages through history oldest to newest, 100 messages per batch.
3. For each message, attachments are downloaded to `temp/`, streamed to `telegram/<channel_id>/<message_id>/<filename>`, and deleted locally. The message is then upserted into `telegram_messages`.
4. A checkpoint is saved after every batch, so a restart resumes where it left off. Telegram rate limits (FloodWait) are waited out automatically.

Details: [docs/architecture.md](docs/architecture.md).

## Quick start

You need Node 20+, Telegram API credentials from [my.telegram.org](https://my.telegram.org) → *API development tools*, a PostgreSQL database that accepts TLS, and an existing S3-compatible bucket.

```bash
npm ci
cp .env.example .env        # fill in the values, see Configuration
npm run start               # first run: prompts for phone, login code and 2FA, then writes ./.session
```

Open http://localhost:3000, log in with `DASHBOARD_PASSWORD`, and add a channel handle.

> **The bundled `postgres` and `minio` containers don't work with the code on `main` yet.** The app requires TLS for Postgres and uses virtual-hosted S3 URLs that MinIO in Docker can't serve. Use managed services (or patch those two settings locally) until this is fixed. See [known issues](docs/status.md#known-issues).

Login needs an interactive terminal. Database setup runs before the Telegram login, so the database must be reachable even on the first run.

## Configuration

All configuration comes from environment variables (`.env` is loaded automatically).

| Variable | Required | Default | Notes |
|---|---|---|---|
| `TELEGRAM_API_ID` | ✓ | | Integer from my.telegram.org |
| `TELEGRAM_API_HASH` | ✓ | | |
| `TELEGRAM_SESSION` | | | Session string. Takes precedence over the session file and is required for headless/Docker runs |
| `TELEGRAM_SESSION_FILE_PATH` | | `./.session` | Where the session is read and saved |
| `TELEGRAM_PROXY_HOST` / `_PORT` | | | SOCKS5 proxy for Telegram; the port is required when the host is set |
| `TELEGRAM_PROXY_USERNAME` / `_PASSWORD` | | | |
| `TELEGRAM_OFFLINE` | | | `true` skips the Telegram login and the importer: an API-only server for testing. Registering channels fails |
| `POSTGRES_HOST`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | ✓ | | TLS with certificate verification is required |
| `POSTGRES_PORT` | | `5432` | |
| `S3_ENDPOINT` | ✓ | | Include the protocol, e.g. `https://<account>.r2.cloudflarestorage.com` |
| `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET` | ✓ | | The bucket must already exist |
| `DASHBOARD_PASSWORD` | ✓ | | Shared password for the dashboard and API |
| `IMPORT_CONCURRENCY` | | `1` | Channels imported in parallel. Keep it low to avoid FloodWaits |
| `PORT` | | `3000` | |
| `LOG_LEVEL` | | `info` | `debug` shows S3 keys and temp paths |
| `NODE_ENV` | | | `production` switches to JSON logs; `test` disables config parsing |

## Development

```bash
npm test            # Jest; every service is mocked, no network needed
npx tsc --noEmit    # typecheck
npm run build       # compile to dist/
```

One config test fails when there's no local `.env` ([known issue #4](docs/status.md#known-issues)).

```
src/
  index.ts                  bootstrap: builds and wires every service, boot order, shutdown
  config.ts                 env parsing and validation
  importer.ts               scheduler + per-channel import loop
  server.ts                 Express API, auth, static dashboard
  mappings.ts               PUT mappings body rules: ID parsing, limits, per-item problems
  logger.ts                 Winston
  services/
    telegram.service.ts     GramJS client, retry/FloodWait wrapper, media metadata
    db.service.ts           schema + queries
    s3.service.ts           streaming upload/download
public/                     dashboard (index.html) and login page, plain HTML/CSS/JS
tests/                      config, importer, server (supertest)
```

Conventions for contributors and Claude Code are in [`CLAUDE.md`](CLAUDE.md), with file-specific rules in [`.claude/rules/`](.claude/rules).

## Deployment

Production runs the Docker image from the `deploy` branch on a single server. A push to `deploy` triggers an SSH deploy. See [docs/deployment.md](docs/deployment.md) for that flow, how to get a Telegram session into a headless container, and common operations (retrying failed channels, finding media that never uploaded).

## Documentation

| Doc | Read it for |
|---|---|
| [docs/pipeline.md](docs/pipeline.md) | The four pipeline stages, who owns each, and the data other stages read from this service |
| [docs/status.md](docs/status.md) | Current checkpoint, known issues, open decisions |
| [docs/architecture.md](docs/architecture.md) | Components, import algorithm, data model, failure behavior |
| [docs/api.md](docs/api.md) | HTTP endpoints with request and response examples |
| [docs/deployment.md](docs/deployment.md) | Docker, production deploy, Telegram sessions, operations |
| [CLAUDE.md](CLAUDE.md) | Working rules for Claude Code |
