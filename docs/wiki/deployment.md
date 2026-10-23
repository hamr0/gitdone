# GitDone — Deployment Guide

**Stack:** Fedora Linux, Node.js ≥18 (vanilla `node:http`), Postfix, opendkim,
nginx, systemd. No PM2, no bundler, no frontend framework.

**Topology:** one VPS, one environment (`signedreply.com`). Local laptop
`--dev` mode (`./data-dev/`, HUD, SSE live-reload) is the test environment
for UI and business logic; prod is the only environment that runs the
inbound-email pipeline. Staging on a subdomain is documented in the
Appendix — add it when you have real users.

Runbook at the bottom.

---

## 1. Prerequisites

- VPS: Fedora 40+, 2 GB RAM, 20 GB disk. Current VPS IP: `104.129.2.254`.
- DNS (Route 53, hosted zone `signedreply.com`):
  - `A   signedreply.com              → 104.129.2.254`
  - `MX  signedreply.com              10 mail.signedreply.com.`
  - `A   mail.signedreply.com         → 104.129.2.254` *(already set)*
  - `TXT signedreply.com              "v=spf1 mx -all"` *(already set)*
  - `TXT gd202606._domainkey.signedreply.com  "v=DKIM1; k=rsa; p=..."` *(already set)*
  - `TXT _dmarc.signedreply.com       "v=DMARC1; p=none; rua=mailto:postmaster@signedreply.com; aspf=s; adkim=s"` *(already set)*

## 2. System packages

```bash
sudo dnf install -y \
  nodejs git \
  postfix opendkim opendkim-tools \
  nginx certbot python3-certbot-nginx \
  opentimestamps-client
```

## 3. User + directories

```bash
sudo useradd --system --home-dir /var/lib/gitdone --shell /sbin/nologin gitdone
sudo install -d -o gitdone -g gitdone /var/lib/gitdone /var/log/gitdone
sudo install -d -o root   -g root    /opt/gitdone
```

## 4. Deploy code

```bash
sudo git clone https://github.com/<you>/gitdone /opt/gitdone
cd /opt/gitdone/app && sudo npm ci --omit=dev
sudo chown -R root:root /opt/gitdone
sudo chmod +x /opt/gitdone/app/bin/receive.sh
```

Production code is read-only to `gitdone`; data/logs are writable.

## 5. Outbound DKIM (opendkim)

Selector `gd202606` already live. For reference:

```
# /etc/opendkim.conf
Domain       signedreply.com
Selector     gd202606
KeyFile      /etc/opendkim/keys/signedreply.com/gd202606.private
Socket       inet:8891@localhost
Mode         sv
SubDomains   yes
```

## 6. Postfix

`/etc/postfix/master.cf` — pipe transport:

```
gitdone unix - n n - 1 pipe
  flags=R user=gitdone argv=/opt/gitdone/app/bin/receive.sh ${client_address} ${client_helo} ${sender} ${original_recipient}
```

**The maxproc column MUST be `1`** (the `1` before `pipe`, not Postfix's default
100). `receive.js` has no in-process locking around the per-event git repo or
`events/<id>.json`; concurrency safety depends on Postfix serializing deliveries
through this pipe. At `maxproc>1`, concurrent deliveries to the same event race
the git `index.lock`/`nextSequence()` (lost replies, repo corruption) and the
per-process 25 MB cap multiplies into a `maxproc*25 MB` memory ceiling. See the
header comment in `app/bin/receive.sh`.

`/etc/postfix/main.cf`:

```
mydestination = localhost
virtual_alias_domains =
virtual_transport = gitdone
smtpd_milters = inet:localhost:8891
non_smtpd_milters = inet:localhost:8891
milter_default_action = accept
```

```bash
sudo systemctl enable --now opendkim postfix
```

### 6.1 Role-address aliases

The `gitdone` pipe transport catches all `*@signedreply.com` recipients by
default, which means `postmaster@`, `abuse@`, etc. never reach a real
inbox. Add virtual aliases BEFORE the pipe fallback so RFC 2142 role
addresses forward to the operator:

```bash
sudo install -m 644 /opt/gitdone/ops/postfix/virtual /etc/postfix/virtual
sudo postmap /etc/postfix/virtual
sudo postconf -e 'virtual_alias_maps = hash:/etc/postfix/virtual'
sudo postfix reload
```

Confirm:

```bash
postmap -q 'postmaster@signedreply.com' hash:/etc/postfix/virtual
# → avoidaccess@gmail.com
```

