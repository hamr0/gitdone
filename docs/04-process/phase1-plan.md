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
| **1.C** | Per-event git repo + commit per reply | 1.A, 1.B | Real reply → commit visible in event's git log with §8.3 schema |
| **1.D** | DKIM key archival per commit | 1.C | `dkim_keys/commit-N.pem` written; offline re-verification works |
| **1.E** | OpenTimestamps async anchoring | 1.C | `ots_proofs/commit-N.ots` verifies against Bitcoin |
| **1.F** | Outbound DKIM signing (DNS + Postfix or opendkim) | independent | Gmail receives a message from us with DKIM pass |
| **1.G** | Attachment forwarding to event owner | 1.C, 1.F | Owner inbox gets original email; SHA-256 in git matches forwarded copy |
| **1.H** | Event creation UI (plain HTML) + magic-link management | independent | Initiator creates event in < 30s; gets management link |
| **1.I** | Participant notification emails | 1.F, 1.H | Participant receives DKIM-signed prompt with reply-to event tag |
| **1.J** | Completion logic (workflow / declaration / attestation) | 1.C, 1.H | Final reply triggers `event.close` + initiator notification |
| **1.K** | Delete v1 participant routes + React UI | 1.H, 1.I | Only initiator-facing pages remain; no participant-token code |

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
