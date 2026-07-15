# Dashboard UI: Typography and Layout System

> Rule for AI agents modifying `public/index.html`.
> Evidence: established in the dashboard redesign; the previous Inter/Outfit combination
> was rejected by the user as "AI-ish".

---

## Fonts

Load **IBM Plex Sans** (UI labels, headings, body) and **IBM Plex Mono** (data values, IDs,
filenames, code). Both are from Google Fonts.

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
```

**Do not change these fonts** unless explicitly instructed. In particular, do NOT substitute:
- `Outfit` — used in previous version, rejected
- `Inter` alone — too generic, associated with AI-generated UIs
- `Space Grotesk`, `DM Sans` — not used here

### Type Scale

| Use case           | Font            | Size  | Weight | Letter-spacing |
|--------------------|-----------------|-------|--------|----------------|
| Page title/stat    | IBM Plex Sans   | 24px  | 600    | -0.04em        |
| Channel name       | IBM Plex Sans   | 13px  | 500    | -0.01em        |
| Section label      | IBM Plex Sans   | 11px  | 500    | +0.09em, ALL CAPS |
| Column header      | IBM Plex Sans   | 11px  | 500    | +0.07em, ALL CAPS |
| Body / snippets    | IBM Plex Sans   | 13px  | 400    | 0              |
| Topbar brand       | IBM Plex Sans   | 13px  | 600    | -0.01em        |
| Numeric data       | IBM Plex Mono   | 13px  | 400    | 0 (tabular)    |
| IDs, paths, mono   | IBM Plex Mono   | 11-12px| 400   | 0              |
| JSON panel         | IBM Plex Mono   | 11.5px | 400  | 0, line-height 1.7 |

Apply `font-variant-numeric: tabular-nums` to all numeric data to prevent layout shift
during polling updates.

---

## Layout

### Topbar (header)

The topbar is a **48px tall sticky bar**, not a hero section. Keep it at exactly 48px.

```css
.topbar {
  height: 48px;
  position: sticky;
  top: 0;
  z-index: 20;
}
```

Never expand the header into a hero with large titles, taglines, or decorative backgrounds.
The header carries: brand mark (24×24px icon) + app name + separator + subtitle (left),
and a live status indicator (right). Nothing else.

### Page container

```css
.page {
  max-width: 860px;
  margin: 0 auto;
  padding: 28px 20px 80px;
}
```

### Component border-radius scale

| Component          | border-radius |
|--------------------|---------------|
| Page panels        | 8px           |
| Buttons, inputs    | 6px           |
| Pills/badges       | 4px           |
| Modal/drawer       | 12px          |
| Brand mark icon    | 6px           |

Do not use `border-radius: 24px` on list containers (previous version, rejected).

### Spacing

Use 8px base unit multiples. Common values: 4, 8, 12, 14, 16, 20, 24, 28, 32.
Avoid arbitrary values like `1.75rem` or `1.25rem`.

---

## Interaction Patterns

### Hover states

- Rows: `background: rgba(255,255,255,0.025)` — no border-color change, no transform
- Buttons: `opacity: 0.85`, no translateY
- Links: `background: var(--border)` swap

No `transform: translateY(-4px)` on hover (previous version, rejected as overdone).

### Transitions

Limit to: `background 0.12s`, `opacity 0.12s`, `transform 0.12s`.
No `transition: all 0.3s cubic-bezier(…)` — this over-smooths and feels "AI-generated".

### Primary button

```css
.add-btn {
  background: var(--text);   /* near-white */
  color: var(--bg);          /* dark text on light button */
  font-weight: 600;
}
```

White-on-dark inverted button. No gradient fills on the primary action.