Required for: Microsoft SNDS sign-up (verification email goes to
`abuse@`), Google Postmaster Tools, and any future abuse-report path.

## 7. systemd unit — web

`/etc/systemd/system/gitdone-web.service`:

```ini
[Unit]
Description=GitDone web
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=gitdone
Group=gitdone
WorkingDirectory=/opt/gitdone/app
Environment=NODE_ENV=production
Environment=GITDONE_DATA_DIR=/var/lib/gitdone
Environment=GITDONE_HTTP_PORT=3001
Environment=GITDONE_PUBLIC_BASE_URL=https://signedreply.com
ExecStart=/usr/bin/node /opt/gitdone/app/bin/server.js
Restart=on-failure
RestartSec=3
StandardOutput=journal
StandardError=journal

# hardening
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/gitdone /var/log/gitdone
ProtectKernelTunables=yes
ProtectControlGroups=yes

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now gitdone-web.service
```

## 8. systemd — OTS upgrade timer (6h)

Already live on the VPS. Ship files at `ops/systemd/gitdone-ots-upgrade.{service,timer}`:

```ini
# service
[Service]
Type=oneshot
User=gitdone
Environment=GITDONE_DATA_DIR=/var/lib/gitdone
ExecStart=/usr/bin/node /opt/gitdone/app/bin/ots-upgrade.js
```

```ini
# timer
[Timer]
OnBootSec=5min
OnUnitActiveSec=6h
Persistent=true
[Install]
WantedBy=timers.target
```

## 9. nginx + TLS

`/etc/nginx/conf.d/gitdone.conf`:

```nginx
server {
  listen 80;
  server_name signedreply.com;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl http2;
  server_name signedreply.com;
  ssl_certificate     /etc/letsencrypt/live/signedreply.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/signedreply.com/privkey.pem;
  client_max_body_size 25m;

  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

> **SECURITY INVARIANT — `X-Forwarded-For $remote_addr` must *overwrite*, never
> *append*.** The app's per-IP login rate-limiter (`auth.sourceIp` →
> knowless `determineSourceIp`) trusts the **leftmost** XFF element as the real
> client. With `$remote_addr` nginx replaces the header with the true peer, so
> that element is trustworthy. If this is ever changed to
> `$proxy_add_x_forwarded_for` (append) — or the directive is dropped so nginx
> forwards the client's raw header — the leftmost element becomes
> **client-controlled**, and an attacker can forge `X-Forwarded-For:` to mint
> unlimited per-IP buckets and bypass the cap entirely. The live host once
> drifted to the appending form (caught 2026-05-31, PRD finding #48); the
> version-controlled vhost at `ops/nginx/gitdone.conf` is the source of truth —
> diff the live config against it after any nginx change. `GITDONE_TRUSTED_PROXIES`
> (default `127.0.0.1,::1`) lists which peer addresses are allowed to set XFF.

```bash
sudo certbot --nginx -d signedreply.com
sudo systemctl enable --now nginx
```

> **Cert renewal MUST reload nginx — set the `renew_hook` (2026-08-17).**
> certbot renews the cert *to disk*, but a long-running nginx keeps serving
> the cert it loaded at its last start until something reloads it. With no
> post-renewal hook, every silent renewal sat unused and the served cert went
> stale while disk was fresh — the §10.1 health check reads the *served* cert
> (`443`), so it paged "cert expires in 13d" even though certbot had already
> renewed to 73d. Fix is a per-cert reload hook, **not** a re-issue:
> ```bash
> # one line under [renewalparams] in the renewal conf:
> #   renew_hook = systemctl reload nginx
> sudo sed -i '/^\[renewalparams\]/a renew_hook = systemctl reload nginx' \
>   /etc/letsencrypt/renewal/signedreply.com.conf
> sudo certbot renew --cert-name signedreply.com --dry-run   # expect "simulated renewals succeeded"
> sudo systemctl reload nginx                                # picks up any already-renewed cert now
> ```
> This host is shared: the same hook is set on the co-tenant `ownsub.com`
> renewal conf too (the only other certbot cert on the box). The hooks live
> **only on the box** — they are not version-controlled — so **re-add them
> after any host rebuild or `/etc/letsencrypt` restore**, or renewals will
> silently stop reloading nginx again. `certbot renew` also applies a random
> delay of up to ~12 min; add `--no-random-sleep-on-renew` for an immediate
> manual dry-run.

## 10. Monitoring & alerts

Local checks run every 15 min from a systemd timer; VPS-down detection
comes from an external pinger (can't self-detect).

### 10.1 Local health check (pulselog)

Runs [`pulselog`](https://github.com/hamr0/pulselog) (pinned in `ops/pulselog`)
from the existing `gitdone-health.timer`. The thresholds/checks live in
`ops/pulselog/health.config.json` (self-contained — no `/etc/default` env file).
pulselog has zero prod deps, so its `node_modules` is just pulselog itself.

```bash
# pin + materialise pulselog on the box (re-run after a deploy that bumps it)
cd /opt/gitdone/ops/pulselog && npm ci

