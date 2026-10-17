import { BatchMessage, learnChannelOrder, planChannelTail, splitIntoBatches } from '../src/batching';

/**
 * Builds messages from a compact spec, one per character, IDs from 1:
 * A = uncaptioned audio, C = captioned audio, T = text, o = photo without text,
 * U = text that starts with an up arrow, D = text that ends with a down arrow.
 * '|' adds no message and puts a 2-hour gap before the next one.
 */
function build(spec: string, stepSeconds = 10): BatchMessage[] {
  const messages: BatchMessage[] = [];
  let time = Date.parse('2024-01-01T00:00:00Z');
  let pendingGap = 0;
  for (const ch of spec) {
    if (ch === '|') {
      pendingGap += 2 * 3600 * 1000;
      continue;
    }
    if (messages.length > 0) time += stepSeconds * 1000 + pendingGap;
    pendingGap = 0;
    messages.push({
      message_id: String(messages.length + 1),
      date: new Date(time),
      is_audio: ch === 'A' || ch === 'C',
      has_text: ch === 'C' || ch === 'T' || ch === 'U' || ch === 'D',
      text_head: ch === 'U' ? '⬆️ Lecture 5' : ch === 'T' || ch === 'D' ? 'Lecture 5' : '',
      has_down_arrow: ch === 'D',
    });
  }
  return messages;
}

const shift = (messages: BatchMessage[], seconds: number) =>
  messages.forEach((m) => (m.date = new Date(m.date.getTime() + seconds * 1000)));

describe('learnChannelOrder', () => {
  it('votes with isolated pairs', () => {
    expect(learnChannelOrder(build('AT|AT|TA'))).toBe('audio_first');
    expect(learnChannelOrder(build('TA|TA|AT'))).toBe('text_first');
  });

  it('gives audio_first on a tie or with no votes', () => {
    expect(learnChannelOrder(build('AT|TA'))).toBe('audio_first');
    expect(learnChannelOrder(build('A|T'))).toBe('audio_first');
  });

  it('weighs pairs inside a longer session like isolated ones', () => {
    // Changed on purpose: the old learner skipped TATATA. Now it gives text_first 1.5 and audio_first 1,
    // and the last AT adds 0.5 to audio_first, so the vote ties and gives audio_first.
    expect(learnChannelOrder(build('TATATA|AT'))).toBe('audio_first');
    expect(learnChannelOrder(build('TATATA|TA'))).toBe('text_first');
  });

  it('reads a header followed by audio runs as text_first', () => {
    expect(learnChannelOrder(build('TAAA|TAAA'))).toBe('text_first');
  });

  it('counts a run only within the gap of the text', () => {
    // Steps of 1000 s: the second audio is 2000 s after the text, outside the 1800 s gap. The run is 1, so
    // text_first gets 0.5, and the AT pair gives audio_first 0.5. A tie gives audio_first (a run of 2 would not).
    expect(learnChannelOrder(build('TAA|AT', 1000))).toBe('audio_first');
  });

  it('reads an up arrow after an audio as audio_first, over the text_first of the following run', () => {
    // Each AU pair: audio_first 1 + 0.5; the next audio is 2 hours away, so no text_first vote.
    expect(learnChannelOrder(build('AU|AU|AU'))).toBe('audio_first');
    // With the arrow, AUAA|AUAA votes audio_first 1.5 and text_first 1 (run of 2) per text.
    expect(learnChannelOrder(build('AUAA|AUAA'))).toBe('audio_first');
    // The arrow tips it: without it, TA|TA|AT gives text_first 1 against audio_first 0.5.
    expect(learnChannelOrder(build('TA|TA|AT'))).toBe('text_first');
    expect(learnChannelOrder(build('TA|TA|AU'))).toBe('audio_first');
  });

  it('reads a down arrow before an audio as text_first', () => {
    expect(learnChannelOrder(build('DA|DA|DA'))).toBe('text_first');
    // Without the arrow a tie of AT and TA gives audio_first; the arrow tips it.
    expect(learnChannelOrder(build('AT|TA'))).toBe('audio_first');
    expect(learnChannelOrder(build('AT|DA'))).toBe('text_first');
  });

  it('ignores an up arrow that is not in the first 40 characters', () => {
    const messages = build('AT|AT|TA');
    messages[1].text_head = 'x'.repeat(40);
    expect(learnChannelOrder(messages)).toBe('audio_first');
  });

  it('skips photos without text when it looks for neighbors', () => {
    expect(learnChannelOrder(build('TooAoA'))).toBe('text_first');
  });
});

