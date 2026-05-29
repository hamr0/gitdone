# Deploy

`ops/deploy.sh` is the only supported way to ship gitdone to production.
This page is the contract: every check it runs, why it exists, and what
to do when one fails.

The script is **safe to re-run**. If the VPS is already at the target
sha it exits early with no side effects.

## Usage

```bash
ops/deploy.sh                # deploys origin/main (default)
ops/deploy.sh <sha-or-tag>   # deploys a specific revision
```

Tests are not skippable. If you genuinely need to bypass the suite, do
it by hand against the runbook below — don't add a flag to the script.

## What it checks, and why

The script runs fourteen numbered steps in the order below. They share
a fail-fast contract: any non-zero exit aborts before the next step
runs. Steps 1–8 are local; nothing on the VPS changes until step 10.

### Pre-flight (local)

#### 1. Working tree is clean (tracked files only)

```bash
git diff --quiet                # no unstaged tracked diffs
git diff --cached --quiet       # no staged-but-uncommitted diffs
```

Untracked files (stash notes, scratch dirs) are ignored on purpose —
they don't affect the sha that ships. Tracked diffs do: if the working
tree disagrees with HEAD, you have no idea what you're actually
deploying. Tests passing on uncommitted code prove nothing once the
script `git checkout`s the *committed* sha on the VPS.

**Failure says:** `unstaged changes to tracked files — commit or stash first`.
Commit (or `git stash`) and re-run.

#### 2. On branch `main`

```bash
git symbolic-ref --short HEAD   # must equal "main"
```

Production tracks `main`. A feature-branch deploy is almost always a
mistake, and a detached HEAD has no upstream to compare against in
step 3. If you genuinely need to deploy something off-main, pass it
explicitly: `ops/deploy.sh <sha-or-tag>` — that bypasses the branch
check by going through step 4 instead.

#### 3. Local `main` == `origin/main`

```bash
git fetch --quiet origin main
test "$(git rev-parse main)" = "$(git rev-parse origin/main)"
```

Catches the "I forgot to `git push`" case. The VPS clones from
`origin`, not from your laptop, so anything not on the remote is
invisible to it. We `fetch` first so a stale local view of
`origin/main` doesn't pass when the remote has actually moved on
(someone else pushed).

#### 4. Target sha is reachable from `origin/main`

```bash
git merge-base --is-ancestor "$target_sha" origin/main
```

Stops you from deploying a sha that exists locally but was never
pushed (or was pushed only to a branch). The check uses
`is-ancestor`, so `origin/main` itself qualifies, as does any commit
that's already in main's history — including older shas for rollback.

#### 5. `app/package-lock.json` is tracked

```bash
git ls-files --error-unmatch app/package-lock.json
```

`npm ci` *requires* a lockfile and refuses to install without one. If
the lockfile is gitignored or never added, the VPS install becomes
non-reproducible — npm falls back to `package.json` resolution, may
silently skip new transitive deps, and the production behavior diverges
from what you tested locally.

#### 6. No `file:` / `link:` / `git:` deps in `app/package.json`

```bash
grep -E '"(file|link|git\+?[a-z]*):"' app/package.json
```

These specifier schemes resolve relative to the maintainer's laptop
(`file:../knowless`) or against a private git URL the VPS may not have
access to. They install fine in development and explode at `npm ci`
time on the VPS. Either publish the dep to npm or vendor it into the
repo.

#### 7. Local Node major ≤ VPS Node major

```bash
node -p 'process.versions.node.split(".")[0]'   # local
ssh gitdone-vps 'node --version'                # remote
```

Engine drift is a silent prod outage. The canonical scar:
`knowless` once bumped to Node ≥22.5 while the VPS was pinned to 20;
the app booted, `/health` returned 200, but `auth.startLogin` blew up
at runtime because `node:sqlite` is a 22.5+ built-in. The check fails
loud at pre-flight rather than letting that recur. Resolution is
always the same — upgrade the VPS Node major *first*, in a separate
change, then come back to the app deploy.

#### 8. Full test suite passes

```bash
cd app && npm test
```

