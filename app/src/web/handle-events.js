'use strict';

// Hash-on-read event lookup for the management dashboard.
// Replaces magic-session.findEventsByInitiator; instead of comparing
// plaintext emails, derives the handle for each event's initiator and
// compares against the session handle. No event-data migration required.

const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');

// Factory: returns a findEventsByHandle function bound to deriveHandle.
// deriveHandle is auth.deriveHandle (from the knowless instance).
function createEventFinder(deriveHandle) {
  if (typeof deriveHandle !== 'function') {
    throw new Error('createEventFinder: deriveHandle must be a function');
  }

  return async function findEventsByHandle(handle) {
    if (!handle) return [];
    const dir = path.join(config.dataDir, 'events');
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const out = [];
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const full = path.join(dir, name);
      let raw;
      try { raw = await fs.readFile(full, 'utf8'); } catch { continue; }
      let ev;
      try { ev = JSON.parse(raw); } catch { continue; }
      if (!ev || !ev.initiator) continue;
      if (deriveHandle(ev.initiator) !== handle) continue;
      out.push(ev);
    }
    // Most recent first
    out.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    return out;
  };
}

module.exports = { createEventFinder };
