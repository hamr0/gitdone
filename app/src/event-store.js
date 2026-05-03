// Event JSON store. Loads events from disk by ID. Schema follows PRD §4.
// Storage: {dataDir}/events/{eventId}.json
//
// Defensive against path traversal via strict eventId allowlist (alphanumeric
// only — validated again here even though router.js validates upstream).

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');

const EVENT_ID_RE = /^[a-zA-Z0-9]+$/;

async function loadEvent(eventId) {
  if (!eventId || !EVENT_ID_RE.test(eventId)) return null;
  const file = path.join(config.dataDir, 'events', `${eventId}.json`);
  try {
    const data = await fs.readFile(file, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function findStep(event, stepId) {
  if (!event || !Array.isArray(event.steps) || !stepId) return null;
  return event.steps.find((s) => s && s.id === stepId) || null;
}

function normaliseEmail(addr) {
  return (addr || '').trim().toLowerCase();
}

function senderMatchesStep(senderAddr, step) {
  if (!step || !step.participant) return false;
  return normaliseEmail(senderAddr) === normaliseEmail(step.participant);
}

// Generate a short, url-safe, alphanumeric event ID. 10 chars of base36 ≈
// 52 bits of entropy — plenty for uniqueness across v2's expected volume,
// and it reads well in URLs and email plus-tags.
function generateEventId() {
  // 8 random bytes → base36 → trim to 12 chars for consistent length
  const n = BigInt('0x' + crypto.randomBytes(8).toString('hex'));
  return n.toString(36).padStart(12, '0').slice(0, 12);
}

// Generate an event's public salt (per-event 32 bytes hex) used to salt
// the sender_hash and message_id_hash in commit metadata per §0.1.10.
function generateEventSalt() {
  return crypto.randomBytes(32).toString('hex');
}

// Persist a new event JSON to {dataDir}/events/{id}.json.
// Caller supplies the validated event shape; this function adds
// {id, created_at, salt} and writes atomically (temp + rename).
async function createEvent(partialEvent) {
  if (!partialEvent || typeof partialEvent !== 'object') {
    throw new Error('createEvent: event object required');
  }
  let id = partialEvent.id;
  if (!id) id = generateEventId();
  if (!EVENT_ID_RE.test(id)) {
    throw new Error(`createEvent: invalid id '${id}' (must be alphanumeric)`);
  }

  const eventsDir = path.join(config.dataDir, 'events');
  await fs.mkdir(eventsDir, { recursive: true });
  const file = path.join(eventsDir, `${id}.json`);

  // Refuse to overwrite — id collision is a real bug, not a silent update
  try {
    await fs.stat(file);
    throw new Error(`createEvent: event ${id} already exists`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const event = {
    id,
    created_at: new Date().toISOString(),
    salt: partialEvent.salt || generateEventSalt(),
    // Events are created in a pending-activation state. The initiator
    // must click the 72h activation magic link before participants are
    // notified and replies start counting. Closes the impersonation
    // hole where anyone could create an event in someone else's name.
    activated_at: null,
    ...partialEvent,
    id, // ensure generated id overrides any caller-supplied id field
  };

  // Atomic write: temp file in same dir, then rename
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(event, null, 2) + '\n');
  await fs.rename(tmp, file);

  return event;
}

// Mark an event activated. Idempotent: re-activating an already-active
// event is a no-op that returns the existing event unchanged. The
// `alreadyActive` flag in the result lets callers gate one-shot side
// effects (e.g. participant notifications) on the first transition only.
//
// Concurrency: a per-event in-process mutex serialises read-modify-write
// against itself so two concurrent activations can't both observe
// !activated_at and both return alreadyActive=false. gitdone-web is a
// single Node process today (`gitdone-web.service`); if it ever sharded
// across workers, this guard would need to move to filesystem-level
// (O_EXCL on a sentinel) — but the in-process serialisation is correct
// for the current deployment shape.
// Per-event write mutex. Both activateEvent and editEvent serialize
// through this map so an edit can't race with a first-visit activation
// (and vice versa). Each entry is a Promise of the in-flight write.
// Callers always reload from disk after the mutex unlocks; the in-flight
// Promise's result shape is op-specific and not relied on here.
const _writeMutex = new Map();
async function _serialize(eventId, work) {
  const prev = _writeMutex.get(eventId);
  const p = (async () => {
    if (prev) { try { await prev; } catch { /* ignore prior failure */ } }
    return work();
  })();
  _writeMutex.set(eventId, p);
  try { return await p; }
  finally {
    // Only clear if we're still the latest entry — a follow-up call may
    // have already chained itself behind us.
    if (_writeMutex.get(eventId) === p) _writeMutex.delete(eventId);
  }
}

async function activateEvent(eventId, { now = new Date().toISOString() } = {}) {
  return _serialize(eventId, async () => {
    const event = await loadEvent(eventId);
    if (!event) throw new Error(`activateEvent: event ${eventId} not found`);
    if (event.activated_at) return { event, alreadyActive: true };
    const next = { ...event, activated_at: now };
    const file = path.join(config.dataDir, 'events', `${eventId}.json`);
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(next, null, 2) + '\n');
    await fs.rename(tmp, file);
    return { event: next, alreadyActive: false };
  });
}

const ALLOWED_STEP_FIELDS = ['participant', 'deadline', 'requires_attachment', 'details'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Apply a partial patch to an event, returning { next, changes }. Patch
// shape:
//   { title?: string, steps?: [{ id, participant?, deadline?,
//     requires_attachment?, details? }, ...] }
//
// Validation:
//   - Only steps with status !== 'complete' are editable. Editing a
//     completed step throws EVENT_STEP_FROZEN — the audit-trail commit
//     for a completed step records what its participant was at the time
//     they replied; rewriting it post-hoc would lie.
//   - Step ids in the patch must exist on the event.
//   - participant: must be a valid email shape (basic).
//   - deadline: 'YYYY-MM-DD' or empty string (clears the deadline).
//   - requires_attachment: coerced to boolean.
//   - details: string (no length cap here; the form already caps).
//   - title: any non-empty string.
//
// Returns the new event object and an array of `change` records:
//   [{ step_id, field, from, to }, ...]
// step_id is null for event-level changes (title).
function _applyEditPatch(event, patch) {
  if (!patch || typeof patch !== 'object') {
    throw Object.assign(new Error('editEvent: patch object required'), { code: 'BAD_PATCH' });
  }
  const changes = [];
  const next = { ...event, steps: Array.isArray(event.steps) ? event.steps.map((s) => ({ ...s })) : event.steps };

  if (Object.prototype.hasOwnProperty.call(patch, 'title')) {
    const newTitle = String(patch.title || '').trim();
    if (!newTitle) {
      throw Object.assign(new Error('editEvent: title cannot be empty'), { code: 'BAD_TITLE' });
    }
    if (newTitle !== event.title) {
      changes.push({ step_id: null, field: 'title', from: event.title, to: newTitle });
      next.title = newTitle;
    }
  }

  if (Array.isArray(patch.steps)) {
    for (const sp of patch.steps) {
      if (!sp || !sp.id) continue;
      const idx = next.steps.findIndex((s) => s.id === sp.id);
      if (idx < 0) {
        throw Object.assign(new Error(`editEvent: step ${sp.id} not found`), { code: 'STEP_NOT_FOUND' });
      }
      const cur = next.steps[idx];
      if (cur.status === 'complete') {
        throw Object.assign(new Error(`editEvent: step ${sp.id} is complete and cannot be edited`), { code: 'EVENT_STEP_FROZEN' });
      }
      const merged = { ...cur };
      for (const f of ALLOWED_STEP_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(sp, f)) continue;
        let value = sp[f];
        if (f === 'participant') {
          value = String(value || '').trim();
          if (!EMAIL_RE.test(value)) {
            throw Object.assign(new Error(`editEvent: invalid email for step ${sp.id}`), { code: 'BAD_EMAIL' });
          }
        } else if (f === 'deadline') {
          value = value == null ? '' : String(value).trim();
          if (value && !DATE_RE.test(value)) {
            throw Object.assign(new Error(`editEvent: deadline must be YYYY-MM-DD on step ${sp.id}`), { code: 'BAD_DEADLINE' });
          }
          // Normalise empty to undefined to keep the JSON terse.
          if (!value) value = undefined;
        } else if (f === 'requires_attachment') {
          value = !!value;
        } else if (f === 'details') {
          value = value == null ? '' : String(value);
          if (!value) value = undefined;
        }
        const before = cur[f];
        if (before !== value) {
          changes.push({ step_id: sp.id, field: f, from: before == null ? null : before, to: value == null ? null : value });
          if (value === undefined) delete merged[f];
          else merged[f] = value;
        }
      }
      next.steps[idx] = merged;
    }
  }

  return { next, changes };
}

// Patch an event in place. For activated events, also writes an audit
// commit to the per-event git repo so the change is tamper-evident in
// the same way replies are. For pending events (no repo yet), the edit
// is a plain event.json mutation — there's no history to amend.
//
// Throws on:
//   - finalised events (completed or archived)
//   - patches that touch a completed step (EVENT_STEP_FROZEN)
//   - invalid field values (BAD_EMAIL, BAD_DEADLINE, BAD_TITLE)
//
// Returns { event, prev, changes, commitSequence }. commitSequence is
// the audit-trail commit number (null for pending-event edits).
async function editEvent(eventId, patch, { now = new Date().toISOString(), organiserHandle = null } = {}) {
  return _serialize(eventId, async () => {
    const event = await loadEvent(eventId);
    if (!event) throw Object.assign(new Error(`editEvent: ${eventId} not found`), { code: 'NOT_FOUND' });
    if (event.completion && event.completion.status === 'complete') {
      throw Object.assign(new Error('editEvent: event is complete'), { code: 'EVENT_COMPLETE' });
    }
    if (event.archived_at) {
      throw Object.assign(new Error('editEvent: event is archived'), { code: 'EVENT_ARCHIVED' });
    }
    const { next, changes } = _applyEditPatch(event, patch);
    if (changes.length === 0) {
      return { event, prev: event, changes: [], commitSequence: null };
    }
    const file = path.join(config.dataDir, 'events', `${eventId}.json`);
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(next, null, 2) + '\n');
    await fs.rename(tmp, file);

    let commitSequence = null;
    if (event.activated_at) {
      const { appendEditCommit } = require('./gitrepo');
      const result = await appendEditCommit(eventId, {
        edited_at: now,
        organiser_handle: organiserHandle,
        changes,
      }, next);
      commitSequence = result.sequence;
    }

    return { event: next, prev: event, changes, commitSequence };
  });
}

module.exports = {
  loadEvent,
  findStep,
  senderMatchesStep,
  createEvent,
  activateEvent,
  editEvent,
  generateEventId,
  generateEventSalt,
};
