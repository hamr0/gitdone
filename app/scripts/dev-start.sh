#!/bin/sh
# Local dev. Run: npm run dev
#
# No real SMTP — sendmail call fails on purpose:
#   - Event activation URL shows inline in the create-event response page.
#   - Sign-in magic link prints here in the terminal (knowless dev fallback).

cd "$(dirname "$0")/.." || exit 1

SECRET_FILE="data-dev/.dev-secret"
mkdir -p data-dev
[ -f "$SECRET_FILE" ] || openssl rand -hex 32 > "$SECRET_FILE"

export GITDONE_PUBLIC_URL="http://localhost:3001"
export GITDONE_COOKIE_SECURE="0"
export GITDONE_SESSION_SECRET="$(cat "$SECRET_FILE")"
export GITDONE_SENDMAIL_BIN="/nonexistent-sendmail"

exec node bin/server.js --dev
