---
title: Architecture, v1-to-v2 and deployment
theme: Architecture, v1-to-v2 and deployment
source: docs/archive/prd.md
summary: What v1 was, what v2 changes, the v2 technical architecture and data model, and the deployment and infrastructure setup.
---

# Architecture, v1-to-v2 and deployment

## 2. What Exists Today (v1)

GitDone v1 is a working multi-vendor workflow coordination platform, ~80% complete for one use case: event/wedding vendor management (docs/archive/prd.md:104-104).

### 2.1 Tech stack (v1)
- Frontend: Next.js 15, TypeScript, Tailwind CSS (docs/archive/prd.md:107-107)
- Backend: Node.js, Express (docs/archive/prd.md:108-108)
- Storage: JSON files (`data/events/*.json`), git repos (`data/git_repos/`), file uploads (docs/archive/prd.md:109-109)
- Auth: JWT magic links, 30-day expiry, one-time use (docs/archive/prd.md:110-110)
- Email (outbound only): Nodemailer over SMTP (docs/archive/prd.md:111-111)
- File processing: Sharp (images), fluent-ffmpeg (videos) (docs/archive/prd.md:112-112)

### 2.2 What works end-to-end
- Event creation with 3 flow types: sequential, non-sequential, hybrid (docs/archive/prd.md:115-115)
- Magic link auth: vendor receives email, clicks, uploads files, step completes (docs/archive/prd.md:116-116)
- Git commits per step completion with files and metadata (docs/archive/prd.md:117-117)
- Real-time initiator dashboard; read-only public event views (docs/archive/prd.md:118-119)
- Platform statistics with 6-hour aggregation cron (docs/archive/prd.md:120-120)
- Management/edit links for event owners (docs/archive/prd.md:121-121)
- File size/type validation and image compression (docs/archive/prd.md:122-122)

### 2.3 Partially built
- Video processing (dependency imported, not tested end-to-end), analytics dashboard, reminder emails (infrastructure present, may need testing) (docs/archive/prd.md:125-127)

### 2.4 Missing
- Inbound email (system only sends); DKIM verification; OpenTimestamps anchoring (docs/archive/prd.md:130-132)
- Multi-use-case abstraction (hardcoded to "vendor uploads files"); crypto event type (count-based completion); attachment forwarding model (current design stores files on server) (docs/archive/prd.md:133-135)

### 2.5 Critical gaps that blocked v1
1. No moat: another event-management tool, nothing structurally unique (docs/archive/prd.md:138-138)
2. Storage burden: every uploaded file lives on the server (docs/archive/prd.md:139-139)
3. Privacy concern: server holds all attachments (docs/archive/prd.md:140-140)
4. Tight coupling: web app required for both initiator and participants (docs/archive/prd.md:141-141)
5. Single use case: engine doesn't generalize beyond wedding-style vendor workflows (docs/archive/prd.md:142-142)

## 3. What's Changing (v2)

v2 is a structural rebuild of the participant flow and a generalization of the event model. The initiator web app stays (simplified); participant web forms disappear; email becomes the interface for everything participants do (docs/archive/prd.md:148-148).

### 3.1 Architectural diff

| Component | v1 | v2 |
|---|---|---|
| Initiator UI | Next.js web app | Simplified: vanilla `node:http` + tagged template literals, no client JS |
| Participant UI | Next.js magic link form | Removed: email reply IS the interface |
| Magic link tokens | Everyone, JWT 30-day | Initiator only, via `knowless` (Mode A): one 15-min single-use magic link per event creation that verifies the email, opens a 30-day session, and lands on the event dashboard. Sessions live in `{dataDir}/knowless.db`; sign out deletes the row |
| SMTP send | Nodemailer | `sendmail(1)` via Postfix pipe; opendkim milter signs at the MTA |
| SMTP receive | None | Postfix on VPS, piped to Node |
| DKIM verification | None | `mailauth` library |
| OpenTimestamps | None | Anchor every commit to Bitcoin |
| DKIM key archival | None | Store signing keys with each commit |
| Reply parsing | None | `mailparser`, extract metadata |
| Attachment storage | Server filesystem | Removed: forwarded to event owner, hash only in git |
| Event types | Sequential / non / hybrid | Same + crypto (declaration + attestation modes) |
| Data storage | JSON files | Same + archived DKIM keys |
| Git commits | Per step completion (via web) | Per reply received (via email) |
| Stats, reminders, management UI | Working | Same (mostly unchanged) |

(docs/archive/prd.md:152-167)

### 3.2 What gets deleted
- All participant-facing web pages (`/participate/:token`, upload forms, participant-perspective progress views) (docs/archive/prd.md:170-170)
- Participant magic link generation (no per-participant tokens) (docs/archive/prd.md:171-171)
- File upload endpoints for participants (docs/archive/prd.md:172-172)
- Server-side attachment storage (only hashes remain) (docs/archive/prd.md:173-173)

