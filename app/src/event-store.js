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
    ...partialEvent,
    id, // ensure generated id overrides any caller-supplied id field
  };

  // Atomic write: temp file in same dir, then rename
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(event, null, 2) + '\n');
  await fs.rename(tmp, file);

  return event;
}

module.exports = {
  loadEvent,
  findStep,
  senderMatchesStep,
  createEvent,
  generateEventId,
  generateEventSalt,
};
