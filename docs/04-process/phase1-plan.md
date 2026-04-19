# Phase 1 — Implementation Plan

**Status:** approved 2026-04-17
**Source:** PRD §10 Phase 1 + §10.5 Phase 0 findings
**Charter:** rewrite the POC into production code, build the receive pipeline end-to-end (routing → git commit → forwarding → outbound), remove v1 magic-link participant code.

This document is the execution plan, not the spec. The spec is the PRD. If they conflict, the PRD wins and this file gets corrected.

---

## Production layout

```
/opt/gitdone/                           # production code (deployed)
├── bin/
│   ├── receive.sh                      # wrapper: envelope args → node
│   └── receive.js                      # entry point
├── src/
│   ├── config.js                       # 12-factor env config
│   ├── prefilter.js                    # humans-only rules (PRD §7.4)
│   ├── classifier.js                   # 4-level trust classifier (PRD §7.4)
│   ├── router.js                       # plus-tag parse, event lookup
│   ├── gitrepo.js                      # commit per reply
│   ├── ots.js                          # OpenTimestamps anchor
│   ├── dkim-archive.js                 # save signing key per commit
│   ├── forward.js                      # SMTP forward to event owner
│   └── outbound.js                     # participant notifications
├── tests/
│   ├── unit/                           # pure modules (prefilter, classifier)
│   ├── integration/                    # real .eml fixtures + tmp git repos
│   └── fixtures/                       # synthetic .eml — never real mail
└── package.json

/var/lib/gitdone/                       # runtime data (separate volume / backup)
├── events/{eventID}.json
└── repos/{eventID}.git/
    ├── event.json
    ├── commits/commit-NNN.json
    ├── dkim_keys/commit-NNN.pem
    └── ots_proofs/commit-NNN.ots

/var/log/gitdone/receive.log            # log file (also stdout → journald)
```

## Decided defaults (overridable)

| Decision | Choice | Rationale |
|---|---|---|
| Runtime user | `gitdone` (system, no shell, home `/var/lib/gitdone`) | Least privilege; not running as `nobody` or `root` |
| Data paths | `/var/lib/gitdone/` | FHS-standard, easy backup separation |
| Test framework | `node:test` (Node ≥18 stdlib) | AGENT_RULES: stdlib over external; one fewer dep |
| Event JSON schema | PRD §4 as-is | Revisit if friction emerges |
| Git library | `simple-git` (≈300KB, in v1 backend already) | Tested, maintained, clean API |
| Config style | Environment variables | 12-factor §3 |
| Logging | stdout (journald captures) + `/var/log/gitdone/receive.log` | 12-factor §11 |

---

## Module breakdown

Modules are ordered so each is independently completable and verifiable.

