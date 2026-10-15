# HTTP API

Served by `src/server.ts` on `PORT` (default `3000`). All responses are JSON with a `success` boolean, except `/api/media`, which streams the file.

## Authentication

Every endpoint except `POST /api/auth/login` requires the `dashboard_token` cookie. Without it the API returns:

```http
401 {"success": false, "error": "Unauthorized"}
```

### `POST /api/auth/login`

```bash
curl -i -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"password":"<DASHBOARD_PASSWORD>"}' http://localhost:3000/api/auth/login
```

| Status | Body |
|---|---|
| 200 | `{"success": true}` + `Set-Cookie: dashboard_token=…; HttpOnly; SameSite=Strict; Max-Age=2592000` |
| 400 | `{"success": false, "error": "Password is required."}` |
| 401 | `{"success": false, "error": "Incorrect password."}` |

Add `-b cookies.txt` to the examples below.

## Channels

### Channel object

Returned by the list and progress endpoints. IDs are strings because they are BigInt values.

```json
{
  "channel_id": "1234567890",
  "channel_username": "some_channel",
  "title": "Some Channel",
  "import_started_at": "2026-07-19T03:10:00.000Z",
  "import_completed_at": null,
  "last_processed_message_id": "4567",
  "status": "running",
  "message_count": 4210,
  "mapping_count": 312
}
```

