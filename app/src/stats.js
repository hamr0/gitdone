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

function lower(s) {
  return (s == null ? '' : String(s)).trim().toLowerCase();
}

function statusOf(ev) {
  const terminal = ev.completion && ev.completion.status === 'complete';
  const allStepsDone = ev.type === 'event' && Array.isArray(ev.steps) && ev.steps.length > 0
    && ev.steps.every((s) => s.status === 'complete');
  if (terminal && (ev.type !== 'event' || allStepsDone)) return 'completed';
  if (terminal && ev.type === 'event' && !allStepsDone) return 'closed_early';
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

module.exports = { collect, statusOf };
