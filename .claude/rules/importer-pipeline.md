---
paths:
  - "src/importer.ts"
  - "src/services/**/*.ts"
  - "src/index.ts"
---

# Importer and service rules

## Telegram calls: always `executeWithRetry`

```typescript
// ✅
const messages = await this.telegramService.executeWithRetry(
  (client) => client.getMessages(channelEntity, { minId: currentMinId, limit: 100, reverse: true }),
  `fetch messages batch for channel ${resolvedTitle}`
);

// ❌ bypasses FloodWait and retry handling
await client.getMessages(channelEntity, { ... });
```

- FloodWait (`FloodWaitError`, `FLOOD_WAIT_<n>`, or "wait <n> seconds") sleeps exactly `n` seconds and retries with no limit. A FloodWait never fails a channel.
- Any other error is retried up to 5 attempts with `2^attempt × 1000 ms` backoff, then rethrown.
- Always pass a descriptive `label`; it is the only context in the warn log.

## Pagination: oldest → newest

`getMessages(entity, { minId, limit: 100, reverse: true })` returns messages with `id > minId` in ascending order. After each batch, `last_processed_message_id` is set to the highest ID seen. The commit `e9488b1` ("restore oldest-to-newest Telegram pagination") exists because this was broken once; don't change the direction without the user asking.

## Media: check, download, upload, always clean up

`getExistingMessageMediaKey(channelId, messageId)` returns:
- `undefined`: the message isn't stored yet, so download.
- `null`: the message is stored without media (an earlier upload failed), so download again.
- a string: the media is already in S3, so skip the download and reuse the key.

```typescript
const tempFilePath = path.join(tempDir, `temp_${channelId}_${messageId}_${mediaInfo.fileName}`);
try {
  await this.telegramService.downloadMediaToFile(msg, tempFilePath);
  const s3Key = `telegram/${channelId}/${messageId}/${mediaInfo.fileName}`;
  await this.s3Service.uploadStream(s3Key, fs.createReadStream(tempFilePath), mediaInfo.mimeType);
  return s3Key;
} catch (err) {
  logger.error(`Media import failed for message ID ${messageId} in channel ${channelId}`, err);
  return null;               // message is still stored, with media_key NULL
} finally {
  if (fs.existsSync(tempFilePath)) await fs.promises.unlink(tempFilePath);   // never skip
}
```

Files go to `temp/` under `process.cwd()` (created on demand; the Docker image pre-creates it).

## S3 key format

`telegram/<channel_id>/<message_id>/<filename>`. The key is stored verbatim in `telegram_messages.media_key` and passed back to `/api/media?key=`. Changing it orphans every stored object.

Filenames come from `TelegramService.extractMediaMetadata`:

| Media | Filename |
|---|---|
| Photo (`MessageMediaPhoto`) | `photo_<messageId>.jpg` |
| Document with a `DocumentAttributeFilename` | original filename |
| Voice note (audio attribute with `voice`) | `voice_<messageId>.ogg` |
| Other document | `document_<messageId>.<mime subtype>` |
| Anything else | `attachment_<messageId>.bin` |

Only `MessageMediaPhoto` and `MessageMediaDocument` count as downloadable. Web pages, polls, geo and similar media are stored as message JSON only.

## Idempotent upsert

```sql
INSERT INTO telegram_messages (channel_id, message_id, message_date, telegram_json, media_key)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (channel_id, message_id)
DO UPDATE SET
  message_date  = EXCLUDED.message_date,
  telegram_json = EXCLUDED.telegram_json,
  media_key     = COALESCE(telegram_messages.media_key, EXCLUDED.media_key);
```

`upsertChannel` follows the same pattern, so a `NULL` username or title never overwrites a known one. On conflict it does **not** touch `status`; its `status` argument only applies to a fresh insert. Change status with `updateChannelStatus`, which also stamps `import_started_at` (first `running`) and `import_completed_at`.

## Message JSON shape

`Importer.extractCleanJson` is the contract for `telegram_json` and is covered by `tests/importer.test.ts`. Keep it free of circular or GramJS objects. Add fields; don't rename existing ones, because downstream consumers (the mapper UI) read them.

## Database

- Never `Number()` a Telegram ID; pass strings (`.toString()`) to `pg`.
- New tables, columns and indexes go into `initializeSchema()` as `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`, inside its existing transaction.
- Multi-statement writes use `pool.connect()` with `BEGIN`/`COMMIT`/`ROLLBACK` and `client.release()` in `finally` (see `deleteChannel`).
