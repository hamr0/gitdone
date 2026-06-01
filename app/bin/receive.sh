#!/bin/bash
# Postfix pipe transport entry. Forwards envelope args to receive.js.
# Configured in /etc/postfix/master.cf:
#
#   gitdone   unix - n n - - pipe
#     flags=R user=gitdone argv=/opt/gitdone/app/bin/receive.sh \
#       ${client_address} ${client_helo} ${sender} ${original_recipient}
#
# Resolves receive.js relative to this script so a rename/move of
# /opt/gitdone -> /opt/gitdone.old doesn't silently break the pipe.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load the same environment as gitdone-web.service (GITDONE_DOMAIN,
# GITDONE_PUBLIC_URL, GITDONE_DATA_DIR, ...). Postfix runs this pipe as the
# `gitdone` user directly — NOT via systemd — so unlike the web service it does
# not inherit the unit's EnvironmentFile. Without this, receive.js falls back to
# config.js defaults, which silently desynced the inbound pipe from the live
# domain during the signedreply.com rename. The file is root:gitdone 0640 (we
# can read it); `set -a` exports each assignment into receive.js's env.
if [ -r /etc/default/gitdone-web ]; then
  set -a; . /etc/default/gitdone-web; set +a
fi

exec /usr/bin/node "$SCRIPT_DIR/receive.js" "$@"
