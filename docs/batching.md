# Message batching for Stage 2

A large channel has thousands of messages, and a person can't map and check them in one view. The scraper splits each channel into **batches**: short runs of consecutive messages that the mapper shows one at a time. This page explains the rules, the data behind them, and how batches stay stable when a channel gets new messages.

## Goals

- A batch is small enough to check in one sitting: about 10 to 50 messages.
- A batch never separates an audio message from the text that describes it.
- A batch that a person has started to map never changes.
- A later scrape adds new batches after the existing ones.

A fixed batch size can't meet the second goal, because a cut at message 50 can fall between an audio and its description. The batcher uses the time gaps and the channel's posting order instead.

## What the data shows

These numbers come from the local copy of production: 92 channels, 86,608 messages.

| Observation | Number | Effect on the design |
|---|---|---|
| Gaps between consecutive messages fall into two groups | 31% are under 5 minutes, most others are hours to days | A gap over 30 minutes is a safe cut |
| Audio messages with their own caption | 65% (17,778 of 27,462) | Only about 9,700 audio messages need a separate text |
| Distance from an uncaptioned audio to its nearest text | Median 44 s, p90 23 min | Pairs sit inside one burst |
| Natural sessions (cut at 30 minutes) | 67% are 1 message, p90 is 2 | The minimum size, not the gap, shapes most batches |
| Bulk uploads | 22 bursts over 50 messages, the largest is 824 messages with one timestamp | The gap can't split them, so the posting order must |
| Posting order | Most channels post audio then text; some post text then audio; 11 of 92 mix both | The order is learned per channel |

## Terms

- **Weighted size**: the number of messages in a batch that the user maps or checks. An audio message counts 1. A non-audio message with non-whitespace text counts 1. Other messages (photos without text, videos, empty messages) count 0.
- **Uncaptioned audio**: an audio message with no text. It needs a separate text message.
- **Text message**: a non-audio message with non-whitespace text. Audio and text use the same rules as `PUT …/mappings`.
- **Channel order**: `audio_first` (an audio, then its description) or `text_first` (a description, then its audio).
- **Safe cut**: a cut between two messages that does not separate an uncaptioned audio from the text next to it, on the side the channel order gives.

## The algorithm

The constants are `GAP_SECONDS = 1800`, `MIN_BATCH = 10` and `MAX_BATCH = 50`. Every size below is a weighted size. Messages are in `message_id` order. Their dates also increase in that order (checked on all 86,608 messages).

### 1. Learn the channel order

Find the isolated pairs: two consecutive messages with a gap of 30 minutes or less between them, and more than 30 minutes (or the channel start or end) on each outer side.

- A text and then an uncaptioned audio counts for `text_first`.
- An uncaptioned audio and then a text counts for `audio_first`.

The order with more votes wins. A tie, or no votes, gives `audio_first`, which is the most common order in the data.

### 2. Cut into sessions

Cut at every gap longer than `GAP_SECONDS`.

### 3. Split sessions larger than `MAX_BATCH`

Split recursively. A candidate cut must leave at least `MIN_BATCH` on each side. If no candidate does, every position is a candidate. Choose the candidate with the highest score, compared in this order:

1. Is it a safe cut for the channel order?
2. Is it safe for both orders? (This helps the channels that mix orders.)
3. How long is the gap before it?
4. How equal are the two sides? (Closer to equal is better.)

The maximum is strict. If the run is one header text followed by more than `MAX_BATCH` audio files, the cut falls inside the run. The text stays mappable from every batch, because a mapping can use a text from any batch of the channel.

### 4. Merge batches smaller than `MIN_BATCH`

Merge a small batch with the neighbor across the shorter gap, if the result is not larger than `MAX_BATCH`. Repeat until no merge is possible.

### Results on the local data

| MIN / MAX | Batches | Size p50 / p90 / max | Pairs cut |
|---|---|---|---|
| 10 / 50 | 3,205 | 16 / 27 / 50 | 0 of 6,725 |
| 15 / 40 | 2,244 | 25 / 36 / 40 | 0 of 6,725 |

The 824-message burst becomes 25 batches of 18 to 46. No mapping data existed when this was tested, so "pairs cut" counts an uncaptioned audio and the text next to it on the channel-order side. Test again against real mappings when the mapper has produced them.

## Stable batches

Each batch is stored in `channel_batches` as a range `[first_message_id, last_message_id]` with a status:

- **`frozen`**: the batch never changes. Only a channel delete removes it.
- **`open`**: the batch is the end of the channel. The next rebuild can replace it.

### Rebuilds

A rebuild runs when an import completes and on `POST /api/channels/:channelId/batches`. One transaction, under the channel row lock, does these steps:

1. Freeze every open batch that has a mapping for one of its audio messages. A person started on it, so it must not change.
2. Find the last frozen batch. Its `last_message_id` is the start of the tail, and the next `batch_no` follows it.
3. Read the stored channel order. If no frozen batch exists, learn the order again from all messages. If a frozen batch exists, keep the stored order, because the frozen batches were cut with it.
4. Plan the batches for all messages after the tail start.
5. Delete the open batches. Insert the planned batches.

### When a planned batch is frozen

- Every planned batch except the last is frozen. A later message can't change it.
- The last batch is frozen only if both of these are true:
  - The import is `completed`, and its `import_completed_at` is more than `GAP_SECONDS` after the last message. Then nothing that comes later can join that session.
  - Its weighted size is at least `MIN_BATCH`.

  Otherwise the last batch stays `open`, and the next rebuild merges it with the new messages.

A resumed scrape adds only messages after the last stored ID (see the pagination rule in `.claude/rules/importer-pipeline.md`). A rebuild therefore only adds to the end. Messages that were edited or deleted on Telegram after the first scrape are not fetched again.

### Mappings per batch

`PUT /api/channels/:channelId/batches/:batchNo/mappings` replaces only the mappings whose audio is inside the batch range. The audio must be in the batch, and the text can be any text message of the channel. Two people can then map different batches of one channel at the same time. The write also freezes the batch.

## Not in scope

- **A mapper UI for batches.** The UI lives in `../telegram-pipeline-ui`.
- **Resuming completed channels automatically.** `completed` is still a final status. To get new messages, set the channel to `pending` (see known issue 5 in [status.md](status.md)). The import then rebuilds the batches when it completes.
- **Telegram albums (`groupedId`).** `extractCleanJson` doesn't store it. Storing it would let the batcher never cut inside an album, but only for messages imported after the change.
- **Showing a series header in a later batch.** The UI can look for the last text before a batch that starts with uncaptioned audio.
