# gitdone

Email-native multi-party workflow coordination with cryptographic proof
of the reply sequence. Participants reply to email; every reply is
DKIM-verified, OpenTimestamped, and committed to a per-event git
repository. Proofs verify offline via `gitdone-verify` — even if
gitdone the service disappears.

Status: **Phase 1 in progress** — end-to-end plumbing works (create →
notify → reply → verify → commit → complete). Management dashboard
and email commands are still open. See
[`docs/04-process/phase1-plan.md`](docs/04-process/phase1-plan.md).

## What it does

An initiator creates an **event** at `https://git-done.com`:

- **Workflow event** — ordered or parallel steps, each with a named
  participant and optional deadline. Example: vendor sign-offs for an
  event; legal → design → exec review.
- **Crypto event** — one of two modes:
  - **Declaration** — one DKIM-verified reply from a single named
    signer becomes a permanent cryptographic record.
  - **Attestation** — anyone the initiator shares the reply address
    with can sign; completion is N distinct signers (configurable
    dedup: `unique`, `latest`, `accumulating`).

Each participant (or signer) gets a unique reply-to address at
`event+{id}-{step}@git-done.com`. They reply from their normal inbox.
gitdone verifies the DKIM signature, archives the signing key,
OpenTimestamps the commit, and forwards the original message with
attachments straight to the initiator — gitdone stores only hashes.

Offline verification: `git clone` the event's repo and run
[`tools/gitdone-verify`](tools/gitdone-verify/). No gitdone calls, no
account, no credentials.

## Principles (PRD §0.1)

- No accounts. No REST API. No telemetry.
- **Invisible beats correct** — day-to-day interactions happen by email,
  not web forms. The web UI is creation + management; participants
  never touch it.
- **Proofs outlive the service** — every verification works without
  gitdone being alive.
- **Cryptographic auth, not social** — initiator commands are
  DKIM-verified emails from the event's recorded initiator address.

## Tech stack

- Node.js ≥ 18, CommonJS, no bundler.
- **HTTP:** vanilla `node:http` + tagged-template HTML. No Express,
  no React, no frontend framework.
- **Storage:** JSON files under `data/` and per-event git repos. No
  database.
- **Email in:** Postfix → pipe to `app/bin/receive.js`. DKIM/SPF/DMARC
  via `mailauth`. MIME via `mailparser`.
- **Email out:** `sendmail(1)` (Postfix), signed by `opendkim` milter
  at the MTA — zero Node-side crypto.
- **Timestamps:** OpenTimestamps, upgraded every 6 h by a systemd timer.
- **Production deps:** `mailauth`, `mailparser`, `simple-git`. That's
  it — everything else is Node stdlib.

## Layout

```
app/
  bin/           receive.js, server.js, ots-upgrade.js
  src/           classifier, verify, ots, forward, outbound,
                 event-store, completion, magic-token, notifications,
                 web/
  tests/         unit, integration, fixtures
tools/
  gitdone-verify/   offline CLI
docs/
  00-context/    background
  01-product/    prd.md, design/
  04-process/    phase1-plan.md, definition-of-done.md, etc.
poc/             throwaway proofs-of-concept
```

## Running

```bash
cd app

# tests (unit + integration)
npm test

# dev web server (uses ./data-dev, injects feedback HUD + live-reload)
node bin/server.js --dev

# pipe a .eml through the receive pipeline
cat some.eml | node bin/receive.js
```

## Commands (entry points)

- `app/bin/receive.js` — Postfix pipe transport per incoming message.
- `app/bin/server.js` — long-lived web server. Nginx proxies `:443`
  → this.
- `app/bin/ots-upgrade.js` — cron target for OTS upgrade (6 h systemd
  timer).
- `tools/gitdone-verify/` — offline CLI that verifies any event's
  proofs without the service.

## Addresses (plus-tag routing)

| Address | Purpose | Auth |
|---|---|---|
| `event+{id}-{step}@` | workflow reply for a specific step | DKIM + participant match |
| `event+{id}@` | crypto reply (declaration or attestation) | DKIM + signer / anyone |
| `verify+{id}@` | public verification report | none (public) |
| `reverify+{id}-{N}@` | contested-commit upgrade | cryptographic |
| `stats+{id}@` | initiator: current progress | DKIM + sender == initiator |
| `remind+{id}@` | initiator: resend reminders | DKIM + sender == initiator |
| `close+{id}@` | initiator: close early | DKIM + sender == initiator |

## Verification

```bash
# Clone any gitdone event repo, then:
tools/gitdone-verify/bin/gitdone-verify ./some-event-repo/
```

Runs six check layers (structure, git fsck, schema discipline, DKIM
PEM verify against archived keys, OpenTimestamps with tamper detection,
completion rules). Zero network calls to gitdone. Works in
air-gapped environments.

## Docs

- [`docs/01-product/prd.md`](docs/01-product/prd.md) — full product spec.
- [`docs/04-process/phase1-plan.md`](docs/04-process/phase1-plan.md) —
  module tracker.
- [`CHANGELOG.md`](CHANGELOG.md) — shipped changes, newest first.
- [`DESIGN_MEMORY.md`](DESIGN_MEMORY.md) /
  [`DESIGN_PLAN.md`](DESIGN_PLAN.md) — UI patterns and remaining
  surfaces.
- [`CLAUDE.md`](CLAUDE.md) — instructions for AI agents working in
  this repo.

## License

Core service: source-available (TBD). `tools/gitdone-verify/` is MIT
— per PRD §0.2 it must remain forkable so every proof stays
independently verifiable.
