# Service Injection via Constructor

**Impact: 9/10**

All services (`DbService`, `S3Service`, `TelegramService`) are **instantiated once** in `src/index.ts` and passed via constructor to all consumers. Never import and self-construct a service inside `Importer`, `server.ts`, or any other module.

## Rule

```typescript
// ✅ CORRECT — receive as constructor param
class Importer {
  constructor(
    private dbService: DbService,
    private s3Service: S3Service,
    private telegramService: TelegramService,
    private concurrency: number
  ) {}
}

// ❌ WRONG — self-construction outside index.ts
const db = new DbService(new Pool(...));
```

## Evidence
- `src/index.ts`: Instantiates all services, then passes them to `new Importer(...)` and `createServer(...)`
- `src/importer.ts`: Receives all 3 services as constructor params
- `src/server.ts`: `createServer(dbService, importer, telegramService, s3Service)`
