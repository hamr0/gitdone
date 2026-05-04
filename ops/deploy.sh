#!/usr/bin/env bash
# Deploy gitdone to the production VPS.
#
# Usage:
#   ops/deploy.sh                # deploys origin/main
#   ops/deploy.sh <sha-or-tag>   # deploys a specific revision
#
# What it does, in order — see docs/04-process/deploy.md for the why
# behind each check:
#
#   Pre-flight (local):
#     1. clean working tree (no unstaged or staged diffs)
#     2. on branch main
#     3. local main == origin/main (i.e. pushed)
#     4. target sha is reachable from origin/main
#     5. app/package-lock.json is tracked
#     6. no file:/link:/git: deps in app/package.json
#     7. local Node major <= VPS Node major
#     8. full test suite passes (cd app && npm test)
#
#   Deploy (remote):
#     9. load SSH key from `pass gitdone/vps/ssh_key_federver`
#    10. fetch + checkout target sha at /opt/gitdone
#    11. run `npm ci --omit=dev` ONLY if app/package*.json changed
#    12. systemctl restart gitdone-web.service
#    13. poll /health (200) and /manage (200/302) — fail-fast on miss
#    14. append one line to ops/deploy-log.md and commit it locally
#
# Tests are not skippable. If you need an emergency override, do it by
# hand — don't add a flag.

set -euo pipefail

SSH_HOST="gitdone-vps"
SSH_KEY="/tmp/gitdone-vps-key"
PASS_ENTRY="gitdone/vps/ssh_key_federver"
VPS_PATH="/opt/gitdone"
HEALTH_URL="https://git-done.com/health"
MANAGE_URL="https://git-done.com/manage"

repo_root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$repo_root"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "    ok — $*"; }

target="${1:-origin/main}"
target_sha="$(git rev-parse "$target" 2>/dev/null)" || fail "cannot resolve $target"
target_short="$(git rev-parse --short "$target_sha")"

echo "==> Deploying $target_short to $SSH_HOST"

# ---- 1. clean tree (tracked files only — untracked is fine) -----------
echo "==> Pre-flight"
git diff --quiet || fail "unstaged changes to tracked files — commit or stash first"
git diff --cached --quiet || fail "staged changes not committed"
ok "clean tree"

# ---- 2. on main -------------------------------------------------------
branch="$(git symbolic-ref --short HEAD 2>/dev/null || echo "DETACHED")"
[[ "$branch" == "main" ]] || fail "not on main (on $branch)"
ok "on branch main"

# ---- 3. pushed --------------------------------------------------------
git fetch --quiet origin main
local_sha="$(git rev-parse main)"
remote_sha="$(git rev-parse origin/main)"
[[ "$local_sha" == "$remote_sha" ]] || fail "local main ($local_sha) != origin/main ($remote_sha) — push first"
ok "main matches origin/main"

# ---- 4. target reachable ---------------------------------------------
git merge-base --is-ancestor "$target_sha" origin/main || fail "$target_short not reachable from origin/main"
ok "target on origin/main"

# ---- 5. lockfile tracked ----------------------------------------------
git ls-files --error-unmatch app/package-lock.json >/dev/null 2>&1 || fail "app/package-lock.json not tracked"
ok "lockfile tracked"

# ---- 6. no non-registry deps -----------------------------------------
if grep -E '"(file|link|git\+?[a-z]*):"' app/package.json >/dev/null; then
  fail "non-registry dep in app/package.json (file:/link:/git:)"
fi
ok "no file:/link:/git: deps"

# ---- 7. node major sanity --------------------------------------------
local_major="$(node -p 'process.versions.node.split(".")[0]')"
vps_major_raw="$(ssh -o ConnectTimeout=8 "$SSH_HOST" 'node --version' 2>/dev/null || echo "v0")"
vps_major="${vps_major_raw#v}"; vps_major="${vps_major%%.*}"
[[ "$vps_major" -ge 1 ]] || fail "could not read VPS node version (got '$vps_major_raw')"
[[ "$local_major" -le "$vps_major" ]] || fail "local Node v$local_major > VPS Node v$vps_major — upgrade VPS first"
ok "node compat (local v$local_major, vps v$vps_major)"

