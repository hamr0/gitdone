#!/bin/bash
# Postfix pipe transport entry. Forwards envelope args to receive.js.
# Configured in /etc/postfix/master.cf:
#
#   gitdone   unix - n n - 1 pipe
#     flags=R user=gitdone argv=/opt/gitdone/app/bin/receive.sh \
#       ${client_address} ${client_helo} ${sender} ${original_recipient}
#
# SECURITY-CRITICAL: the maxproc column MUST be 1 (the `1` before `pipe`, not
# the Postfix default of 100). receive.js has NO in-process locking around the
# per-event git repo or events/<id>.json — concurrency safety relies entirely
# on Postfix serializing deliveries one-at-a-time through this pipe. At
# maxproc>1, two concurrent deliveries to the same event race nextSequence() and
# the git index.lock (lost replies / repo corruption), and the per-process
# 25 MB message cap multiplies into a ~maxproc*25 MB memory ceiling. Verified
# live = 1; pinned here so a master.cf rebuild can't silently regress it.
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