Final gate before anything touches the VPS. Output is captured to
`/tmp/gitdone-deploy-tests.log`; on failure the script tails the last
30 lines so you don't have to dig. The current suite is 393 cases and
runs in ~14s — there is intentionally no skip flag because the cost
of waiting is far less than the cost of shipping a regression.

### Deploy (remote)

#### 9. Load the SSH key from `pass`

```bash
pass show gitdone/vps/ssh_key_federver > /tmp/gitdone-vps-key
chmod 600 /tmp/gitdone-vps-key
```

Only runs if `/tmp/gitdone-vps-key` is missing or empty — across
multiple deploys in one session, the key persists for the
`ControlMaster` to reuse. The path is the one the `gitdone-vps` host
in `~/.ssh/config` already references, so no SSH config edits are
needed. The key is the same one the federver homeserver uses for
backups (single source of truth in `pass`).

#### 10. Fetch and check out on the VPS

```bash
ssh gitdone-vps "cd /opt/gitdone && sudo git fetch --tags --quiet origin \
  && sudo git checkout --quiet <target_sha>"
```

`/opt/gitdone` is a regular git clone, root-owned (hence `sudo`). The
checkout is detached at the target sha — branches don't matter here
because the script always passes a resolved sha. `--tags` keeps tag
refs current so tag-based deploys work without a separate fetch.

#### 11. `npm ci --omit=dev` (only if deps changed)

```bash
git diff --quiet "$deployed_sha" "$target_sha" -- \
  app/package-lock.json app/package.json
```

If that diff is empty between the previously-deployed sha and the
target sha, the script skips `npm ci` entirely — `node_modules/` on
the VPS already matches. When it isn't empty (lockfile or
package.json changed), it runs `npm ci --omit=dev` to install
production deps deterministically. Skipping the install when nothing
changed is what makes the typical deploy sub-second.

#### 12. Restart the service

```bash
ssh gitdone-vps "sudo systemctl restart gitdone-web.service"
```

The service is a single Node process bound to `127.0.0.1:3001`; nginx
on `:443` proxies to it. Restart drops the listening socket briefly,
which nginx surfaces as a `502` to anyone hitting the site during the
window. That's expected and is what step 13 polls past.

#### 13. Smoke checks

```bash
# poll /health up to 15× with 1s spacing
curl -fsS -o /dev/null -w '%{http_code}' --max-time 3 https://git-done.com/health
curl -fsS -o /dev/null -w '%{http_code}' --max-time 5 https://git-done.com/manage
```

`/health` is the zero-dep liveness endpoint — it returns 200 even when
auth is broken (by design), so it tells you the process is up but not
that the app is functional. `/manage` is the second probe: it
exercises the knowless bootstrap, which is the part that tends to fail
on Node-version drift or session-secret problems. We accept 200 *or*
302 (the redirect-to-sign-in is healthy). On failure the script dumps
the last 40 lines of `journalctl -u gitdone-web.service` so the cause
is visible without a second SSH round-trip.

