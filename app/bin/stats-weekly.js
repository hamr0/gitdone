#!/usr/bin/env node
// Weekly stats digest, emailed to GITDONE_STATS_RECIPIENT (default
// avoidaccess@gmail.com — automated alerts always go to the gmail
// identity, never to the msn organiser address).
//
// Reads the daily snapshot log ($GITDONE_STATS_LOG), groups entries
// by ISO week (Mon–Sun), takes the most-recent snapshot in each
// week, and renders a 4-week table with week-over-week deltas.
//
// Wired to systemd via gitdone-stats-weekly.timer — fires Mondays
// at 06:00 UTC, after the Monday 04:30 daily snapshot, so the
// current ISO week has at least one data point.
//
// Usage:
//   node app/bin/stats-weekly.js              send the email
//   node app/bin/stats-weekly.js --dry-run    print to stdout, don't send

'use strict';

const fs = require('node:fs');
const config = require('../src/config');
const { buildRawMessage, sendmail } = require('../src/outbound');

const LOG = process.env.GITDONE_STATS_LOG || '/var/log/gitdone/stats.log';
const TO = process.env.GITDONE_STATS_RECIPIENT || 'avoidaccess@gmail.com';
const WEEKS = 4;
const dryRun = process.argv.includes('--dry-run');

// ISO week-year + week-number helper. Returns "2026-W18" so two
// snapshots in the same Mon–Sun bucket collapse to the same key.
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function readLog(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  return raw.split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// Pick one snapshot per ISO week — the latest one. Returns the most
// recent N weeks in chronological order, oldest first.
function weeklyBuckets(snapshots, n) {
  const byWeek = new Map();
  for (const s of snapshots) {
    if (!s.snapshot_at) continue;
    const k = isoWeek(new Date(s.snapshot_at));
    const prev = byWeek.get(k);
    if (!prev || s.snapshot_at > prev.snapshot_at) byWeek.set(k, s);
  }
  const ordered = [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return ordered.slice(-n).map(([week, snap]) => ({ week, snap }));
}

function fmtDelta(prev, cur) {
  if (typeof prev !== 'number' || typeof cur !== 'number') return '';
  const d = cur - prev;
  if (d === 0) return '';
  return d > 0 ? ` (+${d})` : ` (${d})`;
}

function renderBody(weeks) {
  if (weeks.length === 0) {
    return [
      `gitdone weekly stats — no data yet`,
      ``,
      `The daily snapshot log at ${LOG} is empty or missing.`,
      `The first daily snapshot fires at 04:30 UTC each day; once`,
      `that's run a few times this digest will start showing trends.`,
    ].join('\n');
  }
  const lines = [];
  lines.push(`gitdone — last ${weeks.length} week${weeks.length === 1 ? '' : 's'}`);
  lines.push(``);
  lines.push(`Snapshot per week (latest day in that week, ISO Mon–Sun).`);
  lines.push(`Δ shown vs. the prior week's snapshot.`);
  lines.push(``);
  // Column header
  lines.push('  ' + 'week        '.padEnd(14) + 'orgs'.padEnd(14) + 'rcpts'.padEnd(14) + 'events'.padEnd(14) + 'completed'.padEnd(14) + 'pending'.padEnd(14));
  lines.push('  ' + '─'.repeat(80));
  let prev = null;
  for (const { week, snap } of weeks) {
    const orgs = `${snap.unique_organisers}${prev ? fmtDelta(prev.unique_organisers, snap.unique_organisers) : ''}`;
    const rcpts = `${snap.unique_recipients_named}${prev ? fmtDelta(prev.unique_recipients_named, snap.unique_recipients_named) : ''}`;
    const ev = `${snap.events_total}${prev ? fmtDelta(prev.events_total, snap.events_total) : ''}`;
    const done = `${snap.by_status.completed}${prev ? fmtDelta(prev.by_status.completed, snap.by_status.completed) : ''}`;
    const pend = `${snap.by_status.pending_activation}${prev ? fmtDelta(prev.by_status.pending_activation, snap.by_status.pending_activation) : ''}`;
    lines.push('  ' + week.padEnd(14) + orgs.padEnd(14) + rcpts.padEnd(14) + ev.padEnd(14) + done.padEnd(14) + pend.padEnd(14));
    prev = snap;
  }
  const latest = weeks[weeks.length - 1].snap;
  lines.push(``);
  lines.push(`Latest absolute breakdown (${latest.snapshot_at}):`);
  lines.push(`  workflow / declaration / attestation = ${latest.by_type.event} / ${latest.by_type.declaration} / ${latest.by_type.attestation}`);
  lines.push(`  pending / open / completed / closed early / archived = ${latest.by_status.pending_activation} / ${latest.by_status.open} / ${latest.by_status.completed} / ${latest.by_status.closed_early} / ${latest.by_status.archived}`);
  lines.push(`  workflow steps complete: ${latest.workflow_step_completed_total} of ${latest.workflow_step_count_total}`);
  if (latest.attestation_replies_total) {
    lines.push(`  attestation replies total: ${latest.attestation_replies_total}`);
  }
  lines.push(``);
  lines.push(`Source: ${LOG}`);
  return lines.join('\n');
}

(async () => {
  const snapshots = readLog(LOG);
  const weeks = weeklyBuckets(snapshots, WEEKS);
  const body = renderBody(weeks);
  if (dryRun) {
    process.stdout.write(body + '\n');
    return;
  }
  const from = `gitdone@${config.domain}`;
  const subject = `[gitdone] weekly stats — ${weeks.length ? weeks[weeks.length - 1].week : 'no data'}`;
  const raw = buildRawMessage({
    from, to: TO, subject, body,
    autoSubmitted: 'auto-generated',
    domain: config.domain,
    extraHeaders: { 'X-GitDone-Report': 'weekly-stats' },
  });
  const res = await sendmail({ from, rawMessage: raw, to: [TO] });
  const out = { kind: 'stats_weekly_sent', to: TO, ok: res.ok, code: res.code || null, reason: res.reason || null, weeks: weeks.length };
  process.stdout.write(JSON.stringify(out) + '\n');
  if (!res.ok) process.exit(1);
})().catch((err) => {
  process.stderr.write(`stats-weekly: ${err && err.stack || err}\n`);
  process.exit(1);
});