sudo install -m 0644 /opt/gitdone/ops/systemd/gitdone-health.service /etc/systemd/system/
sudo install -m 0644 /opt/gitdone/ops/systemd/gitdone-health.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gitdone-health.timer

# verify it runs + delivers a real alert: force one failure, confirm the email
# arrives. (The old ops/health-check.sh it replaced is gone as of 0.26.9.)
sudo systemctl start gitdone-health.service
journalctl -u gitdone-health.service -n 20 --no-pager
tail -n 5 /var/lib/gitdone/logs/health.jsonl 2>/dev/null
```

Covers (all in `ops/pulselog/pulselog.config.json`):

| Check | pulselog type | Threshold |
|---|---|---|
| `gitdone-web.service` active | `service` | not `active` |
| `gitdone-ots-upgrade.timer` armed | `service` | not `active` |
| Local API `GET /health` | `http` | non-200 / >10s |
| Disk usage `/` + `/var/lib/gitdone` | `disk` ×2 | ≥80% |
| TLS cert `signedreply.com:443` | `ssl` | <14 days |
| Postfix queue depth | `command` | ≥50 queued |
| Journal errors (≥err) last 1h | `command` | any |
| Stale OTS stamps (>48h, <1KB) | `command` | any |

Silent when green. On any failing check pulselog writes one
`/var/lib/gitdone/logs/health.jsonl` line per failure and emails **one**
summary to `alert.email` (`avoidaccess@gmail.com`) via local `sendmail`
(opendkim signs it → DMARC-clean), with recent flightlog error names folded in
(`alert.logTail`). `service` tests `is-active` — correct here (a long-running
service + an armed timer); a oneshot `.service` would need a `command` check
(`! systemctl is-failed`), see pulselog's adopter contract.

Every check re-probes once (`retry: { retries: 1, retryDelayMs: 1000 }`) before
it's recorded, and the contention-sensitive probes (`web`, `ots-timer`, `api`)
carry a 10s `timeoutMs` — so a transient load spike on the shared VPS doesn't
page (added 0.26.9, pulselog `0.4.1`; see PRD finding #49).

> **Retired (0.26.9):** the superseded `ops/health-check.sh` and any
> `/etc/default/gitdone-health` are gone — the pulselog health check has
> delivered real alerts from the VPS and is the sole health path.

### 10.1b Weekly stats digest (pulselog)

Same pinned `ops/pulselog` as the health check; the existing
`gitdone-stats-weekly.timer` (Mon 06:00 UTC) now runs `pulselog --digest`.

```bash
# (ops/pulselog already materialised by the §10.1 `npm ci`)
sudo install -m 0644 /opt/gitdone/ops/systemd/gitdone-stats-weekly.service /etc/systemd/system/
sudo install -m 0644 /opt/gitdone/ops/systemd/gitdone-stats-weekly.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gitdone-stats-weekly.timer

# RETIRE the old daily snapshot job (its files were deleted from the repo):
sudo systemctl disable --now gitdone-stats.timer 2>/dev/null || true
sudo rm -f /etc/systemd/system/gitdone-stats.service /etc/systemd/system/gitdone-stats.timer
sudo systemctl daemon-reload

# preview without sending/appending:
sudo -u gitdone GITDONE_DATA_DIR=/var/lib/gitdone \
  node /opt/gitdone/ops/pulselog/node_modules/pulselog/bin/pulselog.js \
  --digest --dry-run --config /opt/gitdone/ops/pulselog/pulselog.config.json
