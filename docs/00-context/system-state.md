# System state — what's currently built

**As of 2026-04-20.** Phase 1 feature-complete and live at
https://git-done.com.

## One-paragraph architecture

A single VPS runs three persistent processes: **nginx** (TLS
termination), **Postfix + opendkim** (mail in and out), and
**gitdone-web** (a vanilla `node:http` server on `127.0.0.1:3001`
serving the initiator UI). Inbound mail for `event+*@git-done.com` is
pipe-transported to `app/bin/receive.js` per message — not a
long-running process, each message gets its own invocation. Outbound
mail is submitted via `sendmail(1)`; opendkim signs at the MTA. Every
reply is classified (DKIM / DMARC / SPF), committed to a per-event
git repository under `/var/lib/gitdone/repos/<id>.git/`, and
OpenTimestamped. A systemd timer upgrades OTS proofs every 6h. Data,
code, and ops are strictly separated on disk.

## What works end-to-end

1. Initiator visits `/events/new` or `/crypto/new`, fills a form,
   confirms the preview.
2. Event persisted to `events/<id>.json` with per-event salt.
3. 30-day management token minted; link emailed.
4. For workflow events: root steps (no `depends_on`) get notification
   emails. For crypto declarations: the signer gets one. For
   attestations: the initiator gets a shareable `mailto:` link.
5. Participant replies to `event+<id>-<step>@git-done.com` (or
   `event+<id>@` for crypto).
6. Postfix pipe → `receive.js`: prefilter → classify → verify DKIM →
   commit → OTS stamp → forward original email to the initiator
   (attachments byte-preserving).
7. `completion.js` advances event state; if newly-eligible downstream
   steps exist, notifies them; if the whole event is complete, writes
   `commits/completion.json` + OTS stamp.
8. Initiator drives the rest by email (`stats+`, `remind+`, `close+`,
   `verify+`, `reverify+` addresses) or at
   `https://git-done.com/manage/<token>`.
9. Anyone verifies offline: `git clone` the event repo →
   `tools/gitdone-verify` runs six check layers with zero network
   calls.

## Tech stack (prod)

| Piece | Choice | Why |
|---|---|---|
| Runtime | Node.js 20.20 (AlmaLinux 8) | Stdlib is enough; no bundler |
| HTTP | vanilla `node:http` + tagged-template HTML | No Express, no React |
| Reverse proxy | nginx + Let's Encrypt | Standard, certbot auto-renew |
| Inbound mail | Postfix pipe-transport → `receive.sh` → `node` | Per-message, no long-running |
| Outbound mail | `sendmail(1)` + opendkim milter (selector `gd202604`) | Zero Node-side crypto |
| DKIM/DMARC/SPF verify | `mailauth` | Vetted library per principle |
| MIME parsing | `mailparser` | Same |
| Per-event VCS | `simple-git` | Small, tested |
| Timestamps | OpenTimestamps via `ots` CLI, 6h systemd upgrade timer | Bitcoin anchor, offline-verifiable |
| Sessions | Self-signed HMAC cookies; no server store | Stateless, stdlib-only |
| Data | JSON files + per-event git repos | No database |

Production deps live only in `app/package.json`:
`mailauth`, `mailparser`, `simple-git`. Everything else is stdlib.

## Data layout on disk

```
/opt/gitdone/                   # code (git clone)
└── app/
    ├── bin/{server,receive,ots-upgrade}.js
    └── src/

/var/lib/gitdone/               # runtime data (separate from code)
├── events/<id>.json            # event JSON + per-event salt
├── repos/<id>.git/             # per-event git repo (commits/, dkim_keys/, ots_proofs/)
└── magic_tokens/               # session tokens + per-event management tokens
    ├── <token32>.json          # per-event (30-day)
    └── session_<token32>.json  # self-serve signin (15-min, single-use)

/etc/default/gitdone-web        # systemd EnvironmentFile (session secret + paths)
/etc/opendkim/keys/git-done.com/gd202604.private   # DKIM signing key (irreplaceable)
/etc/letsencrypt/live/git-done.com/                 # TLS cert
/var/log/gitdone/               # web log (journald also has it)
```

## Systemd units

- `gitdone-web.service` — long-lived, 127.0.0.1:3001
- `gitdone-ots-upgrade.timer` — every 6h
- `gitdone-health.timer` — every 15min; emails on any degradation

## Plus-tag address routing

| Address | Purpose | Auth |
|---|---|---|
| `event+<id>-<step>@` | workflow reply | DKIM + participant match |
| `event+<id>@` | crypto reply (declaration or attestation) | DKIM (+ signer match for declarations) |
| `verify+<id>@` | public verification report | none |
| `reverify+<id>-<N>@` | contested-commit upgrade | cryptographic evidence |
| `stats+<id>@` | initiator: progress | DKIM + envelope sender == initiator |
| `remind+<id>@` | initiator: resend reminders | same |
| `close+<id>@` | initiator: close early | same |

## Off-VPS resilience

- **Backup:** federver (home server) pulls events/repos/dkim/cert/env
  daily at 04:15 UTC via `ops/homeserver/gitdone-backup.sh`. 30-day
  retention.
- **Monitoring:** Kuma on federver — HTTP monitor on `/health`
  (60s interval), push monitor for backup heartbeat.
- **Secrets:** `pass gitdone/vps/{ssh_key_federver, session_secret,
  root_password}`; `pass gitdone/opendkim/*` for DKIM keys.

## What's not built (deferred to Phase 2)

See `CHANGELOG.md` "Known gaps" and PRD §10.3–§10.6 for the
authoritative list. Headline items:

- Auto-reminders near deadlines (`remind+` is manual for now)
- Trust-weighted completion (N-of-M per signer class for advanced
  attestations)
- Participant-side reply receipts ("we recorded your reply at commit
  X")
- Staging environment on `staging.git-done.com` (appendix-only in
  `deployment.md` — add when real users exist)
