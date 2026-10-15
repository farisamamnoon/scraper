# Message Batching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split each channel into stored, stable batches of 10–50 mappable messages that never separate an audio from its description, and let the mapper read batches and save mappings one batch at a time.

**Architecture:** A pure planner (`src/batching.ts`) learns the channel order and cuts messages into batches. `DbService.rebuildOpenBatches` runs it on the channel tail in one locked transaction and stores the result in `channel_batches`. The importer rebuilds on completion. Three endpoints expose batches and per-batch mapping writes.

**Tech Stack:** TypeScript, Express 4, express-validator, node-pg, Jest + ts-jest + supertest.

**Spec:** `docs/batching.md`

## Global Constraints

- Constants: `GAP_SECONDS = 1800`, `MIN_BATCH = 10`, `MAX_BATCH = 50`. Sizes are weighted (audio = 1, non-audio with non-whitespace text = 1, other = 0).
- Audio and text use the same rules as `getMappableMessageInfo`: audio is `media_type` in (`audio`, `voice`) or `mime_type LIKE 'audio/%'`; text is `telegram_json->>'text' ~ '\S'`.
- Telegram IDs are strings everywhere; compare with `BigInt`, never `Number()`.
- Schema changes go in `initializeSchema()` as `IF NOT EXISTS` DDL inside its transaction.
- Multi-statement writes use `pool.connect()` + `BEGIN`/`COMMIT`/`ROLLBACK` + `client.release()` in `finally`, and lock the channel row with `SELECT … FOR UPDATE` first.
- New endpoints: `apiAuthMiddleware`, express-validator + `handleValidationErrors`, `try { … } catch (err) { next(err) }`, `{ success, … }` envelope, supertest coverage for 200, 401 and every error status.
- Commits: `<type>(<scope>): <subject>`, max 50 chars, imperative, no period.
- Docs in STE style. Update `docs/status.md` changelog and `CLAUDE.md` code map.

## Review Focus

1. A bulk upload where all messages share one timestamp: every gap is 0, so only the order-aware score can place cuts. Expected: no batch above `MAX_BATCH`, no pair split. (Task 1, `keeps pairs together in a same-timestamp burst`.)
2. A rebuild after a person mapped the open last batch: expected to freeze it, not replace it. (Task 2, `freezes open batches that have mappings before planning`.)
3. A rebuild while the channel is still importing: the last stored message looks old, but more messages follow. Expected: `409`, no rebuild. (Task 3, `returns 409 when the channel is not completed`.)
4. A batch PUT that races a rebuild which changed the open batch range. Expected: `409`, nothing written. (Task 4, `returns 409 when the batch range changed`.)
5. A batch PUT with an audio outside the batch range. Expected: `400` naming the item; a text outside the range is allowed. (Task 4, `rejects audio outside the batch range`.)

---

### Task 1: Batch planner

**Files:**
- Create: `src/batching.ts`
- Test: `tests/batching.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const GAP_SECONDS = 1800, MIN_BATCH = 10, MAX_BATCH = 50;
  export const CHANNEL_ORDERS = ['audio_first', 'text_first'] as const;
  export type ChannelOrder = (typeof CHANNEL_ORDERS)[number];
  export const BATCH_STATUSES = ['open', 'frozen'] as const;
  export type BatchStatus = (typeof BATCH_STATUSES)[number];
  export interface BatchLimits { gapSeconds: number; minBatch: number; maxBatch: number }
  export const DEFAULT_LIMITS: BatchLimits;
  export interface BatchMessage { message_id: string; date: Date; is_audio: boolean; has_text: boolean }
  export interface PlannedBatch { first_message_id: string; last_message_id: string; message_count: number; audio_count: number; status: BatchStatus }
  export interface TailPlanInput { messages: BatchMessage[]; storedOrder: ChannelOrder | null; hasFrozenBatches: boolean; completedAt: Date | null }
  export interface TailPlan { order: ChannelOrder; batches: PlannedBatch[] }
  export function learnChannelOrder(messages: BatchMessage[], gapSeconds?: number): ChannelOrder;
  export function splitIntoBatches(messages: BatchMessage[], order: ChannelOrder, limits?: BatchLimits): Array<{ start: number; end: number }>; // index ranges, end exclusive
  export function planChannelTail(input: TailPlanInput, limits?: BatchLimits): TailPlan;
  ```
  `messages` are in `message_id` order. `completedAt` is `import_completed_at` when the channel is `completed`, else `null`.