```

Snapshots metrics weekly via `stats.js --metrics-json` → one ISO-week line in
`/var/lib/gitdone/logs/stats.jsonl` → WoW email (+ flightlog rollup). The daily
`stats.log` job is gone; `stats.js --diff` still runs but shows no Δ (its source
log is no longer written) — use the digest history instead.

### 10.1c On-host backup (pulselog `--backup`)

Nightly `gitdone-backup.timer` (03:00 UTC) → `pulselog --backup`, one rotated
archive in `/var/lib/gitdone/backups/`. Runs as **root** (sources include
`/etc/opendkim/keys`, `/etc/letsencrypt`, `/etc/default/gitdone-web`).

```bash
# (ops/pulselog already materialised by §10.1)
sudo install -m 0644 /opt/gitdone/ops/systemd/gitdone-backup.service /etc/systemd/system/
sudo install -m 0644 /opt/gitdone/ops/systemd/gitdone-backup.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gitdone-backup.timer

# validate once now:
sudo systemctl start gitdone-backup.service
sudo ls -la /var/lib/gitdone/backups/        # archive present, 0600
tail -n1 /var/lib/gitdone/logs/backup.jsonl   # status:ok, bytes, files
sudo tar tzf /var/lib/gitdone/backups/gitdone-backup-*.tar.gz | head  # contents
```

Integrity: a `command` guard fails the run if `repos/` is empty; `minBytes`
fails a truncated archive (exit 1, no publish, no rotation). On failure pulselog
emails `avoidaccess@gmail.com`. Retention: `keepLast 7` ∪ `keepDays 30`.

> **This is the on-host half only.** Off-host DR is still the federver pull
> (`ops/homeserver/gitdone-backup.sh`, 04:15 UTC), unchanged. The next step
> switches federver to pull *this* archive with a key locked to a single
> read-only forced `command=` (a compromised federver then can't shell the VPS)
> + a `file-age` dead-man's-switch. Until then, both run — off-host coverage is
> uninterrupted.

### 10.2 External liveness (VPS down)

Self-monitoring can't detect the box being off. Use UptimeRobot free tier
(50 monitors, 5-min cadence) — HTTPS monitor on
`https://signedreply.com/health` → email `avoidaccess@gmail.com` on down.

### 10.3 Manual inspection

```bash
systemctl list-timers 'gitdone-*'
journalctl -u gitdone-web.service -f
journalctl -u gitdone-health.service --since today
sudo systemctl start gitdone-health.service          # force a health run
tail -n 20 /var/lib/gitdone/logs/health.jsonl        # per-check failure lines
```

### 10.4 Error flight-recorder (flightlog)

All three entry points record uncaught exceptions, unhandled rejections, and
boundary `capture()`s as one JSON line per error in
`$GITDONE_DATA_DIR/logs/errors.jsonl` (rotates at ~5 MB → `.1`). Local-only,
never uploaded.

```bash
sudo -u gitdone tail -f /var/lib/gitdone/logs/errors.jsonl
sudo -u gitdone jq -r 'select(.proc=="receive") | "\(.ts) \(.name): \(.message)"' \
  /var/lib/gitdone/logs/errors.jsonl
```

