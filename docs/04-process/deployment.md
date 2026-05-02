# GitDone — Deployment Guide

**Stack:** Fedora Linux, Node.js ≥18 (vanilla `node:http`), Postfix, opendkim,
nginx, systemd. No PM2, no bundler, no frontend framework.

**Topology:** one VPS, one environment (`git-done.com`). Local laptop
`--dev` mode (`./data-dev/`, HUD, SSE live-reload) is the test environment
for UI and business logic; prod is the only environment that runs the
inbound-email pipeline. Staging on a subdomain is documented in the
Appendix — add it when you have real users.

Runbook at the bottom.

---

## 1. Prerequisites

- VPS: Fedora 40+, 2 GB RAM, 20 GB disk. Current VPS IP: `104.129.2.254`.
- DNS (Route 53, hosted zone `git-done.com`):
  - `A   git-done.com              → 104.129.2.254`
  - `MX  git-done.com              10 mail.git-done.com.`
  - `A   mail.git-done.com         → 104.129.2.254` *(already set)*
  - `TXT git-done.com              "v=spf1 mx -all"` *(already set)*
  - `TXT gd202604._domainkey.git-done.com  "v=DKIM1; k=rsa; p=..."` *(already set)*
  - `TXT _dmarc.git-done.com       "v=DMARC1; p=none; rua=mailto:postmaster@git-done.com; aspf=s; adkim=s"` *(already set)*

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
sudo chmod +x /opt/gitdone/app/bin/receive.sh /opt/gitdone/ops/health-check.sh
```

Production code is read-only to `gitdone`; data/logs are writable.

## 5. Outbound DKIM (opendkim)

Selector `gd202604` already live. For reference:

```
# /etc/opendkim.conf
Domain       git-done.com
Selector     gd202604
KeyFile      /etc/opendkim/keys/git-done.com/gd202604.private
Socket       inet:8891@localhost
Mode         sv
SubDomains   yes
```

## 6. Postfix

`/etc/postfix/master.cf` — pipe transport:

```
gitdone unix - n n - - pipe
  flags=DRhu user=gitdone argv=/opt/gitdone/app/bin/receive.sh ${sender} ${recipient}
```

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

The `gitdone` pipe transport catches all `*@git-done.com` recipients by
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
postmap -q 'postmaster@git-done.com' hash:/etc/postfix/virtual
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
Environment=GITDONE_PUBLIC_BASE_URL=https://git-done.com
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
  server_name git-done.com;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl http2;
  server_name git-done.com;
  ssl_certificate     /etc/letsencrypt/live/git-done.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/git-done.com/privkey.pem;
  client_max_body_size 25m;

  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

```bash
sudo certbot --nginx -d git-done.com
sudo systemctl enable --now nginx
```

## 10. Monitoring & alerts

Local checks run every 15 min from a systemd timer; VPS-down detection
comes from an external pinger (can't self-detect).

### 10.1 Local health check

```bash
sudo install -m 0644 /opt/gitdone/ops/systemd/gitdone-health.service /etc/systemd/system/
sudo install -m 0644 /opt/gitdone/ops/systemd/gitdone-health.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gitdone-health.timer
```

Covers (all configurable via `/etc/default/gitdone-health`):

| Check | Default threshold | Override var |
|---|---|---|
| systemd `is-failed` on web + ots timer | any failed | `GITDONE_UNITS` |
| Local API `GET /health` | non-200 / >5s | `GITDONE_HEALTH_URL` |
| Disk usage on `/` + data dir | ≥80% | `GITDONE_DISK_THRESHOLD` |
| Postfix deferred queue size | ≥50 | `GITDONE_MAILQ_THRESHOLD` |
| Journal errors (≥err) last 1h | any | — |
| Stale OTS stamps (>48h, not upgraded) | any | `GITDONE_OTS_STALE_HOURS` |
| TLS cert expiry | <14 days | `GITDONE_CERT_WARN_DAYS`, `GITDONE_CERT_DOMAINS` |

Silent when green. One consolidated email to `GITDONE_ALERT_TO` (default
`avoidaccess@gmail.com`) on any failing check, via local `sendmail`
(opendkim signs it, so the alert itself is DMARC-clean).

Example `/etc/default/gitdone-health`:

```
GITDONE_ALERT_TO=avoidaccess@gmail.com
GITDONE_ALERT_FROM=alerts@git-done.com
```

### 10.2 External liveness (VPS down)

Self-monitoring can't detect the box being off. Use UptimeRobot free tier
(50 monitors, 5-min cadence) — HTTPS monitor on
`https://git-done.com/health` → email `avoidaccess@gmail.com` on down.

### 10.3 Manual inspection

```bash
systemctl list-timers 'gitdone-*'
journalctl -u gitdone-web.service -f
journalctl -u gitdone-health.service --since today
sudo -u gitdone /opt/gitdone/ops/health-check.sh    # force a run
```

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
curl -fsS https://git-done.com/health
journalctl -u gitdone-web.service -n 50 --no-pager
```

Note: `/health` returns 200 even when auth is broken — it's a zero-dep
endpoint by design (§Appendix B). For real verification, also
`curl -fsS -o /dev/null -w '%{http_code}\n' https://git-done.com/manage`
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

1. DNS: add `A staging.git-done.com → 104.129.2.254` and
   `MX staging.git-done.com → 10 mail.git-done.com.`
2. `sudo certbot --nginx -d staging.git-done.com`
3. Second systemd unit `gitdone-web-staging.service` — clone
   `gitdone-web.service` with:
   - `Environment=GITDONE_DATA_DIR=/var/lib/gitdone-staging`
   - `Environment=GITDONE_HTTP_PORT=3002`
   - `Environment=GITDONE_PUBLIC_BASE_URL=https://staging.git-done.com`
   - `ReadWritePaths=/var/lib/gitdone-staging /var/log/gitdone`
4. `install -d -o gitdone -g gitdone /var/lib/gitdone-staging`
5. nginx: add a second server block for `staging.git-done.com` → `:3002`.
6. Postfix transport map (`/etc/postfix/transport`):
   `staging.git-done.com  gitdone-staging:`
   + a second master.cf entry exporting `GITDONE_DATA_DIR=/var/lib/gitdone-staging`
   via the pipe transport env, or have `receive.sh` branch on recipient domain.
7. Duplicate `gitdone-ots-upgrade.service` for staging data dir.
8. Extend `GITDONE_UNITS`, `GITDONE_CERT_DOMAINS`, and add a second
   `HEALTH_URL` check in `ops/health-check.sh`.

Runbook becomes: push → restart staging → bake → restart prod.

## Appendix B — Known constraints

- opendkim signs any mail from the VPS; if a future staging needs a
  distinct DKIM identity, add a second selector.
- `/health` must stay a zero-auth, zero-dependency endpoint — both
  UptimeRobot and the local health check rely on it being cheap.
- The apex `A git-done.com` record was missing as of 2026-04-19; add it
  before pointing users at `https://git-done.com/`.
