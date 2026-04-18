<!-- AURORA:START -->
# Aurora Instructions

These instructions are for AI assistants working in this project.

Always open `@/.aurora/AGENTS.md` when the request:
- Mentions planning or proposals (words like plan, create, implement)
- Introduces new capabilities, breaking changes, or architecture shifts
- Sounds ambiguous and you need authoritative guidance before coding

Use `@/.aurora/AGENTS.md` to learn:
- How to create and work with plans
- Aurora workflow and conventions
- Project structure and guidelines

## MCP Tools Available

Aurora provides MCP tools for code intelligence (automatically available in Claude):

**`lsp`** - LSP code intelligence with 3 actions:
- `deadcode` - Find unused symbols, generates CODE_QUALITY_REPORT.md
- `impact` - Analyze symbol usage, show callers and risk level
- `check` - Quick usage check before editing

**`mem_search`** - Search indexed code with LSP enrichment:
- Returns code snippets with metadata (type, symbol, lines)
- Enriched with LSP context (used_by, called_by, calling)
- Includes git info (last_modified, last_author)

**When to use:**
- Before edits: Use `lsp check` to see usage impact
- Before refactoring: Use `lsp deadcode` or `lsp impact` to find all references
- Code search: Use `mem_search` instead of grep for semantic results
- After large changes: Use `lsp deadcode` to find orphaned code

Keep this managed block so 'aur init --config' can refresh the instructions.

<!-- AURORA:END -->

# GitDone

Email-native multi-party workflow coordination with cryptographic proof
of the reply sequence. Initiator creates an event (workflow or crypto);
each step gets a unique `event+<id>-<step>@domain` reply-to; every
inbound reply is DKIM-verified, OpenTimestamped, and committed to a
per-event git repository. Proofs verify offline via `gitdone-verify`
without the gitdone service.

Principles (§0.1 of `docs/01-product/prd.md`): no accounts, no REST API,
no telemetry, invisible beats correct, proofs outlive the service.

## Dev Rules

- **POC first.** ~15min proof-of-concept under `poc/` before building.
  Happy path + edges. POC works → design → build with tests. Never ship
  the POC.
- **Incremental modules.** One small piece at a time, each working on
  its own before integrating. Phase 1 tracks modules in
  `docs/04-process/phase1-plan.md`.
- **Dependency hierarchy (strict):** vanilla JS → Node stdlib → external
  only when stdlib can't do it in <100 lines. External deps must be
  maintained, lightweight, widely adopted. Exception: always use vetted
  libraries for crypto / auth / email parsing / DKIM.
- **Lightweight over complex.** Fewer parts, fewer deps, less config.
  Simple > clever. Readable > elegant.
- **Open-source only.** No vendor lock-in. No speculative code, no
  premature abstractions.

Full standards: `.claude/memory/AGENT_RULES.md`.

## Tech Stack

- **Runtime:** Node.js ≥18, CommonJS, no bundler.
- **Production deps (`app/package.json`):** `mailauth` (DKIM/DMARC/SPF),
  `mailparser` (MIME parsing), `simple-git` (per-event repos). That's
  it — everything else is Node stdlib.
- **HTTP:** vanilla `node:http` + a tiny router (`app/src/web/router.js`)
  + tagged-template HTML (`app/src/web/templates.js`). No Express, no
  React, no frontend framework.
- **Storage:** JSON files under `data/` (`events/<id>.json`) and per-event
  git repos. No database.
- **Timestamps:** OpenTimestamps, scheduled upgrade via systemd timer.
- **Outbound:** DKIM-signed SMTP via `app/src/outbound.js`.

## Entry points

- `app/bin/receive.js` — Postfix pipe transport per incoming message.
- `app/bin/server.js` — long-lived web server (nginx proxies :443 → this).
- `app/bin/ots-upgrade.js` — cron target for OTS upgrade (6h systemd timer).
- `tools/gitdone-verify/` — offline CLI that verifies any event's proofs
  without touching the service.

## Commands

- Tests: `cd app && npm test` (or `npm run test:unit` / `test:integration`).
- Dev server: `cd app && node bin/server.js --dev` — uses `./data-dev/`,
  injects the dev feedback HUD, SSE live-reload.
- Receive locally: pipe an `.eml` into `app/bin/receive.js` (see
  `app/tests/fixtures/`).

## Layout

```
app/
  bin/           # receive.js, server.js, ots-upgrade.js
  src/           # classifier, verify, ots, forward, outbound, event-store, web/
  tests/         # unit, integration, fixtures
tools/gitdone-verify/   # offline CLI
docs/
  00-context/    # background
  01-product/    # prd.md, design/event-form-v1.md
  04-process/    # phase1-plan.md
poc/             # throwaway proofs-of-concept
```

## Key patterns

- **Event types:** `event` (workflow) with `sequential | non-sequential |
  hybrid` flow, or `crypto` (one or many cryptographically-verifiable
  replies).
- **Minimum trust level** per event (`unverified | authorized | forwarded
  | verified`) gates step completion against the verify result.
- **Magic-link management** (1.H.4, not yet shipped): JWT, 30-day expiry,
  one per event.
- **Attachments are forwarded byte-preserving to the event owner**
  (`app/src/forward.js`); gitdone never stores them.

## UI conventions

Design patterns are locked in `DESIGN_MEMORY.md`. Reuse them on new
surfaces instead of re-deriving. The v1 event form reference lives at
`docs/01-product/design/event-form-v1.md`.

## Design Lab adaptation

Stack is vanilla Node http + tagged template literals, not React. When
running the `design-lab` skill:

- Skip the React generator path.
- Variants are CommonJS modules at `.claude-design/lab/variants/variant-*.js`
  exporting `{ id, rationale, render(stepsCount) }`; root element carries
  `data-variant-root="X"`.
- Vanilla-JS `FeedbackOverlay` lives at `.claude-design/lab/overlay.js`.
- The server loads the lab on-demand at `/__design_lab` only when `--dev`
  is set AND `.claude-design/lab/` exists. Finalize by porting the chosen
  variant into the live route in `server.js`, writing a frozen reference
  under `docs/01-product/design/`, deleting `.claude-design/`.

## Documentation

- Index: `docs/KNOWLEDGE_BASE.md` (if present) or `docs/README.md`.
- PRD: `docs/01-product/prd.md`.
- Phase 1 plan: `docs/04-process/phase1-plan.md`.
- Changelog: `CHANGELOG.md`.
- Memory: `.claude/memory/MEMORY.md`.
