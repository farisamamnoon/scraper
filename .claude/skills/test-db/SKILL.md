---
name: test-db
description: Use when checking a scraper change end to end on real data (mappings, batches, channel and message endpoints), when a session needs a running scraper API without Telegram, or when the user asks to refresh the test snapshot.
---

# Test DB

`scripts/test-db.sh` keeps a snapshot of the real local data (92 channels, ~86k messages, batches) in a Postgres container (`scraper-test-pg`, TLS, `127.0.0.1:5433`) and serves it with this checkout's scraper in offline mode (`TELEGRAM_OFFLINE=true`: no Telegram login, no importer). Each session clones the snapshot into its own DB, so its writes never reach another session. `bash scripts/test-db.sh help` lists every command.

For a browser test of the mapper UI, follow `../telegram-pipeline-ui/.claude/skills/ui-browser-testing/SKILL.md` instead; it starts the API and the UI together.

Works: every route that reads or writes the database (progress, channels, messages, batches and rebuilds, mappings, delete), and `/api/media` with real files from R2. Fails by design: `POST /api/channels` (needs Telegram).

## Steps

Shell variables do not persist between Bash calls. Start every Bash call with these lines, with the same short `[a-z0-9_]` topic for the whole session:

```bash
export TEST_DB_NAME=telegram_test_<topic>
S=/home/yasir/projects/telegram-pipeline/scraper/scripts/test-db.sh; E=$($S env)
B=$(sed -n 's/^PIPELINE_API_URL=//p' <<<"$E"); P=$(sed -n 's/^PIPELINE_DASHBOARD_PASSWORD=//p' <<<"$E")
C=$(sed -n 's/^SCRATCH=//p' <<<"$E")/cookies; Q() { docker exec scraper-test-pg psql -U postgres -d "$TEST_DB_NAME" -Atc "$1"; }
```

1. `$S serve`. Done when it prints `API ready` and the env lines (the API port comes from the DB name).
2. Log in once, then test with the cookie file:
   ```bash
   curl -s -c $C -H 'Content-Type: application/json' -d "{\"password\":\"$P\"}" "$B/api/auth/login"
   curl -s -b $C "$B/api/channels/1438886321/batches"
   ```
   Query your data with `Q "<sql>"` (tables and rules under Reference).
3. Between tests that write, `$S reset` (about 3 s) restores your DB to the snapshot. After a change in `src/`, `$S stop` then `$S serve` loads the new code.
4. Done testing: `$S drop`. It stops your API and deletes your DB, its log and the scratch folder that holds `$C`. Leave the container running.

## Reference

- **Tables:** `telegram_channels` (`channel_id`, `channel_username`, `title`, `status`), `telegram_messages` (`channel_id`, `message_id`, `message_date`, `telegram_json`, `media_key`), `channel_batches` (`channel_id`, `batch_no`, `first_message_id`, `last_message_id`, `status`), `channel_mappings` (`channel_id`, `text_message_id`, `media_message_id`, `source`). Full DDL: `initializeSchema()` in `src/services/db.service.ts`.
- **Channel ID from a handle:** `Q "select channel_id from telegram_channels where channel_username='<handle>'"`. Channels with batches: `tholobulilm` 1438886321 (547), `SalafiDawaKsd` 1347922533 (17), `UsoolThalathaByNiyaf` 1383125019 (1); the other 89 have none until `POST …/batches`.
- **Audio** (the rule the API uses, `IS_AUDIO_SQL`): `telegram_json->'media'->>'media_type' in ('audio','voice') or telegram_json->'media'->>'mime_type' like 'audio/%'`. **Text:** `coalesce(telegram_json->>'text','') ~ '\S'`.

- **Code under test** is the checkout that holds the script. For a worktree branch, run that worktree's `scripts/test-db.sh` (needs `npm ci` once; uses the main checkout's `.env`).
- **Schema changes:** `serve` runs `initializeSchema()`, so new `IF NOT EXISTS` DDL reaches your DB at boot. `reset` removes it until the next boot.
- **Snapshot refresh** (only on request): `snapshot` dumps the developer's dev DB in `scraper-local-pg`; `snapshot <file.dump>` takes a `pg_dump -Fc` file. It replaces the shared template; other clones keep their data until their next `reset`.
- **Data location:** `~/.local/share/telegram-scraper/test-db/` (outside git). The snapshot is real channel data: keep its contents out of commits and issues.
- **Port 3000** is the developer's own scraper on the real dev data, and the UI's `yarn dev` is on 3001. Test only against your own port.
