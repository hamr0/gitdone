# Event creation form — v1 (Design Lab synthesis)

**Shipped:** 2026-04-18 as commit 1.H.2.1 — Design Lab variant F, iteration 2.
**Route:** `GET /events/new`, `POST /events` in `app/bin/server.js`.

This doc is a frozen reference for the v1 shape so future Design Lab runs
can diff against it instead of re-deriving the rationale.

## Design decisions (from user feedback)

1. **Numbered section headers** (1 What+Who, 2 How, 3 Steps). Small, muted,
   with a blue circled numeral. Pulled from variant A; users said the
   What/Who/How captioning made the form "self-explanatory".
2. **What + Who on one row, How on its own row.** Iteration-2 compaction
   pass explicitly requested by the user ("what who can be at one step
   same line, second line how, more compaction").
3. **Inline dropdown explanations** — each `<option>` carries its own
   hyphenated description (e.g. `sequential — one after another`, `verified
   — strict DKIM + DMARC`). Pulled from variant A; users clicked on the
   flow dropdown twice to mark "this self explanatory thing is good".
4. **Compact step table** (borderless inputs, hover-to-reveal) instead of
   per-step fieldsets. Pulled from variant C.
5. **`datetime-local` deadlines** (date + time) — users wanted time on
   deadlines, not just date.
6. **Palette:** accent `#0645ad`, body `#222`, code `#f3f3f3`. Matches
   the layout chrome in `app/src/web/templates.js`.

## Variants archived

During the session we explored A (info hierarchy), B (timeline), C
(density), D (progressive disclosure), E (conversational). Two finalists
(A, C) → synthesised into F1 → compacted into F2 (this ship).

## Source files at finalize time

- `app/bin/server.js::renderWorkflowForm` — live implementation.
- CSS is the `WORKFLOW_FORM_CSS` const above the function. Keep it
  co-located unless a second form reuses it — then extract to
  `app/src/web/form-styles.js`.

## Form markup structure

```
<form class="vf-form" method="POST" action="/events" data-variant-root="F">
  <h2><span class="num">1</span>What + Who <span class="hint">…</span></h2>
  <div class="vf-section">
    <div class="vf-row">
      <label><span>Title</span><input name="title"></label>
      <label><span>Your email</span><input name="initiator"></label>
    </div>
  </div>

  <h2><span class="num">2</span>How <span class="hint">…</span></h2>
  <div class="vf-section">
    <div class="vf-row">
      <label><span>Flow</span><select name="flow">…</select></label>
      <label><span>Minimum trust</span><select name="min_trust_level">…</select></label>
    </div>
  </div>

  <h2><span class="num">3</span>Steps <span class="hint">N · each gets a unique reply-to</span></h2>
  <div class="vf-section">
    <table class="vf-steps-table">
      <thead><tr><th>#</th><th>Step</th><th>Participant</th><th>Deadline</th><th>att</th></tr></thead>
      <tbody>…rows…</tbody>
    </table>
    <p class="vf-add-row"><button formaction="/events/new" formmethod="GET" name="_add_step" value="1">+ add step</button></p>
  </div>

  <button type="submit" class="vf-submit">Create event</button>
</form>
```

## What to reuse next time

- Numbered-header pattern (`h2 > .num + text + .hint`) is the canonical
  section header for gitdone forms. Reuse verbatim on the crypto event
  form (1.H.3) and management dashboard (1.H.5).
- `vf-row` two-column grid that collapses to one column below 540px.
- `vf-steps-table` for any repeated-row data entry where per-row
  fieldsets would be noisy.
- "+ add row" submit-button-as-link pattern lets multi-step forms grow
  without JavaScript.
