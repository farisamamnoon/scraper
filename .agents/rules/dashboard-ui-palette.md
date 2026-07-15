# Dashboard UI: Palette and Color Contract

> Rule for AI agents modifying `public/index.html` or any frontend file in this project.
> Evidence: designed and iterated in the actual dashboard (`public/index.html`).

---

## Rule

The dashboard uses a **strict neutral-dark palette**. No blue-tinted blacks, no purple/indigo
gradients, no glassmorphism, no glowing orbs. All color must come from status states only.

### Exact Token Values (do not change without instruction)

```css
:root {
  --bg:        #111111;  /* page background  */
  --surface:   #1a1a1a;  /* cards, topbar    */
  --surface-2: #222222;  /* hover states     */
  --border:    #2d2d2d;  /* default borders  */
  --border-2:  #3d3d3d;  /* focus/emphasis   */
  --text:      #ededed;  /* primary text     */
  --text-2:    #888888;  /* secondary text   */
  --text-3:    #555555;  /* placeholder/muted*/

  /* Status — the ONLY hue in the UI */
  --s-pending: #52525b;
  --s-running: #3b82f6;
  --s-done:    #22c55e;
  --s-failed:  #ef4444;
}
```

### What Is Forbidden

- **No indigo/purple gradients** (e.g., `linear-gradient(…#6366f1…#a855f7…)`)
- **No glassmorphism** (`backdrop-filter: blur(…)` on page-level panels; only permitted
  on the modal overlay scrim)
- **No glowing blob pseudo-elements** (`.hero::before` radial gradient orbs)
- **No multi-color accent gradients** on text or borders
- **No `box-shadow` pulse animations** on status badges
- **No non-status color accents** — any new feature must use the existing tokens only

### Status Pill Pattern

Status is communicated through two signals only: a **3px left border** on the row
and a **small pill** next to the status column. Never use background fills on the full row.

```css
.ch-row.pending   { border-left-color: var(--s-pending); }
.ch-row.running   { border-left-color: var(--s-running); background: rgba(59,130,246,0.03); }
.ch-row.completed { border-left-color: var(--s-done); }
.ch-row.failed    { border-left-color: var(--s-failed); }

.pill.pending   { color: #a1a1aa; background: rgba(113,113,122,0.12); }
.pill.running   { color: #93c5fd; background: rgba(59,130,246,0.13);  }
.pill.completed { color: #86efac; background: rgba(34,197,94,0.12);   }
.pill.failed    { color: #fca5a5; background: rgba(239,68,68,0.12);   }
```

### Why This Matters

The default output of most AI models drifts toward indigo/purple glassmorphism because
that pattern is statistically over-represented in training data. This rule exists to
override that default and maintain a deliberate, tool-appropriate aesthetic.
