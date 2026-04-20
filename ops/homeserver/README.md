# gitdone home-server ops

Two pieces of infrastructure live on the home server (fedora), outside
the VPS, so backups and uptime alerts survive a total VPS loss.

## 1. Nightly backup — `gitdone-backup.{sh,service,timer}`

Pulls from the VPS every night at 04:15 local into a date-stamped
directory under `BACKUP_ROOT`:

- `/var/lib/gitdone/events/`  — event JSON + per-event salts
- `/var/lib/gitdone/repos/`  — per-event git repos = **the proof archive**
- `/var/lib/gitdone/magic_tokens/`  — mgmt tokens + sessions
- `/etc/letsencrypt/`  — TLS state
- `/etc/opendkim/keys/`  — **DKIM private keys** (irreplaceable)
- `/etc/default/gitdone-web`  — session secret + env

Rotates anything past `KEEP_DAYS` (default 30). On success pings the
Kuma push monitor; on failure Kuma's missed-heartbeat alert fires.

### Install

```bash
# 1. One-time SSH key for this job (no passphrase, so systemd can use it):
ssh-keygen -t ed25519 -f ~/.ssh/gitdone_vps -N ""
ssh-copy-id -i ~/.ssh/gitdone_vps.pub root@<vps-ip>

# 2. Copy units + script:
sudo install -m 755 gitdone-backup.sh      /usr/local/bin/
sudo install -m 644 gitdone-backup.service /etc/systemd/system/
sudo install -m 644 gitdone-backup.timer   /etc/systemd/system/

# 3. Env file (the `EnvironmentFile=-` in the unit):
sudo tee /etc/default/gitdone-backup >/dev/null <<EOF
VPS_HOST=104.129.2.254
VPS_USER=root
SSH_KEY=$HOME/.ssh/gitdone_vps
BACKUP_ROOT=$HOME/gitdone-backups
KEEP_DAYS=30
KUMA_PUSH_URL=
EOF

# 4. Replace %i in the unit with your user, enable:
sudo sed -i "s/User=%i/User=$USER/" /etc/systemd/system/gitdone-backup.service
sudo systemctl daemon-reload
sudo systemctl enable --now gitdone-backup.timer
systemctl list-timers gitdone-backup.timer
```

### Manual run (smoke test before enabling)

```bash
sudo -u $USER /usr/local/bin/gitdone-backup.sh
ls -la ~/gitdone-backups/daily/$(date -u +%F)/
```

Expected — six files: `events.tar.gz`, `repos.tar.gz`,
`magic_tokens.tar.gz`, `letsencrypt.tar.gz`, `opendkim-keys.tar.gz`,
`gitdone-web.env`. Size is proportional to the proof archive; at
Phase 1 launch ~1 MB total.

### Restore drill (do this at least once)

On a fresh VPS rebuild, from a backup dir:

```bash
DATE=2026-04-20
# 1. Restore /var/lib/gitdone/
scp events.tar.gz repos.tar.gz magic_tokens.tar.gz root@<new-vps>:/tmp/
ssh root@<new-vps> '
  install -d -o gitdone -g gitdone /var/lib/gitdone
  cd /var/lib/gitdone
  tar -xzf /tmp/events.tar.gz
  tar -xzf /tmp/repos.tar.gz
  tar -xzf /tmp/magic_tokens.tar.gz 2>/dev/null || true
  chown -R gitdone:gitdone /var/lib/gitdone
'

# 2. Restore DKIM signing keys
scp opendkim-keys.tar.gz root@<new-vps>:/tmp/
ssh root@<new-vps> '
  cd /etc/opendkim && tar -xzf /tmp/opendkim-keys.tar.gz
  chown -R opendkim:opendkim keys
  systemctl restart opendkim
'

# 3. Restore TLS certs (or run certbot fresh — either works)
scp letsencrypt.tar.gz root@<new-vps>:/tmp/
ssh root@<new-vps> 'cd /etc && tar -xzf /tmp/letsencrypt.tar.gz'

# 4. Restore env file
scp gitdone-web.env root@<new-vps>:/etc/default/gitdone-web
ssh root@<new-vps> 'chmod 640 /etc/default/gitdone-web && chown root:gitdone /etc/default/gitdone-web'

# 5. Start services
ssh root@<new-vps> 'systemctl restart gitdone-web postfix nginx'
```