# ---- 8. tests ---------------------------------------------------------
echo "==> Running full test suite"
(cd app && npm test --silent >/tmp/gitdone-deploy-tests.log 2>&1) || {
  echo "FAIL: tests failed — tail of /tmp/gitdone-deploy-tests.log:" >&2
  tail -30 /tmp/gitdone-deploy-tests.log >&2
  exit 1
}
test_count="$(grep -E '^# tests ' /tmp/gitdone-deploy-tests.log | tail -1 | awk '{print $3}')"
ok "tests passed (${test_count:-?} cases)"

# ---- 9. ssh key from pass --------------------------------------------
if [[ ! -s "$SSH_KEY" ]]; then
  echo "==> Loading SSH key from pass:$PASS_ENTRY"
  umask 077
  pass show "$PASS_ENTRY" > "$SSH_KEY"
  chmod 600 "$SSH_KEY"
fi

deployed_sha="$(ssh -o ConnectTimeout=8 "$SSH_HOST" "cd $VPS_PATH && git rev-parse HEAD")"
deployed_short="$(git rev-parse --short "$deployed_sha" 2>/dev/null || echo "$deployed_sha")"
echo "==> Currently deployed: $deployed_short"

if [[ "$deployed_sha" == "$target_sha" ]]; then
  echo "==> Already at $target_short — nothing to deploy"
  exit 0
fi

# ---- 11. deps changed? -----------------------------------------------
deps_changed=0
if ! git diff --quiet "$deployed_sha" "$target_sha" -- app/package-lock.json app/package.json 2>/dev/null; then
  deps_changed=1
fi

# ---- 10. checkout on VPS ---------------------------------------------
echo "==> Fetching + checking out $target_short on VPS"
ssh "$SSH_HOST" "cd $VPS_PATH && sudo git fetch --tags --quiet origin && sudo git checkout --quiet $target_sha"

if [[ "$deps_changed" == "1" ]]; then
  echo "==> Dependencies changed — running npm ci --omit=dev"
  ssh "$SSH_HOST" "cd $VPS_PATH/app && sudo npm ci --omit=dev"
else
  echo "==> No dependency changes — skipping npm ci"
fi

# ---- 12. restart ------------------------------------------------------
echo "==> Restarting gitdone-web.service"
ssh "$SSH_HOST" "sudo systemctl restart gitdone-web.service"

# ---- 13. smoke --------------------------------------------------------
echo "==> Smoke checks"
http_health="000"
for _ in $(seq 1 15); do
  http_health="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 3 "$HEALTH_URL" || echo "000")"
  [[ "$http_health" == "200" ]] && break
  sleep 1
done
http_manage="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 5 "$MANAGE_URL" || echo "000")"
echo "    /health  -> $http_health"
echo "    /manage  -> $http_manage"

if [[ "$http_health" != "200" ]] || [[ "$http_manage" != "200" && "$http_manage" != "302" ]]; then
  echo "FAIL: smoke check did not pass — recent logs:" >&2
  ssh "$SSH_HOST" "journalctl -u gitdone-web.service -n 40 --no-pager" >&2
  exit 1
fi
ok "service healthy"

# ---- 14. record -------------------------------------------------------
log_file="ops/deploy-log.md"
[[ -f "$log_file" ]] || {
  printf '# Deploy log\n\nOne line per successful production deploy. Newest first.\n\n' > "$log_file"
}
ts="$(date -u '+%Y-%m-%dT%H:%MZ')"
subject="$(git log -1 --pretty=%s "$target_sha")"
# Insert after the header (line 4 onward).
{ head -n 4 "$log_file"; printf -- '- %s · `%s` · %s\n' "$ts" "$target_short" "$subject"; tail -n +5 "$log_file"; } > "${log_file}.tmp" && mv "${log_file}.tmp" "$log_file"
echo "    appended to $log_file (uncommitted — fold into next commit)"

echo "==> Deployed $target_short"
