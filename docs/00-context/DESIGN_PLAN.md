# Design Plan

Remaining UI surfaces in Phase 1 and how the Design Lab applies to each.

## Shipped

- **1.H.2.1 — Event creation form** (`/events/new`). Design Lab
  synthesis winner (variant F2). Reference: `docs/01-product/design/event-form-v1.md`.
- **1.H.4 — Magic-link management URL + email** (`/manage/:token`).
- **1.H.3 — Landing + Crypto form** (`/`, `/crypto/new`, `POST /crypto`).
  Live Canvas winner (variant F). Reference: `docs/01-product/design/landing-and-crypto-v1.md`.
- **1.I — Participant notification emails**. Plain-text, on-create.
- **1.J — Completion engine**. Pure state transitions + `commitCompletion`
  audit entry. Handles workflow all-steps, declaration one-shot, and
  attestation-with-dedup; cascades to the next sequential step.
- **§6.4 initiator email commands** — `stats+{id}@`, `remind+{id}@`,
  `close+{id}@`. DKIM-authenticated via initiator match.
- **1.H.2b — Dependency graph** — collapsed flow modes into a
  `depends_on` column on the step table. No flow dropdown.
- **1.H.5 — Management dashboard** — step table with live status,
  Send reminders / Close event buttons. Email-command parity.

## Upcoming (Phase 1)

*(all Phase 1 modules complete)*

## How to apply

1. **Default: do not run Design Lab.** Reuse patterns from `DESIGN_MEMORY.md`
   and the v1 reference doc. Running Design Lab on a small variation
   wastes cycles.
2. **Run Design Lab when** the surface is genuinely novel (tree editor,
   dashboard) and more than one layout is plausible.
3. **Skip the React path** in the design-lab skill for this project —
   vanilla Node + template literals only. See CLAUDE.md "Design Lab
   adaptation" section for the project-specific conventions.
