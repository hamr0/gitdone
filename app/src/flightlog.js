'use strict';

// Adopter glue for flightlog — the error flight-recorder. flightlog provides
// the mechanism (global net + capture/captureSync + the JSONL sink); this
// module just chooses the *policy*: where the sink lives and what static
// context every record carries. Per flightlog's contract we log only what we
// pass here — it never auto-harvests, so nothing sensitive leaks unless we put
// it in `context`/`extra`.
//
// flightlog is ESM-only; gitdone is CommonJS. require('flightlog') works
// because both dev and prod run Node >=22.12 (stable require(esm)). gitdone's
// engines floor is bumped to match (see package.json) so a Node downgrade
// fails loudly at install, not at runtime.

const path = require('node:path');
const config = require('./config');

// gitdone's version lives in the repo-root package.json (not app/). Best-effort:
// a missing/unreadable manifest must not stop a process from booting.
let release = 'unknown';
try { release = require('../../package.json').version || 'unknown'; } catch { /* keep 'unknown' */ }

// Sink path: a logs/ dir under the data dir (install() mkdir -p's the parent and
// probes a write at boot, so a bad path fails loudly here). Overridable for ops.
function sinkFile() {
  return process.env.GITDONE_FLIGHTLOG_FILE || path.join(config.dataDir, 'logs', 'errors.jsonl');
}

// Register the global error net and return { capture, captureSync }.
//   - exitOnUncaught: true everywhere (a corrupt event loop should restart clean).
//   - exitOnRejection: true for short-lived processes (receive/ots) so a stray
//     rejection is logged synchronously and exits non-zero — a silent exit-0
//     would be misread as success (Postfix would think a failed message was
//     delivered). false for the long-lived server (a stray rejection must not
//     down it).
function init({ proc, exitOnUncaught = true, exitOnRejection = false } = {}) {
  const { install } = require('flightlog');
  return install({
    file: sinkFile(),
    context: { app: 'gitdone', release, proc },
    exitOnUncaught,
    exitOnRejection,
  });
}

module.exports = { init, sinkFile };
