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

From `ops/homeserver/` in the repo:

```bash
sudo install -m 755 gitdone-backup.sh      /usr/local/bin/
sudo install -m 644 gitdone-backup.service /etc/systemd/system/
sudo install -m 644 gitdone-backup.timer   /etc/systemd/system/

sudo tee /etc/default/gitdone-backup >/dev/null <<EOF
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

`BACKUP_ROOT` is `/mnt/data/...` (same rationale as addypin — survives
a fedora reinstall because `/mnt/data` is the HDD).

## Step 3 — Kuma monitors

Both created in the Kuma UI (`http://federver:3001`):

1. **HTTP(s) monitor** — gitdone site health.
   - URL: `https://git-done.com/health`
   - Interval: 60s, Retries: 2, Accepted: 200
2. **Push monitor** — backup heartbeat.
   - Name: `gitdone-backup`
   - Heartbeat: 86400s, Grace: 3600s
   - Kuma generates a push URL — paste it into the env file:
     ```bash
     sudo sed -i "s|^KUMA_PUSH_URL=.*|KUMA_PUSH_URL=<the-url>|" /etc/default/gitdone-backup
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

## Recreate from scratch

On a fresh federver:

1. `git clone` the repo under `/mnt/data/data/.../gitdone`
2. Step 1 (keygen + copy to VPS)
3. Step 2 (install units + env file)
4. Step 3 (Kuma monitors + push URL)
5. Step 4 (smoke test)

~10 minutes with the VPS root password in hand.
