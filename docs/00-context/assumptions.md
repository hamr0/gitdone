# Assumptions, constraints, risks

## Hard constraints (non-negotiable per PRD §0.1)

1. **No accounts, no REST API, no telemetry.** Cross-cutting — every
   feature must fit.
2. **Proofs verify offline.** Any change that adds a gitdone-service
   dependency to verification is a principle violation.
3. **Plaintext discipline.** Sender addresses hashed with per-event
   salt, attachments never stored server-side (forwarded to owner;
   only SHA-256 hashes committed).

## Technical assumptions

- **Single VPS for Phase 1.** AlmaLinux 8 on `104.129.2.254`. All
  state except backups fits on one box. Horizontal scaling is a
  Phase 2+ concern.
- **Pre-launch scale.** Dozens of events, hundreds of replies. Most
  lookups (events-by-initiator, token-by-event-id) are scan-based.
  Revisit when scan time shows up in logs.
- **Mail providers sign.** DKIM passing from Gmail, MSN/Outlook,
  Proton, Fastmail, iCloud, and major corporate gateways is the
  default assumption. The `min_trust_level` enum exists to
  gracefully degrade when it doesn't.
- **Participants' inboxes are the attachment archive.** gitdone never
  stores attachments; the forward to the initiator is the archive.
- **Git's SHA-1 is good enough.** The commit hash is one of four
  named trust deposits (§0.1.9).

## Operational assumptions

- **Postfix + opendkim on the same box as the web server.** Pipe
  transport needs the `gitdone` user to read/write `/var/lib/gitdone/`
  directly. Splitting roles across hosts is a re-architecture, not a
  config change.
- **Backup runs off-VPS on federver.** Losing federver = losing
  backups (VPS data is still live); losing VPS = restorable from
  federver within ~10 min if the SSH key is in `pass`.
- **Session cookies use HMAC-SHA256, stateless.** Rotating the secret
  invalidates every active `/manage` session but doesn't affect
  per-event 30-day management tokens (those are file-backed).

## Risks, named and mitigated

| Risk | Mitigation |
|---|---|
| opendkim DNS key lost | Private key backed up under `pass gitdone/opendkim/private_key`; also daily tar from VPS to federver |
| Let's Encrypt cert not renewing | `gitdone-health.timer` warns 14 days before expiry; certbot timer handles renewal |
| VPS dies | Full restore from federver tar → new VPS: ~30 min with DNS cutover |
| Inbound mail pipeline OOM on a huge attachment | Postfix `message_size_limit` caps; receive.js streams, doesn't buffer |
| Attestation spam | `min_trust_level=verified` default + `allow_anonymous=off` default; dedup rule chooses whether duplicates count |
| Session secret leaked | Rotate via `/etc/default/gitdone-web`; all live sessions forcibly re-sign |
| gitdone-verify tool maintainer captured | MIT license + PRD §0.1.2; the tool must remain forkable |

## Known unknowns

- Will real corporate mail gateways break DKIM at scale? We default
  to `verified` but offer `forwarded` and `authorized` fallbacks.
  Only time and real events will tell us which levels people
  actually need.
- How many concurrent attestations (N distinct signers in parallel)
  before the scan-based `findEventsByInitiator` / `findTokenByEventId`
  become slow? Empirical threshold unknown; the structural answer is
  "add a JSON index under `data/by_initiator/<sha>.json`." Not yet
  needed.
- Whether per-event git repos grow into a performance problem at
  very long-running attestations (thousands of commits). `git
  maintenance` hasn't been invoked; may need to be scheduled.

## Deferred (explicit non-goals for Phase 1)

- Public REST API — PRD §0.1.6.
- Frontend framework / client-side SPA — principle §0.1.4.
- User accounts, profiles, "my gitdone" — principle §0.1.1.
- Third-party analytics, any telemetry — principle §0.1.5.
- Cross-event aggregation or trust-score system — principle §0.1.8.
- Staging environment on the same VPS — `deployment.md` appendix;
  add when real users exist.
