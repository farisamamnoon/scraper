// Splits a channel's messages into batches for Stage 2 mapping. Pure functions: no I/O.
// The rules and the data behind them are in docs/batching.md.

export const GAP_SECONDS = 1800;
export const MIN_BATCH = 10;
export const MAX_BATCH = 50;

export const CHANNEL_ORDERS = ['audio_first', 'text_first'] as const;
export type ChannelOrder = (typeof CHANNEL_ORDERS)[number];

/** `frozen` batches never change; the `open` last batch can be replaced by the next rebuild. */
export const BATCH_STATUSES = ['open', 'frozen'] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export interface BatchLimits {
  gapSeconds: number;
  minBatch: number;
  maxBatch: number;
}

export const DEFAULT_LIMITS: BatchLimits = { gapSeconds: GAP_SECONDS, minBatch: MIN_BATCH, maxBatch: MAX_BATCH };

/** A stored message as the planner sees it, in message_id order. */
export interface BatchMessage {
  message_id: string;
  date: Date;
  is_audio: boolean;
  has_text: boolean;
}

export interface PlannedBatch {
  first_message_id: string;
  last_message_id: string;
  /** Weighted size: audio messages plus non-audio messages with text. */
  message_count: number;
  audio_count: number;
  status: BatchStatus;
}

export interface TailPlanInput {
  /** Messages after the last frozen batch, in message_id order. */
  messages: BatchMessage[];
  storedOrder: ChannelOrder | null;
  hasFrozenBatches: boolean;
  /** import_completed_at when the channel is completed, else null. */
  completedAt: Date | null;
}

export interface TailPlan {
  order: ChannelOrder;
  batches: PlannedBatch[];
}

interface Range {
  start: number;
  end: number;
}

const isText = (m: BatchMessage): boolean => !m.is_audio && m.has_text;
const isUncaptionedAudio = (m: BatchMessage): boolean => m.is_audio && !m.has_text;
const weight = (m: BatchMessage): number => (m.is_audio || m.has_text ? 1 : 0);
const gapSeconds = (a: BatchMessage, b: BatchMessage): number => (b.date.getTime() - a.date.getTime()) / 1000;

/**
 * Learns whether descriptions come before or after their audio, from isolated two-message sessions.
 * A tie or no votes gives audio_first, the most common order.
 */
export function learnChannelOrder(messages: BatchMessage[], gap = GAP_SECONDS): ChannelOrder {
  let textFirst = 0;
  let audioFirst = 0;
  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1];
    const cur = messages[i];
    if (gapSeconds(prev, cur) > gap) continue;
    const isolatedLeft = i === 1 || gapSeconds(messages[i - 2], prev) > gap;
    const isolatedRight = i === messages.length - 1 || gapSeconds(cur, messages[i + 1]) > gap;
    if (!isolatedLeft || !isolatedRight) continue;
    if (isText(prev) && isUncaptionedAudio(cur)) textFirst++;
    if (isUncaptionedAudio(prev) && isText(cur)) audioFirst++;
  }
  return textFirst > audioFirst ? 'text_first' : 'audio_first';
}