- [ ] **Step 1: Write the failing tests**

Test helper `build(spec: string, stepSeconds = 10): BatchMessage[]`: one message per character, IDs from 1, each `stepSeconds` after the previous; `A` = uncaptioned audio, `C` = captioned audio, `T` = text, `o` = photo without text; `|` adds no message and adds a 2-hour gap before the next one.

```ts
describe('learnChannelOrder', () => {
  it('votes with isolated pairs', () => {
    expect(learnChannelOrder(build('AT|AT|TA'))).toBe('audio_first');
    expect(learnChannelOrder(build('TA|TA|AT'))).toBe('text_first');
  });
  it('gives audio_first on a tie or with no votes', () => {
    expect(learnChannelOrder(build('AT|TA'))).toBe('audio_first');
    expect(learnChannelOrder(build('A|T'))).toBe('audio_first');
  });
  it('ignores pairs inside longer sessions', () => {
    expect(learnChannelOrder(build('TATATA|AT'))).toBe('audio_first');
  });
});

describe('splitIntoBatches', () => {
  const small = { gapSeconds: 1800, minBatch: 1, maxBatch: 10 };
  it('cuts at gaps longer than gapSeconds', () => {
    expect(splitIntoBatches(build('AT|AT'), 'audio_first', small)).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }]);
  });
  it('merges small batches into the neighbor across the shorter gap', () => {
    // sessions ATAT, AT, ATAT; the small middle one is closer to the third
    const msgs = build('ATAT|AT|ATAT');
    msgs.slice(6).forEach((m) => (m.date = new Date(m.date.getTime() - 3600 * 1000)));
    expect(splitIntoBatches(msgs, 'audio_first', { gapSeconds: 1800, minBatch: 3, maxBatch: 10 }))
      .toEqual([{ start: 0, end: 4 }, { start: 4, end: 10 }]);
  });
  it('does not count photos without text toward the size', () => {
    expect(splitIntoBatches(build('oooooAT'), 'audio_first', { gapSeconds: 1800, minBatch: 1, maxBatch: 2 }))
      .toEqual([{ start: 0, end: 7 }]);
  });
  it('keeps pairs together in a same-timestamp burst', () => {
    const msgs = build('AT'.repeat(400), 0);
    const batches = splitIntoBatches(msgs, 'audio_first');
    for (const { start, end } of batches) {
      expect(end - start).toBeLessThanOrEqual(50);
      expect(end - start).toBeGreaterThanOrEqual(10);
      expect(msgs[start].is_audio).toBe(true);
      expect(msgs[end - 1].is_audio).toBe(false);
    }
  });
  it('cuts after the audio in a text_first burst', () => {
    const msgs = build('TA'.repeat(100), 0);
    for (const { start, end } of splitIntoBatches(msgs, 'text_first')) {
      expect(msgs[start].is_audio).toBe(false);
      expect(msgs[end - 1].is_audio).toBe(true);
    }
  });
  it('keeps the maximum strict for one text before a long audio run', () => {
    const batches = splitIntoBatches(build('T' + 'A'.repeat(120), 1), 'text_first');
    expect(batches.length).toBeGreaterThanOrEqual(3);
    batches.forEach(({ start, end }) => {
      expect(end - start).toBeLessThanOrEqual(50);
      expect(end - start).toBeGreaterThanOrEqual(10);
    });
  });
  it('prefers a cut that is safe for both orders', () => {
    // 0A 1T 2A 3T 4A 5T 6C 7C 8A 9T: cuts 6, 7, 8 are safe for both orders; 6 is the most equal
    expect(splitIntoBatches(build('ATATATCCAT', 0), 'audio_first', { gapSeconds: 1800, minBatch: 2, maxBatch: 6 }))
      .toEqual([{ start: 0, end: 6 }, { start: 6, end: 10 }]);
  });
  it('prefers the longest gap among safe cuts', () => {
    const msgs = build('ATATATAT', 10);
    msgs.slice(6).forEach((m) => (m.date = new Date(m.date.getTime() + 600 * 1000)));
    expect(splitIntoBatches(msgs, 'audio_first', { gapSeconds: 1800, minBatch: 2, maxBatch: 6 }))
      .toEqual([{ start: 0, end: 6 }, { start: 6, end: 8 }]);
  });
});

describe('planChannelTail', () => {
  const at = (n: number) => build('AT'.repeat(n));
  const after = (msgs: BatchMessage[], s: number) => new Date(msgs[msgs.length - 1].date.getTime() + s * 1000);
  it('returns no batches for no messages', () => {
    expect(planChannelTail({ messages: [], storedOrder: null, hasFrozenBatches: false, completedAt: null }))
      .toEqual({ order: 'audio_first', batches: [] });
  });
  it('freezes every batch but the last, and the last when the tail is closed and big enough', () => {
    const msgs = build('AT'.repeat(20) + '|' + 'AT'.repeat(10));
    const plan = planChannelTail({ messages: msgs, storedOrder: null, hasFrozenBatches: false, completedAt: after(msgs, 1801) });
    expect(plan.batches.map((b) => b.status)).toEqual(['frozen', 'frozen']);
    expect(plan.batches[0]).toMatchObject({ first_message_id: '1', last_message_id: '40', message_count: 40, audio_count: 20 });
    const open = planChannelTail({ messages: msgs, storedOrder: null, hasFrozenBatches: false, completedAt: null });
    expect(open.batches.map((b) => b.status)).toEqual(['frozen', 'open']);
  });
  it('keeps the last batch open when the import is not completed or ended within the gap', () => {
    const msgs = at(20);
    expect(planChannelTail({ messages: msgs, storedOrder: null, hasFrozenBatches: false, completedAt: null }).batches[0].status).toBe('open');
    expect(planChannelTail({ messages: msgs, storedOrder: null, hasFrozenBatches: false, completedAt: after(msgs, 1800) }).batches[0].status).toBe('open');
  });
  it('keeps the last batch open when it is smaller than the minimum', () => {
    const msgs = at(4);
    expect(planChannelTail({ messages: msgs, storedOrder: null, hasFrozenBatches: false, completedAt: after(msgs, 99999) }).batches[0].status).toBe('open');
  });
  it('keeps the stored order when frozen batches exist, and learns it otherwise', () => {
    const msgs = build('TA|TA|TA');
    expect(planChannelTail({ messages: msgs, storedOrder: 'audio_first', hasFrozenBatches: true, completedAt: null }).order).toBe('audio_first');
    expect(planChannelTail({ messages: msgs, storedOrder: 'audio_first', hasFrozenBatches: false, completedAt: null }).order).toBe('text_first');
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx jest tests/batching.test.ts`
Expected: FAIL, `Cannot find module '../src/batching'`.

