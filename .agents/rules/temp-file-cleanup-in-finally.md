# Temp File Cleanup in finally Block

**Impact: 8/10**

All Telegram media downloads write to `temp/` on disk before streaming to S3. The temp file **must always be deleted in a `finally` block**, even if the upload fails. Failure to do so causes disk bloat in long-running processes.

## Rule

```typescript
// ✅ CORRECT
const tempFilePath = path.join(tempDir, `temp_${channelId}_${messageId}_${mediaInfo.fileName}`);
try {
  await telegramService.downloadMediaToFile(msg, tempFilePath);
  const fileStream = fs.createReadStream(tempFilePath);
  await s3Service.uploadStream(s3Key, fileStream, mediaInfo.mimeType);
  return s3Key;
} catch (err) {
  logger.error(`Media import failed`, err);
  return null;
} finally {
  // ALWAYS clean up, regardless of success or failure
  if (fs.existsSync(tempFilePath)) {
    await fs.promises.unlink(tempFilePath);
  }
}

// ❌ WRONG — cleanup only on success
await s3Service.uploadStream(...);
await fs.promises.unlink(tempFilePath); // Not reached on error!
```

## Temp file naming convention
```
temp/temp_<channelId>_<messageId>_<originalFilename>
```

## Evidence
- `src/importer.ts`: `downloadAndUploadMedia()` private method (lines 242–286)
