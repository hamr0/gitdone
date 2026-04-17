// Event JSON store. Loads events from disk by ID. Schema follows PRD §4.
// Storage: {dataDir}/events/{eventId}.json
//
// Defensive against path traversal via strict eventId allowlist (alphanumeric
// only — validated again here even though router.js validates upstream).

'use strict';

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

module.exports = { loadEvent, findStep, senderMatchesStep };