- [ ] **Step 3: Implement `src/batching.ts`**

Follow `docs/batching.md` § The algorithm. Use a prefix sum of weights for `W(start, end)`. Cut scoring, as a tuple compared in order (all "higher is better"):

```ts
// cut before index i, prev = messages[i - 1], cur = messages[i]
const uncaptioned = (m) => m.is_audio && !m.has_text;
const isText = (m) => !m.is_audio && m.has_text;
const splitsTextFirst = isText(prev) && uncaptioned(cur);
const splitsAudioFirst = uncaptioned(prev) && isText(cur);
score = [
  order === 'text_first' ? !splitsTextFirst : !splitsAudioFirst,
  !splitsTextFirst && !splitsAudioFirst,
  gapSeconds(prev, cur),
  -Math.abs(W(start, i) - W(i, end)),
];
```

On equal scores take the lowest index. Merge step: repeat a single pass that merges the first batch with `W < minBatch` into the neighbor across the shorter gap whose merged `W <= maxBatch`, until no merge happens.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx jest tests/batching.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/batching.ts tests/batching.test.ts
git commit -m "feat(batching): add order-aware batch planner"
```

---

### Task 2: Batch storage and rebuild

**Files:**
- Modify: `src/services/db.service.ts` (schema, `deleteChannel`, new methods, shared SQL fragments)
- Test: `tests/db.service.test.ts`
- Modify: `docs/architecture.md` (schema section), `docs/pipeline.md` (contract list)

**Interfaces:**
- Consumes: Task 1 types (`TailPlanInput`, `TailPlan`, `ChannelOrder`, `BatchStatus`, `BATCH_STATUSES`, `CHANNEL_ORDERS`).
- Produces:
  ```ts
  export interface ChannelBatch {
    batch_no: number; first_message_id: string; last_message_id: string;
    message_count: number; audio_count: number; mapped_audio_count: number;
    status: BatchStatus; first_date: Date; last_date: Date; frozen_at: Date | null;
  }
  export interface BatchRebuildResult { order: ChannelOrder; batch_count: number; open_count: number }
  rebuildOpenBatches(channelId: string | number | bigint, plan: (input: TailPlanInput) => TailPlan): Promise<BatchRebuildResult | null>; // null = channel not tracked
  getChannelBatches(channelId): Promise<{ order: ChannelOrder | null; batches: ChannelBatch[] }>; // batches by batch_no
  getChannelBatch(channelId, batchNo: number): Promise<ChannelBatch | null>;
  ```

Schema (in `initializeSchema`, after `channel_mappings`):

```sql
ALTER TABLE telegram_channels ADD COLUMN IF NOT EXISTS batch_order TEXT;
CREATE TABLE IF NOT EXISTS channel_batches (
    channel_id BIGINT NOT NULL,
    batch_no INTEGER NOT NULL,
    first_message_id BIGINT NOT NULL,
    last_message_id BIGINT NOT NULL,
    message_count INTEGER NOT NULL,
    audio_count INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'frozen')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    frozen_at TIMESTAMPTZ,
    PRIMARY KEY (channel_id, batch_no)
);
```

Build the status list from `BATCH_STATUSES` the same way as `MAPPING_SOURCES`. Move the audio and text SQL expressions out of `getMappableMessageInfo` into module constants `IS_AUDIO_SQL` and `HAS_TEXT_SQL`, and use them in both queries.

`rebuildOpenBatches` statement order (one client, one transaction):

1. `BEGIN`
2. `SELECT status, import_completed_at, batch_order FROM telegram_channels WHERE channel_id = $1 FOR UPDATE` → no row: `ROLLBACK`, return `null`.
3. Freeze open batches with a mapped audio in range (`UPDATE channel_batches b SET status = 'frozen', frozen_at = NOW() WHERE b.channel_id = $1 AND b.status = 'open' AND EXISTS (SELECT 1 FROM channel_mappings m WHERE m.channel_id = b.channel_id AND m.media_message_id BETWEEN b.first_message_id AND b.last_message_id)`).
4. `SELECT batch_no, last_message_id::TEXT … WHERE status = 'frozen' ORDER BY batch_no DESC LIMIT 1`.
5. Read messages with `message_id > $2` (`'0'` when no frozen batch), ordered by `message_id`, as `BatchMessage` rows.
6. Call `plan({ messages, storedOrder, hasFrozenBatches, completedAt: status === 'completed' ? import_completed_at : null })`. Ignore a stored `batch_order` that is not in `CHANNEL_ORDERS`.
7. `DELETE FROM channel_batches WHERE channel_id = $1 AND status = 'open'`.
8. Insert planned batches numbered from last frozen `batch_no + 1` with one `unnest` insert; `frozen_at` is `NOW()` for frozen rows. Skip when there are none.
9. `UPDATE telegram_channels SET batch_order = $2 WHERE channel_id = $1`.
10. `COMMIT`. On error: `ROLLBACK`, `logger.error`, rethrow.

`getChannelBatches` / `getChannelBatch`: dates from `telegram_messages` rows at `first_message_id` and `last_message_id`; `mapped_audio_count` is the count of `channel_mappings` rows with `media_message_id` in range.

`deleteChannel`: add `DELETE FROM channel_batches WHERE channel_id = $1` right after the mappings delete.

- [ ] **Step 1: Write the failing tests** in `tests/db.service.test.ts`

```ts
describe('initializeSchema') → it('should create channel_batches and the batch_order column'):
  expect(sql).toContain('CREATE TABLE IF NOT EXISTS channel_batches');
  expect(sql).toContain("CHECK (status IN ('open', 'frozen'))");
  expect(sql).toContain('PRIMARY KEY (channel_id, batch_no)');
  expect(sql).toContain('ALTER TABLE telegram_channels ADD COLUMN IF NOT EXISTS batch_order TEXT');

