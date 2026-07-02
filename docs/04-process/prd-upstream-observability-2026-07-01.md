# PRD — Upstream observability asks: flightlog fatal-exit breadcrumb + pulselog command-timeout label

- **Status:** **Both delivered 2026-07-01** — pulselog `0.6.0` (Ask 2) and flightlog `0.6.0` (Ask 1, plus a control-char hardening bonus). **Adopted in gitdone 0.27.6** (flightlog + pulselog bumped to `^0.6.0`).
- **Author:** Amr (via incident review, 2026-07-01)
- **Targets:** `flightlog` (canonical `~/PycharmProjects/flightlog`, v0.5.0) and
  `pulselog` (canonical `~/PycharmProjects/pulselog`, v0.5.0) — both first-party libraries.
- **Source:** the 2026-07-01 shared-VPS incident (gitdone + plato co-tenants on
  `104.129.2.254`). See §1.
- **Scope note:** Two **independent** asks against two libraries, bundled because one
  incident surfaced both. Each §(Ask) is self-contained and can be lifted into that
  library's own backlog verbatim.

---

## 0. TL;DR

| # | Library | Ask | Kind | Value |
|---|---------|-----|------|-------|
| 1 | flightlog | On the **fatal-exit** path, emit one line to **stderr** before `process.exit(1)`, so a crash cause reaches the process's journal (systemd/journald), not only the JSONL sink. | Observability gap | **High** — cost ~11h of invisible crash-loop diagnosis. |
| 2 | pulselog | Make the `command` check's timeout reason read `timeout after Ns`, matching the other four checks, instead of the misleading `exit 1 (timeout)`. | Consistency / clarity | **Low** — cosmetic; prevents "exit 1" misreads. |

**Neither is a bug.** In the incident both libraries behaved exactly as designed —
flightlog is what *recorded* the crash cause at all. These are ergonomics
improvements that would have shortened diagnosis.

---

## 1. Background — what happened (where these are coming from)

On 2026-07-01 a routine bounce report ("alert email to Gmail failed, `550-5.7.26`")
opened into two production issues on the shared VPS:

1. **plato was down ~11 hours in a crash-loop (4500+ restarts).** The quarterly
   `refresh-disposable-domains.sh` (runs as **root**) rewrote
   `/opt/plato/disposable-domains.txt` with a `mktemp` 0600 umask, leaving it
   `root:root 0600`. plato's `bin/server.js` boot-reads that file
   (`loadDisposableDomains` → `readFileSync`) as the **plato** user → `EACCES` →
   uncaught exception → systemd restart → repeat.
2. **Every plato pulselog alert was silently bouncing at Gmail** because the
   generated config used `from: <operator gmail address>` — unauthenticated
   spoofing of gmail.com from the box's own Postfix. This is why the outage was
   invisible: the "your forum is down" alerts couldn't be delivered.

