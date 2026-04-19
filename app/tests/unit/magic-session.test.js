'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function withTempDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-session-'));
  process.env.GITDONE_DATA_DIR = dir;
  // Clear module cache so config picks up the new env
  for (const k of Object.keys(require.cache)) {
    if (k.includes('src/config') || k.includes('src/magic-session')) delete require.cache[k];
  }
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

test('createMagicLink mints a 32-hex token and records email', async (t) => {
  withTempDataDir(t);
  const session = require('../../src/magic-session');
  const rec = await session.createMagicLink('Foo@Bar.com');
  assert.match(rec.token, /^[a-f0-9]{32}$/);
  assert.equal(rec.email, 'foo@bar.com');
  assert.equal(rec.kind, 'session');
  assert.ok(new Date(rec.expires_at) > new Date());
});

test('consumeMagicLink returns email, then null on replay', async (t) => {
  withTempDataDir(t);
  const session = require('../../src/magic-session');
  const { token } = await session.createMagicLink('a@b.com');
  const first = await session.consumeMagicLink(token);
  assert.equal(first, 'a@b.com');
  const second = await session.consumeMagicLink(token);
  assert.equal(second, null);
});

test('consumeMagicLink rejects malformed tokens without disk hit', async (t) => {
  withTempDataDir(t);
  const session = require('../../src/magic-session');
  assert.equal(await session.consumeMagicLink(''), null);
  assert.equal(await session.consumeMagicLink('nothex'), null);
  assert.equal(await session.consumeMagicLink('a'.repeat(64)), null);
});

test('session cookie round-trips and survives time; invalid sig rejected', async (t) => {
  withTempDataDir(t);
  const session = require('../../src/magic-session');
  const cookie = session.signSessionCookie('x@y.com');
  assert.equal(session.verifySessionCookie(cookie), 'x@y.com');
  // tamper with signature
  const tampered = cookie.slice(0, -2) + 'ff';
  assert.equal(session.verifySessionCookie(tampered), null);
  // malformed
  assert.equal(session.verifySessionCookie('garbage'), null);
  assert.equal(session.verifySessionCookie(''), null);
});

test('session cookie rejects expired payload', async (t) => {
  withTempDataDir(t);
  const session = require('../../src/magic-session');
  const crypto = require('node:crypto');
  const secret = process.env.GITDONE_SESSION_SECRET || 'gitdone-dev-secret-do-not-use-in-prod';
  const emailB64 = Buffer.from('x@y.com').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const exp = Math.floor(Date.now() / 1000) - 60; // expired
  const payload = `${emailB64}.${exp}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  assert.equal(session.verifySessionCookie(`${payload}.${sig}`), null);
});

test('parseCookie finds the named cookie among several', (t) => {
  withTempDataDir(t);
  const session = require('../../src/magic-session');
  const header = 'foo=bar; gd_session=abc.def.ghi; baz=qux';
  assert.equal(session.parseCookie(header, 'gd_session'), 'abc.def.ghi');
  assert.equal(session.parseCookie(header, 'nope'), null);
  assert.equal(session.parseCookie('', 'gd_session'), null);
});

test('findEventsByInitiator scans and filters by normalised email', async (t) => {
  const dir = withTempDataDir(t);
  const session = require('../../src/magic-session');
  const eventsDir = path.join(dir, 'events');
  fs.mkdirSync(eventsDir, { recursive: true });
  const mk = (id, initiator, title, extra = {}) => {
    fs.writeFileSync(path.join(eventsDir, `${id}.json`),
      JSON.stringify({ id, initiator, title, type: 'event', created_at: '2026-04-19T00:00:00Z', ...extra }));
  };
  mk('aaaa', 'foo@bar.com', 'alpha');
  mk('bbbb', 'FOO@BAR.COM', 'beta');
  mk('cccc', 'someone@else.com', 'gamma');
  const hits = await session.findEventsByInitiator('foo@bar.com');
  const ids = hits.map((e) => e.id).sort();
  assert.deepEqual(ids, ['aaaa', 'bbbb']);
});

test('findTokenByEventId returns unexpired per-event token, ignores session_* files', async (t) => {
  const dir = withTempDataDir(t);
  const session = require('../../src/magic-session');
  const tokensDir = path.join(dir, 'magic_tokens');
  fs.mkdirSync(tokensDir, { recursive: true });
  const future = new Date(Date.now() + 10 * 86400 * 1000).toISOString();
  fs.writeFileSync(path.join(tokensDir, 'aaaa111122223333aaaa111122223333.json'),
    JSON.stringify({ token: 'aaaa111122223333aaaa111122223333', event_id: 'evt1', expires_at: future }));
  fs.writeFileSync(path.join(tokensDir, 'session_deadbeefdeadbeefdeadbeefdeadbeef.json'),
    JSON.stringify({ token: 'deadbeef', kind: 'session', email: 'x@y.com', expires_at: future }));
  const t1 = await session.findTokenByEventId('evt1');
  assert.equal(t1, 'aaaa111122223333aaaa111122223333');
  const t2 = await session.findTokenByEventId('nope');
  assert.equal(t2, null);
});
