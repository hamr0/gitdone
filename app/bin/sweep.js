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
  findNewlyOverdue,
  markNudged,
  archiveStale,
} = require('../src/sweep');
const config = require('../src/config');
const { buildRawMessage, sendmail } = require('../src/outbound');

const dryRun = process.argv.includes('--dry-run');

function publicBaseUrl() {
  return process.env.GITDONE_PUBLIC_URL || `https://${config.domain}`;
}

function overdueBody({ event, daysOver }) {
  const pending = (event.steps || [])
    .filter((s) => s.status !== 'complete')
    .map((s) => `  - ${s.name} (${s.participant})`)
    .join('\n') || '  (crypto event — no per-step breakdown)';
  return [
    `Heads up — your gitdone event "${event.title}" has been open for`,
    `${daysOver} days past its reference deadline with work still pending.`,
    ``,
    `Still waiting on:`,
    pending,
    ``,
    `No action is required from gitdone — this is a one-time nudge. Options:`,
    `  - Send a reminder:  remind+${event.id}@${config.domain}`,
    `  - Close it early:   close+${event.id}@${config.domain}`,
    `  - Do nothing:       the event stays open; if it's still idle at`,
    `                      ${config.archiveDays} days past the deadline it will be`,
    `                      auto-archived (reversible; no data is lost).`,
    ``,
    `Manage: ${publicBaseUrl()}/manage`,
    `Event ID: ${event.id}`,
  ].join('\n');
}

function archivedBody({ event, daysIdle }) {
  return [
    `Your gitdone event "${event.title}" has been auto-archived after`,
    `${daysIdle} days of inactivity past its reference deadline.`,
    ``,
    `What this means:`,
    `  - The event is hidden from your active dashboard.`,
    `  - New replies to its reply addresses still commit to the audit trail`,
    `    but no longer count toward completion.`,
    `  - Nothing has been deleted. The git repo + proofs remain intact.`,
    ``,
    `Reactivate anytime from ${publicBaseUrl()}/manage — click the event,`,
    `then "Un-archive". Any replies that arrived while it was archived`,
    `can be resent.`,
    ``,
    `Event ID: ${event.id}`,
  ].join('\n');
}

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

  // 1. Pending-activation cleanup.
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
          subject: `[gitdone] "${event.title}" — overdue, ${daysOver} days past deadline`,
          body: overdueBody({ event, daysOver }),
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
          subject: `[gitdone] "${title}" — auto-archived`,
          body: archivedBody({ event: { id, title }, daysIdle: days_idle }),
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
