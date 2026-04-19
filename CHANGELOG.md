# Changelog

All notable changes to GitDone are recorded here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
GitDone is pre-launch; versions are **phase-based** rather than semver
until a public release cuts v1.0 (tracked in `docs/01-product/prd.md`
§10). Newest first.

**Entry scope:** user-visible or principle-visible changes. A reader
should be able to answer "can GitDone do X yet?" from this file alone —
internal refactors and commit-level churn stay in `git log`.

---

## [Unreleased]

*(no changes pending)*

---

## [Phase 1 — 1.I participant notifications] — 2026-04-19

Creating an event now reaches the people who need to reply. Until now,
`POST /events` and `POST /crypto` only emailed the initiator with a
management link; participants were never told anything. 1.I closes that
gap.

### Added
- `app/src/notifications.js` composes per-participant plain-text email
  bodies and calls `sendmail(1)` via the existing outbound path. Two
  exports: `notifyWorkflowParticipants(event)` and
  `notifyDeclarationSigner(event)`.
- `POST /events` and `POST /crypto` now fire notifications in parallel
  with the management email. Per-recipient send failures are logged to
  stderr; the create flow still completes successfully.
- 3 unit tests on the body composers, 4 integration tests covering the
  per-flow/per-mode behaviour via a capturing fake sendmail.

### Flow & mode rules

| Event | Who gets notified on creation |
|---|---|
| workflow, sequential | step 1 participant only |
| workflow, non-sequential | every step's participant |
| workflow, hybrid | every step's participant (interim — real tree-aware notification lands with 1.H.2b) |
| crypto, declaration | the named signer |
| crypto, attestation | nobody — initiator shares the reply address manually per PRD §6.1 |

Cascading notifications (step 2 fires after step 1 completes, etc.)
are part of the completion engine (1.J), not 1.I.

---

## [Phase 1 — 1.H.3 landing + crypto events] — 2026-04-19

Landing page now uses a compact two-CTA block (Create Event / Create
Crypto) with a one-paragraph explainer. Crypto events can be created
at `/crypto/new` in either **declaration** mode (one DKIM-verified
signer → one permanent record) or **attestation** mode (N distinct
signers with a dedup rule). Winning design: Live Canvas variant F
(dense 2-col grid, no numbered section headers, fields dim in place
for the inactive mode). PRD §4.2 is now fully wired end-to-end.

### Added
- `validateCryptoEvent` in `app/src/web/validation.js` — branches per
  mode. Declaration requires `signer`. Attestation requires integer
  `threshold >= 1`, `dedup` ∈ `{unique, latest, accumulating}`,
  optional `allow_anonymous`.
- `GET /crypto/new` + `POST /crypto` in `app/bin/server.js`. Success
  page spells out the shareable reply address (`event+{id}@domain`)
  and, for attestation, includes a pre-filled `mailto:` helper for
  posting to channels.
- Crypto-specific management email body — explains mode, threshold,
  reply address, and the email-command namespace.
- Frozen design reference at
  `docs/01-product/design/landing-and-crypto-v1.md`. `DESIGN_MEMORY.md`
  gains the "dense-grid form" pattern (for ≤6-field forms).
- 8 integration tests covering GET landing, GET form, declaration
  success, attestation success, per-mode validation failures, and
  magic-token generation for crypto events.

### Changed
- Landing (`GET /`) no longer uses the `btn-big` placeholders from
  `templates.js`; it renders its own `.f-landing` block with the F
  palette.

---

## [Phase 1 — 1.H.4 magic-link management URL + email] — 2026-04-19

Creating an event now mints a 30-day opaque token (32 hex chars) and
emails the initiator a management URL at `/manage/{token}`. Both
workflow events and crypto events use the same token flow. Day-to-day
commands still happen by email (§6.4); the URL is the visual fallback.

### Added
- `app/src/magic-token.js` — one-file-per-token store under
  `data/magic_tokens/{token}.json`. File-per-token avoids RMW races
  and matches `data/events/{id}.json` layout. Malformed tokens never
  touch disk. Expired tokens read as null.
- `GET /manage/{token}` renders a minimal valid-link landing that
  points at the email commands; full dashboard is 1.H.5.
- Management email composed in `sendManagementEmail` — sent via the
  existing `sendmail(1)` path (opendkim milter signs it).