/** Cuts messages into batches. Returns index ranges, end exclusive, covering every message. */
export function splitIntoBatches(
  messages: BatchMessage[],
  order: ChannelOrder,
  limits: BatchLimits = DEFAULT_LIMITS
): Range[] {
  const n = messages.length;
  if (n === 0) return [];
  const prefix = [0];
  for (const m of messages) prefix.push(prefix[prefix.length - 1] + weight(m));
  const size = (start: number, end: number) => prefix[end] - prefix[start];
  const gapBefore = (i: number) => gapSeconds(messages[i - 1], messages[i]);

  // 1. Natural sessions.
  const sessions: Range[] = [];
  let start = 0;
  for (let i = 1; i < n; i++) {
    if (gapBefore(i) > limits.gapSeconds) {
      sessions.push({ start, end: i });
      start = i;
    }
  }
  sessions.push({ start, end: n });

  // 2. Split oversized sessions at the best cut. Scores compare element by element, higher first.
  const score = (i: number, range: Range): number[] => {
    const prev = messages[i - 1];
    const cur = messages[i];
    const splitsTextFirst = isText(prev) && isUncaptionedAudio(cur);
    const splitsAudioFirst = isUncaptionedAudio(prev) && isText(cur);
    const safe = order === 'text_first' ? !splitsTextFirst : !splitsAudioFirst;
    return [
      safe ? 1 : 0,
      !splitsTextFirst && !splitsAudioFirst ? 1 : 0,
      gapBefore(i),
      -Math.abs(size(range.start, i) - size(i, range.end)),
    ];
  };
  const better = (a: number[], b: number[]) => {
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] > b[k];
    return false;
  };
  const split = (range: Range): Range[] => {
    if (size(range.start, range.end) <= limits.maxBatch) return [range];
    let candidates: number[] = [];
    for (let i = range.start + 1; i < range.end; i++) {
      if (size(range.start, i) >= limits.minBatch && size(i, range.end) >= limits.minBatch) candidates.push(i);
    }
    if (candidates.length === 0) {
      for (let i = range.start + 1; i < range.end; i++) candidates.push(i);
    }
    let best = candidates[0];
    let bestScore = score(best, range);
    for (const i of candidates.slice(1)) {
      const s = score(i, range);
      if (better(s, bestScore)) {
        best = i;
        bestScore = s;
      }
    }
    return [...split({ start: range.start, end: best }), ...split({ start: best, end: range.end })];
  };
  const batches = sessions.flatMap(split);

  // 3. Merge undersized batches into the neighbor across the shorter gap, while the result fits.
  let merged = true;
  while (merged && batches.length > 1) {
    merged = false;
    for (let k = 0; k < batches.length; k++) {
      const { start: s, end: e } = batches[k];
      if (size(s, e) >= limits.minBatch) continue;
      const options: Array<{ gap: number; neighbor: number }> = [];
      if (k > 0 && size(batches[k - 1].start, e) <= limits.maxBatch) {
        options.push({ gap: gapBefore(s), neighbor: k - 1 });
      }
      if (k < batches.length - 1 && size(s, batches[k + 1].end) <= limits.maxBatch) {
        options.push({ gap: gapBefore(e), neighbor: k + 1 });
      }
      if (options.length === 0) continue;
      const { neighbor } = options.reduce((a, b) => (b.gap < a.gap ? b : a));
      const first = Math.min(k, neighbor);
      batches.splice(first, 2, { start: batches[first].start, end: batches[first + 1].end });
      merged = true;
      break;
    }
  }
  return batches;
}

/**
 * Plans the batches for a channel tail and decides which are frozen: all but the last, and the last
 * only when the import completed more than gapSeconds after it and it reaches minBatch.
 */
export function planChannelTail(input: TailPlanInput, limits: BatchLimits = DEFAULT_LIMITS): TailPlan {
  const { messages } = input;
  const order =
    input.hasFrozenBatches && input.storedOrder ? input.storedOrder : learnChannelOrder(messages, limits.gapSeconds);
  const ranges = splitIntoBatches(messages, order, limits);

  const batches = ranges.map(({ start, end }, k): PlannedBatch => {
    const slice = messages.slice(start, end);
    const last = slice[slice.length - 1];
    const messageCount = slice.reduce((sum, m) => sum + weight(m), 0);
    const isLast = k === ranges.length - 1;
    const tailClosed =
      input.completedAt !== null && (input.completedAt.getTime() - last.date.getTime()) / 1000 > limits.gapSeconds;
    return {
      first_message_id: slice[0].message_id,
      last_message_id: last.message_id,
      message_count: messageCount,
      audio_count: slice.filter((m) => m.is_audio).length,
      status: !isLast || (tailClosed && messageCount >= limits.minBatch) ? 'frozen' : 'open',
    };
  });
  return { order, batches };
}
