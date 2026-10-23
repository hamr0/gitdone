# Terminal Theme v1 — site-wide retro aesthetic

**Frozen:** 2026-04-19 (supersedes prior light-theme variants for landing,
crypto form, event form, management dashboard).

**Origin:** Design Lab synthesis Variant F (A+C hybrid). Started from a
terminal/mono aesthetic (A) and layered C's hierarchy choices (oversized
wordmark, heavy two-cell layout with inverted second panel). Amber
replaces C's warning-tape yellow — reads as CRT phosphor, not
construction site.

## Palette

| Token | Hex | Use |
|---|---|---|
| bg | `#0d1117` | page background (GitHub-dark) |
| surface | `#161b22` | form inputs, subtle fills, chips |
| border | `#30363d` | section borders, input borders |
| border-soft | `#21262d` | table row dividers |
| text | `#c9d1d9` | body text |
| text-muted | `#8b949e` | labels, captions, inactive |
| text-dim | `#6e7681` | footer, placeholder numerics |
| green | `#3fb950` | primary accent, CTAs, success, cursor |
| amber | `#ffb000` | secondary accent, code, hover, warning-tape |
| blue | `#58a6ff` | links |
| red | `#f85149` | destructive (close event) |

Semantic rule: **green = action/success**, **amber = emphasis/hover**,
**blue = link**, **red = destructive only**. Never mix amber with red —
they clash.

## Typography

- Primary font: `JetBrains Mono`, `ui-monospace`, `SF Mono`, `Menlo`,
  `Consolas`, `monospace` fallback chain.
- Body size: 15px/1.55.
- Headings: same font, 600–700 weight, `-0.01em` letter-spacing.
- Section labels (`h2`): uppercase, 0.78em, letter-spacing 0.12em, muted
  color. Often prefixed with a bracketed or keycap-style counter.
- Hero wordmark (landing only): `clamp(2.4rem, 8vw, 4.4rem)`, weight 700,
  letter-spacing `-0.04em`. Amber `/` slash with phosphor text-shadow.
- Blinking cursor (`█`) on landing — 1.1s steps, green with soft glow.

## Components

- **Buttons (primary):** `#3fb950` fill, `#0d1117` text, uppercase,
  letter-spacing 0.05em. Hover flips to amber fill. No border-radius.
- **Buttons (secondary):** transparent bg, green border + green text.
  Hover inverts.
- **Inputs:** `#161b22` bg, `#30363d` border, `#c9d1d9` text. Focus →
  green border + subtle green glow. No border-radius.
- **Tables:** 1px `#30363d` outer border, row dividers in `#21262d`.
  Headers in `#161b22`, muted-color uppercase small-caps.
- **Pills / status chips:** outlined (1px border matches text color),
  transparent fill, uppercase, letter-spacing 0.1em, no radius.
- **Code:** `#161b22` bg, `#ffb000` text, tiny 2px radius (one of the
  few places radius is allowed).
- **ASCII accents:** `◢` for numbered options, `●` for status dots,
  `▸` for list arrows. Used sparingly.

## Layout

- Main container: `max-width: 720px`, centered, 2rem top margin.
- Sections: thin 2px left rule (`#30363d`) with 1.55rem padding —
  conveys hierarchy without heavy headers.
- Corner diagonal-stripe warning-tape: on the landing card only, as a
  small 82×82px accent. Don't repeat it on other pages — the landing
  earns it as the "entry" moment.

## Form conventions

Interaction/content patterns for forms — palette-independent, carried
forward from the pre-theme Design Lab work (merged here from the retired
`DESIGN_MEMORY.md`). All verified live in `app/bin/server.js` /
`app/src/web/templates.js`.

- **Inline dropdown explanations.** Every `<option>` carries an em-dash
  description (`accumulating — every email counts`, `verified — strict
  DKIM + DMARC`). Users repeatedly flagged this as what makes the form
  self-explanatory — keep it on any new `<select>`.
- **"+ add row" without JavaScript.** Repeated-row entry (the step table)
  grows via `<button type="submit" formaction="/events/new"
  formmethod="GET" name="_add_step" value="1">`; submitting GETs the same
  page with all current values in the query string, so the server
  re-renders with one more row (`_remove_step` removes one). No client JS.
  Reuse this for any add/remove-row UI.
- **`datetime-local`** for time-sensitive fields (deadlines), never bare
  `date`.
- **Compact step table.** Borderless inputs inside `vf-steps-table`; the
  input border appears on focus and a row-hover tint reveals field edges —
  avoids the visual weight of per-row `<fieldset>`s.
- **Error block at the top.** `.vf-errors` — one block above the form
  (`#0d1117` bg, `#f85149` left rule, `#f0b8b8` text), uppercase label,
  bulleted one-line-per-error list. PRD §0.1.4: point at what to fix in
  one line, no field-by-field wall.

Dense-grid / segmented-control-mode-row / dim-in-place conditional-field
patterns for short (~6-field) forms live in `landing-and-crypto-v1.md`.

## Motion

- Transitions: 120ms on bg/color only. No transforms, no scale effects.
- Single animated element: the landing wordmark cursor blink (1.1s
  steps, pure on/off — no ease).
- Respect `prefers-reduced-motion` implicitly (steps() does).

## Where this theme lives in code

- **Base:** `app/src/web/templates.js` → `layout()`. Every page inherits
  the palette, font, input/button/table defaults from here.
- **Landing:** `app/bin/server.js` → `LANDING_CSS` (`.vF` class family).
- **Workflow form:** `app/bin/server.js` → `WORKFLOW_FORM_CSS`.
- **Crypto form:** `app/bin/server.js` → `CRYPTO_FORM_CSS`.
- **Management dashboard:** `app/bin/server.js` → `MANAGE_CSS`.

## Invariants — do not change without revisiting the theme

1. Monospace everywhere. The character of the site depends on uniform
   glyph width, including in body copy.
2. No border-radius on structural elements (cards, buttons, inputs,
   pills). Tiny 2px radius permitted only on inline code chips.
3. Green = action, amber = emphasis. Never use amber for a CTA.
4. Blinking cursor is a landing-only ornament; don't sprinkle it
   elsewhere.
5. Corner warning-tape is landing-only.
