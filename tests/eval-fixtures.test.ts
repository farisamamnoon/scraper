import { EvalBatchInput, EvalFixture, serializeEvalFixture, toEvalBatch } from '../src/eval-fixtures';
import type { StoredMessageRow } from '../src/services/db.service';

const row = (id: string, json: Record<string, unknown>, date = '2025-01-01T10:00:00.000Z'): StoredMessageRow => ({
  id: Number(id),
  channel_id: '1438886321',
  message_id: id,
  message_date: new Date(date),
  telegram_json: { date, text: '', ...json },
  media_key: null,
  imported_at: new Date(date),
});

const audio = (id: string, text = '', date?: string) =>
  row(id, { text, media: { media_type: 'audio', mime_type: 'audio/mpeg', file_name: `${id}.mp3` } }, date);
const text = (id: string, body: string, date?: string) => row(id, { text: body }, date);
const photo = (id: string) => row(id, { text: '', media: { media_type: 'photo', mime_type: 'image/jpeg' } });

function input(overrides: Partial<EvalBatchInput> = {}): EvalBatchInput {
  return {
    channel: { channel_id: '1438886321', channel_username: 'tholobulilm' },
    batch: { batch_no: 7, first_message_id: '10', last_message_id: '20' },
    order: 'text_first',
    // Newest first, as getBatchMessages returns them.
    messages: [audio('14'), photo('13'), audio('12', 'Lecture 5 caption'), text('11', 'Lecture 5'), text('10', '  ')],
    contextMessage: text('9', 'Earlier header'),
    linkedMessages: [text('5', 'Linked outside text')],
    mappings: [
      { media_message_id: '14', text_message_id: '5' },
      { media_message_id: '12', text_message_id: '12' },
      { media_message_id: '99', text_message_id: '11' },
    ],
    deleted: [],
    ...overrides,
  };
}

describe('toEvalBatch', () => {
  it('maps rows to the fixture shape', () => {
    const batch = toEvalBatch(input());
    expect(batch).toMatchObject({
      channelHandle: 'tholobulilm',
      channelId: '1438886321',
      batchNo: 7,
      order: 'text_first',
      legacyOrder: null,
    });
    expect(batch.messages.map((m) => m.id)).toEqual(['11', '12', '14']);
    expect(batch.messages[2]).toEqual({
      id: '14',
      date: '2025-01-01T10:00:00.000Z',
      text: '',
      isAudio: true,
      fileName: '14.mp3',
      mediaType: 'audio',
    });
    expect(batch.contextMessage).toMatchObject({ id: '9', text: 'Earlier header', isAudio: false, fileName: null });
    expect(batch.linkedMessages.map((m) => m.id)).toEqual(['5']);
  });

  it('keeps a captioned audio as audio with its text', () => {
    const captioned = toEvalBatch(input()).messages.find((m) => m.id === '12');
    expect(captioned).toMatchObject({ isAudio: true, text: 'Lecture 5 caption' });
  });

  it('drops a photo without text and a whitespace-only text', () => {
    const ids = toEvalBatch(input()).messages.map((m) => m.id);
    expect(ids).not.toContain('13');
    expect(ids).not.toContain('10');
  });

  it('keeps a photo with a caption as a text message', () => {
    const withCaption = row('13', { text: 'Photo caption', media: { media_type: 'photo' } });
    const message = toEvalBatch(input({ messages: [withCaption] })).messages[0];
    expect(message).toMatchObject({ id: '13', isAudio: false, text: 'Photo caption', mediaType: 'photo' });
  });

  it('writes expected only for mapped audio of the range, ids as strings', () => {
    expect(toEvalBatch(input()).expected).toEqual({ '14': '5', '12': '12' });
  });

  it('keeps BigInt-size ids as strings and sorts them as numbers', () => {
    const big = '9007199254740993';
    const bigger = '9007199254740995';
    const batch = toEvalBatch(
      input({
        batch: { batch_no: 1, first_message_id: big, last_message_id: bigger },
        messages: [audio(bigger), text(big, 'Header')],
        mappings: [{ media_message_id: bigger, text_message_id: big }],
        contextMessage: null,
        linkedMessages: [],
      })
    );
    expect(batch.messages.map((m) => m.id)).toEqual([big, bigger]);
    expect(batch.expected).toEqual({ [bigger]: big });
  });

  it('falls back to the handle-less channel id', () => {
    const batch = toEvalBatch(input({ channel: { channel_id: '55', channel_username: null } }));
    expect(batch.channelHandle).toBe('55');
  });

  it('uses the ISO date of telegram_json, not the local-time column', () => {
    const odd = { ...audio('14'), message_date: new Date('2025-01-01T15:30:00.000Z') };
    expect(toEvalBatch(input({ messages: [odd] })).messages[0].date).toBe('2025-01-01T10:00:00.000Z');
  });

  describe('deleted messages', () => {
    it('drops an audio deleted as audio and its label', () => {
      const batch = toEvalBatch(input({ deleted: [{ message_id: '14', role: 'audio' }] }));
      expect(batch.messages.map((m) => m.id)).toEqual(['11', '12']);
      expect(batch.expected).toEqual({ '12': '12' });
    });

    it('keeps the text side of a captioned audio deleted as audio', () => {
      const batch = toEvalBatch(input({ deleted: [{ message_id: '12', role: 'audio' }] }));
      expect(batch.messages.find((m) => m.id === '12')).toMatchObject({ isAudio: false, text: 'Lecture 5 caption' });
      expect(batch.expected).toEqual({ '14': '5' });
    });

    it('blanks the text of a message deleted as text and drops labels that use it', () => {
      const batch = toEvalBatch(input({ deleted: [{ message_id: '12', role: 'text' }] }));
      expect(batch.messages.find((m) => m.id === '12')).toMatchObject({ isAudio: true, text: '' });
      expect(batch.expected).toEqual({ '14': '5' });
    });

    it('drops a text-only message deleted as text', () => {
      const batch = toEvalBatch(input({ deleted: [{ message_id: '11', role: 'text' }] }));
      expect(batch.messages.map((m) => m.id)).toEqual(['12', '14']);
    });
  });
});

describe('serializeEvalFixture', () => {
  const fixture: EvalFixture = { version: 1, source: 'test', batches: [toEvalBatch(input())] };

  it('returns JSON that round-trips', () => {
    expect(JSON.parse(serializeEvalFixture(fixture))).toEqual(fixture);
  });

  it('refuses a file over the limit', () => {
    expect(() => serializeEvalFixture(fixture, 100)).toThrow(/over the 100 byte limit/);
  });
});