describe('deleteChannel') → update the exact statement list: 'DELETE FROM channel_batches WHERE channel_id = $1' after the mappings delete.

describe('rebuildOpenBatches'):
  it('returns null and rolls back for an untracked channel')
    → result null; clientSql() ends with 'ROLLBACK'; plan not called.
  it('freezes open batches that have mappings before planning')
    → the freeze UPDATE comes before the frozen-batch SELECT, and before the messages SELECT.
  it('plans the tail after the last frozen batch and numbers batches after it')
    → last frozen row { batch_no: 7, last_message_id: '300' }; messages query params ['123', '300'];
      plan called with { hasFrozenBatches: true, storedOrder: 'text_first', completedAt: <import_completed_at> };
      insert params: batch_no [8, 9], statuses ['frozen', 'open'];
      returns { order: 'text_first', batch_count: 9, open_count: 1 }.
  it('passes completedAt null when the channel is not completed')
  it('starts from message 0 and learns the order when no frozen batch exists')
    → messages params ['123', '0']; plan input hasFrozenBatches false.
  it('rolls back and rethrows when a query fails')
```

Use a `mockClient.query.mockImplementation(async (sql) => …)` router keyed on SQL fragments, like `trackedChannelQueries` in the existing `replaceChannelMappings` suite.

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx jest tests/db.service.test.ts`
Expected: FAIL (`rebuildOpenBatches is not a function`, schema strings missing, delete list mismatch).

