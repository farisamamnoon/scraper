# Idempotent UPSERT with COALESCE for media_key

**Impact: 9/10**

All message database writes use `INSERT ... ON CONFLICT (channel_id, message_id) DO UPDATE`. The `media_key` column is protected by `COALESCE(existing, excluded)` — a valid S3 key must never be overwritten by NULL on a retry.

## Rule

```sql
-- ✅ CORRECT — media_key is append-only once set
ON CONFLICT (channel_id, message_id)
DO UPDATE SET
  message_date = EXCLUDED.message_date,
  telegram_json = EXCLUDED.telegram_json,
  media_key = COALESCE(telegram_messages.media_key, EXCLUDED.media_key);
```

Before downloading media, always check `dbService.getExistingMessageMediaKey(channelId, messageId)`:
- Returns `undefined` → message not in DB yet → proceed with download + insert
- Returns `null` → message exists but upload failed previously → re-attempt download
- Returns a string → media key already set → **skip download entirely**

## Evidence
- `src/services/db.service.ts`: `upsertMessage()` method
- `src/importer.ts`: `importChannel()` — media key check before `downloadAndUploadMedia()`
