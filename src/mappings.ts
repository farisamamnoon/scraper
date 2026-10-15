import { MAPPING_SOURCES } from './services/db.service';
import type { MappingInput, MappingSource } from './services/db.service';

// Request rules for PUT /api/channels/:channelId/mappings. The route handlers live in server.ts.

export const MAX_MAPPINGS = 50000;
export const MAX_MAPPING_PROBLEMS = 20;
export const MAPPINGS_BODY_LIMIT = '5mb';
const MAX_BIGINT = BigInt('9223372036854775807');
const mappingSources: readonly string[] = MAPPING_SOURCES;

export interface MappingProblem {
  index?: number;
  field: string;
  reason: string;
}

/**
 * Parses a Telegram ID sent as a digit string or an integer into its canonical digit string.
 * Returns null unless it is a positive integer that fits in BIGINT.
 */
export function parseTelegramId(value: unknown): string | null {
  let digits: string;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    digits = value;
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    digits = value.toString();
  } else {
    return null;
  }
  const id = BigInt(digits);
  if (id <= BigInt(0) || id > MAX_BIGINT) return null;
  return id.toString();
}

/**
 * Checks the shape of a PUT mappings body. Returns the normalized mappings, or the problems found.
 */
export function parseMappingsBody(body: unknown): { mappings: MappingInput[]; problems: MappingProblem[] } {
  const raw = (body as { mappings?: unknown } | null | undefined)?.mappings;
  if (!Array.isArray(raw)) {
    return { mappings: [], problems: [{ field: 'mappings', reason: 'must be an array.' }] };
  }
  if (raw.length > MAX_MAPPINGS) {
    return { mappings: [], problems: [{ field: 'mappings', reason: `must contain at most ${MAX_MAPPINGS} items.` }] };
  }

  const mappings: MappingInput[] = [];
  const problems: MappingProblem[] = [];
  const seenMedia = new Map<string, number>();

  raw.forEach((item: unknown, index: number) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      problems.push({ index, field: 'mappings', reason: 'must be an object.' });
      return;
    }
    const fields = item as Record<string, unknown>;
    const textId = parseTelegramId(fields.text_message_id);
    const mediaId = parseTelegramId(fields.media_message_id);
    const source = (fields.source ?? 'unknown') as MappingSource;

    if (!textId) problems.push({ index, field: 'text_message_id', reason: 'must be a positive integer message ID.' });
    if (!mediaId) problems.push({ index, field: 'media_message_id', reason: 'must be a positive integer message ID.' });
    if (!mappingSources.includes(source)) {
      problems.push({ index, field: 'source', reason: `must be one of: ${mappingSources.join(', ')}.` });
    }
    if (mediaId) {
      const firstIndex = seenMedia.get(mediaId);
      if (firstIndex !== undefined) {
        problems.push({ index, field: 'media_message_id', reason: `duplicate of index ${firstIndex}; an audio can map to one text only.` });
      } else {
        seenMedia.set(mediaId, index);
      }
    }
    if (textId && mediaId) {
      mappings.push({ text_message_id: textId, media_message_id: mediaId, source });
    }
  });

  return { mappings, problems };
}

export const describeMappingProblem = (problem: MappingProblem): string =>
  problem.index === undefined
    ? `${problem.field} ${problem.reason}`
    : `mappings[${problem.index}].${problem.field} ${problem.reason}`;
