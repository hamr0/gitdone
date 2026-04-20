# Federver-side install log — gitdone backup

What to actually do on federver (`192.168.178.180`, user `ahassan`) to
get `gitdone-backup.{sh,service,timer}` running. Parallel to the
addypin setup — same VPS host, **same federver**.

## Prerequisites

- federver reachable on LAN at `192.168.178.180`
- gitdone VPS at `104.129.2.254` (root SSH works — same box as addypin
  isn't the case here, `git-done.com` has its own VPS)
- Kuma already running on federver at `http://federver:3001`
- The repo pulled at `/mnt/data/data/My Docs/PycharmProjects/gitdone`

## Step 1 — SSH key federver → VPS

On federver:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/gitdone_vps -N "" -C "gitdone-backup@federver"
ssh-copy-id -i ~/.ssh/gitdone_vps.pub root@104.129.2.254
# test
ssh -i ~/.ssh/gitdone_vps root@104.129.2.254 'hostname && ls /var/lib/gitdone/'
```

## Step 2 — Install units and env file

**Option A — one-shot installer (recommended).** `federver-install.sh`
wraps all of Step 2 into a single command:

```bash
# From your laptop, scp the four files to federver /tmp:
scp ops/homeserver/{gitdone-backup.sh,gitdone-backup.service,gitdone-backup.timer,federver-install.sh} \
    ahassan@federver:/tmp/

# On federver:
ssh ahassan@federver
cd /tmp && sudo bash federver-install.sh
```

The installer:
- installs the three files into `/usr/local/bin/` and `/etc/systemd/system/`
- writes `/etc/default/gitdone-backup` with `BACKUP_ROOT=/mnt/data/data/gitdone-backups` (survives fedora reinstall)
- replaces `User=%i` with `User=ahassan` in the unit
- `daemon-reload` + `enable --now` the timer
- prints the next steps for Kuma

**Option B — manual** (if you need to tweak something mid-install):

```bash
sudo install -m 755 gitdone-backup.sh      /usr/local/bin/
sudo install -m 644 gitdone-backup.service /etc/systemd/system/
sudo install -m 644 gitdone-backup.timer   /etc/systemd/system/

sudo tee /etc/default/gitdone-backup >/dev/null <<'EOF'
VPS_HOST=104.129.2.254
VPS_USER=root
SSH_KEY=/home/ahassan/.ssh/gitdone_vps
BACKUP_ROOT=/mnt/data/data/gitdone-backups
KEEP_DAYS=30
KUMA_PUSH_URL=
EOF

sudo sed -i "s/User=%i/User=ahassan/" /etc/systemd/system/gitdone-backup.service
sudo -u ahassan mkdir -p /mnt/data/data/gitdone-backups/daily
sudo systemctl daemon-reload
sudo systemctl enable --now gitdone-backup.timer
```

Single-quoted heredoc (`<<'EOF'`) matters: the URL contains `&` and
`?`, and an unquoted heredoc will try to shell-interpret them.

## Step 3 — Kuma monitors

Both created in the Kuma UI (`http://federver:3001`):

1. **HTTP(s) monitor** — gitdone site health.
   - URL: `https://git-done.com/health`
   - Interval: 60s, Retries: 2, Accepted: 200
2. **Push monitor** — backup heartbeat.
   - Name: `gitdone-backup`
   - **Heartbeat Interval: `86400`** (Kuma defaults this to `60` — that
     gives you a monitor that flaps red every minute between daily pings.
     Override it before saving.)
   - Heartbeat Retries: `0`
   - Grace Period: `3600` (1h)
   - Kuma prints a push URL. **Do not wrap it in `<` `>`** — those were
     placeholders in this doc, not literal characters. Use a heredoc
     rather than `sed` (the URL contains `&` which sed treats as a
     backref):
     ```bash
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

## Step 4 — Smoke test

```bash
sudo systemctl start gitdone-backup
sudo journalctl -u gitdone-backup -n 20 --no-pager
ls -la /mnt/data/data/gitdone-backups/daily/$(date -u +%F)/
```

Expected contents:

| File | What |
|---|---|
| `events.tar.gz` | event JSON |
| `repos.tar.gz` | per-event git repos (the proof archive) |
| `magic_tokens.tar.gz` | mgmt tokens + sessions |
| `letsencrypt.tar.gz` | TLS state |
| `opendkim-keys.tar.gz` | DKIM private keys — critical |
| `gitdone-web.env` | session secret + prod env |

Kuma push monitor flips green with `msg=backup_<date>_<size>`.

## Offset from addypin

Both projects back up to the same federver but at different times:

- addypin-backup.timer: `03:15 UTC`
- gitdone-backup.timer: `04:15 UTC`

Avoids both jobs thundering on the federver at the same instant.

## Step 5 — Back up the SSH key to `pass` (on the laptop)

Loss of federver = loss of the backup job until you regenerate the
key. Copy it to the password store so a fresh federver can be
bootstrapped in minutes.

On your **laptop** (where `pass` lives):

```bash
scp ahassan@federver:~/.ssh/gitdone_vps /tmp/.gvps.tmp
pass insert -m gitdone/vps/ssh_key_federver < /tmp/.gvps.tmp
shred -u /tmp/.gvps.tmp
pass ls gitdone/vps       # should show ssh_key_federver
```

Also worth storing:

```bash
# Production session secret — preserving it across a VPS rebuild
# keeps active /manage sign-in cookies valid.
ssh gitdone-vps 'grep ^GITDONE_SESSION_SECRET /etc/default/gitdone-web' \
  | cut -d= -f2 | pass insert -e gitdone/vps/session_secret
```

Restore (on a fresh federver):

```bash
mkdir -p ~/.ssh
pass show gitdone/vps/ssh_key_federver > ~/.ssh/gitdone_vps
chmod 600 ~/.ssh/gitdone_vps
```

## Recreate from scratch

On a fresh federver:

1. `git clone` the repo under `/mnt/data/data/.../gitdone`
2. Restore the SSH key from `pass` (Step 5 restore block)
3. Step 2 (`federver-install.sh` — one command)
4. Step 3 (Kuma monitors + push URL — UI only)
5. Step 4 (smoke test)

~10 minutes with `pass` unlocked.
