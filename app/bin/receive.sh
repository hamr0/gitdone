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
exec /usr/bin/node "$SCRIPT_DIR/receive.js" "$@"