- [ ] **Step 3: Implement the schema, `deleteChannel` change, and the three methods**

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx jest tests/db.service.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Document the table** in `docs/architecture.md` (schema) and `docs/pipeline.md` (contract: batch ranges are stable once frozen).

- [ ] **Step 6: Commit**

```bash
git add src/services/db.service.ts tests/db.service.test.ts docs/architecture.md docs/pipeline.md
git commit -m "feat(db): store channel batches and rebuild tail"
```

---

### Task 3: Batch read and rebuild endpoints

**Files:**
- Modify: `src/server.ts`
- Test: `tests/server.test.ts`
- Modify: `docs/api.md`

**Interfaces:**
- Consumes: `DbService.getChannelBatches`, `DbService.rebuildOpenBatches`, `planChannelTail`.
- Produces:
  - `GET /api/channels/:channelId/batches` → `200 { success: true, channel_id, order, batches: ChannelBatch[] }`; `400 Invalid channel ID.`; `404 Channel not found.`
  - `POST /api/channels/:channelId/batches` → `200 { success: true, channel_id, order, batch_count, open_count }`; `400`; `404`; `409 { success: false, error: 'Batches are built after the import completes.' }` when the channel status is not `completed`. `rebuildOpenBatches` returning `null` → `404`.

Use the existing `channelIdParam`, `handleValidationErrors` and `findTrackedChannel` helpers.

- [ ] **Step 1: Write the failing tests** in `tests/server.test.ts` (add `getChannelBatches`, `getChannelBatch`, `rebuildOpenBatches`, `replaceBatchMappings` to the mock)

