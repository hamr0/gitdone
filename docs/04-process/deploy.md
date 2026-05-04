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

Each check is one numbered step in `ops/deploy.sh`. They run in this
order; the first failure exits non-zero before anything touches the
VPS.

### Pre-flight (local)

| # | Check | Why |
|---|-------|-----|
| 1 | Working tree is clean | A dirty tree means the sha you think you're deploying isn't what's on disk. Tests passing on uncommitted code don't prove anything once the script `git checkout`s a different sha on the VPS. |
| 2 | On branch `main` | Production tracks `main`. Deploying from a feature branch is almost always a mistake. Use the explicit `<sha-or-tag>` form if you really need to deploy something off-main. |
| 3 | `main == origin/main` | Catches the "I forgot to `git push`" case. The VPS pulls from `origin`, not your laptop. |
| 4 | Target sha is reachable from `origin/main` | Stops you from deploying a sha that exists locally but isn't on the public main branch. |
| 5 | `app/package-lock.json` is tracked | `npm ci` requires a lockfile. Without it the VPS install is non-reproducible and may silently skip new deps. |
| 6 | No `file:` / `link:` / `git:` deps in `app/package.json` | Those resolve only on the maintainer laptop and break `npm ci` on the VPS. Use a published package or vendor it. |
| 7 | Local Node major ≤ VPS Node major | knowless once required Node ≥22.5 while the VPS was on 20; `auth.startLogin` blew up at runtime because `node:sqlite` is a 22.5+ built-in and only `/health` worked. Engine drift = silent prod outage. |
| 8 | `cd app && npm test` passes | Final gate. The full suite (~390 cases) runs against the same code that's about to ship. Output goes to `/tmp/gitdone-deploy-tests.log` if it fails. |

### Deploy (remote)

| # | Action | Notes |
|---|--------|-------|
| 9 | Load SSH key from `pass gitdone/vps/ssh_key_federver` into `/tmp/gitdone-vps-key` | Only happens if the file is missing. The `gitdone-vps` ssh alias in `~/.ssh/config` points at this path. |
| 10 | `git fetch --tags && git checkout <target>` at `/opt/gitdone` | Run as `sudo` because the deploy dir is root-owned. |
| 11 | `npm ci --omit=dev` | Only if `app/package-lock.json` or `app/package.json` changed between deployed and target sha. Skipped otherwise — restart is sub-second. |
| 12 | `systemctl restart gitdone-web.service` | The service is a single Node process on `127.0.0.1:3001`. nginx proxies `:443` → `:3001`. |
| 13 | Poll `/health` (200) and `/manage` (200/302) | `/health` is zero-dep so it passes even when auth is broken — `/manage` exercises the knowless bootstrap. Up to 15s of polling on `/health` to ride out the restart. |
| 14 | Append a line to `ops/deploy-log.md` | Uncommitted — fold it into your next commit. |

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
