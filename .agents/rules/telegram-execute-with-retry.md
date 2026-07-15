# Telegram API Must Use executeWithRetry()

**Impact: 8/10**

All Telegram API calls must be wrapped in `TelegramService.executeWithRetry()`. Never call `this.client.*` directly. This is the sole FloodWait and transient-error safety net.

## Behavior

- **FloodWaitError** — sleeps for the exact seconds from the error (`FLOOD_WAIT_X` pattern), then retries indefinitely
- **Transient errors** — retries up to 5 times with exponential backoff: `2^attempt × 1000ms`
- Always provide a descriptive `label` for clear log output

## Rule

```typescript
// ✅ CORRECT
return await this.executeWithRetry(
  async (client) => client.getMessages(entity, { minId, limit: 100, reverse: true }),
  `fetch messages batch for channel ${channelTitle}`
);

// ❌ WRONG
return await this.client!.getMessages(entity, { minId, limit: 100, reverse: true });
```

## Evidence
- `src/services/telegram.service.ts`: `executeWithRetry()` method (lines 138–183)
- `src/importer.ts`: All `telegramService.executeWithRetry(...)` call sites
- `src/services/telegram.service.ts`: `downloadMediaToFile()` and `getChannelEntity()` both delegate to `executeWithRetry`
