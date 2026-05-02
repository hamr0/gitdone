'use strict';

// Shared test helper: mint a knowless session cookie directly so HTTP
// tests can simulate "user is already signed in." Replicates knowless's
// session HMAC + sessions-table schema (see node_modules/knowless/src/
// session.js and store.js). If knowless rotates SESS_TAG, changes the
// columns, or alters the cookie format, this helper drifts silently —
// keep an eye on the upstream CHANGELOG.
//
// Tests should ALWAYS go through this helper rather than re-implementing
// the formula inline. If knowless gains a public test-mint API in a
// future release, replace this entire module with a thin wrapper.

const crypto = require('node:crypto');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SESS_TAG = Buffer.from('sess\x00');
const COOKIE_NAME = 'knowless_session';
const DEFAULT_TTL_MS = 30 * 24 * 3600 * 1000;
const TEST_SECRET = 'a'.repeat(64);

function deriveHandle(email, secret = TEST_SECRET) {
  return crypto.createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(email.toLowerCase(), 'utf8')
    .digest('hex');
}

function sidHashOf(sid) {
  return crypto.createHash('sha256')
    .update(Buffer.from(sid, 'base64url'))
    .digest('hex');
}

function signSession(sid, secret = TEST_SECRET) {
  const sig = crypto.createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(SESS_TAG)
    .update(sid, 'utf8')
    .digest('hex');
  return `${sid}.${sig}`;
}

// Mint a session for `email` against the knowless DB at `dataDir`.
// Returns the full Cookie header value (`knowless_session=...`).
function mintSessionCookie({ email, dataDir, secret = TEST_SECRET, ttlMs = DEFAULT_TTL_MS }) {
  const sid = crypto.randomBytes(32).toString('base64url');
  const handle = deriveHandle(email, secret);
  const expiresAt = Date.now() + ttlMs;
  const db = new DatabaseSync(path.join(dataDir, 'knowless.db'));
  try {
    db.prepare('INSERT INTO sessions (sid_hash, handle, expires_at) VALUES (?, ?, ?)')
      .run(sidHashOf(sid), handle, expiresAt);
  } finally {
    db.close();
  }
  return `${COOKIE_NAME}=${signSession(sid, secret)}`;
}

module.exports = { mintSessionCookie, deriveHandle, TEST_SECRET };
