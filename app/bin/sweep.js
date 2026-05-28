#!/usr/bin/env node
// Hourly lifecycle sweep — wired to systemd via gitdone-sweep.timer.
// Orchestrates three passes from src/sweep.js:
//
//   1. Delete never-activated events older than activationTtlHours.
//   2. Email a one-shot "steps still pending" nudge to organisers
//      whose events crossed overdueNudgeDays past the reference clock.
//      The write to event.nudged_overdue_at happens BEFORE the send so
//      a crash-mid-send doesn't result in a repeat nudge next tick —
//      we prefer "one email never sent" over "N emails sent".
//   3. Auto-archive events past archiveDays. Emails the organiser a
//      heads-up that it was archived with a reversal link.
//
// Logs one JSON summary line to stdout per invocation. systemd pipes
// it into the journal alongside all other gitdone service logs.
//
// Usage: node app/bin/sweep.js [--dry-run]
//   --dry-run prints what would happen without persisting or sending.

'use strict';

const {
  sweepPendingActivation,
  findPendingActivationNudge,
  markPendingActivationNudged,
  findNewlyOverdue,
  markNudged,
  archiveStale,
} = require('../src/sweep');
const config = require('../src/config');
const { buildRawMessage, sendmail } = require('../src/outbound');

const dryRun = process.argv.includes('--dry-run');

// Sweep notice bodies/subjects live in the email-bodies catalogue
// (bodies.sweep.{pendingActivation,overdue,archived}). This file owns
// the scheduling/eligibility logic and the send; the catalogue owns text.
const { sweep: sweepBodies } = require('../src/email-bodies');

async function sendMail({ to, subject, body, eventId }) {
  const from = `gitdone@${config.domain}`;
  const raw = buildRawMessage({
    from,
    to,
    subject,
    body,
    autoSubmitted: 'auto-generated',
    domain: config.domain,
    extraHeaders: eventId ? { 'X-GitDone-Event': eventId } : {},
  });
  return sendmail({ from, rawMessage: raw, to: [to] });
}

async function main() {
  const t0 = Date.now();
  const report = { kind: 'sweep_tick', dry_run: dryRun, timestamp: new Date().toISOString() };

  // 1a. Pending-activation reminder (24h before deletion). Runs BEFORE
  // the cleanup pass so events still exist when we send the nudge —
  // otherwise sweepPendingActivation would delete a stale event between
  // its 71h-old reminder and the 72h check.
  const pendingNudges = await findPendingActivationNudge();
  const pendingNudgeResults = [];
  for (const { event, hoursLeft } of pendingNudges) {
    if (!event.initiator) continue;
    if (!dryRun) await markPendingActivationNudged(event.id);
    const res = dryRun
      ? { ok: true, dry_run: true }
      : await sendMail({
          to: event.initiator,
          ...sweepBodies.pendingActivation(event, { hoursLeft }),
          eventId: event.id,
        });
    pendingNudgeResults.push({ id: event.id, to: event.initiator, hours_left: hoursLeft, ok: res.ok });
  }
  report.pending_activation_nudges = pendingNudgeResults;

  // 1b. Pending-activation cleanup (delete events past TTL).
  const deleted = await sweepPendingActivation({ dryRun });
  report.pending_activation_deleted = deleted.length;
  if (deleted.length) report.pending_activation_ids = deleted.map((d) => d.id);

  // 2. Overdue nudge.
  const overdueCandidates = await findNewlyOverdue();
  const nudgeResults = [];
  for (const { event, daysOver } of overdueCandidates) {
    if (!event.initiator) continue;
    if (!dryRun) await markNudged(event.id);
    const res = dryRun
      ? { ok: true, dry_run: true }
      : await sendMail({
          to: event.initiator,
          ...sweepBodies.overdue(event, { daysOver }),
          eventId: event.id,
        });
    nudgeResults.push({ id: event.id, to: event.initiator, days_over: daysOver, ok: res.ok });
  }
  report.overdue_nudges = nudgeResults;

  // 3. Auto-archive.
  const archived = await archiveStale({ dryRun });
  const archiveNotifyResults = [];
  for (const { id, title, initiator, days_idle } of archived) {
    if (!initiator) continue;
    const res = dryRun
      ? { ok: true, dry_run: true }
      : await sendMail({
          to: initiator,
          ...sweepBodies.archived({ id, title }, { daysIdle: days_idle }),
          eventId: id,
        });
    archiveNotifyResults.push({ id, to: initiator, days_idle, ok: res.ok });
  }
  report.archived = archiveNotifyResults;

  report.duration_ms = Date.now() - t0;
  process.stdout.write(JSON.stringify(report) + '\n');
}

main().catch((err) => {
  process.stderr.write(`sweep: ${err && err.stack || err}\n`);
  process.exit(1);
});
