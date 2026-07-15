# Dashboard UI: Live Polling — No-Flicker DOM Update Pattern

> Rule for AI agents modifying the JavaScript in `public/index.html`.
> Evidence: previous implementation replaced `innerHTML` every 2 seconds, causing all
> channel rows to re-animate. This pattern was identified and fixed.

---

## The Problem

The dashboard polls `/api/progress` every 2 seconds via `setInterval`. If `renderChannels`
replaces `element.innerHTML` on every poll, the browser destroys and rebuilds all DOM nodes
each cycle. This causes:
- CSS entry animations re-triggering on every refresh (visible flicker)
- Loss of any active hover/focus state
- Unnecessary browser layout work

## The Required Pattern: Keyed In-Place Update

Use a serialised channel-ID key to detect whether the **set of channels** has changed.
Only rebuild the DOM when channels are added or removed. On the common polling tick (same
channels, only stats changed), patch text content in-place.

```javascript
let _channelKey = '';   // serialised id list; empty string = "not rendered yet"

function renderChannels(channels) {
  if (!channels || channels.length === 0) {
    _channelKey = '';
    listEl.innerHTML = '<div class="empty-row">…</div>';
    return;
  }

  const newKey = channels.map(c => c.channel_id).join(',');

  if (newKey === _channelKey) {
    // ── IN-PLACE UPDATE (most common path) ──────────────────
    // No DOM rebuild. Patch only what can change between polls.
    channels.forEach(ch => {
      const row = document.getElementById(`cr-${ch.channel_id}`);
      if (!row) return;

      // 1. Status class (affects border-left color and background)
      row.className = `ch-row ${ch.status}`;

      // 2. Status pill text + class
      const pill = row.querySelector('.pill');
      if (pill) { pill.className = `pill ${ch.status}`; pill.textContent = ch.status; }

      // 3. Numeric fields — only write if value actually changed (avoids layout thrash)
      const msgsEl = row.querySelector('.js-msgs');
      const newMsgs = fmt(ch.message_count);
      if (msgsEl && msgsEl.textContent !== newMsgs) msgsEl.textContent = newMsgs;

      const idEl   = row.querySelector('.js-lastid');
      const newId  = String(ch.last_processed_message_id || '—');
      if (idEl && idEl.textContent !== newId) idEl.textContent = newId;
    });
    return;
  }

  // ── FULL REBUILD (only when channel set changes) ────────────
  _channelKey = newKey;
  listEl.innerHTML = channels.map(ch => `
    <div class="ch-row ${ch.status}" id="cr-${ch.channel_id}" onclick="…">
      …
      <div class="row-msgs js-msgs">${fmt(ch.message_count)}</div>
      <div class="row-lastid js-lastid">${ch.last_processed_message_id || '—'}</div>
      <div class="row-status"><span class="pill ${ch.status}">${ch.status}</span></div>
      …
    </div>`).join('');
}
```

## Mandatory Conventions

1. **Row IDs**: Every channel row must have `id="cr-${channel_id}"` so in-place patching
   can find it with `document.getElementById`.

2. **Patchable field classes**: Fields that change between polls (`message_count`,
   `last_processed_message_id`, `status`) must carry a stable class: `js-msgs`,
   `js-lastid`. Do not use positional selectors like `:nth-child(2)`.

3. **No CSS animations on rebuilt rows only**: Entry animations (e.g., `row-in`) must
   use `animation-fill-mode: both` and `animation-delay` only during the initial build.
   Do not unconditionally apply entry animations to the `.ch-row` selector if those rows
   will be rebuilt on every poll.

4. **Stats are always patched in-place**: The stat numbers (`stat-msgs`, `stat-chans`,
   `stat-active`) are updated directly by targeting their element IDs:
   ```javascript
   statMsgs.textContent = fmt(s.total_messages);
   ```
   Never rebuild the stats strip HTML.

5. **Poll interval**: Keep at 2000ms (`setInterval(fetchProgress, 2000)`). Do not
   reduce below 1000ms.

## Anti-Patterns (Do Not Do)

```javascript
// ❌ WRONG — full rebuild on every poll tick
setInterval(async () => {
  const data = await fetch('/api/progress').then(r => r.json());
  channelsGrid.innerHTML = data.channels.map(renderCard).join(''); // flickers!
}, 2000);

// ❌ WRONG — rebuilding stats HTML
statsEl.innerHTML = `<div>${data.stats.total_messages}</div>…`;
```
