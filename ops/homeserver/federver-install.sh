#!/bin/bash
# One-shot installer for gitdone backup on federver.
#
# Usage:
#   scp ops/homeserver/*.{sh,service,timer} ahassan@federver:/tmp/gitdone-install/
#   ssh ahassan@federver
#   cd /tmp/gitdone-install && sudo bash federver-install.sh
#
# Prerequisites (do once, manually, BEFORE running this):
#   ssh-keygen -t ed25519 -f ~/.ssh/gitdone_vps -N "" -C "gitdone-backup@federver"
#   ssh-copy-id -i ~/.ssh/gitdone_vps.pub root@104.129.2.254
#   ssh -i ~/.ssh/gitdone_vps root@104.129.2.254 'ls /var/lib/gitdone/'
#
# After running this, finish in Kuma UI:
#   - HTTP(s) monitor: https://git-done.com/health (60s)
#   - Push monitor:    gitdone-backup (86400s / 3600s grace)
#   - Paste push URL into /etc/default/gitdone-backup (KUMA_PUSH_URL=)
#   - Run:  sudo systemctl start gitdone-backup
#           sudo journalctl -u gitdone-backup -n 20 --no-pager

set -euo pipefail

# ── config you may want to tweak ────────────────────────────────────────
RUN_USER="${RUN_USER:-ahassan}"
VPS_HOST="${VPS_HOST:-104.129.2.254}"
VPS_USER="${VPS_USER:-root}"
SSH_KEY="${SSH_KEY:-/home/${RUN_USER}/.ssh/gitdone_vps}"
BACKUP_ROOT="${BACKUP_ROOT:-/mnt/data/data/gitdone-backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"

# ── sanity ──────────────────────────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
    echo "run with sudo" >&2
    exit 1
fi

for f in gitdone-backup.sh gitdone-backup.service gitdone-backup.timer; do
    if [ ! -f "$f" ]; then
        echo "missing $f in cwd — scp it here first" >&2
        exit 1
    fi
done

if [ ! -f "$SSH_KEY" ]; then
    echo "WARN: $SSH_KEY does not exist" >&2
    echo "  Generate it and copy the pubkey to the VPS before enabling the timer:" >&2
    echo "    su - $RUN_USER" >&2
    echo "    ssh-keygen -t ed25519 -f ~/.ssh/gitdone_vps -N \"\" -C \"gitdone-backup@federver\"" >&2
    echo "    ssh-copy-id -i ~/.ssh/gitdone_vps.pub ${VPS_USER}@${VPS_HOST}" >&2
    echo "  Continuing install; you'll need to finish the key step before the timer fires." >&2
fi

# ── install ─────────────────────────────────────────────────────────────
echo "[1/6] install script + units"
install -m 755 gitdone-backup.sh      /usr/local/bin/
install -m 644 gitdone-backup.service /etc/systemd/system/
install -m 644 gitdone-backup.timer   /etc/systemd/system/

echo "[2/6] write /etc/default/gitdone-backup"
cat > /etc/default/gitdone-backup <<EOF
VPS_HOST=${VPS_HOST}
VPS_USER=${VPS_USER}
SSH_KEY=${SSH_KEY}
BACKUP_ROOT=${BACKUP_ROOT}
KEEP_DAYS=${KEEP_DAYS}
KUMA_PUSH_URL=
EOF
chmod 640 /etc/default/gitdone-backup

echo "[3/6] fix unit User= to ${RUN_USER}"
sed -i "s/^User=%i/User=${RUN_USER}/" /etc/systemd/system/gitdone-backup.service

echo "[4/6] ensure backup root exists and is writable"
install -d -o "$RUN_USER" -g "$RUN_USER" "$BACKUP_ROOT/daily"

echo "[5/6] daemon-reload + enable timer"
systemctl daemon-reload
systemctl enable --now gitdone-backup.timer

echo "[6/6] status"
systemctl list-timers gitdone-backup.timer --no-pager

cat <<DONE

================================================================
Install complete.

Next steps (in Kuma UI at http://federver:3001):

  1. Add HTTP(s) monitor:
       URL:      https://git-done.com/health
       Interval: 60s
       Accepted: 200
       Retries:  2

  2. Add Push monitor:
       Name:      gitdone-backup
       Heartbeat: 86400
       Grace:     3600
     Copy the generated push URL, then:

       sudo sed -i "s|^KUMA_PUSH_URL=.*|KUMA_PUSH_URL=<url>|" /etc/default/gitdone-backup

  3. Smoke test:

       sudo systemctl start gitdone-backup
       sudo journalctl -u gitdone-backup -n 20 --no-pager
       ls -la ${BACKUP_ROOT}/daily/\$(date -u +%F)/

Expected: events.tar.gz, repos.tar.gz, magic_tokens.tar.gz,
letsencrypt.tar.gz, opendkim-keys.tar.gz, gitdone-web.env
================================================================
DONE
