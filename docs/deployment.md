# Deployment and operations

## Branches

| Branch | Purpose |
|---|---|
| `main` | Development. `docker-compose.yml` includes local `postgres` and `minio` services. |
| `deploy` | Production. Same `src/`. Adds `.github/workflows/main.yml` and removes the local `postgres`/`minio` services, because production uses managed Postgres (with TLS) and external S3-compatible storage. |

Keep `src/` identical between the two; only infra files should differ.

## How production deploys

`.github/workflows/main.yml` (on `deploy` only) runs on every push to `deploy`:

```yaml
uses: appleboy/ssh-action@v1.2.2   # secrets: SERVER_HOST, SERVER_USER, SERVER_SSH_KEY
script: |
  cd /home/scraper-user/scraper
  git pull origin main
  docker compose up -d --build
```

Pushing to `deploy` is the trigger, but the server pulls **`main`** into whatever branch its checkout is on. In practice, what goes live is whatever is on `main` when you push to `deploy`. Check `git branch` on the server before relying on this; see [status.md](status.md#open-questions).

The `.env` the containers use lives on the server in `/home/scraper-user/scraper/.env` and isn't in git.

## Container

`Dockerfile`: a two-stage `node:20-alpine` build that compiles TypeScript to `dist/`, copies `public/`, pre-creates `temp/`, and runs `node dist/index.js` with `NODE_ENV=production` (JSON logs). It exposes port `3000`.

`docker-compose.yml` passes through every variable in the [configuration table](../README.md#configuration) and mounts the named volume `telegram_session` at `/app/session`, with `TELEGRAM_SESSION_FILE_PATH=/app/session/.session`.

```bash
docker compose up -d --build
docker compose logs -f app
docker compose restart app       # running channels resume from their checkpoint
```

## Telegram session

The container has no TTY, so it can't do the interactive first login. Make the session elsewhere and hand it over:

1. Locally, with `.env` pointing at a reachable database (schema setup runs before login), run `npm run start` and complete the phone, code and 2FA prompts. This writes `./.session`. You can stop the process once it logs `Connected to Telegram successfully.`
2. Copy the file's contents into the server's `.env`:
   ```bash
   TELEGRAM_SESSION=<contents of .session>
   ```
   When `TELEGRAM_SESSION` is set, it wins and the session file is never written.

The session belongs to a real Telegram account. Treat it like a password, and never commit `.session` (it's gitignored).

If Telegram revokes the session, the app crashes at boot with `Telegram authentication required: … non-interactive (headless) mode`. Generate a new one with the steps above.

## Storage prerequisites

- **Postgres** must accept TLS with a certificate that verifies (`ssl: { rejectUnauthorized: true }` is hardcoded in `src/index.ts`). Tables are created automatically on boot.
- **Bucket** must already exist. The app doesn't create it (`ensureBucketExists()` is commented out in `src/index.ts`).
- `S3_ENDPOINT` must include the protocol (`https://…`). For AWS S3 use the regional endpoint; for R2, use `https://<account>.r2.cloudflarestorage.com` with `S3_REGION=auto`.

## Routine operations

All of these are SQL against the production database. There are no API endpoints for them yet.

```sql
-- Re-run a failed channel (resumes from its checkpoint)
UPDATE telegram_channels SET status = 'pending' WHERE channel_id = <id>;

-- Pick up posts published since a channel completed
UPDATE telegram_channels SET status = 'pending' WHERE channel_id = <id>;

-- Messages whose media never reached S3 (not retried automatically)
SELECT channel_id, message_id FROM telegram_messages
WHERE media_key IS NULL AND telegram_json ? 'media';
```

To re-fetch media for those messages, move the channel's `last_processed_message_id` below the earliest affected `message_id` and set it back to `pending`. Already-stored media is skipped, so only the missing files are downloaded.

`DELETE /api/channels/:id` (or the dashboard's delete button) removes database rows only. Delete objects under `telegram/<channel_id>/` in the bucket separately if you need to.