Both root causes were **adopter-side** (plato's script/config) and are fixed
(plato 0.14.1; gitdone 0.27.5 fixed two unrelated false-paging health checks found
in the same pass). This PRD is **only** about the two *library* ergonomics gaps
that made the incident slower to diagnose than it should have been:

- **The crash cause was invisible in the obvious place.** `journalctl -u
  plato.service` showed only `Main process exited, code=exited, status=1/FAILURE`
  through 4500 restarts. The actual `EACCES … open '/opt/plato/disposable-domains.txt'`
  stack existed **only** in flightlog's `errors.jsonl` — you had to already know to
  look there. → **Ask 1.**
- **The gitdone `ots-backlog` health check reported `exit 1 (timeout)`** — the
  `exit 1` reads like the command failed with code 1, when in fact pulselog *killed*
  it at the timeout (the `1` is synthesised). Every other pulselog check says
  `timeout after Ns`. → **Ask 2.**

---

## 2. Ask 1 — flightlog: one stderr breadcrumb on the fatal-exit path

### 2.1 Problem

When flightlog is configured with a **file** sink (the normal production case) and a
fatal handler fires (`exitOnUncaught` / `exitOnRejection`), the record is written to
the JSONL file and the process exits. **Nothing is written to stderr**, so nothing
reaches journald / `docker logs` / the supervisor's captured output. An operator
watching the *process's own logs* during a crash-loop sees an exit code and no cause.

Confirmed in `flightlog/src/install.js` (v0.5.0):

```js
activeUncaught = (err) => {
  s.writeSync(normalize(err, 'uncaught', context)); // → file sink only
  if (exitOnUncaught) process.exit(1);              // exits; stderr untouched
};
// …and the exitOnRejection === true branch, identically.
```

### 2.2 Why it matters

- The incident: 11h crash-loop, cause present in `errors.jsonl` but **absent from the
  journal**. Standard first move (`journalctl -u <svc>`) yielded nothing actionable.
- This is precisely the moment observability matters most — a process that is
  **dying**. A file sink is great for history and offline `jq`, but at the instant of
  a fatal exit the operator is almost always looking at the process's live output.

### 2.3 Why this fits flightlog's philosophy (not a new principle)

flightlog **already** uses "exactly one stderr line" for operational visibility in
adjacent cases — this ask extends an existing pattern, it does not introduce one:

- **Broken sink** (perms/read-only/full disk): "surfaced once to stderr with the
  errno, reset on recovery" (`sink.js`; README).
- **`bootCheck: false`**: "warn once to stderr and continue."
- **No `file` configured**: records are written to stderr (the `stderrSink`).

It also keeps every invariant: **local only** (stderr → journald, never the network),
**zero deps**, no daemon, no telemetry. The full record still goes to the JSONL sink;
this is a one-line *pointer*, not a second copy of the stack.

### 2.4 Proposed change (exact)

Add a private one-line breadcrumb on the two **fatal** branches only. It fires
**only when there is a file sink** (if `file` is omitted the record already went to
stderr — don't double-print). One line, never throws.

```js
// install.js — inside install(), `file` is already in scope (used at sink({ file, … })).

/** One-line stderr pointer on a fatal exit, so the cause reaches the process journal
 *  and not only the JSONL sink. No-op when there is no file sink (record is already on
 *  stderr). Never throws — the process is dying; a broken stderr must not mask the exit. */
const fatalBreadcrumb = (err, kind) => {
  if (!file) return;
  try {
    const name = (err && err.name) || 'Error';
    const msg  = (err && err.message) || String(err);
    process.stderr.write(`flightlog: fatal ${kind} — ${name}: ${msg} (recorded to ${file})\n`);
  } catch { /* stderr gone — stay quiet, still exit */ }
};

activeUncaught = (err) => {
  s.writeSync(normalize(err, 'uncaught', context));
  if (exitOnUncaught) { fatalBreadcrumb(err, 'uncaught'); process.exit(1); }
};

activeRejection = (reason) => {
  if (exitOnRejection) {
    s.writeSync(normalize(reason, 'unhandledRejection', context));
    fatalBreadcrumb(reason, 'unhandledRejection');
    process.exit(1);
  } else {
    s.write(normalize(reason, 'unhandledRejection', context)); // log-only path: unchanged
  }
};
```

Message shape (single line):

```
flightlog: fatal uncaught — Error: EACCES: permission denied, open '/opt/plato/disposable-domains.txt' (recorded to /opt/plato/data/logs/errors.jsonl)
```

### 2.5 Design decisions & non-goals

- **Fatal path only.** The log-only rejection path (`exitOnRejection:false`, the
  long-lived-server default) is untouched — a stray rejection on a healthy server
  must not start printing to stderr. Only paths that are about to `exit(1)` breadcrumb.
- **One line, not the stack.** The stack stays in the JSONL. stderr gets `name:
  message` + the file path. Enough to know *what* and *where to read more*.
- **No new public API (recommended).** Do it always-on on the fatal path — no config
  knob. This respects the "no new public surface in maintenance-mode libs" test: it's
  pure **mechanism** (how a fatal error surfaces), and mechanism belongs in the
  library. (If a knob is ever wanted, `echoFatalToStderr?: boolean = true` is the
  shape — but default-on with no knob is preferred, and adds nothing to learn.)
- **Never throws.** Guarded; the process is exiting regardless.
- **Non-goal:** echoing *non-fatal* `capture()`/`captureSync()` calls to stderr. Out
  of scope — those are boundary captures on a living process.

### 2.6 Acceptance criteria

- With `file` set and `exitOnUncaught:true`, a thrown uncaught error writes the JSONL
  record **and** exactly one matching line to stderr, then exits non-zero.
- With `file` set and `exitOnRejection:true`, same for an unhandled rejection.
- With `exitOnRejection:false` (log-only), **no** stderr line is emitted.
- With **no** `file` (stderr sink), **no** duplicate breadcrumb (record already on stderr).
- A broken stderr does not throw or change the exit code.
- Tests: spawn a child process for each of the above and assert on its stderr + exit
  code (matches flightlog's existing process-level test style).

### 2.7 Version / release

- flightlog **0.5.0 → 0.6.0** (new observable behaviour, backward-compatible; no API change).
- Changelog: "Fatal uncaught/rejection now also emit one stderr line before exit, so
  the cause reaches the process journal, not only the JSONL sink (file-sink mode)."

---

## 3. Ask 2 — pulselog: consistent `timeout after Ns` label for `command` checks

### 3.1 Problem

The `command` check reports a timeout kill as `exit 1 (timeout)`. The `1` is a
synthesised exit code (execFile's kill produces `err.code === null` → normalised to
1), so the label reads like a genuine exit-1 failure. In the incident this showed as:

```
✗ ots-backlog [command]: exit 1 (timeout) (after 2 attempts)
```

Every **other** pulselog check already phrases a timeout uniformly (`checks.js`, v0.5.0):

- `tcp` (L58): `timeout after Ns connecting host:port`
- `ssl` (L85): `timeout after Ns (TLS host:port)`
- `disk` (L94): `df timeout after Ns for <path>`
- `service` (L173): `<unit> timeout after Ns`
- **`command` (L184):** `exit ${code}${killed ? ' (timeout)' : ''}…`  ← the odd one out

### 3.2 Proposed change (exact)

`pulselog/src/checks.js`, `command()`:

```js
export async function command(cfg) {
  const { command: cmd, args = [], timeoutMs = 10_000 } = cfg;
  const { code, stderr, killed } = await exec(cmd, args, timeoutMs);
  const ok = code === 0;
  const tail = stderr.trim().slice(0, 200);
  const reason = ok
    ? 'exit 0'
    : killed
      ? `timeout after ${secs(timeoutMs)}s${tail ? ': ' + tail : ''}`   // ← align with tcp/ssl/disk/service
      : `exit ${code}${tail ? ': ' + tail : ''}`;
  return { ok, reason };
}
```

Result: `ots-backlog` would have read `timeout after 10s` — unambiguous.

### 3.3 Acceptance criteria & release

- A `command` check killed by timeout → reason `timeout after Ns` (optionally `: <stderr tail>`).
- A `command` check that genuinely exits non-zero → reason unchanged (`exit N[: tail]`).
- Test: a `sleep`-longer-than-timeout command asserts the `timeout after Ns` label;
  a `exit 3` command asserts `exit 3`.
- **Delivered in pulselog `0.6.0`** (2026-07-01), not the originally-proposed `0.5.1`
  patch: the reason string lands in the JSONL `message` + the alert email, so a consumer
  may match on it — a behaviour-visible change earns a **minor**. Both acceptance tests
  above are in `test/pulselog.test.js` (timeout kill → `timeout after Ns`; genuine
  `exit 3` → `exit 3`); full suite 52/52.

---

## 4. Priority & sequencing

1. **Ask 1 (flightlog)** — do first. It has real operational value: it directly
   addresses "why was an 11h crash-loop invisible in the journal." Small, additive,
   no API change.
2. **Ask 2 (pulselog)** — nice-to-have consistency; batch it with the next pulselog
   touch. No urgency.

They are independent; either can ship without the other.

## 5. Rollout / adopter impact after release

Both libraries are vendored per-project (`node_modules`), so a release must be pulled
into adopters:

- **flightlog** in use: gitdone `0.3.0`, plato `0.4.0` → bump to the new release.
- **pulselog** in use: gitdone `0.3.0`, plato `0.4.1` → bump to the new release.
- On the VPS, remember the ops-dir caveat: `deploy.sh`'s `npm ci` is **app-only**, so
  a pulselog/flightlog bump under `ops/` (or plato's tree) needs a manual `npm ci` on
  the box after deploy.
- No config changes required in adopters for either ask — both are transparent
  behaviour/label improvements.

## 6. Out of scope (explicitly not asked)

- Changing plato's decision to hard-fail on an unreadable spam blocklist (that's a
  plato design choice; fixed at the perms layer instead).
- Any new pulselog `from`-address validation (the `from` value is adopter policy, not
  library mechanism — kept with the adopter).
- Cross-run alert de-duplication in pulselog (previously declined upstream; belongs in
  the consuming layer).
