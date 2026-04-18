# Design Plan

Remaining UI surfaces in Phase 1 and how the Design Lab applies to each.

## Shipped

- **1.H.2.1 — Event creation form** (`/events/new`). Design Lab
  synthesis winner (variant F2). Reference: `docs/01-product/design/event-form-v1.md`.
- **1.H.4 — Magic-link management URL + email** (`/manage/:token`).
- **1.H.3 — Landing + Crypto form** (`/`, `/crypto/new`, `POST /crypto`).
  Live Canvas winner (variant F). Reference: `docs/01-product/design/landing-and-crypto-v1.md`.

## Upcoming (Phase 1)

| Module | Surface | Design Lab? | Notes |
|---|---|---|---|
| 1.H.2b | Hybrid tree editor | yes — novel | Only the Steps section changes; chrome + sections 1/2 stay. |
| 1.H.5 | Management dashboard | yes — novel | Read-only view + close action; different shape from forms. |
| 1.I | Participant notification emails | no | Plain-text, mirrors 1.H.4. |

## How to apply

1. **Default: do not run Design Lab.** Reuse patterns from `DESIGN_MEMORY.md`
   and the v1 reference doc. Running Design Lab on a small variation
   wastes cycles.
2. **Run Design Lab when** the surface is genuinely novel (tree editor,
   dashboard) and more than one layout is plausible.
3. **Skip the React path** in the design-lab skill for this project —
   vanilla Node + template literals only. See CLAUDE.md "Design Lab
   adaptation" section for the project-specific conventions.