- 7 unit tests for magic-token, 3 integration tests for the full
  `POST /events` → email → `/manage/{token}` flow using a fake
  sendmail shell script.

### Design decision
- **Opaque token, not JWT.** PRD §4 originally said JWT; we use
  `crypto.randomBytes(16).toString('hex')` instead. Reasoning: single
  host, file-backed, revocation by file delete, no need for
  JWT-style statelessness. Every "real" JWT feature (one-time use,
  revocation, listing active links) re-introduces a server lookup.

---

## [Phase 1 — 1.H.2.1 event form redesign] — 2026-04-18

Event form at `/events/new` gets its v1 visual identity: Design Lab
synthesis winner **variant F2**. Numbered section headers, What+Who
on one row, How on a second, compact step table with datetime-local
deadlines, inline explained dropdowns (`sequential — one after
another`, `verified — strict DKIM + DMARC`).

### Added
- Frozen reference at `docs/01-product/design/event-form-v1.md`.
- `DESIGN_MEMORY.md` — locked-in patterns (palette, numbered
  headers, explained dropdowns, `datetime-local` for time-sensitive
  fields). `DESIGN_PLAN.md` — remaining UI surfaces and when to
  re-run Design Lab.

### Changed
- `renderWorkflowForm` in `app/bin/server.js` now emits the F2
  markup (`vf-form`, `vf-row`, `vf-steps-table`) replacing the
  scaffold from 1.H.2.
- "Add step" uses `formaction=/events/new formmethod=GET` so values
  round-trip in the query string — still no client JS.

### Removed
- The Design Lab route + loader (`/__design_lab`) added during 1.H.2.
  Lab is recreated on demand by the `design-lab` / `live-canvas`
  skills.

### Also this day
- Dev ergonomics (`bd52610`): `--dev` flag injects a
  fixed-position feedback HUD (`/dev/feedback`, appends to
  `dev-feedback.log` + stderr) and SSE live-reload (`/dev/stream`)
  that reloads the browser on server restart. Production pages are
  byte-identical.
- CLAUDE.md rewritten (`0eb820a`) to match the actual Phase 1 stack
  (vanilla `node:http` + tagged template literals, not the old
  Next.js / Express description).

---

## [Phase 1 — 1.H.2 workflow event creation] — 2026-04-18

Event initiators can now create workflow events via a plain-HTML form
at `/events/new`. Supports sequential or non-sequential flow, optional
deadlines per step, optional "requires attachment" per step, and the
configurable `min_trust_level` (from the 4 trust tiers in PRD §7.4).

### Added
- `app/src/web/validation.js` — shape + format validators for form
  input. Collects multiple errors per submission rather than failing
  on the first. Generates deterministic `step.id` via slug, dedupes
  collisions with numeric suffix.
- `app/src/event-store.js::createEvent` — atomic persistence with
  `generateEventId` (12-char base36) + `generateEventSalt` (32B hex
  per §0.1.10). Temp+rename write, refuses to overwrite, traversal
  guard on id.
- Routes in `app/bin/server.js`:
  - `GET /events/new` — workflow form (with "+ Add another step"
    via query-string round-trip; no client JS needed)
  - `POST /events` — validates + creates; 422 on errors with the
    form re-rendered and user values preserved; success page shows
    each step's `event+{id}-{stepId}@git-done.com` reply-to
  - `GET /events/:id` — read-only debug view (will be gated by
    magic-link in 1.H.5)
- 34 new tests: 22 unit tests for validation + createEvent, 8
  integration tests hitting the real HTTP server with a throwaway
  data dir.

### Non-goals (deliberate)
- No client-side JS. Dynamic step-count works via GET round-trip.
- No CSS framework. One inline `<style>` block in `layout()`.
- No hybrid flow yet — that's 1.H.2b (tree UI, UI-heaviest piece).

---

## [Phase 1 — 1.H.1 v1 deletion + web skeleton] — 2026-04-18