```
describe('GET /api/channels/:channelId/batches'):
  it('returns the batches and order')        → 200, body.order 'audio_first', body.batches length 2, getChannelBatches called with '123'
  it('returns 401 when unauthenticated')
  it('returns 400 for an invalid channel ID') → GET /api/channels/abc/batches
  it('returns 404 for an untracked channel')
  it('returns 500 when the query fails')

describe('POST /api/channels/:channelId/batches'):
  it('rebuilds a completed channel')          → 200 { batch_count: 9, open_count: 1 }; rebuildOpenBatches called with ('123', planChannelTail)
  it('returns 409 when the channel is not completed') → status 'running'; rebuildOpenBatches not called
  it('returns 404 when the channel is deleted during the rebuild') → rebuildOpenBatches resolves null
  it('returns 401 when unauthenticated')
  it('returns 400 for an invalid channel ID')
  it('returns 404 for an untracked channel')
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx jest tests/server.test.ts -t "batches"`
Expected: FAIL with 404 responses.

- [ ] **Step 3: Implement both routes inside `createServer()`** next to the mappings routes.

- [ ] **Step 4: Run them to make sure they pass**

Run: `npx jest tests/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Document both routes** in `docs/api.md` (new "Batches" section with the batch object, both routes and status tables).

- [ ] **Step 6: Commit**

```bash
git add src/server.ts tests/server.test.ts docs/api.md
git commit -m "feat(api): add channel batch endpoints"
```

---

### Task 4: Mappings per batch

**Files:**
- Modify: `src/services/db.service.ts`, `src/server.ts`
- Test: `tests/db.service.test.ts`, `tests/server.test.ts`
- Modify: `docs/api.md`

**Interfaces:**
- Consumes: `ChannelBatch`, `parseMappingsBody`, `describeMappingProblem`, `MAX_MAPPING_PROBLEMS`.
- Produces:
  ```ts
  export type BatchMappingsResult =
    | { status: 'ok'; count: number; updated_at: Date }
    | { status: 'not_found' }   // channel or batch gone
    | { status: 'conflict' };   // batch range changed since it was read
  replaceBatchMappings(channelId, batch: Pick<ChannelBatch, 'batch_no' | 'first_message_id' | 'last_message_id'>, mappings: MappingInput[]): Promise<BatchMappingsResult>;
  ```
  `PUT /api/channels/:channelId/batches/:batchNo/mappings` → `200 { success: true, channel_id, batch_no, count, updated_at }`; `400` (invalid IDs, body problems, audio outside range, bad JSON); `404 Channel not found.` / `Batch not found.`; `409 Batch changed while saving. Load it again.`; `413`.

`replaceBatchMappings` statements: `BEGIN` → channel lock (`FOR UPDATE`, missing → `not_found`) → `SELECT first_message_id::TEXT, last_message_id::TEXT FROM channel_batches WHERE channel_id = $1 AND batch_no = $2` (missing → `not_found`; different range → `conflict`) → `DELETE FROM channel_mappings WHERE channel_id = $1 AND media_message_id BETWEEN $2 AND $3` → insert (same `unnest` insert as `replaceChannelMappings`; extract it into a private helper) → `UPDATE channel_batches SET status = 'frozen', frozen_at = COALESCE(frozen_at, NOW()) WHERE channel_id = $1 AND batch_no = $2` → `SELECT NOW()` → `COMMIT`. Every early return does `ROLLBACK`.

Server: extract the stored-message check from the PUT mappings handler into a helper `checkStoredMessages(channelId, mappings, problems): Promise<void>` inside `createServer`, and use it in both handlers. Before it, the batch handler adds a problem `{ index, field: 'media_message_id', reason: 'is not in batch <n>.' }` for each audio with `BigInt(id)` outside `[first, last]`. Register the batch PUT path on the existing pre-parser (`app.put([MAPPINGS_PATH, BATCH_MAPPINGS_PATH], …)`), so bad JSON gives `400`. Validate `:batchNo` with `param('batchNo').isInt({ min: 1, max: 2147483647 }).toInt()` and the message `Invalid batch number.`

- [ ] **Step 1: Write the failing tests**

```
tests/db.service.test.ts › describe('replaceBatchMappings'):
  it('replaces only the batch range and freezes the batch') → statement order as above; DELETE params ['123', '41', '80']
  it('returns not_found for an untracked channel or a missing batch') → ROLLBACK, no DELETE
  it('returns conflict when the batch range changed') → stored range '41'..'90' vs passed '41'..'80'; ROLLBACK, no DELETE

