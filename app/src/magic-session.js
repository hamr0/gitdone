// Magic-link session auth for the management dashboard.
//
// Flow:
//   1. User enters email at /manage -> POST /manage
//   2. Server mints a 15-min single-use token, emails a magic link
//      https://<domain>/manage/session/<token>
//   3. User clicks link -> GET /manage/session/<token>
//      - loads token, deletes it (single-use), sets a signed 30-day
//        session cookie, redirects to /manage
//   4. Subsequent /manage requests use the cookie (no re-auth for 30d)
//
// Storage: one file per magic-link token at
//   {dataDir}/magic_tokens/session_<token>.json
// Naming prefix "session_" keeps them distinct from the per-event
// management tokens (which use the bare token as the filename).
//
// Cookie: signed HMAC, self-contained (no server state).
//   Value:   b64url(email) . expiryUnix . hmacHex
//   Secret:  GITDONE_SESSION_SECRET env var; dev fallback is a fixed
//            string so local cookies persist across restarts.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');

const TOKEN_RE = /^[a-f0-9]{32}$/;
const SESSION_TTL_DAYS = 30;
const MAGIC_TTL_MINUTES = 15;
const COOKIE_NAME = 'gd_session';

function tokensDir() {
  return path.join(config.dataDir, 'magic_tokens');
}

function sessionSecret() {
  return process.env.GITDONE_SESSION_SECRET
    || 'gitdone-dev-secret-do-not-use-in-prod';
}

function normaliseEmail(e) {
  return String(e || '').trim().toLowerCase();
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

function hmac(data) {
  return crypto.createHmac('sha256', sessionSecret()).update(data).digest('hex');
}

// --- magic-link tokens --------------------------------------------------

async function createMagicLink(email) {
  const em = normaliseEmail(email);
  if (!em || !em.includes('@')) throw new Error('createMagicLink: invalid email');
  const token = crypto.randomBytes(16).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + MAGIC_TTL_MINUTES * 60 * 1000);
  const record = {
    token,
    kind: 'session',
    email: em,
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
  };
  const dir = tokensDir();
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `session_${token}.json`);
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(record, null, 2) + '\n');
  await fs.rename(tmp, file);
  return record;
}

// Consume a magic-link token: load + delete atomically. Returns the email
// if the token is valid and unexpired, null otherwise.
async function consumeMagicLink(token) {
  if (!token || !TOKEN_RE.test(token)) return null;
  const file = path.join(tokensDir(), `session_${token}.json`);
  let data;
  try {
    data = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  // Delete first so a double-click can't reuse the token even if the
  // subsequent JSON parse succeeds.
  try { await fs.unlink(file); } catch {}
  const record = JSON.parse(data);
  if (record.kind !== 'session') return null;
  if (new Date(record.expires_at).getTime() < Date.now()) return null;
  return record.email;
}

// --- session cookie -----------------------------------------------------

function signSessionCookie(email) {
  const em = normaliseEmail(email);
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_DAYS * 86400;
  const payload = `${b64url(em)}.${exp}`;
  const sig = hmac(payload);
  return `${payload}.${sig}`;
}

function verifySessionCookie(cookieValue) {
  if (!cookieValue) return null;
  const parts = String(cookieValue).split('.');
  if (parts.length !== 3) return null;
  const [emailB64, expStr, sig] = parts;
  const payload = `${emailB64}.${expStr}`;
  const expected = hmac(payload);
  // Constant-time compare
  if (sig.length !== expected.length
    || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;
  try { return b64urlDecode(emailB64); } catch { return null; }
}

// Parse a "Cookie:" header value and return the named cookie, or null.
function parseCookie(header, name) {
  if (!header) return null;
  const parts = String(header).split(';');
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const k = p.slice(0, eq).trim();
    if (k === name) return p.slice(eq + 1).trim();
  }
  return null;
}

function cookieHeader(value, { maxAge } = {}) {
  const parts = [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (process.env.GITDONE_COOKIE_SECURE !== '0') parts.push('Secure');
  if (typeof maxAge === 'number') parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

function buildSetCookie(email) {
  return cookieHeader(signSessionCookie(email), { maxAge: SESSION_TTL_DAYS * 86400 });
}

function buildClearCookie() {
  return cookieHeader('', { maxAge: 0 });
}

// --- event scan --------------------------------------------------------

// Find all events whose initiator matches the given email (case-insensitive).
// Scans data/events/*.json. Fine for pre-launch volume; revisit with an
// index when scan time shows up in logs.
async function findEventsByInitiator(email) {
  const em = normaliseEmail(email);
  if (!em) return [];
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
    if (!ev || normaliseEmail(ev.initiator) !== em) continue;
    out.push(ev);
  }
  // Most recent first
  out.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return out;
}

// Find the per-event management token for a given event ID by scanning
// magic_tokens/. Pre-launch scale; revisit with an index at volume.
// Returns the token string or null.
async function findTokenByEventId(eventId) {
  if (!eventId) return null;
  const dir = tokensDir();
  let entries;
  try { entries = await fs.readdir(dir); } catch { return null; }
  for (const name of entries) {
    if (!name.endsWith('.json') || name.startsWith('session_')) continue;
    const full = path.join(dir, name);
    let raw;
    try { raw = await fs.readFile(full, 'utf8'); } catch { continue; }
    let rec;
    try { rec = JSON.parse(raw); } catch { continue; }
    if (rec && rec.event_id === eventId) {
      if (rec.expires_at && new Date(rec.expires_at).getTime() < Date.now()) continue;
      return rec.token;
    }
  }
  return null;
}

module.exports = {
  createMagicLink,
  consumeMagicLink,
  signSessionCookie,
  verifySessionCookie,
  parseCookie,
  buildSetCookie,
  buildClearCookie,
  findEventsByInitiator,
  findTokenByEventId,
  COOKIE_NAME,
  TOKEN_RE,
  SESSION_TTL_DAYS,
  MAGIC_TTL_MINUTES,
};
