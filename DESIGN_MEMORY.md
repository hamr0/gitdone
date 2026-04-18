# Design Memory

Locked-in patterns established through the Design Lab process. Reuse
these on new forms/pages instead of re-deriving; run Design Lab only
for genuinely novel UI (not for variations that already have a
precedent here).

## Typography & layout

- Body font: `ui-sans-serif, system-ui, sans-serif` at 16px/1.5 (set
  in `app/src/web/templates.js::layout`).
- Max content width: 640px for text pages; forms can fill to 640 and
  use a two-column `vf-row` grid that collapses to one column ≤ 540px.
- Section headers use a numbered-circle pattern:
  `h2 > span.num + text + span.hint`. Muted label style (uppercase,
  0.82em, `#555`), blue circled numeral (`#0645ad` on white).

## Palette

- Accent / links: `#0645ad` (hover `#053590`)
- Body: `#222`
- Muted text / hints: `#555` – `#888` – `#999` (use `#666` for meta,
  `#888` for dropdown hints, `#999` for tabular row numbers)
- Rule/divider: `#ddd`
- Code chip bg: `#f3f3f3`
- Table hover: `#fafafa`

## Dense-grid form (crypto pattern)

For forms with ~6 fields or fewer, drop numbered section headers in
favour of a flat 2-column grid. See `docs/01-product/design/landing-and-crypto-v1.md`.

- **Segmented-control mode row** at the top for binary/ternary mode
  choices: `[ mode-a | mode-b ]` with an inline right-aligned hint
  describing the selected mode.
- **Dim-in-place conditional fields.** When a field doesn't apply to
  the picked mode, add class `dim` (opacity 0.42, pointer-events none)
  and a `::after` label suffix (e.g. "· declaration only"). Keeps
  layout stable across mode switches.
- **No step/wizard.** A one-page form with conditional dimming beats
  a two-step wizard for this field count.
- **Small "Create →" button, right-aligned.** Less ceremonial than
  the numbered-sections form's full-width primary.

## Form conventions

- **Inline dropdown explanations:** every `<option>` carries a hyphenated
  description. E.g. `sequential — one after another`, `verified — strict
  DKIM + DMARC`. Users repeatedly flagged this as making the form
  self-explanatory; keep doing it.
- **Time-sensitive fields use `datetime-local`,** not `date` alone.
- **Compact data tables** (`vf-steps-table` style) for any repeated-row
  entry. Borderless inputs, border appears on focus, row hover tint
  reveals field edges. Avoids the visual weight of per-row `<fieldset>`.
- **"+ add row" pattern:** a `<button type="submit" formaction="..."
  formmethod="GET" name="_add_step" value="1">` inside the main form.
  Submitting it GETs the same page with all current values in the
  query string, so the server can re-render with one more row. No
  JavaScript required.
- **Error block:** light red (`#fee` bg, `#c99` border) at the top of
  the form, bulleted list of short strings. Principle §0.1.4: errors
  point at what to fix in one line, no field-by-field wall.

## Chrome

- Dev HUD is injected automatically when the server runs with `--dev`
  (wraps `layout()` in `server.js`). Don't add it to individual pages.
- Footer is shared in `layout()`. A `DEV MODE` badge appears only in
  dev.

## Non-goals (explicit)

- No client-side framework, no bundler, no CSS preprocessor.
- No JS required for core flows. Progressive enhancement only.
- No branded chrome. Principle §0.1.4: invisible beats correct.
