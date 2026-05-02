#!/bin/sh
# Dev sendmail — saves email to data-dev/mail/ and prints links to terminal.

MAIL_DIR="$(dirname "$0")/../data-dev/mail"
mkdir -p "$MAIL_DIR"

body=$(mktemp)
cat > "$body"

to=$(grep -m1 -i '^To:' "$body" | sed 's/^[Tt]o:[[:space:]]*//' | tr -d '\r')
subj=$(grep -m1 -i '^Subject:' "$body" | sed 's/^[Ss]ubject:[[:space:]]*//' | tr -d '\r')
safe=$(printf '%s' "$to" | sed 's/@/_at_/g' | tr -c 'a-zA-Z0-9._-' '_')
ts=$(date +%s)

cp "$body" "$MAIL_DIR/${safe}_${ts}.eml"

printf '\n📧  to: %s — %s\n' "$to" "$subj" >&2
tr -d '\r' < "$body" | grep -o 'http://[^ ]*' | sed 's/^/    /' >&2
printf '\n' >&2

rm "$body"
exit 0