**Runbook — unwritable log dir defers mail.** flightlog probes its sink at boot
and, by default, throws if it can't write. Because `receive.js` is a per-message
Postfix pipe, an unwritable `logs/` dir means **every inbound message exits
non-zero and Postfix defers it** (queued and retried — *not* lost). The deferred
queue will climb (the health check alerts at ≥50). Fix: ensure
`/var/lib/gitdone/logs/` is owned by and writable by `gitdone` (it self-creates
under the already-`gitdone`-owned data dir) and that the disk isn't full; the
queue drains on the next retry. We deliberately keep the fail-loud default
(flightlog's `bootCheck: false` would deliver blind instead) — for a mail pipe,
defer-and-retry is the safer failure mode.

## 11. Runbook — deploy

Local testing first, pre-flight against the VPS, then push-and-restart.

### 11.1 Pre-flight (run BEFORE pushing)

Catches the three classes of latent breakage that `npm test` doesn't:
unresolvable deps, missing lockfile, Node-version drift.

```bash
# 1. No file:/link:/git:// deps in app/package.json — they only resolve
#    on the maintainer laptop and silently break npm ci on the VPS.
grep -E '"(file|link|git\+?[a-z]*):"' app/package.json && \
  echo "FAIL: non-registry dep" && exit 1

# 2. Lockfile is tracked. `npm ci` requires it; without it the VPS
#    install is non-reproducible and may skip new deps entirely.
git ls-files --error-unmatch app/package-lock.json >/dev/null

# 3. Engine ≤ VPS Node major. knowless required Node ≥22.5 once;
#    VPS was pinned to 20 and `auth.startLogin` blew up at runtime
#    (node:sqlite is a 22.5+ built-in) — only `/health` worked.
node -p "require('./app/package.json').engines?.node || 'none'"
ssh vps 'node --version'
# Compare manually. If app needs a newer major, upgrade VPS Node FIRST,
# in a separate change, before merging the dep bump.
```

### 11.2 Deploy

```bash
# --- local ---
cd app && npm test                              # expect 353/353
node bin/server.js --dev                        # manual smoke via http://localhost:3001
git push origin main

# --- vps ---
ssh vps
cd /opt/gitdone
sudo git fetch --tags
sudo git checkout <sha-or-tag>
# Do NOT pipe `npm ci` through `tail` / `head` — it masks failure.
sudo -u root bash -c 'cd app && npm ci --omit=dev'
sudo systemctl restart gitdone-web.service
curl -fsS https://signedreply.com/health
journalctl -u gitdone-web.service -n 50 --no-pager
```

Note: `/health` returns 200 even when auth is broken — it's a zero-dep
endpoint by design (§Appendix B). For real verification, also
`curl -fsS -o /dev/null -w '%{http_code}\n' https://signedreply.com/manage`
(triggers the knowless bootstrap on first hit).

### 11.3 Rollback

```bash
sudo git checkout <previous-sha>
sudo -u root bash -c 'cd app && npm ci --omit=dev'   # only if deps changed
sudo systemctl restart gitdone-web.service
```

Restart is sub-second because there's no build step. Data lives outside
`/opt/gitdone/`, so rollback is always safe.

### 11.4 Upgrading Node major (AlmaLinux module stream)

When a dep raises `engines.node` past the installed major, upgrade Node
in a dedicated maintenance window before the dep bump merges. Current
VPS is AlmaLinux 8 with the `nodejs:22` AppStream module:

```bash
sudo systemctl stop gitdone-web.service
# If a NodeSource package is currently installed, remove it first —
# it conflicts with module installs on the same files.
sudo dnf -y remove nodejs nodejs-libs nodejs-full-i18n
sudo dnf -y module reset nodejs
sudo dnf -y --disablerepo='nodesource-*' module install nodejs:22/common
node --version    # expect v22.x
cd /opt/gitdone/app && sudo rm -rf node_modules
sudo -u root bash -c 'cd /opt/gitdone/app && npm ci --omit=dev'
sudo systemctl start gitdone-web.service
sudo systemctl start gitdone-ots-upgrade.service   # smoke-test the timer-driven unit too
```

## 12. Backup

- `/var/lib/gitdone/` — restic/borg to off-VPS storage, daily.
- `/etc/opendkim/keys/` — store offline; losing this breaks outbound
  signing irrecoverably.
- Event repos are git history — a single `tar` of
  `/var/lib/gitdone/repos/` is a complete proof archive.

---

## Appendix A — Adding staging later

Skip until real users exist. When you do:

1. DNS: add `A staging.signedreply.com → 104.129.2.254` and
   `MX staging.signedreply.com → 10 mail.signedreply.com.`
2. `sudo certbot --nginx -d staging.signedreply.com`
3. Second systemd unit `gitdone-web-staging.service` — clone
   `gitdone-web.service` with:
   - `Environment=GITDONE_DATA_DIR=/var/lib/gitdone-staging`
   - `Environment=GITDONE_HTTP_PORT=3002`
   - `Environment=GITDONE_PUBLIC_BASE_URL=https://staging.signedreply.com`
   - `ReadWritePaths=/var/lib/gitdone-staging /var/log/gitdone`
4. `install -d -o gitdone -g gitdone /var/lib/gitdone-staging`
5. nginx: add a second server block for `staging.signedreply.com` → `:3002`.
6. Postfix transport map (`/etc/postfix/transport`):
   `staging.signedreply.com  gitdone-staging:`
   + a second master.cf entry exporting `GITDONE_DATA_DIR=/var/lib/gitdone-staging`
   via the pipe transport env, or have `receive.sh` branch on recipient domain.
7. Duplicate `gitdone-ots-upgrade.service` for staging data dir.
8. Add the staging units and a second `http` check (staging `/health`) to
   `ops/pulselog/pulselog.config.json`.

Runbook becomes: push → restart staging → bake → restart prod.

## Appendix B — Known constraints

- opendkim signs any mail from the VPS; if a future staging needs a
  distinct DKIM identity, add a second selector.
- `/health` must stay a zero-auth, zero-dependency endpoint — both
  UptimeRobot and the local health check rely on it being cheap.
- The apex `A signedreply.com` record was missing as of 2026-04-19; add it
  before pointing users at `https://signedreply.com/`.