v1's Next.js + Express + Docker stack is retired. The whole v1
surface area is gone from the tree (~2,235 files across `backend/`,
`frontend/`, Dockerfiles, deploy scripts, test artefacts, and their
entire `node_modules/` that shouldn't have been committed). Git
history preserves v1 at commit `f9820ea` and before.

No archive dir kept — the PRD's rebuild (Path B) doesn't need v1
as a reuse source; any pattern that's genuinely useful can be
pulled via `git show <sha>:<path>` on demand.

### Added
- `app/bin/server.js` — HTTP server for the initiator web UI,
  vanilla Node `http` (no Express, stdlib only). Landing page +
  `/health` for now.
- `app/src/web/router.js` — tiny (method, path) router with
  `:param` support.
- `app/src/web/templates.js` — tagged-template `html\`...\``
  primitive with automatic HTML-escape on interpolation + `raw()`
  opt-out; shared `layout()` chrome.
- `app/src/web/body.js` — stdlib body parser for
  `application/x-www-form-urlencoded` and `application/json`,
  256KB cap.
- 34 new unit tests (router, templates, body-parse, end-to-end
  server response).
- On VPS: `/etc/systemd/system/gitdone-web.service` (runs as
  `gitdone` user, bound to `127.0.0.1:3001`, sandbox-hardened).
  Not yet publicly exposed — nginx + TLS will come at the end of
  1.H once all initiator routes are working locally.

### Removed
- `backend/` (v1 Express + JSON + SMTP)
- `frontend/` (v1 Next.js + React)
- `Dockerfile`, `docker-compose.yml`, `docker_compose.yml`,
  `deploy.sh`, `dev.sh`, `nginx.conf`, `playwright.config.ts`,
  `package.json` (root), `README.md`, `start.sh`, `tests/` (v1
  playwright), `test-results/`, `quick-start.sh`.
- `data/` (v1 runtime events + magic tokens). Clean slate for v2.
- `.env` (may have contained real credentials — shredded).
- All v1 `node_modules/` (should never have been in git).

### Changed
- `docs/04-process/phase1-plan.md` — 1.H decomposed into 1.H.1
  through 1.H.5 (and 1.H.2b for hybrid-flow tree UI). 1.H.1
  marked done.

---

## [Phase 1 — 1.E+ OTS upgrade scheduler] — 2026-04-18

Closes the operational gap identified in 1.L.3 finding 41: proofs
in the repo at commit time carry only calendar attestations, not
Bitcoin ones. `ots verify` used to paper over this by querying
calendars live. Now we periodically fold the Bitcoin attestations
into the `.ots` files themselves, so the repo is self-contained
against calendar-server outages.

### Added
- `app/bin/ots-upgrade.js` — worker that walks
  `$dataDir/repos/*/ots_proofs/*.ots`, runs `ots upgrade` on each,
  compares sha256 before/after to detect upgrades, and makes ONE
  git commit per event repo if ≥1 proof got Bitcoin-anchored
  (`ots upgrade: N proof(s) anchored to Bitcoin`). JSON-lines output
  for journalctl. Idempotent: no changes = no commit.
- `app/tests/unit/ots-upgrade.test.js` — 8 tests using a fake
  `ots` binary that simulates upgrades selectively, validating
  batched commit shape and idempotent re-runs.
- VPS systemd units:
  - `/etc/systemd/system/gitdone-ots-upgrade.service` — oneshot,
    runs as `gitdone` user.
  - `/etc/systemd/system/gitdone-ots-upgrade.timer` — 6h cadence,
    5min post-boot jitter, `Persistent=true` so missed runs fire
    on next boot.

### Changed
- `tools/gitdone-verify` OTS classifier now recognises an additional
  post-upgrade state: when a proof has Bitcoin attestations embedded
  and `ots verify` exits with "Could not connect to Bitcoin node"
  and no failure signal, the proof is classified as `anchored`
  (cryptographically valid; no Bitcoin node available for
  independent cross-check). Tamper is still reliably caught by
  `does not match`.

### Verified
- First production run on VPS upgraded 2 proofs (demo123
  commit-001 and commit-002) — file sizes grew ~550→2620 bytes
  and ~690→2760 bytes as Bitcoin Merkle-path attestations were
  folded in. One git commit `b30a48f: ots upgrade: 2 proof(s)
  anchored to Bitcoin`. Second run 30s later was a clean no-op.
  Systemd timer scheduled: next run in ~6h.

---

## [Phase 1 — 1.L.3 reverify+ handler] — 2026-04-18

Completes the verify trilogy (`event+` / `verify+` / `reverify+`). A
commit that failed to reach the initiator's required trust level at
reception can now be upgraded by supplying cryptographic evidence — a
raw `.eml` whose DKIM signature validates against the commit's
archived PEM. The original commit stays immutable; upgrades are
layered as new `reverify-NNN.json` audit records.

### Added
- `app/src/router.js::parseReverifyTag` — `reverify+{eventId}-{seq}@`
  parser with sequence bounds and traversal guards.
- `app/src/gitrepo.js::commitReverify` — writes `commits/reverify-NNN.json`
  (own sequence namespace, separate from `commit-NNN.json`), stamps with
  OTS, commits to git. Never touches the target commit.
- `app/src/gitrepo.js::loadCommit`, `nextReverifySequence` — helpers.
- `app/src/reverify.js` — orchestrator: load target commit, pick signer
  from its DKIM record, extract forwarded `.eml`, run DKIM re-verify
  against archived PEM, build upgrade record with policy (`unverified`
  / `authorized` / `forwarded` → `verified` on pass; already-verified
  is a no-op audit entry).
- `bin/receive.js` — handles `reverify+` before event routing. Writes
  the reverify commit, sends DKIM-signed ack reply via 1.L.1 path.
- `tools/gitdone-verify/gitdone-verify.js` — recognises `reverify-NNN.json`
  files, validates their schema separately from reply commits, and
  computes **effective trust** as `max(original, upgrade)` when
  evaluating completion. Summary now shows "4 reply + 2 reverify
  commit(s) conform to schema v2".
- 29 new unit tests across router (10), gitrepo (4), reverify (15).

### Verified
- Three E2E paths on the production VPS against the demo123 repo:
  1. `reverify+demo123-99@` (non-existent commit) → `not found`,
     `git_record: null`, DKIM-signed reply sent explaining why.
  2. `reverify+demo123-1@` (commit-001 was unsigned at reception) →
     `no archived DKIM key`, `upgraded: false`, still written as an
     audit entry (`reverify-001.json`).
  3. `reverify+demo123-2@` (commit-002 already verified) →
     `trust: verified → verified`, `upgraded: false` with policy note
     "already verified", audit entry `reverify-002.json`.
- Offline `gitdone-verify` re-run on the updated repo correctly
  summarises: `4 reply + 2 reverify commit(s) conform to schema v2`,
  OpenTimestamps passes all 6 proofs (2 anchored + 4 pending for the
  new reverify OTS stamps).

### Changed
- `gitdone-verify` OTS classifier now treats `Got N attestation(s)
  from cache` output as `anchored` (independent of exit code — `ots`
  exits 1 both on tamper AND on cache-without-local-bitcoin-node,
  so text signals are authoritative). Tamper detection still reliable
  via `does not match` regex.

### Known gap — tracked as module 1.E+
`ots upgrade` is not yet automated. `.ots` proofs in the repo start as
calendar-pending (attestations from 3-4 calendars, no Bitcoin tx yet).
`ots verify` papers over this by querying calendars live, but if all
calendars died before an upgrade, the proof would become unverifiable.
**Planned:** 6-hour cron running `ots upgrade` across all event repos,
making one idempotent git commit per upgraded event (`ots upgrade: N
proofs anchored to Bitcoin block X`). See `phase1-plan.md`.

---

## [Phase 1 — 1.G attachment forwarding] — 2026-04-18

Completes §0.1.10 privacy story: received attachments are hashed into
the git commit at reception, then handed to the event initiator's
mailbox byte-for-byte. GitDone's filesystem never stores attachments.

### Added
- `app/src/forward.js` — `buildForwardMessage` (prepends
  `X-GitDone-Event`, `-Step`, `-Commit`, `-Trust`, `-Received-At`,
  `-Forwarded-At` headers before the original message's header block)
  and `forwardToOwner` (byte-preserving resubmission via sendmail with
  envelope rewrite).
- `outbound.sendmail` positional-recipient mode: `to: [addr, ...]`
  switches from `-t` (header-derived recipients) to `-- addr1 addr2`
  (explicit positional). Used for forward-to-owner where we want to
  preserve the original `To: event+{id}-{step}@` for context but route
  to the initiator.
- 10 new unit tests covering header prepending (incl. the no-blank-line
  invariant), byte-preservation, the positional-recipient sendmail
  path, and end-to-end forward via a fake sendmail capturing stdin.

### Changed
- `receive.js` now calls `forwardToOwner` after a successful
  `commitReply` when `event.initiator` is set. Best-effort — forward
  failure logs `forward.ok: false` but does not reject the inbound.

### Verified
- End-to-end from Gmail: reply to `event+demo123-step1@git-done.com`
  → commit-003.json + commit-004.json in the event's git repo
  → both forwards delivered to `avoidaccess@msn.com` (Microsoft
  `250 Queued mail for delivery`, landed in inbox not junk).
  Original `braun-invoice.pdf` attachment byte-intact on the
  recipient side; `X-GitDone-*` tracking headers present.

---

## [Phase 1 — 1.L.2 offline verifier] — 2026-04-17

Principle §0.1.2 made executable: any cloned event repo can now be
verified on a disconnected machine with no call to any GitDone service.

### Added
- `tools/gitdone-verify/gitdone-verify.js` — single-file Node script
  (stdlib only, ~330 lines, MIT-licensed) with six check layers:
  structure, `git fsck`, schema v2 + plaintext discipline (§0.1.10),
  archived DKIM PEM parse, OpenTimestamps (catches tamper), workflow
  completion (incl. sequential-flow ordering).
- `tools/gitdone-verify/tests/verify.test.js` — 31 unit tests, all
  stdlib, including a fake-`ots` harness that simulates each OTS output
  state (anchored / in-bitcoin / pending / tampered).
- `tools/gitdone-verify/README.md` and `LICENSE` (MIT) — the script is
  intended to be forked, audited, or re-implemented; the principle
  matters more than this implementation.

### Verified
- Tamper detection end-to-end: cloned production demo123 repo, flipped
  one byte of `trust_level` in `commit-002.json`, `gitdone-verify`
  returned `OpenTimestamps FAIL (1 bad proof)` and exit code 1. Clean
  repo passes with exit 0.

---

## [Phase 1 — 1.L.1 send path] — 2026-04-17

`verify+{id}@` now replies to the forwarder with a DKIM-signed report
instead of just logging it (graduates 1.L.1 from log-only POC to
fully shipped).

### Added
- `app/src/outbound.js` — `sendmail(8)` wrapper + RFC-822 builder.
  stdlib `child_process.spawn` only; no new npm deps. Outbound is
  signed automatically via the opendkim non_smtpd milter (1.F).
- `app/src/verify.js::formatVerifyReportBody` — plain-text report
  covering MATCH / NO MATCH / empty-event / DKIM-reverify-limitation
  cases, CRLF-clean.
- 20 new unit tests covering outbound (rawMessage builder, sendmail
  spawn with stub binaries) and the report formatter.

### Changed
- Identity alias casing: `GitDone Verify` → `gitdone` in the From
  display name; `GitDone` → `gitdone` in the git commit author. Applies
  to all outbound email and all new git commits.
- `Auto-Submitted: auto-replied` (RFC 3834) on every verify reply —
  paired with the prefilter's system-sender rejection, this closes
  auto-responder loops cleanly.

---

## [Phase 1 — 1.F outbound DKIM signing] — 2026-04-17

Mail leaving `git-done.com` is cryptographically verifiable by
recipients: Gmail confirms dkim/spf/dmarc all `pass`.

### Added
- opendkim 2.11 on the VPS (Mode `sv`, TCP socket `inet:8891@127.0.0.1`),
  wired as Postfix `smtpd_milters` and `non_smtpd_milters` with
  `milter_default_action = accept` (mail still flows if opendkim dies).
- 2048-bit RSA DKIM keypair (selector `gd202604`) on the VPS at
  `/etc/opendkim/keys/git-done.com/gd202604.private`; public material
  and keypair stashed in `pass gitdone/opendkim/{selector,domain,
  private_key,public_key,public_record}`.
- DNS in Route 53: DKIM TXT at `gd202604._domainkey.git-done.com`,
  SPF at apex (`v=spf1 mx -all`), DMARC at `_dmarc.git-done.com`
  (`v=DMARC1; p=none; rua=mailto:postmaster@git-done.com`).
- `.gitignore` hardening: `*.private`, `*.pem`, DKIM artefacts blocked
  from accidental commits (a stray `default.private` from local
  `opendkim-genkey` experimentation was shredded before 1.F's commit).

### Verified
- End-to-end: `postmaster@git-done.com` → `avoidaccess@gmail.com`
  arrived with DKIM pass, SPF pass, DMARC pass, TLS 1.3.

### Known limitations
- Brand-new sending domain: first outbound lands in Gmail Spam despite
  perfect auth. This is reputation, not crypto — fixes itself with
  real traffic over time.

---

## [Phase 1 — 1.L.1 verify+ handler (POC)] — 2026-04-17

Anyone can forward a raw `.eml` or a file attachment to
`verify+{eventId}@git-done.com` and the handler identifies which commit
it corresponds to. At this point the handler **logs** the report; the
send path follows in a later commit the same day.

### Added
- `app/src/verify.js` — `buildVerificationReport`, `findMatch`
  (cascade: `raw_sha256` → `message_id_hash` → attachment
  `sha256`), `reverifyDkim` (against archived PEMs).
- `app/bin/receive.js` short-circuits `verify+` mail before the event
  routing / commit flow; no trust classifier, no git commit, no
  attachment storage — it's a pure read path.

### Findings recorded to PRD §10.5
- Raw-byte email match is unreliable across forward paths (every client
  normalises) — findings 11, 13.
- Message-ID is the only stable cross-client identifier per RFC 5322 —
  finding 12. Commit schema v2 adds `message_id_hash` to support this.
- `verify+` graduates on commit **identification**, not content
  re-verification; the trust guarantee never relied on repeated DKIM —
  finding 14.
- Direct-attachment hashing IS deterministic across providers
  (byte-identical SHA-256 from MSN and Gmail) — finding 15.
  **Attach-a-raw-file is therefore the primary verification UX**.

---

## [Phase 1 — 1.C+ principle §0.1.10 retrofit + OTS fix] — 2026-04-17

Plaintext discipline was added to PRD §0.1.10 this session; committed
JSON schemas were retrofitted to match, and a latent OTS bug was fixed.

### Changed
- Commit schema v1 → v2: drops plaintext `sender`, `subject`,
  `body_preview`, `message_id`; replaces with salted
  `sender_hash`, `message_id_hash`. Event `event.json` gains per-event
  public `salt` (32-byte hex) so verifiers can re-hash a claimed
  address but bulk correlation across events is infeasible.

### Fixed
- OpenTimestamps (1.E) was stamping a pre-final version of
  `commit-NNN.json` — `ots verify` then failed against the committed
  file. Finalise metadata **before** stamping; `ots verify` now
  succeeds on the committed content.

---

## [Phase 1 — 1.E OpenTimestamps anchoring] — 2026-04-17

### Added
- `app/src/ots.js` — wraps `/usr/local/bin/ots` via `child_process`;
  graceful degradation when the binary is missing.
- Each commit now has a paired `ots_proofs/commit-NNN.ots` proof,
  submitted to OTS calendar servers and eventually anchored in a
  Bitcoin block. Independent of GitDone — verifiable with any
  OpenTimestamps client.

---

## [Phase 1 — 1.D DKIM key archival] — 2026-04-17

### Added
- `app/src/dkim-archive.js` — fetches the DKIM DNS TXT record for a
  signature's (domain, selector) at reception time and writes a PEM to
  `dkim_keys/commit-NNN.pem`. Future DKIM verification no longer
  depends on DNS being intact; the archived key in the repo is the
  source of truth.

---

## [Phase 1 — 1.C per-event git repo + commit per reply] — 2026-04-17

First time an inbound reply becomes a permanent audit record.

### Added
- `app/src/gitrepo.js` — init repo + write `commit-NNN.json` per
  accepted reply; schema evolves in 1.C+ above.
- Repo layout at `/var/lib/gitdone/repos/{eventId}/` — `event.json`,
  `commits/commit-NNN.json`, `dkim_keys/`, `ots_proofs/`.
- Accept-with-flag: every reply commits regardless of
  `participant_match` or trust level; the initiator's policy is
  enforced at completion time, not at the door.

---

## [Phase 1 — 1.B plus-tag router + event lookup] — 2026-04-17

### Added
- `app/src/router.js` — `parseEventTag`, `parseVerifyTag`, traversal
  guards for `eventId`.
- `app/src/event-store.js` — `loadEvent`, `findStep`,
  `senderMatchesStep` (case-insensitive).
- Unknown tags are rejected and logged; routing never throws.

---

## [Phase 1 — 1.A production receive pipeline rewrite] — 2026-04-17

Graduated the Phase 0 POC into structured production code with the
findings from §10.5 baked in (PrivateTmp log location, pipe-transport
envelope args, dedicated `gitdone` user, etc.).

### Added
- `app/` — new Node project structure separate from the v1 `backend/`
  and `frontend/` (v1 never received mail, so nothing to reuse here).
- `app/src/{config,envelope,prefilter,classifier,logger}.js` — 12-factor
  config, argv parsing, RFC 3834 pre-filter (Auto-Submitted, List-Id,
  Precedence, system senders), 4-level trust classifier (PRD §7.4).
- Unit tests from day one (`node --test`, stdlib). 95 tests at end of
  1.A-1.L.1.
- VPS layout: `/opt/gitdone/bin/receive.sh` (Postfix pipe wrapper) →
  `/opt/gitdone/bin/receive.js` (entry), runs as dedicated `gitdone`
  system user.
- Postfix pipe(8) transport (not alias-pipe) so envelope args
  `${client_address} ${client_helo} ${sender} ${original_recipient}`
  reach the script — required for SPF and plus-tag.

### Removed
- Phase 0 POC code at `poc/phase0/` stays in-tree as a historical
  reference, but is no longer on the delivery path.

---

## [Phase 0 — POC graduation] — 2026-04-17

A weekend's worth of POC work validated every architectural bet in
PRD §1, §3, §7, §8. Graduated and started Phase 1 the same day.

### Added
- `poc/phase0/` — minimal `receive.js` that reads email from stdin,
  verifies DKIM via `mailauth`, logs sender and metadata.
- RackNerd VPS (AlmaLinux 8, Postfix 3.5.8, Node 20) configured as MX
  for `git-done.com`: MX + A + PTR + FCrDNS all clean.
- PRD §10.5 "Phase 0 Validation Results" — happy-path matrix (real mail
  from MSN and Gmail), pre-filter behaviour, findings 1–10.

### Verified
- Architectural bet "we are the MX, so no intermediary modifies the
  body" holds empirically: MSN and Gmail both produced DKIM pass +
  DMARC pass through direct SMTP.
- Attachment SHA-256 is deterministic across provider sessions.
- Plus-tag (`event+ID-step@git-done.com`) survives end-to-end through
  external SMTP.

---

## [v2.0 PRD Revival] — 2026-04-16

Structural rebuild of v1 into a universal coordination protocol.
v1's "vendor workflow management" framing is too narrow; v2 is any
cryptographically-verifiable multi-party action, with email as the
participant interface and git as the permanent record.

### Added
- PRD §0 design principles (10, non-negotiable) with historical
  context pointing at 60 years of identity-system failure modes.
- PRD §4 two-event-type taxonomy: **Event** (workflow) and **Crypto**
  (declaration / attestation).
- PRD §7 four-layer trust model with accept-with-flag policy: DKIM →
  ARC → SPF/DMARC → flag; initiator decides what counts toward
  completion.
- PRD §8 technical architecture for the new inbound pipeline.
- PRD §10 four-phase rollout plan (0 POC, 1 core rebuild, 2 crypto
  types, 3 polish + launch) + `gitdone-verify` as the load-bearing
  principle check.

### Deprecated
- v1's participant-facing web pages, per-participant magic link tokens,
  file upload endpoints, and server-side attachment storage — all
  scheduled for deletion in module 1.K.

---

## [v1 Archive] — 2025-10-03 to 2026-02-13

Original GitDone: Next.js 15 + Express + JSON storage multi-vendor
workflow coordinator. Reached ~80% on a single use case (wedding
vendor coordination) before being deemed structurally unsuitable
(PRD §2.5 — no moat, storage burden, privacy concern, tight
coupling, single use case).

What v1 can do today that still ships in v2 (per PRD §3.4):
- Event creation (sequential / non-sequential / hybrid flow types)
- Platform stats aggregation (6-hour cron)
- Management magic links for initiators
- Reminder email infrastructure
- One git repo per event

These components stay; the participant side gets rebuilt in Phase 1.
