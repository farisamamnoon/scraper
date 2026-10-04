---
paths:
  - "tests/**/*.ts"
  - "src/config.ts"
  - "jest.config.js"
---

# Testing rules

- Jest + ts-jest; the suites live in `tests/*.test.ts`. Jest sets `NODE_ENV=test`, so `config` is `{}`. Never read `config.*` in a test or in code that runs at import time in tests.
- **No real network or services.** Mock every service with inline `jest.fn()` objects and inject them, the same way `src/index.ts` would:

```typescript
const mockDbService = {
  getAllChannels: jest.fn(),
  getGlobalStats: jest.fn(),
  getChannelByUsername: jest.fn(),
  getChannelProgress: jest.fn(),
  upsertChannel: jest.fn(),
  deleteChannel: jest.fn(),
} as unknown as jest.Mocked<DbService>;

const app = createServer(mockDbService, mockImporter, mockTelegramService, mockS3Service, 'test_password');
```

- `jest.config.js` sets `clearMocks`, `resetMocks` and `restoreMocks`, so mock implementations are wiped before every test. Set return values inside each test or in `beforeEach`.
- Authenticated supertest requests send the cookie `dashboard_token=<sha256(password)>` (see the helper at the top of `tests/server.test.ts`).
- Server code skips the 1s delay between bulk channel resolutions when `NODE_ENV === 'test'`; keep test-only branches like that to a minimum.
- Config tests set `process.env` directly and call `parseAndValidateConfig()`. `src/config.ts` calls `dotenv.config()` at import, so a developer's local `.env` leaks into these tests. Write config tests that hold whether or not a `.env` exists (clear `process.env` explicitly rather than relying on it being empty).
- Every new endpoint gets supertest coverage for the happy path, 401 when unauthenticated, and each validation or error status it can return.
