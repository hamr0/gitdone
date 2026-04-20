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

- **Event types:** `event` (workflow) with per-step `depends_on` DAG
  (replaced the `flow` enum in 1.H.2b), or `crypto` in `declaration`
  (one signer) or `attestation` (N distinct signers) mode.
- **Minimum trust level** per event (`unverified | authorized | forwarded
  | verified`) gates step completion against the verify result.
- **Per-event magic link** (1.H.4): opaque 32-hex token, 30-day TTL,
  file-backed under `data/magic_tokens/<token>.json`. Emailed at event
  create. Bookmarkable.
- **Self-serve session login** at `/manage`: enter email → 15-min
  single-use magic link → 30-day HMAC-signed cookie. Shows a dashboard
  of all events owned by that email. Secret from `GITDONE_SESSION_SECRET`
  (generate with `openssl rand -hex 32`, persist per-deploy).
- **Preview-before-create** for workflow events: POST `/events` renders
  a preview with flow prose (`renderFlowProse`) + confirm/edit buttons.
  Nothing persists until `_action=confirm`.
- **Attachments are forwarded byte-preserving to the event owner**
  (`app/src/forward.js`); gitdone never stores them.

## Production

Live at **https://git-done.com**. AlmaLinux 8 VPS at `104.129.2.254`;
nginx `:443 → :3001`; Postfix pipe-transport `gitdone` user →
`/opt/gitdone/app/bin/receive.sh`; opendkim selector `gd202604`.

Code lives at `/opt/gitdone/` as a git clone. App is under
`/opt/gitdone/app/` (note the nested path; earlier deploys had files at
the root). Data is separate at `/var/lib/gitdone/` — never in the code
dir.

Systemd units:
- `gitdone-web.service` — vanilla Node on 127.0.0.1:3001
- `gitdone-ots-upgrade.timer` — every 6h, OTS upgrades
- `gitdone-health.timer` — every 15min, emails `avoidaccess@gmail.com`
  on any degradation (disk, mailq, unit state, cert expiry, etc.)

Env is in `/etc/default/gitdone-web`:
`GITDONE_DATA_DIR`, `GITDONE_WEB_PORT`, `GITDONE_PUBLIC_URL`,
`GITDONE_DOMAIN`, `GITDONE_SESSION_SECRET`.
Session secret is 64 hex bytes, backed up at
`pass gitdone/vps/session_secret`.

Backup runs off-VPS on federver (daily 04:15 UTC) via
`ops/homeserver/gitdone-backup.sh` — pulls events/repos/dkim/cert/env
to `/mnt/data/data/gitdone-backups/`. Monitored by Kuma (HTTP +
push heartbeat).

## UI conventions

The site-wide visual language is the retro-terminal theme — charcoal
bg, JetBrains Mono, CRT green `#3fb950` for actions, amber `#ffb000`
for emphasis/links, no border-radius on structural elements. Full
palette tokens, typography rules, and five invariants:
`docs/01-product/design/terminal-theme-v1.md`. Frozen references for
specific surfaces live alongside it:
- `event-form-v1.md` (workflow form layout)
- `landing-and-crypto-v1.md` (landing + crypto form; superseded
  in-place by terminal theme but the layout choices are still current)

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

- Index: `docs/README.md`.
- PRD: `docs/01-product/prd.md`.
- Phase 1 plan: `docs/04-process/phase1-plan.md`.
- Deployment + ops runbook: `docs/04-process/deployment.md`.
- Home-server backup: `ops/homeserver/README.md` +
  `ops/homeserver/FEDERVER_INSTALL.md`.
- Changelog: `CHANGELOG.md`.
- Memory: `.claude/memory/MEMORY.md`.
