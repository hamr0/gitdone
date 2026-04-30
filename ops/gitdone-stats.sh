#!/bin/sh
# Daily stats snapshot: append one JSON line per run to the stats log.
# Invoked by gitdone-stats.timer (daily). The log file is JSONL —
# one snapshot per line — so a year of records is a few hundred KB
# and trivially parseable with `jq` or `tail | head -1`.

set -e

LOG_FILE="${GITDONE_STATS_LOG:-/var/log/gitdone/stats.log}"
APP_DIR="${GITDONE_APP_DIR:-/opt/gitdone/app}"

mkdir -p "$(dirname "$LOG_FILE")"
cd "$APP_DIR"
node bin/stats.js --json >> "$LOG_FILE"
