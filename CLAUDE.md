# CLAUDE.md

Telegram historical importer: a long-running Node/TypeScript process that copies the full message history of public Telegram channels into PostgreSQL (cleaned JSONB) and streams media attachments to S3-compatible storage. An Express server on the same process serves a password-protected dashboard and REST API for registering channels and watching progress.

It is Stage 1 (export) of a four-stage migration pipeline and also stores Stage 2's text↔audio mappings. Stage 3 (LLM text processing) is not built, and Stage 4 (database delivery) is a separate service. Read `docs/pipeline.md` before changing anything another stage reads: `telegram_json`, S3 keys, `channel_mappings`, or the `/api/*` shapes.

The mapper UI is the sibling checkout `../telegram-pipeline-ui` (GitHub: `al-fikra-labs/salsabeel-workflow-frontend`, with its own `CLAUDE.md`). See `docs/status.md` for where the project stands and what is unresolved.

## Commands

```bash
npm ci                 # install
npm run start          # run from source with ts-node (interactive Telegram login on first run)
npm run build          # tsc -> dist/
npx tsc --noEmit       # typecheck src/ (tests are typechecked by ts-jest)
npm test               # jest, all services mocked, no network
npx jest tests/server.test.ts -t "DELETE"   # single file / test name
```

`npm test` has one known failure in a clean checkout without a `.env` (see `docs/status.md`). Don't treat it as a regression you caused.

## Code map

| File | Role |
|---|---|
| `src/index.ts` | Bootstrapper. The only place services are constructed. Boot order: schema → Telegram connect → reset `running`→`pending` → importer loop → HTTP server. Owns SIGINT/SIGTERM shutdown. |
| `src/config.ts` | Parses and validates env vars into a typed `Config`. Returns `{}` when `NODE_ENV=test`. |
| `src/importer.ts` | Scheduler (5s tick, `IMPORT_CONCURRENCY` slots) and per-channel import loop: 100-message batches oldest→newest, media to S3, message upsert, progress checkpoint per batch. |
| `src/server.ts` | `createServer(...)`: cookie auth, static `public/`, all `/api/*` routes, global error handler. |
| `src/mappings.ts` | Pure request rules for `PUT …/mappings`: `parseTelegramId`, `parseMappingsBody`, item and body-size limits. |
| `src/services/telegram.service.ts` | GramJS client, session handling, `executeWithRetry`, media metadata/filename derivation, media download. |
| `src/services/db.service.ts` | `pg` pool wrapper. Schema DDL (`initializeSchema`), channel/message queries. |
| `src/services/s3.service.ts` | Multipart streaming upload, object read stream, `ensureBucketExists` (currently not called). |
| `src/logger.ts` | Winston. JSON in production, colorized otherwise, silent in tests. `LOG_LEVEL` env. |
| `public/index.html` | Single-file vanilla dashboard (inline CSS/JS). `public/login.html` is the password page. |
| `tests/` | `config`, `importer` (`extractCleanJson`), `server` (supertest), `db.service` (mocked pg pool) suites. |

Deeper explanations: `docs/architecture.md` (data flow, schema, recovery), `docs/api.md` (endpoints), `docs/deployment.md` (Docker, `deploy` branch, sessions).

## Invariants

These hold across the codebase; break one only when the user explicitly asks.

1. **Construct services only in `src/index.ts`** and pass them in through constructors or `createServer` arguments. Consumers never `new` a service, which is what lets tests inject mocks.
2. **Every Telegram call goes through `telegramService.executeWithRetry(fn, label)`.** Never touch the GramJS client directly.
3. **Message writes are idempotent upserts** on `(channel_id, message_id)`, and an existing non-null `media_key` is never overwritten.
4. **Media temp files are deleted in a `finally`**, whether the upload succeeds or fails.
5. **S3 keys are `telegram/<channel_id>/<message_id>/<filename>`.** Stored keys and `/api/media` depend on it.
6. **Telegram IDs are BigInt.** `.toString()` them before storing or comparing. Never `Number()` a channel ID.
7. **Schema changes go in `DbService.initializeSchema()`** as `IF NOT EXISTS` DDL. It runs on every boot; there is no migration tool.

Path-scoped details load automatically from `.claude/rules/` when you touch the relevant files: the importer/services rules, test conventions, and the dashboard design system.

## Conventions

- New service: `src/services/<name>.service.ts` class → construct in `index.ts` → inject → add a `jest.fn()` mock in the tests that need it.
- New endpoint: add inside `createServer()`, protect with `apiAuthMiddleware`, wrap the handler body in `try { … } catch (err) { next(err) }`, validate input with `express-validator` + `handleValidationErrors`, respond `{ success, … }`, add supertest coverage in `tests/server.test.ts`.
  - Exception: the body of `PUT /api/channels/:channelId/mappings` is checked by hand in `parseMappingsBody` (`src/mappings.ts`). The check is all-or-nothing over up to 50,000 items, reports per-item `details`, and ends in one set-based DB lookup, which `express-validator` chains don't fit. Its `:channelId` param still uses `express-validator`. Don't copy this for other endpoints.
- New DB query: typed `DbService` method with a JSDoc line. Update `ChannelProgress` or add an interface for new shapes.
- Logging: `logger.info` lifecycle, `logger.warn` recoverable (FloodWait, retries, resets), `logger.error(msg, err)` with the error as the second argument, `logger.debug` internals (keys, temp paths).
- Errors inside a message loop are logged and the loop continues; errors that abort a channel mark it `failed`.

## Gotchas

- **A fully local stack won't run as-is.** `src/index.ts` forces Postgres `ssl: { rejectUnauthorized: true }`, and the `postgres` container has no TLS. The `S3Client` has no `forcePathStyle`, so requests go to `<bucket>.minio:9000`, which MinIO can't serve. Production (managed Postgres, R2/S3) is fine. Don't "fix" either setting in place without making it configurable, because production depends on the current values.
- **The S3 bucket must already exist.** The `ensureBucketExists()` call is commented out. A missing bucket makes every upload fail, and those messages are stored with `media_key = NULL`.
- **Telegram login needs a TTY.** The first run must be interactive (`npm run start`). Headless runs need an existing session (`TELEGRAM_SESSION` or the session file) and throw deliberately otherwise.
- **`running` doesn't survive restarts.** Boot resets it to `pending`, and the in-memory `runningChannels` set is what actually prevents double processing.
- **`completed` is terminal.** Completed channels are never re-polled for new posts.
- **The S3 endpoint needs a protocol** (`http://minio:9000`).
- **Branches:** `main` is development. `deploy` is the production branch: it adds the SSH deploy workflow and drops the local postgres/minio services. Its `src/` matches `main`. See `docs/deployment.md`.

## Working in this repo

- Before UI work, the dashboard rules in `.claude/rules/dashboard-*.md` apply. They encode explicit user rejections (no indigo/purple gradients, no glassmorphism, IBM Plex fonts, no full `innerHTML` rebuild on poll).
- Keep `docs/` current when behavior changes. `docs/status.md` is the running checkpoint: update its known-issues list when you fix or find one.
