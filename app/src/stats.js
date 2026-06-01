// Aggregate counters over the events directory. Computed on-demand —
// at Phase-1 volume this is a fraction-of-a-second walk and avoids a
// separate persistence layer that could drift from truth. Reads only;
// no side effects; safe to run alongside any other process.
//
// All counts are privacy-safe aggregates. No PII is returned. The
// "unique organisers" / "unique recipients" tallies use lowercase-
// normalised email strings as set keys but report only the cardinality.

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');
const { isClosedByInitiator } = require('./completion');

function lower(s) {
  return (s == null ? '' : String(s)).trim().toLowerCase();
}

function statusOf(ev) {
  const terminal = ev.completion && ev.completion.status === 'complete';
  if (terminal && isClosedByInitiator(ev)) return 'closed_early';
  if (terminal) return 'completed';
  if (ev.archived_at) return 'archived';
  if (!ev.activated_at) return 'pending_activation';
  return 'open';
}

async function listEventFiles() {
  const dir = path.join(config.dataDir, 'events');
  try { return (await fs.readdir(dir)).filter((f) => f.endsWith('.json')); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
}

// Walk every events/*.json and return a single aggregate snapshot.
// Throws if the data dir is unreadable; per-file parse errors are
// counted separately so a corrupt record doesn't poison the report.
async function collect() {
  const files = await listEventFiles();
  const counts = {
    events_total: 0,
    by_type: { event: 0, declaration: 0, attestation: 0 },
    by_status: { pending_activation: 0, open: 0, completed: 0, closed_early: 0, archived: 0 },
    completed_vs_incomplete: { completed: 0, incomplete: 0 }, // incomplete = anything not in {completed}
    workflow_step_count_total: 0,
    workflow_step_completed_total: 0,
    attestation_replies_total: 0,
    parse_errors: 0,
  };
  const organisers = new Set();
  const recipients = new Set();

  for (const f of files) {
    let ev;
    try { ev = JSON.parse(await fs.readFile(path.join(config.dataDir, 'events', f), 'utf8')); }
    catch { counts.parse_errors++; continue; }
    if (!ev || typeof ev !== 'object') { counts.parse_errors++; continue; }

    counts.events_total++;
    if (ev.initiator) organisers.add(lower(ev.initiator));

    const status = statusOf(ev);
    if (counts.by_status[status] != null) counts.by_status[status]++;
    if (status === 'completed') counts.completed_vs_incomplete.completed++;
    else counts.completed_vs_incomplete.incomplete++;

    if (ev.type === 'event') {
      counts.by_type.event++;
      const steps = Array.isArray(ev.steps) ? ev.steps : [];
      counts.workflow_step_count_total += steps.length;
      for (const s of steps) {
        if (s && s.participant) recipients.add(lower(s.participant));
        if (s && s.status === 'complete') counts.workflow_step_completed_total++;
      }
    } else if (ev.type === 'crypto' && ev.mode === 'declaration') {
      counts.by_type.declaration++;
      if (ev.signer) recipients.add(lower(ev.signer));
    } else if (ev.type === 'crypto' && ev.mode === 'attestation') {
      counts.by_type.attestation++;
      counts.attestation_replies_total += Array.isArray(ev.replies) ? ev.replies.length : 0;
      // Attestation participants are anonymous-by-design (sender_hash
      // only); we deliberately do NOT add them to the recipients set.
    }
  }

  return {
    snapshot_at: new Date().toISOString(),
    unique_organisers: organisers.size,
    unique_recipients_named: recipients.size, // workflow participants + declaration signers
    ...counts,
  };
}

// Flatten a collect() snapshot to a single-level object of named whole-number
// integers — the shape pulselog's digest `metricsCommand` consumes (one command
// → one JSON object, values picked by name). Kept here (not in bin/) so it's
// unit-testable, and so the metric key names live next to the snapshot they
// derive from. The digest config declares which of these keys to trend.
function flatMetrics(s) {
  const int = (x) => (Number.isFinite(x) ? Math.trunc(x) : 0);
  const bt = s.by_type || {};
  const bs = s.by_status || {};
  return {
    orgs: int(s.unique_organisers),
    rcpts: int(s.unique_recipients_named),
    events: int(s.events_total),
    type_workflow: int(bt.event),
    type_declaration: int(bt.declaration),
    type_attestation: int(bt.attestation),
    pending: int(bs.pending_activation),
    open: int(bs.open),
    completed: int(bs.completed),
    closed_early: int(bs.closed_early),
    archived: int(bs.archived),
    steps_done: int(s.workflow_step_completed_total),
    steps_total: int(s.workflow_step_count_total),
    attest_replies: int(s.attestation_replies_total),
  };
}

module.exports = { collect, statusOf, flatMetrics };