### 3.3 What gets added
- Postfix configuration on the VPS to receive email at `*@gitdone.yourdomain` (docs/archive/prd.md:176-176)
- `receive.js`: reads inbound email from Postfix pipe, verifies DKIM, parses MIME, routes to the correct event, forwards attachments to event owner, commits metadata to git, anchors to OpenTimestamps, sends receipt to sender (docs/archive/prd.md:177-177)
- `mailauth` npm dependency for DKIM, SPF, DMARC and ARC verification (docs/archive/prd.md:178-178)
- `mailparser` npm dependency for MIME parsing (docs/archive/prd.md:179-179)
- `opentimestamps-client` dependency (Node or Python) for Bitcoin timestamp anchoring (docs/archive/prd.md:180-180)
- New event type `crypto`: count-based completion with distinct DKIM-verified senders (docs/archive/prd.md:181-181)
- DKIM public key archival: each commit stores the DKIM public key used, so future verification doesn't depend on DNS archives (docs/archive/prd.md:182-182)
- Attachment hash recording: SHA-256 hashes recorded in the git commit when forwarding to event owner (docs/archive/prd.md:183-183)
- Humans-only pre-filter: reject messages with `Auto-Submitted`, `List-Id`, `List-Post`, `Precedence: bulk|list|junk` headers, or system-sender patterns (`noreply@`, `mailer-daemon@`); keeps the git repo free of auto-responders and list traffic (docs/archive/prd.md:184-184)

### 3.4 What stays the same
- Event creation flow (initiator defines steps, participants, sequence); JSON-based storage; one git repo per event; git commits as audit trail (docs/archive/prd.md:187-190)
- Sequential / non-sequential / hybrid workflows; platform stats aggregation; reminder email infrastructure; management links for initiators (docs/archive/prd.md:191-194)

## 8. Technical Architecture (v2)

### 8.1 Services