> **The automated smoke is `curl`-only, and `curl` is not a browser.**
> It cannot reproduce browser-specific request shaping — most notably
> the `Origin: null` header a browser sends on same-origin *form-navigation*
> POSTs under our `Referrer-Policy: no-referrer`. The 0.26.2 CSRF
> regression (every create + dashboard mutation 403'd) sailed through
> the `curl` smoke because `curl` sends whatever `Origin` you hand it.
> So **for any change that touches the request path** — auth, CSRF/Origin
> checks, security headers, routing, body parsing — also run the manual
> browser pass below before calling it done.

#### 13b. Manual browser smoke (request-path changes only)

In a real browser on https://git-done.com, signed in as an organiser:

1. **Create a workflow event** — fill the form, Confirm. Expect the
   "check your inbox" page, not `forbidden`.
2. **Create a crypto declaration event** — same: fill, Create, expect
   success not `forbidden`.
3. **Dashboard mutations** — on an event you own, click **Activate**,
   then **Remind**, then **Close**. Each must act, not 403. (These are
   the form-navigation POSTs that carry `Origin: null`.)
4. Confirm the security headers are still present (`curl -sSI
   https://git-done.com/ | grep -i 'content-security\|x-frame'`).

If any create/mutation returns `forbidden`, the Origin/CSRF path has
regressed — see `sameOrigin()` in `bin/server.js` and PRD finding #44.

#### 14. Record in `ops/deploy-log.md`

```markdown
- 2026-05-04T18:34Z · `53ffaaa` · deploy: ignore untracked files in clean-tree check
```

One line, prepended at the top (newest first). Left **uncommitted** so
it folds into your next functional commit instead of generating churn
of its own. The log is a thin audit trail — handy for "when did we
last ship X?" without grepping git history.

## When something fails

- **Pre-flight fail**: fix the root cause (commit, push, bump VPS Node, etc.)
  and re-run. No partial state to clean up.
- **Tests fail**: `tail -30 /tmp/gitdone-deploy-tests.log` shows the failures.
  Fix, commit, re-run.
- **Smoke check fails after restart**: the script dumps the last 40 lines
  of `journalctl -u gitdone-web.service`. Common causes: env var missing
  in `/etc/default/gitdone-web`, port collision, lockfile/dep mismatch
  the pre-flight didn't catch. Roll back with `ops/deploy.sh <previous-sha>`.

## Rollback

```bash
ops/deploy.sh <previous-sha>
```

Same script, older sha. The lockfile-aware step 11 means deps roll back
automatically if they need to. Data lives at `/var/lib/gitdone/`,
outside `/opt/gitdone/`, so rollback never touches user state.

## Manual deploys

The expanded runbook in `deployment.md §11` covers things the script
deliberately doesn't automate (initial install, Node major upgrades,
DKIM rotations, certificate renewal). Use it when you're touching the
host itself, not just the application.

## One-time migrations

### Repo `event.json` backfill (post bug-fix)

Pre-fix, every per-event git repo's working-tree `event.json` was
written ONCE on repo init and never updated. State transitions
(activation, edits, completion, archive) only landed in the master
`data/events/<id>.json` — leaving the repo (which IS the proof
artifact per PRD §0.1) carrying a stale snapshot. The offline
verifier read the wrong state.

Fix landed: every master-JSON write now also calls
`gitrepo.syncEventJson()` so the repo stays current.

After the fix deploys, run the one-shot backfill on prod ONCE to
sync existing repos with their masters:

```bash
ssh -i "$HOME/.ssh/gitdone_federver" gitdone@104.129.2.254 \
  'sudo -u gitdone node /opt/gitdone/app/bin/backfill-event-json.js'
```

Output is per-event `synced` / `up-to-date` / `no repo` lines plus a
summary tally. Idempotent — re-running is safe and reports
`up-to-date` for everything once the migration has run.

## Periodic hygiene

Quarterly (or whenever a security advisory fires), run from `app/`:

```bash
npm outdated
npm audit
npm view mailauth dependencies
```

### Active overrides — remove when upstream catches up

`app/package.json` carries `overrides` to pin the following transitive
deps of `mailauth` past advisories that mailauth itself hadn't fixed:

| Override | Pinned to | Reason |
|---|---|---|
| `fast-xml-parser` | `^5.7.3` | entity-expansion bypass (CVE-2026-26278 incomplete fix), CDATA injection |
| `nodemailer` | `^8.0.7` | SMTP CRLF injection in `envelope.size` and EHLO/HELO |
| `undici` | `^7.23.0` | WebSocket length overflow, `upgrade` CRLF injection, deduplication-handler memory DoS |

Watch for: a mailauth release whose `dependencies` (per `npm view
mailauth dependencies`) list versions that meet or exceed all three
pins above. When that lands, **delete the `overrides` block** in
`app/package.json` and run `npm install && npm audit && npm test`. If
audit stays clean, ship the cleanup as a one-line commit.

Carrying overrides past the point where upstream has caught up risks
behavior drift (we'd be running version combinations mailauth wasn't
tested against). The pin is a temporary measure, not a permanent fork.
