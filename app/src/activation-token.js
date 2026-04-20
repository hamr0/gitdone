// Activation tokens — emailed to the initiator at event creation so they
// can prove they control the email address before participants get
// notified. Until an event is activated, no participant notifications
// fire and no reply counts. This closes the impersonation / spam hole
// where anyone could type a victim's email as initiator.
//
// Differences vs magic-token.js:
//   - Shorter TTL (72h, not 30d).
//   - Single-use: consumed on first successful load — file is deleted.
//     Re-entering the URL after activation hits a clean 404, so nobody
//     can re-trigger participant notifications by replaying the link.
//   - Carries the management token id so one click can activate AND
//     redirect the organiser straight into the management dashboard
//     without requiring a second email.
//
// Storage: {dataDir}/activation_tokens/{token}.json (same O(1) shape as
// magic-token). 128 bits of entropy per token.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');

const TOKEN_RE = /^[a-f0-9]{32}$/;
const DEFAULT_TTL_HOURS = 72;

function tokensDir() {
  return path.join(config.dataDir, 'activation_tokens');
}

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

async function createActivationToken({ eventId, initiator, managementToken, ttlHours = DEFAULT_TTL_HOURS }) {
  if (!eventId) throw new Error('createActivationToken: eventId required');
  if (!initiator) throw new Error('createActivationToken: initiator required');
  const token = generateToken();
  const now = new Date();
  const expires = new Date(now.getTime() + ttlHours * 3600 * 1000);
  const record = {
    token,
    event_id: eventId,
    initiator,
    management_token: managementToken || null,
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

// Load WITHOUT consuming. Used to inspect the record (e.g. in a resend
// flow). Returns null if missing, malformed, or expired.
async function peekActivationToken(token) {
  if (!token || !TOKEN_RE.test(token)) return null;
  const file = path.join(tokensDir(), `${token}.json`);
  let data;
  try { data = await fs.readFile(file, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  const record = JSON.parse(data);
  if (record.expires_at && new Date(record.expires_at).getTime() < Date.now()) {
    return null;
  }
  return record;
}

// Load AND consume atomically. Returns the record if the token was
// valid+unexpired at the moment of consumption; null otherwise. The
// file is deleted on success, so a second call with the same token
// returns null. The unlink runs BEFORE expiry check to avoid leaking
// stale files.
async function consumeActivationToken(token) {
  if (!token || !TOKEN_RE.test(token)) return null;
  const file = path.join(tokensDir(), `${token}.json`);
  let data;
  try { data = await fs.readFile(file, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  try { await fs.unlink(file); } catch { /* best-effort */ }
  const record = JSON.parse(data);
  if (record.expires_at && new Date(record.expires_at).getTime() < Date.now()) {
    return null;
  }
  return record;
}

module.exports = {
  createActivationToken,
  peekActivationToken,
  consumeActivationToken,
  generateToken,
  TOKEN_RE,
  DEFAULT_TTL_HOURS,
};
