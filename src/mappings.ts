import { DELETION_ROLES, MAPPING_SOURCES } from './services/db.service';
import type { DeletionInput, DeletionRole, MappingInput, MappingSource } from './services/db.service';

// Request rules for the PUT mappings routes (the channel and the batch one), including the batch `deleted` list.
// The route handlers live in server.ts.

export const MAX_MAPPINGS = 50000;
export const MAX_MAPPING_PROBLEMS = 20;
export const MAPPINGS_BODY_LIMIT = '5mb';
const MAX_BIGINT = BigInt('9223372036854775807');
const mappingSources: readonly string[] = MAPPING_SOURCES;
const deletionRoles: readonly string[] = DELETION_ROLES;

export interface MappingProblem {
  /** The body list the item is in. Absent means `mappings`. */
  list?: 'deleted';
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

/**
 * Checks the shape of the optional `deleted` list of a batch PUT body. Returns `deleted: undefined` when the field is
 * absent (the stored deletions stay as they are), else the normalized list. Also reports a deleted audio or text
 * that a mapping of the same body uses, so pass the mappings returned by parseMappingsBody.
 */
export function parseDeletedBody(
  body: unknown,
  mappings: MappingInput[]
): { deleted: DeletionInput[] | undefined; problems: MappingProblem[] } {
  const raw = (body as { deleted?: unknown } | null | undefined)?.deleted;
  if (raw === undefined) return { deleted: undefined, problems: [] };
  if (!Array.isArray(raw)) {
    return { deleted: [], problems: [{ field: 'deleted', reason: 'must be an array.' }] };
  }
  if (raw.length > MAX_MAPPINGS) {
    return { deleted: [], problems: [{ field: 'deleted', reason: `must contain at most ${MAX_MAPPINGS} items.` }] };
  }

  const audioMappingIndex = new Map<string, number>();
  const textMappingIndex = new Map<string, number>();
  mappings.forEach((mapping, index) => {
    audioMappingIndex.set(mapping.media_message_id, index);
    if (!textMappingIndex.has(mapping.text_message_id)) textMappingIndex.set(mapping.text_message_id, index);
  });

  const deleted: DeletionInput[] = [];
  const problems: MappingProblem[] = [];
  const seen = new Map<string, number>();

  raw.forEach((item: unknown, index: number) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      problems.push({ list: 'deleted', index, field: 'deleted', reason: 'must be an object.' });
      return;
    }
    const fields = item as Record<string, unknown>;
    const messageId = parseTelegramId(fields.message_id);
    const role = fields.role;
    const validRole = typeof role === 'string' && deletionRoles.includes(role);

    if (!messageId) {
      problems.push({ list: 'deleted', index, field: 'message_id', reason: 'must be a positive integer message ID.' });
    }
    if (!validRole) {
      problems.push({ list: 'deleted', index, field: 'role', reason: `must be one of: ${deletionRoles.join(', ')}.` });
    }
    if (!messageId || !validRole) return;

    const key = `${messageId}:${role}`;
    const firstIndex = seen.get(key);
    if (firstIndex !== undefined) {
      problems.push({
        list: 'deleted',
        index,
        field: 'message_id',
        reason: `duplicate of index ${firstIndex}; each message and role can be deleted once.`
      });
      return;
    }
    seen.set(key, index);

    if (role === 'audio' && audioMappingIndex.has(messageId)) {
      problems.push({
        list: 'deleted',
        index,
        field: 'message_id',
        reason: `is the audio of mappings[${audioMappingIndex.get(messageId)}]; a deleted audio cannot be mapped.`
      });
    }
    if (role === 'text' && textMappingIndex.has(messageId)) {
      problems.push({
        list: 'deleted',
        index,
        field: 'message_id',
        reason: `is the text of mappings[${textMappingIndex.get(messageId)}]; a deleted text cannot be mapped.`
      });
    }
    deleted.push({ message_id: messageId, role: role as DeletionRole });
  });

  return { deleted, problems };
}

export const describeMappingProblem = (problem: MappingProblem): string => {
  if (problem.index === undefined) return `${problem.field} ${problem.reason}`;
  const list = problem.list ?? 'mappings';
  // An item that is not an object has no field of its own to name.
  if (problem.list && problem.field === list) return `${list}[${problem.index}] ${problem.reason}`;
  return `${list}[${problem.index}].${problem.field} ${problem.reason}`;
};