tests/server.test.ts › describe('PUT /api/channels/:channelId/batches/:batchNo/mappings'):
  it('stores the batch mappings')                → 200 { batch_no: 2, count: 1 }
  it('accepts a text outside the batch range')   → text '5', audio '50' in batch 41..80 → 200
  it('rejects audio outside the batch range')    → audio '90' → 400, error 'mappings[0].media_message_id is not in batch 2.'
  it('returns 404 for a missing batch')          → getChannelBatch resolves null → 'Batch not found.'
  it('returns 409 when the batch range changed') → replaceBatchMappings resolves { status: 'conflict' }
  it('returns 400 for an invalid batch number')  → /batches/0/mappings → 'Invalid batch number.'
  it('returns 400 for invalid JSON')
  it('returns 401 when unauthenticated')
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx jest -t "Batch"`
Expected: FAIL.

- [ ] **Step 3: Implement `replaceBatchMappings`, the shared insert helper, `checkStoredMessages`, and the route**

- [ ] **Step 4: Run the full suite**

Run: `npx tsc --noEmit && npm test`
Expected: only the known `config.test.ts › DASHBOARD_PASSWORD` failure.

- [ ] **Step 5: Document the route** in `docs/api.md` (Batches section).

- [ ] **Step 6: Commit**

```bash
git add src/services/db.service.ts src/server.ts tests/db.service.test.ts tests/server.test.ts docs/api.md
git commit -m "feat(api): save mappings per batch"
```

---

### Task 5: Rebuild on import completion

**Files:**
- Modify: `src/importer.ts`
- Test: `tests/importer.test.ts`
- Modify: `docs/status.md`, `CLAUDE.md`, `docs/architecture.md` (data flow)

**Interfaces:**
- Consumes: `DbService.rebuildOpenBatches`, `planChannelTail`.

In `importChannel`, after `updateChannelStatus(resolvedId, 'completed')`, call `this.rebuildBatches(resolvedId, resolvedTitle)`: a private method that awaits `rebuildOpenBatches(channelId, planChannelTail)`, logs `logger.info` with the batch and open counts, and on error logs `logger.error(msg, err)` without changing the channel status.

- [ ] **Step 1: Write the failing tests** in `tests/importer.test.ts`

```
describe('importChannel batching'):
  setup: getChannelEntity → { id: BigInt(123), title: 'T', username: 'u' }; getChannelProgress → { last_processed_message_id: '5' };
         executeWithRetry → resolves [] (no new messages)
  it('rebuilds the batches after the import completes')
    → rebuildOpenBatches called with ('123', planChannelTail), after updateChannelStatus('123', 'completed')
  it('keeps the channel completed when the rebuild fails')
    → rebuildOpenBatches rejects; updateChannelStatus never called with 'failed'
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx jest tests/importer.test.ts`
Expected: FAIL, `rebuildOpenBatches` not called.

- [ ] **Step 3: Implement the hook**

- [ ] **Step 4: Run the full suite**

Run: `npx tsc --noEmit && npm test`
Expected: only the known config failure.

- [ ] **Step 5: Update the docs**: `CLAUDE.md` code map row for `src/batching.ts`; `docs/status.md` changelog entry, the "Processing chunks" open question answered by `docs/batching.md`, and known issue 5 noting that a re-queued channel rebuilds its tail; `docs/architecture.md` data flow.

- [ ] **Step 6: Commit**

```bash
git add src/importer.ts tests/importer.test.ts CLAUDE.md docs/status.md docs/architecture.md
git commit -m "feat(importer): rebuild batches on completion"
```

---

### Task 6: Check against the local data

**Files:** none committed.

- [ ] **Step 1:** Run the planner over the local `telegram_archive` export (`channel_id, message_id, ts, is_audio, has_text`) with a throwaway `ts-node` script, and compare with `docs/batching.md` § Results: batch count near 3,205, max size 50, 0 pairs cut.
- [ ] **Step 2:** If the numbers differ, explain the difference in `docs/batching.md` (for example, photos with captions now count as text) and commit as `docs(batching): record results on local data`.
