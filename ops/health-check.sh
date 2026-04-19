#!/bin/bash
# gitdone health check — runs from systemd timer, emails ALERT_TO on any degradation.
# Exit 0 always; alert by sending mail. Silent on green.

set -u

ALERT_TO="${GITDONE_ALERT_TO:-avoidaccess@gmail.com}"
ALERT_FROM="${GITDONE_ALERT_FROM:-alerts@git-done.com}"
HOST="$(hostname -f 2>/dev/null || hostname)"

DATA_DIR_PROD="${GITDONE_DATA_DIR:-/var/lib/gitdone}"
DISK_THRESHOLD="${GITDONE_DISK_THRESHOLD:-80}"     # percent
HEALTH_URL_PROD="${GITDONE_HEALTH_URL:-http://127.0.0.1:3001/health}"
MAILQ_THRESHOLD="${GITDONE_MAILQ_THRESHOLD:-50}"
OTS_STALE_HOURS="${GITDONE_OTS_STALE_HOURS:-48}"
CERT_WARN_DAYS="${GITDONE_CERT_WARN_DAYS:-14}"
CERT_DOMAINS="${GITDONE_CERT_DOMAINS:-git-done.com}"
UNITS="${GITDONE_UNITS:-gitdone-web.service gitdone-ots-upgrade.timer}"

ALERTS=()
add() { ALERTS+=("$1"); }

# 1. systemd unit health
for u in $UNITS; do
  state=$(systemctl is-failed "$u" 2>/dev/null || true)
  if [ "$state" = "failed" ]; then
    add "UNIT FAILED: $u"
  fi
done

# 2. local API health
if ! curl -fsS --max-time 5 "$HEALTH_URL_PROD" >/dev/null 2>&1; then
  add "API DOWN: $HEALTH_URL_PROD"
fi

# 3. disk space
for d in / "$DATA_DIR_PROD"; do
  [ -d "$d" ] || continue
  pct=$(df -P "$d" | awk 'NR==2 {gsub("%",""); print $5}')
  if [ -n "$pct" ] && [ "$pct" -ge "$DISK_THRESHOLD" ]; then
    add "DISK ${pct}% on $d (threshold ${DISK_THRESHOLD}%)"
  fi
done

# 4. postfix mail queue
if command -v mailq >/dev/null 2>&1; then
  deferred=$(mailq 2>/dev/null | awk '/^-- [0-9]+ Kbytes in ([0-9]+) Request/ {print $5}' | tail -1)
  deferred="${deferred:-0}"
  if [ "$deferred" -ge "$MAILQ_THRESHOLD" ]; then
    add "MAIL QUEUE: $deferred deferred (threshold $MAILQ_THRESHOLD)"
  fi
fi

# 5. recent errors in journal (last hour, priority err)
errs=$(journalctl -u gitdone-web.service --since '1 hour ago' -p err --no-pager -q 2>/dev/null | wc -l)
if [ "$errs" -gt 0 ]; then
  add "LOG ERRORS (gitdone-web.service): $errs in last hour"
fi

# 6. OTS stale backlog (unstamped .ots older than threshold)
for d in "$DATA_DIR_PROD/repos"; do
  [ -d "$d" ] || continue
  stale=$(find "$d" -name '*.ots' -type f -mmin +$((OTS_STALE_HOURS*60)) 2>/dev/null | wc -l)
  if [ "$stale" -gt 0 ]; then
    # only alert if they're also unupgraded — heuristic: small file (<1KB = pending)
    pending=$(find "$d" -name '*.ots' -type f -mmin +$((OTS_STALE_HOURS*60)) -size -1024c 2>/dev/null | wc -l)
    if [ "$pending" -gt 0 ]; then
      add "OTS BACKLOG: $pending stamps >${OTS_STALE_HOURS}h old, not upgraded ($d)"
    fi
  fi
done

# 7. TLS cert expiry
for domain in $CERT_DOMAINS; do
  end=$(echo | openssl s_client -servername "$domain" -connect "$domain:443" 2>/dev/null \
        | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  [ -z "$end" ] && { add "CERT CHECK FAILED: $domain unreachable"; continue; }
  end_ts=$(date -d "$end" +%s 2>/dev/null) || continue
  now_ts=$(date +%s)
  days=$(( (end_ts - now_ts) / 86400 ))
  if [ "$days" -lt "$CERT_WARN_DAYS" ]; then
    add "CERT EXPIRY: $domain in $days days"
  fi
done

# Emit alert email if any
if [ "${#ALERTS[@]}" -gt 0 ]; then
  {
    echo "From: $ALERT_FROM"
    echo "To: $ALERT_TO"
    echo "Subject: [gitdone/$HOST] ${#ALERTS[@]} alert(s)"
    echo "Content-Type: text/plain; charset=utf-8"
    echo
    echo "Host: $HOST"
    echo "Time: $(date -u +%FT%TZ)"
    echo
    for a in "${ALERTS[@]}"; do echo " - $a"; done
    echo
    echo "--"
    echo "gitdone-health.timer ($(basename "$0"))"
  } | /usr/sbin/sendmail -t -i
fi

exit 0