`status` is one of `pending`, `running`, `completed`, `failed`. `mapping_count` is the number of stored text↔audio mappings (see [Mappings](#mappings)).

### `GET /api/progress`

Everything the dashboard polls: global stats plus every channel, ordered by `import_started_at DESC NULLS LAST`, then username.

```json
{
  "success": true,
  "stats": { "total_messages": 18234, "total_channels": 7, "active_imports": 1 },
  "channels": [ /* channel objects */ ]
}
```

### `GET /api/channels`

A paginated, filterable version of the channel list.

| Query | Default | Notes |
|---|---|---|
| `status` | (all) | One of the four statuses |
| `page` | `1` | Positive integer |
| `limit` | `50` | Positive integer, capped at `100` |

```json
{
  "success": true,
  "channels": [ /* channel objects */ ],
  "pagination": { "page": 1, "limit": 50, "total": 7, "total_pages": 1 }
}
```

`400` with the validation message for a bad `status`, `page` or `limit`.

### `POST /api/channels`

Registers one or more public channels as `pending`. The importer picks them up within about 5 seconds.

```bash
curl -b cookies.txt -H 'Content-Type: application/json' \
  -d '{"username":"@channel_one, https://t.me/channel_two"}' http://localhost:3000/api/channels
```

`username` accepts a single handle or several separated by commas, spaces or newlines. Each one may be `name`, `@name` or a `t.me/name` link, and must be 5–32 characters of `[A-Za-z0-9_]` after cleanup. Every handle is resolved on Telegram before it's saved, with a 1s pause between handles.

**One handle** gives a flat response:

| Status | Body |
|---|---|
| 200 | `{"success": true, "channel": {"channel_id", "channel_username", "title", "status": "pending"}}` |
| 400 | Missing, malformed, or not resolvable on Telegram |
| 409 | Already tracked, matched by username or by the resolved channel ID |
| 500 | Database error |

**Several handles** always return `200` with a result per handle:

```json
{
  "success": true,
  "results": [
    { "username": "channel_one", "success": true, "channel": { "channel_id": "…", "channel_username": "channel_one", "title": "…", "status": "pending" } },
    { "username": "channel_two", "success": false, "error": "Channel @channel_two is already being tracked." }
  ]
}
```

### `GET /api/channels/:channelId/messages`

Every stored message for the channel, newest first. **Not paginated**: a large channel returns everything in one response.

```json
{
  "success": true,
  "messages": [
    {
      "id": "981",
      "channel_id": "1234567890",
      "message_id": "4567",
      "message_date": "2026-06-17T08:00:00.000Z",
      "telegram_json": { /* see architecture.md#telegram_json-shape */ },
      "media_key": "telegram/1234567890/4567/voice_4567.ogg",
      "imported_at": "2026-07-19T03:12:44.000Z"
    }
  ]
}
```

### `DELETE /api/channels/:channelId`

Deletes the channel row, all its message rows and all its mappings in one transaction. **S3 objects are not deleted.**

| Status | Body |
|---|---|
| 200 | `{"success": true, "message": "Channel deleted successfully."}` |
| 400 | `Cannot delete a channel while its import is in progress.` |
| 404 | `Channel not found.` |

## Mappings

A mapping pairs one audio message with one text message of the same channel (stage 2 of the pipeline). The mapper UI holds the whole set and sends it in one request.

- A mapping is keyed by the **audio** message: one audio has at most one text.
- One text can be mapped to many audios.
- A message can be on both sides (an audio post with a caption).
- `source` is `manual` (human pair), `auto` (accepted suggestion) or `unknown`.

### Mapping object

```json
{ "text_message_id": "55", "media_message_id": "67", "source": "manual", "updated_at": "2026-10-14T18:00:00.000Z" }
```

IDs are Telegram `message_id` values, returned as strings because they are BigInt values.

### `PUT /api/channels/:channelId/mappings`

Replaces the channel's **full** mapping set. A request with the same body gives the same result. An empty array clears all mappings.

```bash
curl -b cookies.txt -X PUT -H 'Content-Type: application/json' \
  -d '{"mappings":[{"text_message_id":"55","media_message_id":"67","source":"manual"}]}' \
  http://localhost:3000/api/channels/1234567890/mappings
```

Each item takes `text_message_id` and `media_message_id` as digit strings or integers (send IDs above 2^53 as strings), and an optional `source` (default `unknown`). The request is validated before anything is written. If one item fails, nothing is written:

1. `:channelId` is a positive integer and a tracked channel.
2. `mappings` is an array with at most 50,000 items.
3. Each ID is a positive integer that fits in `BIGINT`, and `source` is one of the three values.
4. No `media_message_id` occurs twice.
5. Every `media_message_id` is a stored message of this channel and is audio: `telegram_json.media.media_type` is `audio` or `voice`, or `telegram_json.media.mime_type` starts with `audio/`.
6. Every `text_message_id` is a stored message of this channel with a non-empty `telegram_json.text` after trimming. Text that is only whitespace counts as no text.

Checks 5 and 6 run only when checks 1–4 pass, and use one database query for the whole set.

| Status | Body |
|---|---|
| 200 | `{"success": true, "channel_id": "1234567890", "count": 100, "updated_at": "<ISO>"}` |
| 400 | `Request body is not valid JSON.`, `Invalid channel ID.`, or the problem list below |
| 404 | `Channel not found.` |
| 413 | `Request body exceeds the 5 MB limit.` |

A rejected set returns the first problem as `error`, and up to 20 problems in `details`. `index` is the item position, and is absent for problems with the whole `mappings` field:

```json
{
  "success": false,
  "error": "mappings[3].media_message_id is not an audio or voice message.",
  "details": [ { "index": 3, "field": "media_message_id", "reason": "is not an audio or voice message." } ]
}
```

**Body size.** This route accepts JSON bodies up to **5 MB** (5,000 pairs are about 385 KB; 50,000 pairs are about 4 MB). The auth check runs before the body is parsed, so an unauthenticated call gets `401` whatever its size. All other routes keep the default 100 KB limit.

**While importing.** A `running` channel accepts mapping writes. Mappings reference only stored messages, and the validation checks that.

**Concurrent writes.** The write locks the channel row (`SELECT … FOR UPDATE`) in the same transaction as the replace. Overlapping PUTs for one channel run one after the other, and the last write wins. There is no history and no version check, so the earlier set is lost without a warning. The write checks again that the channel exists under the lock, and returns `404` when a delete removed it while the request ran.

### `GET /api/channels/:channelId/mappings`

```bash
curl -b cookies.txt http://localhost:3000/api/channels/1234567890/mappings
```

```json
{
  "success": true,
  "channel_id": "1234567890",
  "updated_at": "2026-10-14T18:00:00.000Z",
  "mappings": [ /* mapping objects, ordered by media_message_id ascending */ ]
}
```

The top-level `updated_at` is the latest row time, or `null` when the channel has no mappings. An empty list is a normal `200`.

| Status | Body |
|---|---|
| 200 | as above |
| 400 | `Invalid channel ID.` |
| 404 | `Channel not found.` |

## Batches

A batch is a stable range of consecutive messages that the mapper shows at one time. [batching.md](batching.md) explains how the scraper cuts a channel into batches and when a batch is frozen.

### Batch object

```json
{
  "batch_no": 2,
  "first_message_id": "41",
  "last_message_id": "80",
  "message_count": 24,
  "audio_count": 12,
  "mapped_audio_count": 3,
  "status": "frozen",
  "first_date": "2021-03-04T10:00:00.000Z",
  "last_date": "2021-03-05T08:12:00.000Z",
  "frozen_at": "2026-10-15T09:00:00.000Z"
}
```

- `first_message_id` and `last_message_id` are inclusive. Every message of the channel in that ID range belongs to the batch.
- `message_count` counts only the messages that a person maps or checks: audio messages, and non-audio messages with text.
- `mapped_audio_count` is the number of stored mappings whose audio is in the range.
- `status` is `frozen` (the range never changes) or `open` (only the last batch; the next rebuild can replace it).
- `first_date` and `last_date` have the time zone offset of known issue 15 in [status.md](status.md).

### `GET /api/channels/:channelId/batches`

```bash
curl -b cookies.txt http://localhost:3000/api/channels/1234567890/batches
```

```json
{ "success": true, "channel_id": "1234567890", "order": "audio_first", "batches": [ /* batch objects, by batch_no */ ] }
```

`order` is the learned channel order, `audio_first` or `text_first`. It is `null` before the first rebuild. A channel with no batches returns an empty list.

| Status | Body |
|---|---|
| 200 | as above |
| 400 | `Invalid channel ID.` |
| 404 | `Channel not found.` |

### `POST /api/channels/:channelId/batches`

Rebuilds the open end of the channel's batches. The importer also runs this when an import completes. Use this route for channels that completed before batching existed. Frozen batches never change, so you can call it at any time.

```bash
curl -b cookies.txt -X POST http://localhost:3000/api/channels/1234567890/batches
```

| Status | Body |
|---|---|
| 200 | `{"success": true, "channel_id": "1234567890", "order": "audio_first", "batch_count": 140, "open_count": 0}` |
| 400 | `Invalid channel ID.` |
| 404 | `Channel not found.` |
| 409 | `Batches are built after the import completes.` The channel status is not `completed` |

`batch_count` is the number of all batches of the channel after the rebuild. `open_count` is 0 or 1.

### `PUT /api/channels/:channelId/batches/:batchNo/mappings`

Replaces the mappings whose audio is inside one batch. Mappings of other batches stay as they are, so two people can map different batches of one channel at the same time. The write also freezes the batch.

```bash
curl -b cookies.txt -X PUT -H 'Content-Type: application/json' \
  -d '{"mappings":[{"text_message_id":"38","media_message_id":"41","source":"manual"}]}' \
  http://localhost:3000/api/channels/1234567890/batches/2/mappings
```

The body and the item checks are the same as for `PUT /api/channels/:channelId/mappings`, plus one check: every `media_message_id` must be inside the batch range. The `text_message_id` can be any text message of the channel, for example a series header in an earlier batch. An empty array clears the mappings of the batch.

| Status | Body |
|---|---|
| 200 | `{"success": true, "channel_id": "1234567890", "batch_no": 2, "count": 1, "updated_at": "<ISO>"}` |
| 400 | `Invalid channel ID.`, `Invalid batch number.`, `Request body is not valid JSON.`, or a problem list such as `mappings[0].media_message_id is not in batch 2.` |
| 404 | `Channel not found.` or `Batch not found.` |
| 409 | `Batch changed while saving. Load it again.` A rebuild replaced the open batch after the request read it. Nothing is written |
| 413 | `Request body exceeds the 5 MB limit.` |

**Concurrent writes.** The write locks the channel row, as the full-set PUT does. It checks again that the batch has the range it validated against, and returns `409` if not. A full-set PUT and a batch PUT on the same channel still overwrite each other: the last write wins.

## Media

### `GET /api/media?key=<media_key>[&download=true]`

Streams an object from the bucket, passing through its `Content-Type` and `Content-Length`. By default it sends `Content-Disposition: inline`; `download=true` switches to `attachment; filename="<basename>"`. The dashboard uses this for previews.

| Status | Body |
|---|---|
| 200 | file bytes |
| 400 | `Key query parameter is required.` |
| 404 | `Media not found.` (any S3 error) |

The key is passed to S3 unchecked, so an authenticated caller can read any object in the bucket.

## Errors

An unexpected error in a route handler is logged and returned as:

```http
500 {"success": false, "error": "An internal server error occurred."}
```
