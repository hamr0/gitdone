# Insights

Lessons learned during Phase 1 that aren't captured in the code or
commit messages. Append newest-first.

---

### Kuma push-monitor heartbeat defaults to 60s — always override for daily crons

**When:** 2026-04-20, federver install. The backup-heartbeat push
monitor was set up with Kuma's default heartbeat of 60s, so it flapped
red-green all day between the daily 04:15 pushes.

**Fix:** set Heartbeat Interval to `86400` (24h) and Grace to `3600`
before saving. Documented in `ops/homeserver/FEDERVER_INSTALL.md`.

### Rewriting env files with `sed` fails when the value contains `&`

**When:** 2026-04-20. `KUMA_PUSH_URL=http://.../?status=up&msg=OK&ping=`
— `sed` treats `&` as "the whole match" and duplicates the search
pattern. The env file became a cascade of concatenated lines.

**Fix:** use a single-quoted heredoc (`sudo tee file >/dev/null <<'EOF'`)
to write the whole env file atomically. Heredoc is unaffected by `&`
or by shell substitution. Avoid `sed -i` for config files that contain
URLs or shell metacharacters.

### rsync 3.4.1 rejects remote paths, across the board

**When:** adapting addypin's backup script for gitdone.

**Symptom:** `Unexpected remote arg: root@host:/path`
(`rsync error: syntax or usage error (code 1)`).

**Fix:** drop `rsync` entirely for backup, use
`ssh host 'tar -czf - -C /path subdir' > local.tar.gz`. rsync's delta
transfer gives nothing for small files anyway. May revisit if rsync
fixes argument handling.

### `datetime-local` forces a time; use `type="date"` for day-level fields

**When:** dev-feedback.log 2026-04-19, Firefox rejected valid dates
with "Please enter valid date and time" because the `datetime-local`
spec requires a time component and the browser didn't infer one. Users
don't want to type "by 14:32" for a workflow deadline.

**Fix:** `<input type="date">`. Backend validator already accepts
YYYY-MM-DD or full ISO 8601.

### Node 22 dropped directory-based `--test` auto-discovery

**When:** 2026-04-19, `npm test` failing with
`Cannot find module '/.../tests/unit'`.

**Fix:** use explicit globs, not directory paths, in
`package.json`:

```json
"test": "node --test 'tests/unit/**/*.test.js' 'tests/integration/**/*.test.js'"
```

### Opaque file-backed tokens beat JWT for single-host stateful features

**When:** 1.H.4, magic-link per-event management URLs.

Concluded that JWT buys nothing here: the server doing the minting is
the same server doing the lookup, file-per-token gives O(1) lookup +
file delete = revocation for free. JWT's statelessness would
re-introduce the lookup anyway (for event ownership), and every
useful feature (one-time use, revocation, audit log) fights its
design. Reserve JWT for cross-service auth.

### Preview-before-create is cheap if all state carries through hidden fields

**When:** 2026-04-20, feedback asked for "confirmation after final
submit."

Tempting to introduce server-side session state for the two-step flow
(`POST /events` → token → `POST /events/confirm`). Instead, the
preview page embeds all validated fields as hidden inputs. Confirm
just re-POSTs the same body with `_action=confirm`. Zero
infrastructure, zero new failure modes, easy to test.

### Delete, don't migrate, test/demo data on schema change

**When:** 1.H.2b dropped the `flow` enum in favor of `depends_on`.

Spent no time writing migration code for the two existing test events.
Deleted them, regenerated via the form. Migration paths are a real
cost later; pre-launch they're pure overhead.

### "No REST API" is a feature, and documenting it as one matters

**When:** archiving `docs/02-features/api-reference.md`.

The v1 doc literally contradicted PRD §0.1.6. Writing REST endpoints
by default is such a strong programmer reflex that the absence has
to be *visibly asserted* (in the PRD, in the README, in CLAUDE.md)
or someone will re-introduce it on the assumption it was an
oversight.

### External monitoring needs to live off-box

**When:** deciding between a local health check and external uptime
watcher.

A health check *on* the box it monitors can't detect the box being
off — the check dies with it. Two layers are needed: a local
`gitdone-health.timer` watching app-specific things (disk, mailq,
cert), plus an external pinger (Kuma on federver) watching HTTP
from the outside. Neither replaces the other.
