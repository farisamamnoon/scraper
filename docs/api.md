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
  "message_count": 4210
}
```

`status` is one of `pending`, `running`, `completed`, `failed`.

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

Deletes the channel row and all its message rows in one transaction. **S3 objects are not deleted.**

| Status | Body |
|---|---|
| 200 | `{"success": true, "message": "Channel deleted successfully."}` |
| 400 | `Cannot delete a channel while its import is in progress.` |
| 404 | `Channel not found.` |

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
