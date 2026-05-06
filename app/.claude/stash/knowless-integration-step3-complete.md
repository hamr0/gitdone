# Stash: knowless-integration-step3-complete
Timestamp: 2026-05-02T17:05:29Z
Branch: knowless-integration

## Plan Reference
`/home/hamr/.claude/plans/continue-elegant-seal.md`

## What Was Done This Session

### Step 1 (prior session) — already complete
- Branch `knowless-integration` checked out
- `app/package.json`: `engines.node` → `>=22.5`, `knowless` file-linked dependency added
- `npm install` run

### Step 2 — complete (this session)
New files created:
- `app/src/auth.js` — memoised `getAuth()` bootstrap. Dynamic `import('knowless')`, wires `GITDONE_SESSION_SECRET` + `GITDONE_PUBLIC_URL` + `${dataDir}/knowless.db`. `openRegistration: true`, `devLogMagicLinks` from `GITDONE_DEV_MAGIC_LINKS` env var. Exports `_resetAuth()` for test isolation.
- `app/src/auth-mailer.js` — custom knowless mailer. `createAuthMailer({from, fromName, domain, dropShamRecipient})`. Timing equalization: both sham and real paths spawn sendmail subprocess (sham closes stdin immediately). Reads `sendmailBin()` at call time (not module-load time) so tests can override via env var. `verify()` checks binary execute permission.
- `app/src/web/handle-events.js` — `createEventFinder(deriveHandle)` factory. Returns `findEventsByHandle(handle)` that hash-on-read scans `data/events/*.json`, comparing `deriveHandle(ev.initiator)` against the session handle. No event-data migration.
- `app/tests/unit/auth.test.js` — 4 tests (bootstrap, memoization, missing secret, handle determinism)
- `app/tests/unit/auth-mailer.test.js` — 9 tests (buildAuthRaw, sham/real submit, verify, factory validation)
- `app/tests/unit/handle-events.test.js` — 7 tests (match, case-insensitive, empty dir, unknown handle, sort, null handle, bad deriveHandle)

### Step 3 — complete (this session)
Surface A cutover: hand-rolled session → knowless.

Modified files:
- `app/src/magic-token.js` — added `findTokenByEventId` (moved from magic-session; needed until Surface C goes in step 4). Exported.
- `app/src/auth.js` — `openRegistration: true`, `devLogMagicLinks: process.env.GITDONE_DEV_MAGIC_LINKS === '1'`, `confirmationMessage` customised.
- `app/bin/server.js`:
  - Added `IS_DEV → GITDONE_DEV_MAGIC_LINKS=1` env setup before any requires
  - Added requires: `{ getAuth }`, `{ createEventFinder }`, `{ findTokenByEventId }` from magic-token
  - Removed `const session = require('../src/magic-session')`
  - Replaced `currentSessionEmail(req)` with `async currentHandle(req)` — calls `auth.handleFromRequest(req)`, catches auth bootstrap errors and returns null (so tests without `GITDONE_SESSION_SECRET` still get 303 instead of 500)
  - `renderSessionHub({ email, devLink, ... })` → `renderSessionHub({ handle, auth, ... })` — uses `createEventFinder((email) => auth.deriveHandle(email))`; removed "signed in as" email display (can't recover email from handle)
  - `GET /manage` — uses `currentHandle`, shows dashboard or gitdone-themed sign-in form
  - `POST /manage` → `auth.login(req, res)`
  - `GET /manage/session/:token` → replaced by `GET /manage/callback` → `auth.callback`
  - New `GET /manage/verify` → `auth.verify`
  - `POST /manage/logout` → `auth.logout`
  - `GET /manage/event/:id` — `currentHandle` + `auth.deriveHandle` ownership check + `findTokenByEventId` redirect (Surface C interim)
  - `GET /events/:id` — `currentHandle` + conditional `auth.deriveHandle` ownership check (try/catch guards against missing secret in tests)

Deleted:
- `app/src/magic-session.js`
- `app/tests/unit/magic-session.test.js`

Test result: **363 tests, all passing**.

Smoke test verified:
- `GET /manage` → 200, renders gitdone-themed sign-in form ("Open your events")
- `POST /manage` → 200 (knowless confirmation, sham-safe)
- `GET /manage/callback?t=notatoken` → 302 redirect to /manage

## What's Next

### Step 4 — Surface C cutover (NOT YET STARTED)
Replace `/manage/:token` family with session-gated `/manage/event/:id` routes. Delete `app/src/magic-token.js` and its tests.

Changes needed in `app/bin/server.js`:
- Rewrite `GET /manage/:token` → redirect to session-gated `GET /manage/event/:id` (or show dashboard inline)
- Rewrite `POST /manage/:token/remind` → `POST /manage/event/:id/remind` (session-gated)
- Rewrite `POST /manage/:token/unarchive` → `POST /manage/event/:id/unarchive` (session-gated)
- Rewrite `POST /manage/:token/close` → `POST /manage/event/:id/close` (session-gated)
- Update `GET /activate/:token` redirect: `rec.management_token ? /manage/${token}?activated=1` → `/manage/event/${eventId}?activated=1`
- Update hub `renderRow` manageHref: `ev.management_token ? /manage/${ev.management_token}` → `/manage/event/${ev.id}` always
- Update activation email copy: remove "management link" paragraph; add "manage at /manage" copy
- Run one-shot cleanup: `data/magic_tokens/*.json` files (or just leave them as dead files since they'll 404 on `/manage/:token`)
- Delete `app/src/magic-token.js` and `app/tests/unit/magic-token.test.js`

Also: `findTokenByEventId` in magic-token.js is the only thing tying `/manage/event/:id` to magic-token.js. Once Surface C is done, that goes away too.

### Step 5 — Update CLAUDE.md
Collapse "Self-serve session login" paragraph into "knowless-backed session login"; remove per-event magic-link paragraph (1.H.4).

### Verification still needed
- Manual end-to-end on dev: file event → activation → `/manage` sign-in → dashboard → per-event actions
- `inspect data/knowless.db` schema (no plaintext email column)
- `tools/gitdone-verify` against a branch-created event

## Key Decisions Made
- `openRegistration: true` — required; gitdone has no pre-registered accounts. Any email can sign in; if they have events, dashboard shows them.
- `currentHandle` catches bootstrap errors and returns null — prevents 500s in tests/environments without `GITDONE_SESSION_SECRET`
- "signed in as" email display removed — email is not recoverable from the HMAC handle
- `devLogMagicLinks` driven by `GITDONE_DEV_MAGIC_LINKS=1` env var (set by server.js when `--dev`)
- `findTokenByEventId` moved to magic-token.js as interim measure for step 3 (will be deleted in step 4)
- Surface C `GET /manage/:token` and action routes remain unchanged in step 3 — only Surface A was cut over

## Uncommitted Changes
All changes are unstaged/untracked. Nothing committed yet on this branch.
Files modified vs main:
- app/package.json (engines + knowless dep)
- app/bin/server.js (Surface A cutover)
- app/src/auth.js (new)
- app/src/auth-mailer.js (new)
- app/src/magic-token.js (findTokenByEventId added)
- app/src/web/handle-events.js (new)
- app/tests/unit/auth.test.js (new)
- app/tests/unit/auth-mailer.test.js (new)
- app/tests/unit/handle-events.test.js (new)
- app/src/magic-session.js (DELETED)
- app/tests/unit/magic-session.test.js (DELETED)
