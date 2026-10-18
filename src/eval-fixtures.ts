import type { ChannelOrder } from './batching';
import type { ChannelBatch, ChannelMapping, DeletionInput, StoredMessageRow } from './services/db.service';

// Pure builder of the eval fixture the mapper UI's offline harness reads (`EvalFixtureSchema` in the UI repo,
// `lib/automation/eval-fixture.ts`). The export script `scripts/export-eval-fixtures.ts` reads the rows and writes the
// file. See docs/pipeline.md, "Eval fixture export".

/** An export larger than this is refused, so a wrong channel cannot dump a huge file. */
export const EVAL_FIXTURE_MAX_BYTES = 1_000_000;

export interface EvalMessage {
  id: string;
  /** ISO 8601, UTC. */
  date: string;
  text: string;
  isAudio: boolean;
  fileName: string | null;
  mediaType: string | null;
}

export interface EvalBatch {
  channelHandle: string;
  channelId: string;
  batchNo: number;
  order: ChannelOrder;
  legacyOrder: ChannelOrder | null;
  /** Audio messages and messages with text of the batch range, oldest first. */
  messages: EvalMessage[];
  contextMessage: EvalMessage | null;
  linkedMessages: EvalMessage[];
  /** audio id -> text id, only for audio with a stored mapping. */
  expected: Record<string, string | null>;
}

export interface EvalFixture {
  version: 1;
  source: string;
  batches: EvalBatch[];
}

export interface EvalBatchInput {
  channel: { channel_id: string; channel_username: string | null };
  batch: Pick<ChannelBatch, 'batch_no' | 'first_message_id' | 'last_message_id'>;
  /** The order stored for the channel (`telegram_channels.batch_order`). */
  order: ChannelOrder;
  /** Every stored message of the batch range, any order. */
  messages: StoredMessageRow[];
  contextMessage: StoredMessageRow | null;
  linkedMessages: StoredMessageRow[];
  /** Stored mappings of the channel. Only those whose audio is in the batch range are used. */
  mappings: Pick<ChannelMapping, 'media_message_id' | 'text_message_id'>[];
  /** Stored deletions of the batch range. */
  deleted: DeletionInput[];
}

/** The audio rule of the scraper (`IS_AUDIO_SQL` in db.service.ts). */
function isAudioJson(json: any): boolean {
  const media = json?.media;
  return media?.media_type === 'audio' || media?.media_type === 'voice' || String(media?.mime_type ?? '').startsWith('audio/');
}

/**
 * The date as ISO UTC. `telegram_json.date` is exact; `message_date` is a TIMESTAMP that node-pg reads as local time,
 * so it is only the fallback.
 */
function isoDate(row: StoredMessageRow): string {
  const jsonDate = row.telegram_json?.date;
  if (typeof jsonDate === 'string' && !Number.isNaN(Date.parse(jsonDate))) return new Date(jsonDate).toISOString();
  return new Date(row.message_date).toISOString();
}

function toEvalMessage(row: StoredMessageRow): EvalMessage {
  const json = row.telegram_json ?? {};
  return {
    id: String(row.message_id),
    date: isoDate(row),
    text: typeof json.text === 'string' ? json.text : '',
    isAudio: isAudioJson(json),
    fileName: json.media?.file_name ?? null,
    mediaType: json.media?.media_type ?? null,
  };
}

const hasText = (m: EvalMessage) => m.text.trim() !== '';

/**
 * Builds one fixture batch from stored rows. Deleted messages are excluded: a message deleted as audio is no longer
 * audio, a message deleted as text has no text, and one with neither side left is dropped. Mappings that use a
 * deleted audio or a deleted text are not labels, so they are left out of `expected`.
 */
export function toEvalBatch(input: EvalBatchInput): EvalBatch {
  const first = BigInt(input.batch.first_message_id);
  const last = BigInt(input.batch.last_message_id);
  const deletedAudio = new Set(input.deleted.filter((d) => d.role === 'audio').map((d) => String(d.message_id)));
  const deletedText = new Set(input.deleted.filter((d) => d.role === 'text').map((d) => String(d.message_id)));

  const messages = input.messages
    .map(toEvalMessage)
    .map((m) => ({
      ...m,
      isAudio: m.isAudio && !deletedAudio.has(m.id),
      text: deletedText.has(m.id) ? '' : m.text,
    }))
    .filter((m) => m.isAudio || hasText(m))
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));

  const audioIds = new Set(messages.filter((m) => m.isAudio).map((m) => m.id));
  const expected: Record<string, string | null> = {};
  for (const mapping of input.mappings) {
    const audioId = String(mapping.media_message_id);
    const textId = String(mapping.text_message_id);
    const inRange = BigInt(audioId) >= first && BigInt(audioId) <= last;
    if (inRange && audioIds.has(audioId) && !deletedText.has(textId)) expected[audioId] = textId;
  }

  return {
    channelHandle: input.channel.channel_username ?? input.channel.channel_id,
    channelId: String(input.channel.channel_id),
    batchNo: input.batch.batch_no,
    order: input.order,
    legacyOrder: null,
    messages,
    contextMessage: input.contextMessage ? toEvalMessage(input.contextMessage) : null,
    linkedMessages: input.linkedMessages.map(toEvalMessage),
    expected,
  };
}

/** Serializes the fixture. Throws when the file would be over `EVAL_FIXTURE_MAX_BYTES`. */
export function serializeEvalFixture(fixture: EvalFixture, maxBytes: number = EVAL_FIXTURE_MAX_BYTES): string {
  const json = `${JSON.stringify(fixture, null, 2)}\n`;
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > maxBytes) {
    throw new Error(`Fixture is ${bytes} bytes, over the ${maxBytes} byte limit. Export fewer batches with --batches.`);
  }
  return json;
}
