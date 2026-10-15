# Project status

Checkpoint taken **2026-10-04**, after roughly 2.5 months without commits. Development is moving to Claude Code. Update this page as items are resolved; it's the first thing to read when picking the project back up.

## Where the code stands

| Ref | Commit | Date | State |
|---|---|---|---|
| `main` | `780861a` | 2026-07-20 | Revert of PR #10. **This is the baseline.** |
| `deploy` | `33948de` | 2026-07-20 | Same `src/` as `main`, plus the production infra (see [deployment.md](deployment.md)) |
| `batch-processing` | `e9488b1` | 2026-07-19 | PR #10 work; merged and then reverted on `main` |
| `feat/upgrade` | `1559139` | 2026-07-18 | Fully merged; can be deleted |

**What works:** registering channels (one or many), importing full history oldest to newest with resume, media to S3, the dashboard (progress, explorer, media preview, delete), password login, and FloodWait and retry handling. 32 of 33 tests pass and `tsc` is clean.

### PR #10, reverted

`9f11a7e` grouped imported messages into time-window **processing chunks**, so a later stage could process a channel in pieces. It added `IMPORT_LIMIT_PER_BATCH` and `IMPORT_BUFFER_HOURS`, a `processing_chunk` table, and `telegram_messages.processing_chunk_id`. `e9488b1` fixed the pagination direction it had broken. It was merged on 2026-07-19 and reverted the next day; no reason was recorded.

The revert removed the code but **not the schema**. If PR #10 ever booted against production, `processing_chunk` and the `processing_chunk_id` column are still in that database. They're harmless, but worth knowing about before you revisit chunking.

## Known issues

Ordered roughly by impact. None are fixed at this checkpoint.

1. **Failed media is never retried automatically.** If a download or upload fails, the message is stored with `media_key = NULL`, and progress moves past it in the same batch. The "re-download when the key is NULL" path only runs if the batch is fetched again (a crash mid-batch, or a manual checkpoint rewind; see [deployment.md](deployment.md#routine-operations)).
2. **Messages that throw are skipped for good.** Same mechanism: per-message errors are logged and the checkpoint still moves past them.
3. **A fully local stack doesn't work on `main` without code changes.**
   - `src/index.ts` forces `ssl: { rejectUnauthorized: true }`, and the `postgres` container has no TLS.
   - The `S3Client` lacks `forcePathStyle: true`, so requests go to `<bucket>.minio:9000`, which MinIO in Docker can't serve. (Checked: the SDK builds virtual-hosted URLs for `http://minio:9000` and `http://localhost:9000`.)
   - `ensureBucketExists()` is commented out, so the bucket must be created by hand.

   Production (managed Postgres plus R2 or S3) is unaffected. A fix would make SSL and path-style addressing configurable through env vars.
4. **The test suite depends on a local `.env`.** `config.test.ts › should fail if DASHBOARD_PASSWORD is missing` expects `DASHBOARD_PASSWORD` to be the *only* missing variable. It passes only when `dotenv` loads a `.env` that supplies all the others, so it fails in clean checkouts and in CI.
5. **`completed` is terminal.** Channels aren't re-polled for new posts. Re-queue by setting `status = 'pending'`.
6. **There's no API or UI to retry a `failed` channel.** It's SQL only.
7. **`GET /api/channels/:id/messages` returns everything, unpaginated.** It will get slow and memory-heavy on large channels.
8. **Deleting a channel leaves its S3 objects behind.**
9. **Shutdown doesn't wait for running imports.** The reset on boot makes this safe, but logs can end mid-batch.
10. **The auth token is just `sha256(password)`.** It's static, unsalted, and compared without a timing-safe check. That's fine for an internal tool, but it isn't per-user.
11. **The deploy workflow pulls `main`, not `deploy`** (see [deployment.md](deployment.md#how-production-deploys)).
12. **Mappings: the last write wins, with no history.** `PUT /api/channels/:id/mappings` replaces the whole set. Two editors on the same channel overwrite each other, and there is no history and no undo.
13. **Mappings are checked only at write time.** A later re-import can change a message (for example, an edit that removes its text). The stored mapping stays, and only the next PUT checks it again.
14. **Body-parser errors return `500` on most routes.** The global error handler maps every error to 500, so a body over the size limit or malformed JSON reaches the client as `500 An internal server error occurred.` Only `PUT /api/channels/:id/mappings` returns `413` and `400` for these.
15. **`TIMESTAMP` columns are read as Node's local time.** `telegram_channels` and `telegram_messages` use `TIMESTAMP` without a time zone. node-pg parses those values as local time, so API times are off by the server's UTC offset when the Node process does not run in UTC. `channel_mappings` uses `TIMESTAMPTZ` and is not affected.

## Open questions

These need a decision, not just code.

- **Stage 3 owner and storage.** Who builds the large language model (LLM) text processing? Does it store its results here, behind new endpoints, or in its own service?
- **Stage 4 input.** The delivery service writes to the destination database. Does it read validated records from this API, from this database, or from wherever Stage 3 stores them?
- **Stage 4 review grid.** The product spec puts the validation grid in the mapper UI. Does it stay there, next to the delivery service it feeds?
- **Processing chunks.** Is grouping messages by time window (PR #10) still wanted for stage 2 or 3? If so, why was it reverted?
- **The production server's checkout.** Which branch is `/home/scraper-user/scraper` on? Should the workflow pull `deploy` instead of `main`?
- **Live following.** Should completed channels be re-polled on a schedule, or is this purely a one-off history importer?

## Changelog

- **2026-10-15**: Mappings review fixes. `replaceChannelMappings` locks the channel row before the replace, so two overlapping PUTs no longer fail with `500` on the primary key; the last write wins. `deleteChannel` takes the same lock first, so a PUT that overlaps a delete can no longer leave mapping rows without a channel.
- **2026-10-15**: Pipeline context documented in [pipeline.md](pipeline.md): the four stages, their owners, and the data contracts other stages rely on. Stage 4 delivery is a separate service. The mapper UI integration question is answered: the UI adapts to this API through its own server-side routes. n8n has no role. Three pipeline questions added.
- **2026-10-15**: Mapper integration, gap 1. New `channel_mappings` table, plus `PUT` and `GET /api/channels/:channelId/mappings` to store and read text↔audio pairs. `DELETE /api/channels/:channelId` now also deletes the channel's mappings. Known issues 12–15 added. Channel objects from `GET /api/progress` and `GET /api/channels` now include `mapping_count`.
- **2026-10-04**: Documentation revamp for Claude Code. `AGENTS.md` and `.agents/rules/` were replaced by `CLAUDE.md` and path-scoped `.claude/rules/`, `README.md` was rewritten, and `docs/` was added. No code changes.