| # | Module | Depends on | Done = |
|---|---|---|---|
| **1.A** ✅ | Clean rewrite + production user/dirs + unit tests | POC | Phase 0 happy-path matrix passes under new code; unit tests green — **done 2026-04-17, commit `2bfb5f2`** |
| **1.B** ✅ | Plus-tag router + event JSON lookup | 1.A | Reply with valid tag finds event; unknown tag rejected and logged — **done 2026-04-17** |
| **1.C** ✅ | Per-event git repo + commit per reply | 1.A, 1.B | Real reply → commit visible in event's git log with §8.3 schema — **done 2026-04-17** |
| **1.D** ✅ | DKIM key archival per commit | 1.C | `dkim_keys/commit-N.pem` written; offline re-verification works — **done 2026-04-17** |
| **1.E** ✅ | OpenTimestamps async anchoring | 1.C | `ots_proofs/commit-N.ots` verifies against Bitcoin — **done 2026-04-17** |
| **1.C+** ✅ | Principle §0.1.10 compliance (salted hash, drop plaintext) + OTS-verify fix | 1.C, §0 | No plaintext leaks in commit JSON; `ots verify` succeeds on final committed JSON — **done 2026-04-17** |
| **1.L.1** ✅ | `verify+{id}@` email handler + DKIM-signed reply send path | 1.C, 1.F | Forwarded `.eml` identifies matching commit via Message-ID cascade; plain-text report DKIM-signed and replied to forwarder via sendmail(8) — **done 2026-04-17** |
| **1.L.2** ✅ | Offline CLI `gitdone-verify` | 1.C | CLI takes a repo path; runs 6 check layers (structure, git fsck, schema v2 + plaintext discipline, archived DKIM PEM parse, OTS with tamper detection, workflow completion); zero gitdone service calls — **done 2026-04-17**, 31 tests green, tamper-detection validated against a live-modified demo123 repo |
| **1.L.3** ✅ | `reverify+{id}-{commitN}@` handler + append-only upgrade record | 1.C, 1.L.1 ✅, 1.F ✅ | Contested commits can be upgraded by forwarding evidence; history preserved as immutable `reverify-NNN.json` — **done 2026-04-18**, 3 E2E paths validated (not-found / no-key / already-verified); offline verifier updated to recognise reverify records and apply trust upgrades |
| **1.E+** ✅ | OTS upgrade scheduled — `ots upgrade` every 6h via systemd timer | 1.E | `app/bin/ots-upgrade.js` (walks repos, upgrades, commits). Systemd `gitdone-ots-upgrade.timer` (6h cadence, 5min post-boot jitter). Idempotent (no change = no commit). Closes the gap where `.ots` files would depend on calendar-server longevity — **done 2026-04-18**, 2 proofs upgraded on first run (commit-001, commit-002), next run scheduled |
| — ✅ | **Initiator email commands** — stats+, remind+, close+ | 1.F ✅, 1.J ✅ | DKIM-verified sender == event.initiator + trust ≥ min_trust_level. stats replies with checklist/progress; remind resends pending-participant invites; close writes completion.json with closed_by=initiator — **done 2026-04-19**, 14 tests (10 unit + 4 integration) |
| **1.F** ✅ | Outbound DKIM signing (DNS + Postfix + opendkim) | independent | Gmail receives a message from us with DKIM pass — **done 2026-04-17**, selector `gd202604`, Gmail confirms dkim/spf/dmarc all `pass` |
| **1.G** ✅ | Attachment forwarding to event owner | 1.C, 1.F | Owner inbox gets original email (byte-preserving); SHA-256 in git matches forwarded copy; X-GitDone-* tracking headers prepended — **done 2026-04-18**, validated end-to-end: Gmail → event+demo123-step1@ → MSN inbox of initiator, both test forwards delivered, attachment (PDF) intact |
| **1.H.1** ✅ | Archive v1 + Express-less HTTP skeleton on VPS | independent | v1 deleted (2235 files incl. node_modules); vanilla Node http server with router/templates/body-parse; landing page + /health; systemd unit; 34 tests — **done 2026-04-18** |
| **1.H.2** ✅ | Workflow event creation (sequential + non-sequential + deadlines per step) | 1.H.1 ✅ | Plain-HTML form + server-side validation + schema write with event.salt (1.C+), atomic persistence, debug read-only view — **done 2026-04-18**, 34 new tests (validation + create + integration) |
| **1.H.2.1** ✅ | Event form redesign — Design Lab synthesis winner F2 | 1.H.2 ✅ | Numbered sections, What+Who/How/Steps, compact datetime-local step table, explained dropdowns — **done 2026-04-18**, frozen at `docs/01-product/design/event-form-v1.md` |
| **1.H.2b** ✅ | Dependency graph (replaces flow + hybrid tree editor) | 1.H.2 ✅ | Dropped the flow dropdown entirely; each step has a `depends_on` list (text input of comma-separated step numbers). Empty = runs immediately. Sequential = chain; non-sequential = all roots; DAG forks and merges are free. Cycle detection at submit — **done 2026-04-19**, clean cut, 8 new unit tests |
| **1.H.3** ✅ | Landing + Crypto form (declaration + attestation) | 1.H.1 ✅ | F-variant dense grid, mode-segmented control, `validateCryptoEvent`, `POST /crypto`, per-mode management email — **done 2026-04-19**, Live Canvas winner; frozen at `docs/01-product/design/landing-and-crypto-v1.md` |
| **1.H.4** ✅ | Magic-link management URL + email | 1.H.2 ✅ | Opaque 32-hex token, 30-day TTL, one-file-per-token store, `/manage/{token}` stub — **done 2026-04-19**, chose opaque over JWT (single-host, revocation by file delete) |
| **1.H.5** ✅ | Management dashboard (read-only + close event) | 1.H.4 ✅ | Compact step table with status + deps, attestation/declaration status panels, Send reminders + Close event buttons (303 redirect with flash), email-command fallback footer — **done 2026-04-19**, 2 new integration tests |
| **1.I** ✅ | Participant notification emails | 1.F ✅, 1.H.2 ✅, 1.H.3 ✅ | Workflow sequential: step 1 only. Non-sequential / hybrid: every step. Declaration: signer. Attestation: skip (shareable address) — **done 2026-04-19**, 3 unit + 4 integration tests |
| **1.J** ✅ | Completion engine (workflow / declaration / attestation) | 1.C ✅, 1.H ✅, 1.I ✅ | Pure state machine + `commitCompletion` audit entry + sequential cascade. Trust-gated, dedup-aware (unique / latest / accumulating) — **done 2026-04-19**, 21 unit + 6 integration tests |
| **1.K** ✅ | Delete v1 participant routes + React UI | 1.H ✅, 1.I ✅ | All v1 code removed in 1.H.1 (2235 files); no participant-token paths remain — **done 2026-04-18** |

**First slice = 1.A + 1.B + 1.C** — minimum vertical that proves end-to-end "reply lands as git commit." Estimated 3–5 hours.

After the first slice: tackle 1.D + 1.E (cryptographic completeness) as a pair, then 1.F + 1.G (owner path), then 1.H + 1.I (UI/outbound), then 1.J (completion), 1.K (cleanup).

---

## Constraints carried forward from Phase 0 findings

These are non-obvious lessons that production code must respect:

1. **Postfix `PrivateTmp=yes`** — never log to `/tmp/`. Use `/var/log/gitdone/`.
2. **Pipe(8) transport, not alias-pipe** — required for `${client_address}` etc. Already configured on VPS in Phase 0.
3. **`receive.js` accepts envelope args** (`client_ip client_helo sender original_recipient`) and passes them to `mailauth.authenticate()` as `{ip, helo, sender, mta}`.
4. **`mydestination` must NOT contain `git-done.com`** or `local(8)` intercepts before the transport runs.
5. **Run as dedicated `gitdone` user**, not `nobody`. Postfix master.cf needs updating.
6. **Pre-filter scans raw header bytes via regex, not parsed structured headers** — mailparser's structured-header parsing was the latent bug we fixed.

---

## Out of scope for Phase 1

Per PRD §12 + Phase 1 charter:

- Crypto event types (Declaration / Attestation) → Phase 2
- Federation, webhooks, external API → Phase 4
- TLS on inbound SMTP (Let's Encrypt + smtpd_tls_*) → defer to Phase 1.5 polish
- Production hardening (SELinux policy, fail2ban) → defer until traffic justifies

---

## Open items at start of Phase 1

- **DKIM signing key for outbound** (1.F): generate, publish DNS, configure signer
- **SPF + DMARC DNS records** for `git-done.com` (1.F prereq)
- **First event-creation flow design** — minimal HTML form, schema confirmed (1.H)

These get resolved in their respective modules.