describe('splitIntoBatches', () => {
  it('cuts at gaps longer than gapSeconds', () => {
    expect(splitIntoBatches(build('AT|AT'), 'audio_first', { gapSeconds: 1800, minBatch: 1, maxBatch: 10 })).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it('merges small batches into the neighbor across the shorter gap', () => {
    // Sessions ATAT, AT, ATAT; the small middle one is closer to the third.
    const messages = build('ATAT|AT|ATAT');
    shift(messages.slice(6), -3600);
    expect(splitIntoBatches(messages, 'audio_first', { gapSeconds: 1800, minBatch: 3, maxBatch: 10 })).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 10 },
    ]);
  });

  it('does not count photos without text toward the size', () => {
    expect(splitIntoBatches(build('oooooAT'), 'audio_first', { gapSeconds: 1800, minBatch: 1, maxBatch: 2 })).toEqual([
      { start: 0, end: 7 },
    ]);
  });

  it('keeps pairs together in a same-timestamp burst', () => {
    const messages = build('AT'.repeat(400), 0);
    const batches = splitIntoBatches(messages, 'audio_first');
    expect(batches[0].start).toBe(0);
    expect(batches[batches.length - 1].end).toBe(800);
    for (const { start, end } of batches) {
      expect(end - start).toBeLessThanOrEqual(50);
      expect(end - start).toBeGreaterThanOrEqual(10);
      expect(messages[start].is_audio).toBe(true);
      expect(messages[end - 1].is_audio).toBe(false);
    }
  });

  it('cuts after the audio in a text_first burst', () => {
    const messages = build('TA'.repeat(100), 0);
    for (const { start, end } of splitIntoBatches(messages, 'text_first')) {
      expect(messages[start].is_audio).toBe(false);
      expect(messages[end - 1].is_audio).toBe(true);
    }
  });

  it('keeps the maximum strict for one text before a long audio run', () => {
    const batches = splitIntoBatches(build('T' + 'A'.repeat(120), 1), 'text_first');
    expect(batches.length).toBeGreaterThanOrEqual(3);
    for (const { start, end } of batches) {
      expect(end - start).toBeLessThanOrEqual(50);
      expect(end - start).toBeGreaterThanOrEqual(10);
    }
  });

  it('prefers a cut that is safe for both orders', () => {
    // 0A 1T 2A 3T 4A 5T 6C 7C 8A 9T: cuts before 6, 7 and 8 are safe for both orders; 6 is the most equal.
    expect(
      splitIntoBatches(build('ATATATCCAT', 0), 'audio_first', { gapSeconds: 1800, minBatch: 2, maxBatch: 6 })
    ).toEqual([
      { start: 0, end: 6 },
      { start: 6, end: 10 },
    ]);
  });

  it('prefers the longest gap among safe cuts', () => {
    const messages = build('ATATATAT', 10);
    shift(messages.slice(6), 600);
    expect(splitIntoBatches(messages, 'audio_first', { gapSeconds: 1800, minBatch: 2, maxBatch: 6 })).toEqual([
      { start: 0, end: 6 },
      { start: 6, end: 8 },
    ]);
  });
});

describe('planChannelTail', () => {
  const after = (messages: BatchMessage[], seconds: number) =>
    new Date(messages[messages.length - 1].date.getTime() + seconds * 1000);

  it('returns no batches for no messages', () => {
    expect(planChannelTail({ messages: [], storedOrder: null, hasFrozenBatches: false, completedAt: null })).toEqual({
      order: 'audio_first',
      batches: [],
    });
  });

  it('freezes every batch but the last, and the last when the tail is closed and big enough', () => {
    const messages = build('AT'.repeat(20) + '|' + 'AT'.repeat(10));
    const closed = planChannelTail({
      messages,
      storedOrder: null,
      hasFrozenBatches: false,
      completedAt: after(messages, 1801),
    });
    expect(closed.batches.map((b) => b.status)).toEqual(['frozen', 'frozen']);
    expect(closed.batches[0]).toMatchObject({
      first_message_id: '1',
      last_message_id: '40',
      message_count: 40,
      audio_count: 20,
    });

    const open = planChannelTail({ messages, storedOrder: null, hasFrozenBatches: false, completedAt: null });
    expect(open.batches.map((b) => b.status)).toEqual(['frozen', 'open']);
  });

  it('keeps the last batch open when the import is not completed or ended within the gap', () => {
    const messages = build('AT'.repeat(20));
    expect(
      planChannelTail({ messages, storedOrder: null, hasFrozenBatches: false, completedAt: null }).batches[0].status
    ).toBe('open');
    expect(
      planChannelTail({ messages, storedOrder: null, hasFrozenBatches: false, completedAt: after(messages, 1800) })
        .batches[0].status
    ).toBe('open');
  });

  it('keeps the last batch open when it is smaller than the minimum', () => {
    const messages = build('AT'.repeat(4));
    expect(
      planChannelTail({ messages, storedOrder: null, hasFrozenBatches: false, completedAt: after(messages, 99999) })
        .batches[0].status
    ).toBe('open');
  });

  it('keeps the stored order when frozen batches exist, and learns it otherwise', () => {
    const messages = build('TA|TA|TA');
    expect(planChannelTail({ messages, storedOrder: 'audio_first', hasFrozenBatches: true, completedAt: null }).order).toBe(
      'audio_first'
    );
    expect(planChannelTail({ messages, storedOrder: 'audio_first', hasFrozenBatches: false, completedAt: null }).order).toBe(
      'text_first'
    );
  });
});
