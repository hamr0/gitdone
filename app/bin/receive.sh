#!/bin/bash
# Postfix pipe transport entry. Forwards envelope args to receive.js.
# Configured in /etc/postfix/master.cf:
#
#   gitdone   unix - n n - - pipe
#     flags=R user=gitdone argv=/opt/gitdone/bin/receive.sh \
#       ${client_address} ${client_helo} ${sender} ${original_recipient}

set -euo pipefail
exec /usr/bin/node /opt/gitdone/bin/receive.js "$@"