One VPS hosts (docs/archive/prd.md:1127-1158):
- Nginx (TLS, HTTPS in) in front of a vanilla `node:http` server exposing `POST /events, /crypto`, `/manage` (hub + auth), `/manage/event/:id`, and read-only `/events/:id`.
- The web server does file I/O against `data/`: `events/*.json`, `git_repos/*/`, `dkim_keys_archive/*`.
- Postfix (MX, SMTP in from participants' email) pipes to `receive.js`, which uses mailauth (DKIM), mailparser (MIME), ots-client (OTS), forwards the email to the owner, and commits to the event repo.

### 8.2 Dependencies

Existing (keep): `express`, `nodemailer`, `sharp`, `fluent-ffmpeg` (if video needed); whatever frontend stays (simplify to vanilla or keep Next.js minimal) (docs/archive/prd.md:1162-1164).

New (docs/archive/prd.md:1166-1170):
- `mailauth`: DKIM / SPF / DMARC / ARC verification (Node, by Nodemailer author, actively maintained)
- `mailparser`: MIME parsing (Node, same author)
- `opentimestamps-client`: Bitcoin anchoring (Python binary via subprocess, or Node equivalent if available)
- `simple-git` or equivalent: git operations from Node (already in use)

Infrastructure (docs/archive/prd.md:1172-1175):
- Postfix (`dnf install postfix`, pipe transport to `receive.js`)
- MX DNS record pointing at the VPS
- SPF + DKIM + DMARC records for outbound from `gitdone.yourdomain`, so our own emails validate

### 8.3 Data model (git repo per event)

```
data/git_repos/evt-abc123/
├── event.json              # initial event definition
├── commits/commit-001.json, commit-002.json, ...   # one per reply
├── dkim_keys/commit-001.pem, ...                   # archived DKIM public key per commit
├── ots_proofs/commit-001.ots, ...                  # OpenTimestamps proof per commit
└── completion.json         # when event closes, final state
```

(docs/archive/prd.md:1179-1195)

Each `commit-NNN.json` (docs/archive/prd.md:1197-1227) carries:
- `schema_version: 2`, `event_id`, `step_id`, `sequence`, `received_at`
- `sender_hash` (`sha256:...`), `sender_domain`, `trust_level` (e.g. `verified`), `participant_match`
- `attachments[]`: `filename`, `size`, `sha256`
- `dkim.signatures[]` (`result`, `aligned`, `selector`, `domain`), `spf.result`, `dmarc.result`, `arc.result`
- `envelope`: `client_ip`, `client_helo`
- `raw_sha256`, `raw_size`, `dkim_key_file` (`dkim_keys/commit-001.pem`), `ots_proof_file` (`ots_proofs/commit-001.ots`)

Schema v2 rationale (per §0.1.10 plaintext discipline): sender is represented only by its salted hash (salt lives in the event's `event.json`) and by domain. Subject, body preview, message ID, and plaintext sender are not stored in committed metadata; they live only in the forwarded email to the event owner. The event salt is per-event public, so a verifier can re-hash a claimed address and match, but bulk correlation across events is infeasible (docs/archive/prd.md:1229-1229).

## 9. Deployment and Infrastructure

### 9.1 Target environment
- VPS: NerdWallet (user's existing); OS: Fedora Linux (user's standard); domain: fresh, MX records pointing to VPS (docs/archive/prd.md:1237-1239)
- Deployment: systemd services + Nginx + TLS. No PM2: the Phase 1 stack is vanilla `node:http`, not Express; one long-lived `gitdone-web.service` plus Postfix pipe transport per-message (docs/archive/prd.md:1240-1240)
- Storage budget: minimal (no attachment storage; JSON + DKIM keys + OTS proofs are small) (docs/archive/prd.md:1241-1241)

### 9.1.1 Dev + prod on the same VPS

Production runs on `signedreply.com`. Integration testing needing inbound email (receive pipeline, completion cascades, initiator email commands) uses a staging environment on the same VPS under `staging.signedreply.com` (docs/archive/prd.md:1245-1248):
- Separate systemd unit `gitdone-web-staging.service` on a second local port (docs/archive/prd.md:1250-1251)
- Separate data dir `/var/lib/gitdone-staging/` vs `/var/lib/gitdone/` (docs/archive/prd.md:1252-1253)
- Separate Postfix transport routing `event+*@staging.signedreply.com` to `receive.js` with `GITDONE_DATA_DIR` overridden (docs/archive/prd.md:1254-1255)
- Nginx server block for `staging.signedreply.com` to the staging port (docs/archive/prd.md:1256-1256)
- Same DKIM selector works for both since the signing key is domain-scoped; only the subdomain changes on outbound (docs/archive/prd.md:1257-1258)

Local laptop `--dev` mode (HUD + live-reload + `./data-dev/`) is for UI work and anything not needing inbound mail; full-pipeline testing happens on staging (docs/archive/prd.md:1260-1262).

### 9.2 Setup steps (infrastructure)
1. Install Postfix: `dnf install postfix`
2. Configure Postfix to receive mail for `*@gitdone.yourdomain`
3. Configure pipe transport in `/etc/postfix/master.cf` to hand email to `receive.js`
4. DNS: MX record to VPS; SPF record for outbound; DKIM keys and DKIM TXT record for outbound; DMARC record
5. Generate OpenTimestamps client binary on VPS
6. Configure Node service (PM2) for Express + `receive.js` listener

(docs/archive/prd.md:1266-1275). Note: step 6 names PM2/Express, whereas §9.1 says no PM2 and vanilla `node:http` (docs/archive/prd.md:1240-1240, 1274-1275).

### 9.2.1 Operator visibility (stats)

Two read-only artefacts walk `data/events/*.json` and give privacy-safe aggregate counts; neither surfaces to end users (docs/archive/prd.md:1279-1281).
- `app/bin/stats.js`: on-demand CLI. Prints unique organisers, unique named recipients (workflow participants + declaration signers; attestation senders excluded as anonymous-by-design), events by type and status, completed-vs-incomplete, workflow step totals, attestation reply totals. JSON to stdout, human table to stderr. `--metrics-json` emits a flat `{name:integer}` object (via `flatMetrics` in `app/src/stats.js`), the feed for pulselog's digest (docs/archive/prd.md:1283-1289).
- Weekly digest email (`gitdone-stats-weekly.timer`, Mondays 06:00 UTC), produced by `pulselog --digest` (pinned in `ops/pulselog`): runs `stats.js --metrics-json`, appends one ISO-week snapshot line to `/var/lib/gitdone/logs/stats.jsonl`, and emails the last 4 weeks as a week-over-week table to `avoidaccess@gmail.com` (the alerts identity, never the organiser address), with a 7-day flightlog error rollup (counts + names only). pulselog's `loadWeeks` groups by ISO week, so the snapshot is taken weekly at digest time. The prior daily snapshot job (`gitdone-stats.timer` to `stats.log`) is retired. See finding #49 (docs/archive/prd.md:1290-1300).

Both are aggregates only; no PII leaves the box. pulselog stores only the integers `stats.js` prints, and the error rollup is counts + names, never messages or stacks (docs/archive/prd.md:1302-1304).

### 9.3 No vendor dependencies
- No SendGrid, Mailgun, or Postmark: Postfix directly
- No cloud functions: Node scripts on VPS
- No proprietary timestamp service: OpenTimestamps is free, open, Bitcoin-anchored
- No platform lock-in

(docs/archive/prd.md:1308-1311)
