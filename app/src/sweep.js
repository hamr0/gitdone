// Lifecycle sweep — runs hourly from systemd (gitdone-sweep.timer →
// app/bin/sweep.js). Three passes per tick:
//
//   1. Never-activated cleanup.
//      Events created in pending-activation state that never got the
//      activation click get deleted after config.activationTtlHours
//      (default 72h). The activation token is already expired at that
//      point by its own TTL; we just purge the event.json and any
//      stale token records.
//
//   2. Overdue nudge.
//      Active (activated, not complete, not archived) events past their
//      "reference clock" by config.overdueNudgeDays (default 14) get
//      ONE email to the organiser saying "steps still pending, send a
//      reminder / close it / or ignore". Idempotent via
//      event.nudged_overdue_at — we only nudge once.
//
//   3. Auto-archive.
//      Same activity cohort, but past the reference clock by
//      config.archiveDays (default 45), transitions to archived
//      (event.archived_at = now). Stops counting replies, drops off
//      the default dashboard. Organiser can unarchive.
//
// Reference clock = max(deadline over pending steps) if any step has a
// deadline set, else event.activated_at. That way a deadline-less
// event still eventually ages out, counted from when it actually went
// live — not from when the organiser filled the form.
//
// Nothing in this module is destructive to the audit trail: git repos
// and OTS proofs are never touched. Only event.json + bookkeeping
// tokens. "Proofs outlive the service" applies to the evidence, not
// to the dashboard record.

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');
const { loadEvent } = require('./event-store');

const MS_PER_HOUR = 3600 * 1000;
const MS_PER_DAY = 86400 * 1000;

async function listDir(dir) {
  try { return await fs.readdir(dir); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
}

async function atomicWriteEvent(eventId, event) {
  const file = path.join(config.dataDir, 'events', `${eventId}.json`);
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(event, null, 2) + '\n');
  await fs.rename(tmp, file);
}

// The reference clock for overdue/archive decisions. Returns a ms
// timestamp or null if the event has no meaningful clock yet.
function referenceClockMs(event) {
  if (!event || !event.activated_at) return null;
  if (event.type === 'event' && Array.isArray(event.steps)) {
    const pendingDeadlines = event.steps
      .filter((s) => s.status !== 'complete' && s.deadline)
      .map((s) => new Date(s.deadline).getTime())
      .filter((n) => Number.isFinite(n));
    if (pendingDeadlines.length > 0) {
      return Math.max(...pendingDeadlines);
    }
  }
  return new Date(event.activated_at).getTime();
}

function isActive(event) {
  if (!event) return false;
  if (!event.activated_at) return false;
  if (event.archived_at) return false;
  if (event.completion && event.completion.status === 'complete') return false;
  return true;
}

// Pass 1: never-activated cleanup.
async function sweepPendingActivation({ now = Date.now(), ttlHours = config.activationTtlHours, dryRun = false } = {}) {
  const deleted = [];
  const eventsDir = path.join(config.dataDir, 'events');
  for (const file of await listDir(eventsDir)) {
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -5);
    const ev = await loadEvent(id);
    if (!ev) continue;
    if (ev.activated_at) continue;
    const createdMs = new Date(ev.created_at).getTime();
    if (!Number.isFinite(createdMs)) continue;
    const ageHours = (now - createdMs) / MS_PER_HOUR;
    if (ageHours < ttlHours) continue;
    if (!dryRun) {
      try { await fs.unlink(path.join(eventsDir, file)); }
      catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
    deleted.push({ id, created_at: ev.created_at, initiator: ev.initiator });
  }
  return deleted;
}

// Pass 2: overdue nudge. Returns the list of events that crossed the
// threshold this tick. Caller (sweep.js binary) is responsible for
// sending the emails — keeping the side effect outside the core
// makes this testable.
async function findNewlyOverdue({ now = Date.now(), overdueNudgeDays = config.overdueNudgeDays } = {}) {
  const out = [];
  const eventsDir = path.join(config.dataDir, 'events');
  for (const file of await listDir(eventsDir)) {
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -5);
    const ev = await loadEvent(id);
    if (!isActive(ev)) continue;
    if (ev.nudged_overdue_at) continue;
    const clock = referenceClockMs(ev);
    if (clock == null) continue;
    const daysOver = (now - clock) / MS_PER_DAY;
    if (daysOver < overdueNudgeDays) continue;
    out.push({ event: ev, daysOver: Math.floor(daysOver) });
  }
  return out;
}

async function markNudged(eventId, { now = new Date().toISOString() } = {}) {
  const ev = await loadEvent(eventId);
  if (!ev) return null;
  const next = { ...ev, nudged_overdue_at: now };
  await atomicWriteEvent(eventId, next);
  return next;
}

// Pass 3: auto-archive. Returns the events it archived this tick.
// Archiving is a state transition, so it's persisted here (unlike the
// nudge pass which splits persist from side effect).
async function archiveStale({ now = Date.now(), archiveDays = config.archiveDays, dryRun = false } = {}) {
  const archived = [];
  const eventsDir = path.join(config.dataDir, 'events');
  for (const file of await listDir(eventsDir)) {
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -5);
    const ev = await loadEvent(id);
    if (!isActive(ev)) continue;
    const clock = referenceClockMs(ev);
    if (clock == null) continue;
    const daysOver = (now - clock) / MS_PER_DAY;
    if (daysOver < archiveDays) continue;
    const stamp = new Date(now).toISOString();
    const next = { ...ev, archived_at: stamp, archive_reason: 'auto_stale' };
    if (!dryRun) await atomicWriteEvent(id, next);
    archived.push({ id, title: ev.title, initiator: ev.initiator, days_idle: Math.floor(daysOver) });
  }
  return archived;
}

async function unarchive(eventId) {
  const ev = await loadEvent(eventId);
  if (!ev) return null;
  if (!ev.archived_at) return ev;
  const next = { ...ev };
  delete next.archived_at;
  delete next.archive_reason;
  await atomicWriteEvent(eventId, next);
  return next;
}

module.exports = {
  referenceClockMs,
  isActive,
  sweepPendingActivation,
  findNewlyOverdue,
  markNudged,
  archiveStale,
  unarchive,
};