Preserving the session secret (`gitdone-web.env`) means **active user
sessions survive the rebuild** — users don't get logged out of
`/manage`. Losing it is not catastrophic; everyone re-does the magic
link.

Losing the DKIM key (`opendkim-keys.tar.gz`) means every outbound
email from gitdone is unsigned until you rotate the DNS DKIM record,
which receivers cache for hours. Back this up. It is not stored
anywhere else.

## 2. Uptime watchdog — Kuma HTTP monitor (pull)

Configured entirely in Kuma's UI. No files here.

1. Kuma → Add New Monitor → **HTTP(s)**
2. URL: `https://git-done.com/health`
3. Interval: `60s`
4. Accepted Status Codes: `200`
5. Max. Retries: `2`
6. Notification: your email / Telegram
7. Save.

Kuma now pings the VPS every minute. If gitdone is down *or* the VPS
is dead *or* DNS breaks *or* the cert expires (TLS error → non-200),
Kuma alerts you.

## 3. Backup heartbeat — Kuma push monitor

1. Kuma → Add New Monitor → **Push**
2. Name: `gitdone-backup`
3. **Heartbeat Interval: `86400` (seconds)**, **Heartbeat Retries: `0`**,
   **Grace Period: `3600`**. Kuma defaults the interval to `60` — leaving
   that default means Kuma marks the monitor "down" between pings every
   minute, which is wrong for a daily cron. Override before saving.
4. Kuma prints a push URL — paste it into the env file. **Do not wrap
   it in angle brackets.** Use this heredoc to avoid sed-escaping the
   `&` characters:

```bash
# Rewrite the line cleanly. Single-quoted heredoc = no shell
# substitution, so &msg= and &ping= survive verbatim.
sudo tee /etc/default/gitdone-backup >/dev/null <<'EOF'
VPS_HOST=104.129.2.254
VPS_USER=root
SSH_KEY=/home/ahassan/.ssh/gitdone_vps
BACKUP_ROOT=/mnt/data/data/gitdone-backups
KEEP_DAYS=30
KUMA_PUSH_URL=http://federver:3001/api/push/XYZ?status=up&msg=OK&ping=
EOF
sudo chmod 640 /etc/default/gitdone-backup
```

Replace the `KUMA_PUSH_URL=` line's URL with the exact string Kuma
shows — no surrounding `<` `>`, no extra quotes.

5. Save. Next successful backup flips Kuma green with
   `msg=backup_<date>_<size>`.

If a backup fails or the home server is off for >25h, Kuma sends
the same notification as an HTTP down event.

## 4. Back up the SSH key + session secret to `pass`

Runs on your **laptop** (the password store host), not on federver:

```bash
# A. Pull the VPS SSH key from federver into pass
scp ahassan@federver:~/.ssh/gitdone_vps /tmp/.gvps.tmp
pass insert -m gitdone/vps/ssh_key_federver < /tmp/.gvps.tmp
shred -u /tmp/.gvps.tmp

# B. Pull the production session secret from the VPS into pass
ssh gitdone-vps 'grep ^GITDONE_SESSION_SECRET /etc/default/gitdone-web' \
  | cut -d= -f2 \
  | pass insert -e gitdone/vps/session_secret

# C. VPS root password (if you have it)
pass insert gitdone/vps/root_password    # prompts

# Verify
pass ls gitdone
```

Restore path if federver ever dies:

```bash
mkdir -p ~/.ssh
pass show gitdone/vps/ssh_key_federver > ~/.ssh/gitdone_vps
chmod 600 ~/.ssh/gitdone_vps
```
