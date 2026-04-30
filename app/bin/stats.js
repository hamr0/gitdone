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
//
// On the VPS:
//   ssh gitdone-vps 'cd /opt/gitdone/app && node bin/stats.js'

'use strict';

const { collect } = require('../src/stats');

const jsonOnly = process.argv.includes('--json') || process.argv.includes('--quiet');

function formatHuman(s) {
  const lines = [];
  lines.push(`gitdone stats — ${s.snapshot_at}`);
  lines.push(``);
  lines.push(`  unique organisers           ${s.unique_organisers}`);
  lines.push(`  unique recipients (named)   ${s.unique_recipients_named}`);
  lines.push(``);
  lines.push(`  events total                ${s.events_total}`);
  lines.push(`    by type:`);
  lines.push(`      workflow                ${s.by_type.event}`);
  lines.push(`      declaration             ${s.by_type.declaration}`);
  lines.push(`      attestation             ${s.by_type.attestation}`);
  lines.push(`    by status:`);
  lines.push(`      pending activation      ${s.by_status.pending_activation}`);
  lines.push(`      open                    ${s.by_status.open}`);
  lines.push(`      completed               ${s.by_status.completed}`);
  lines.push(`      closed early            ${s.by_status.closed_early}`);
  lines.push(`      archived                ${s.by_status.archived}`);
  lines.push(``);
  lines.push(`  completed vs incomplete     ${s.completed_vs_incomplete.completed} / ${s.completed_vs_incomplete.incomplete}`);
  lines.push(``);
  lines.push(`  workflow step totals        ${s.workflow_step_completed_total} of ${s.workflow_step_count_total} complete`);
  lines.push(`  attestation replies total   ${s.attestation_replies_total}`);
  if (s.parse_errors) lines.push(`  parse errors                ${s.parse_errors}`);
  return lines.join('\n');
}

(async () => {
  const s = await collect();
  if (!jsonOnly) process.stderr.write(formatHuman(s) + '\n');
  process.stdout.write(JSON.stringify(s) + '\n');
})().catch((err) => {
  process.stderr.write(`stats: ${err && err.stack || err}\n`);
  process.exit(1);
});
