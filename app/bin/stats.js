#!/usr/bin/env node
// CLI: print a one-shot aggregate of every events/*.json under
// $GITDONE_DATA_DIR. JSON to stdout for machine consumption (a future
// dashboard / cron / Kuma probe can parse it); the human-readable
// table goes to stderr so piping `| jq` still works.
//
// Usage:
//   node app/bin/stats.js              human + json
//   node app/bin/stats.js --json       json only (no human output)
//   node app/bin/stats.js --quiet      json only (alias for --json)
//   node app/bin/stats.js --diff       human output with a "Δ since
//                                      <last-snapshot-date>" column;
//                                      reads the most recent line of
//                                      $GITDONE_STATS_LOG (default
//                                      /var/log/gitdone/stats.log).
//
// On the VPS:
//   ssh gitdone-vps 'cd /opt/gitdone/app && node bin/stats.js --diff'

'use strict';

const fs = require('node:fs');
const { collect } = require('../src/stats');

const jsonOnly = process.argv.includes('--json') || process.argv.includes('--quiet');
const wantDiff = process.argv.includes('--diff');
const STATS_LOG = process.env.GITDONE_STATS_LOG || '/var/log/gitdone/stats.log';

// Read the most recent JSON line from the stats log. Returns null if
// the file is missing, empty, or its last line is unparseable.
function readLastSnapshot(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  try { return JSON.parse(lines[lines.length - 1]); }
  catch { return null; }
}

// "+3" / "-1" / "" for a numeric delta. Empty string for zero so the
// human output stays uncluttered when nothing changed.
function fmtDelta(prev, cur) {
  if (typeof prev !== 'number' || typeof cur !== 'number') return '';
  const d = cur - prev;
  if (d === 0) return '';
  return d > 0 ? `  (+${d})` : `  (${d})`;
}

function formatHuman(s, prev) {
  const lines = [];
  const head = prev
    ? `gitdone stats — ${s.snapshot_at} (Δ since ${prev.snapshot_at.slice(0, 10)})`
    : `gitdone stats — ${s.snapshot_at}`;
  lines.push(head);
  lines.push(``);
  const row = (label, key, sub) => {
    const cur = sub ? s[key] && s[key][sub] : s[key];
    const old = sub
      ? (prev && prev[key] ? prev[key][sub] : undefined)
      : (prev ? prev[key] : undefined);
    lines.push(`  ${label.padEnd(28)}${cur}${prev ? fmtDelta(old, cur) : ''}`);
  };
  row('unique organisers', 'unique_organisers');
  row('unique recipients (named)', 'unique_recipients_named');
  lines.push(``);
  row('events total', 'events_total');
  lines.push(`    by type:`);
  row('  workflow', 'by_type', 'event');
  row('  declaration', 'by_type', 'declaration');
  row('  attestation', 'by_type', 'attestation');
  lines.push(`    by status:`);
  row('  pending activation', 'by_status', 'pending_activation');
  row('  open', 'by_status', 'open');
  row('  completed', 'by_status', 'completed');
  row('  closed early', 'by_status', 'closed_early');
  row('  archived', 'by_status', 'archived');
  lines.push(``);
  const cv = s.completed_vs_incomplete;
  const pcv = prev && prev.completed_vs_incomplete;
  const cvDelta = pcv
    ? `${fmtDelta(pcv.completed, cv.completed).replace('  ', '')} / ${fmtDelta(pcv.incomplete, cv.incomplete).replace('  ', '')}`
    : '';
  lines.push(`  ${'completed vs incomplete'.padEnd(28)}${cv.completed} / ${cv.incomplete}${cvDelta && cvDelta !== ' / ' ? '  (' + cvDelta + ')' : ''}`);
  lines.push(``);
  const stepLabel = `${s.workflow_step_completed_total} of ${s.workflow_step_count_total} complete`;
  lines.push(`  ${'workflow step totals'.padEnd(28)}${stepLabel}`);
  row('attestation replies total', 'attestation_replies_total');
  if (s.parse_errors) lines.push(`  ${'parse errors'.padEnd(28)}${s.parse_errors}`);
  return lines.join('\n');
}

(async () => {
  const s = await collect();
  const prev = wantDiff ? readLastSnapshot(STATS_LOG) : null;
  if (!jsonOnly) process.stderr.write(formatHuman(s, prev) + '\n');
  process.stdout.write(JSON.stringify(s) + '\n');
})().catch((err) => {
  process.stderr.write(`stats: ${err && err.stack || err}\n`);
  process.exit(1);
});
