#!/bin/bash
# Nightly gitdone backup runner — lives on the home server.
#
# Pulls from the VPS into a date-stamped directory under BACKUP_ROOT:
#   - /var/lib/gitdone/events/       (event JSON + per-event salts)
#   - /var/lib/gitdone/repos/        (per-event git repos = the proof archive)
#   - /var/lib/gitdone/magic_tokens/ (30-day management tokens + sessions)
#   - /etc/letsencrypt/              (TLS state)
#   - /etc/opendkim/keys/            (DKIM private keys — IRREPLACEABLE)
#   - /etc/default/gitdone-web       (session secret + env)
#
# Rotates old backup directories past KEEP_DAYS.
#
# On success pings the Kuma push URL so the watchdog resets.
# On failure exits non-zero and does NOT ping — Kuma flags a missed
# heartbeat and alerts you within its grace window.
#
# Uses ssh+tar throughout (no rsync). rsync 3.4 rejects remote paths
# on both-3.4 pairs ("Unexpected remote arg"); tar-over-ssh is
# unaffected and fine for pre-launch volumes.
#
# Deploy:
#   sudo install -m 755 gitdone-backup.sh      /usr/local/bin/
#   sudo install -m 644 gitdone-backup.service /etc/systemd/system/
#   sudo install -m 644 gitdone-backup.timer   /etc/systemd/system/
#   sudo systemctl enable --now gitdone-backup.timer

set -eu
set -o pipefail

# ── config (override via /etc/default/gitdone-backup) ────────────────────
VPS_HOST="${VPS_HOST:-104.129.2.254}"
VPS_USER="${VPS_USER:-root}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/gitdone_vps}"
BACKUP_ROOT="${BACKUP_ROOT:-$HOME/gitdone-backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"
KUMA_PUSH_URL="${KUMA_PUSH_URL:-}"

# ── run ──────────────────────────────────────────────────────────────────
DATE="$(date -u +%F)"
DEST="${BACKUP_ROOT}/daily/${DATE}"
mkdir -p "$DEST"

SSH="ssh -i $SSH_KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new"

echo "[$(date -Iseconds)] gitdone backup → $DEST"

# 1. Event JSON + salts. Small files, one tar.
$SSH "${VPS_USER}@${VPS_HOST}" \
    'tar -czf - -C /var/lib/gitdone events' > "$DEST/events.tar.gz"

# 2. Per-event git repos — the proof archive. Tar captures the .git
#    internals plus dkim_keys/ and ots_proofs/ already inside each repo.
$SSH "${VPS_USER}@${VPS_HOST}" \
    'tar -czf - -C /var/lib/gitdone repos' > "$DEST/repos.tar.gz"

# 3. Magic tokens (30-day management tokens + short-lived sessions).
#    Not critical but cheap to include.
$SSH "${VPS_USER}@${VPS_HOST}" \
    'tar -czf - -C /var/lib/gitdone magic_tokens 2>/dev/null || true' \
    > "$DEST/magic_tokens.tar.gz"

# 4. Let's Encrypt state (certs + renewal config).
$SSH "${VPS_USER}@${VPS_HOST}" \
    'tar -czf - -C /etc letsencrypt' > "$DEST/letsencrypt.tar.gz"

# 5. opendkim signing keys — CRITICAL. Losing these means every
#    outbound email from gitdone is unsigned until you rotate the
#    DNS DKIM record, which receivers cache for hours.
$SSH "${VPS_USER}@${VPS_HOST}" \
    'tar -czf - -C /etc/opendkim keys' > "$DEST/opendkim-keys.tar.gz"

# 6. Systemd env file (session secret). Regeneratable but restoring
#    the old one keeps active user sessions valid across a rebuild.
$SSH "${VPS_USER}@${VPS_HOST}" \
    'cat /etc/default/gitdone-web' > "$DEST/gitdone-web.env"

# 7. Sanity check: non-trivial repos.tar.gz (the real signal).
if [ ! -s "$DEST/repos.tar.gz" ]; then
    echo "FAIL: repos.tar.gz missing or empty in $DEST" >&2
    exit 1
fi

# 8. Rotate.
find "${BACKUP_ROOT}/daily" -mindepth 1 -maxdepth 1 -type d -mtime +"${KEEP_DAYS}" \
    -print -exec rm -rf {} +

# 9. Kuma ping (optional).
if [ -n "$KUMA_PUSH_URL" ]; then
    SIZE=$(du -sh "$DEST" | cut -f1)
    curl -fsS --max-time 10 "${KUMA_PUSH_URL}&msg=backup_${DATE}_${SIZE}" >/dev/null \
        || echo "WARN: Kuma ping failed (backup still succeeded)" >&2
fi

echo "[$(date -Iseconds)] done ($(du -sh "$DEST" | cut -f1))"
