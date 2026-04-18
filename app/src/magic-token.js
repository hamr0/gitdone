// 1.H.4 — Opaque magic-link tokens for initiator management URLs.
//
// Storage: one file per token at {dataDir}/magic_tokens/{token}.json.
// File-per-token avoids read-modify-write races and matches the shape
// of {dataDir}/events/{id}.json. Lookup is O(1) via the filename.
//
// Token format: 32 hex chars (16 random bytes). 128 bits of entropy —
// unguessable, short enough for a clean URL.
//
// Revocation / one-time use: not implemented. The URL stays valid until
// its expires_at timestamp. Rationale: per PRD §6.2 the management URL
// is a fallback for initiators whose outbound DKIM is broken; day-to-day
// commands happen via email. Bookmarkable, re-openable convenience wins
// over strict one-use semantics. If we ever need revocation, delete the
// file — no blocklist needed.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');

const TOKEN_RE = /^[a-f0-9]{32}$/;
const DEFAULT_TTL_DAYS = 30;

function tokensDir() {
  return path.join(config.dataDir, 'magic_tokens');
}

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

async function createToken({ eventId, initiator, ttlDays = DEFAULT_TTL_DAYS }) {
  if (!eventId) throw new Error('createToken: eventId required');
  if (!initiator) throw new Error('createToken: initiator required');
  const token = generateToken();
  const now = new Date();
  const expires = new Date(now.getTime() + ttlDays * 86400 * 1000);
  const record = {
    token,
    event_id: eventId,
    initiator,
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
  };
  const dir = tokensDir();
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${token}.json`);
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(record, null, 2) + '\n');
  await fs.rename(tmp, file);
  return record;
}

// Look up a token. Returns the record if found AND unexpired; null otherwise.
// Expired tokens read as null (expired-not-found is indistinguishable to the
// bearer). Malformed tokens never touch disk.
async function loadToken(token) {
  if (!token || !TOKEN_RE.test(token)) return null;
  const file = path.join(tokensDir(), `${token}.json`);
  let data;
  try {
    data = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const record = JSON.parse(data);
  if (record.expires_at && new Date(record.expires_at).getTime() < Date.now()) {
    return null;
  }
  return record;
}

module.exports = {
  createToken,
  loadToken,
  generateToken,
  TOKEN_RE,
  DEFAULT_TTL_DAYS,
};
