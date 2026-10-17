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
5. **`completed` is terminal.** Channels aren't re-polled for new posts. Re-queue by setting `status = 'pending'`. When the import completes again, it rebuilds only the open end of the channel's batches; frozen batches stay as they are.
6. **There's no API or UI to retry a `failed` channel.** It's SQL only.
7. **`GET /api/channels/:id/messages` returns everything, unpaginated.** It will get slow and memory-heavy on large channels (a 12,000 message channel is about 17 MB). The mapper uses `GET …/batches/:batchNo/messages` instead.
8. **Deleting a channel leaves its S3 objects behind.**
9. **Shutdown doesn't wait for running imports.** The reset on boot makes this safe, but logs can end mid-batch.
10. **The auth token is just `sha256(password)`.** It's static, unsalted, and compared without a timing-safe check. That's fine for an internal tool, but it isn't per-user.
11. **The deploy workflow pulls `main`, not `deploy`** (see [deployment.md](deployment.md#how-production-deploys)).
12. **Mappings: the last write wins, with no history.** `PUT /api/channels/:id/mappings` replaces the whole set. Two editors on the same channel overwrite each other, and there is no history and no undo.
13. **Mappings are checked only at write time.** A later re-import can change a message (for example, an edit that removes its text). The stored mapping stays, and only the next PUT checks it again.
14. **Body-parser errors return `500` on most routes.** The global error handler maps every error to 500, so a body over the size limit or malformed JSON reaches the client as `500 An internal server error occurred.` Only `PUT /api/channels/:id/mappings` returns `413` and `400` for these.
15. **`TIMESTAMP` columns are read as Node's local time.** `telegram_channels` and `telegram_messages` use `TIMESTAMP` without a time zone. node-pg parses those values as local time, so API times are off by the server's UTC offset when the Node process does not run in UTC. `channel_mappings` uses `TIMESTAMPTZ` and is not affected.
16. **Some audio files are not counted as audio.** Telegram stores some audio as a generic document: `media_type` is `document` and `mime_type` is `application/octet-stream` or `application/binary`, so only the file name (for example `.aac`) shows that it is audio. The audio rule in [pipeline.md](pipeline.md#data-other-stages-depend-on) does not match them, so the mapping check rejects them, the mapper UI does not show them as audio, and the batcher counts them as photos. The local data has 23 of them. A fix would add a file-extension check to the audio rule in the scraper and the mapper UI in one change.

## Open questions

These need a decision, not just code.

- **Stage 3 owner and storage.** Who builds the large language model (LLM) text processing? Does it store its results here, behind new endpoints, or in its own service?
- **Stage 4 input.** The delivery service writes to the destination database. Does it read validated records from this API, from this database, or from wherever Stage 3 stores them?
- **Stage 4 review grid.** The product spec puts the validation grid in the mapper UI. Does it stay there, next to the delivery service it feeds?
- **Processing chunks.** Is grouping messages by time window (PR #10) still wanted for stage 3? Stage 2 now has its own batches (see [batching.md](batching.md)), which use time gaps and the channel's posting order instead of a fixed time window.
- **The production server's checkout.** Which branch is `/home/scraper-user/scraper` on? Should the workflow pull `deploy` instead of `main`?
- **Live following.** Should completed channels be re-polled on a schedule, or is this purely a one-off history importer?

## Changelog

- **2026-10-17**: Soft deletions in the mapper. New table `channel_deletions` (`channel_id`, `message_id`, `role` `audio` or `text`, `deleted_at`). `PUT …/batches/:batchNo/mappings` takes an optional `deleted` list that replaces the batch's deletions in the same transaction (absent means unchanged) and returns `deleted_count`. `GET …/batches/:batchNo/messages` returns `deleted`, and the batch object has `deleted_audio_count` ([api.md](api.md#deletions)). `DELETE /api/channels/:channelId` also removes the channel's deletions. Stage 3 must skip deleted audio ([pipeline.md](pipeline.md#data-other-stages-depend-on)). Checked on the real-data test database (tholobulilm, batch 52): save, read-back, count, absent field leaves the rows, subset replace keeps `deleted_at`, clear, every `400`, the `409` (range moved while the request waited on the lock) and the channel delete. Known gap: a text deleted in one batch can still be linked by a mapping of another batch.

- **2026-10-17**: New route `GET /api/channels/:channelId/batches/:batchNo/messages` ([api.md](api.md#get-apichannelschannelidbatchesbatchnomessages)). It returns one batch's messages, the closest earlier text message and the texts that stored mappings of the batch use from outside its range, so the mapper no longer loads a whole channel. `GET …/messages` is unchanged. Checked on the real-data test database (tholobulilm, batch 52): 53 messages, 72 KB, about 10 ms, against 17.8 MB and about 0.55 s for the full list. The check found that an unqualified `ORDER BY message_id` sorts the `::TEXT` output column as text, so the context query returned message 999 instead of 1675. The queries now order by the table column.
- **2026-10-15**: Real-data test setup. `scripts/test-db.sh` keeps a snapshot of the local data in a separate Postgres container (`scraper-test-pg`, port 5433) and serves it with an offline scraper. Each session clones the snapshot into its own DB and port; `test-db.sh ui` also starts the mapper UI against it. New env var `TELEGRAM_OFFLINE=true` skips the Telegram login and the importer. The mapper UI uses this setup for browser tests instead of fake scraper servers (`test-db` skill here, `ui-browser-testing` in the UI repo). Found during setup: the PlanetScale branch in `.env` (`scraper_dev`) no longer exists; the local container `scraper-local-pg` holds the current data.
- **2026-10-15**: Stage 2 batches ([batching.md](batching.md)). New `channel_batches` table and `telegram_channels.batch_order` column. The importer rebuilds a channel's open batches when an import completes. New routes: `GET` and `POST /api/channels/:channelId/batches`, and `PUT /api/channels/:channelId/batches/:batchNo/mappings`, which replaces only one batch's mappings. Channels that completed before this change need one `POST …/batches` each. Checked end to end: the mapper UI branch `feat/mapper-batches` ran against this server code on a copy of the local database (build, list with `batch_count`, batch save, read-back, 400, 404 and 409). The check found known issue 16.

- **2026-10-15**: Mappings review fixes. `replaceChannelMappings` locks the channel row before the replace, so two overlapping PUTs no longer fail with `500` on the primary key; the last write wins. `deleteChannel` takes the same lock first, so a PUT that overlaps a delete can no longer leave mapping rows without a channel. A text message that holds only whitespace no longer passes the "has text" check.
- **2026-10-15**: Pipeline context documented in [pipeline.md](pipeline.md): the four stages, their owners, and the data contracts other stages rely on. Stage 4 delivery is a separate service. The mapper UI integration question is answered: the UI adapts to this API through its own server-side routes. n8n has no role. Three pipeline questions added.
- **2026-10-15**: Mapper integration, gap 1. New `channel_mappings` table, plus `PUT` and `GET /api/channels/:channelId/mappings` to store and read text↔audio pairs. `DELETE /api/channels/:channelId` now also deletes the channel's mappings. Known issues 12–15 added. Channel objects from `GET /api/progress` and `GET /api/channels` now include `mapping_count`.
- **2026-10-04**: Documentation revamp for Claude Code. `AGENTS.md` and `.agents/rules/` were replaced by `CLAUDE.md` and path-scoped `.claude/rules/`, `README.md` was rewritten, and `docs/` was added. No code changes.
