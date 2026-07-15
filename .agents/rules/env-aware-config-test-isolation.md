# Environment-Aware Config and Test Isolation

**Impact: 7/10**

Config is only parsed when `NODE_ENV !== 'test'`. Tests must never depend on real env vars. All services must be mocked using `jest.fn()` inline — never import live services into tests.

## Config Guard Pattern

```typescript
// src/config.ts — do not change this line
export const config = process.env.NODE_ENV !== 'test' ? parseAndValidateConfig() : {} as Config;
```

This means in test files, importing `config` returns `{}` — never try to use `config.telegram.apiId` in a test.

## Test Mock Pattern

```typescript
// ✅ CORRECT — inline jest.fn() mocks, typed safely
const mockDbService = {
  upsertChannel: jest.fn(),
  updateChannelStatus: jest.fn(),
  upsertMessage: jest.fn(),
  getExistingMessageMediaKey: jest.fn(),
  getAllChannels: jest.fn(),
  getGlobalStats: jest.fn(),
} as unknown as jest.Mocked<DbService>;

const mockTelegramService = {
  connect: jest.fn(),
  executeWithRetry: jest.fn(),
  hasDownloadableMedia: jest.fn(),
  extractMediaMetadata: jest.fn(),
} as unknown as jest.Mocked<TelegramService>;
```

## Test commands
```bash
npm run test                   # Run all tests
# jest config: jest.config.js — uses ts-jest, NODE_ENV=test set automatically
```

## Evidence
- `src/config.ts`: Line 155 — `NODE_ENV !== 'test'` guard
- `tests/importer.test.ts`: Full inline mock pattern
- `tests/server.test.ts`: supertest with mocked services injected to `createServer()`
- `tests/config.test.ts`: Config validation unit tests with env var injection
