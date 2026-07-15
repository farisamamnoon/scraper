# S3 Media Key Naming Convention

**Impact: 7/10**

All media stored in S3 must use this exact key format. The key is stored in the `media_key` DB column and used directly by the `/api/media?key=` endpoint to proxy content. Changing this format breaks media retrieval.

## Format

```
telegram/<channel_id>/<message_id>/<filename>
```

## Examples

```
telegram/123456789/4567/audio.ogg
telegram/123456789/4568/photo_4568.jpg
telegram/123456789/4569/voice_4569.ogg
telegram/123456789/4570/document_4570.pdf
telegram/123456789/4571/document_4571.bin
```

## Filename derivation rules (from TelegramService.extractMediaMetadata)

| Media Type | Filename pattern |
|---|---|
| Photo | `photo_<messageId>.jpg` |
| Document with filename attr | original filename from Telegram |
| Voice message | `voice_<messageId>.ogg` |
| Other document | `document_<messageId>.<ext_from_mimetype>` |
| Fallback | `attachment_<messageId>.bin` |

## Evidence
- `src/importer.ts`: `const s3Key = \`telegram/${channelId}/${messageId}/${mediaInfo.fileName}\``
- `src/server.ts`: `/api/media` endpoint reads `key` query param and calls `s3Service.getObjectStream(key)`
