'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let tmp;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-auth-'));
  process.env.GITDONE_DATA_DIR = tmp;
  process.env.GITDONE_SESSION_SECRET = 'a'.repeat(64);
  process.env.GITDONE_PUBLIC_URL = 'http://localhost:3001';
  process.env.GITDONE_COOKIE_SECURE = '0';
  process.env.GITDONE_SENDMAIL_BIN = '/bin/true';
  // Recache config with the temp dir.
  delete require.cache[require.resolve('../../src/config')];
  delete require.cache[require.resolve('../../src/auth')];
});

after(async () => {
  delete process.env.GITDONE_SESSION_SECRET;
  delete process.env.GITDONE_PUBLIC_URL;
  delete process.env.GITDONE_COOKIE_SECURE;
  delete process.env.GITDONE_SENDMAIL_BIN;
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

test('getAuth: returns a knowless instance with expected methods', async () => {
  const { getAuth, _resetAuth } = require('../../src/auth');
  _resetAuth();
  const auth = await getAuth();
  assert.equal(typeof auth.login, 'function', 'login handler');
  assert.equal(typeof auth.callback, 'function', 'callback handler');
  assert.equal(typeof auth.verify, 'function', 'verify handler');
  assert.equal(typeof auth.logout, 'function', 'logout handler');
  assert.equal(typeof auth.handleFromRequest, 'function', 'handleFromRequest');
  assert.equal(typeof auth.deriveHandle, 'function', 'deriveHandle');
  auth.close();
});

test('getAuth: memoises — same instance on repeated calls', async () => {
  const { getAuth, _resetAuth } = require('../../src/auth');
  _resetAuth();
  const a = await getAuth();
  const b = await getAuth();
  assert.equal(a, b, 'same instance');
  a.close();
});

test('getAuth: throws when GITDONE_SESSION_SECRET is absent', async () => {
  const savedSecret = process.env.GITDONE_SESSION_SECRET;
  delete process.env.GITDONE_SESSION_SECRET;
  delete require.cache[require.resolve('../../src/auth')];
  const { getAuth, _resetAuth } = require('../../src/auth');
  _resetAuth();
  await assert.rejects(
    () => getAuth(),
    /GITDONE_SESSION_SECRET is required/,
  );
  process.env.GITDONE_SESSION_SECRET = savedSecret;
  delete require.cache[require.resolve('../../src/auth')];
});

test('getAuth: throws when GITDONE_SESSION_SECRET is not 64 hex chars (audit M4)', async () => {
  const savedSecret = process.env.GITDONE_SESSION_SECRET;
  for (const bad of ['x', 'a'.repeat(32), 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
    process.env.GITDONE_SESSION_SECRET = bad;
    delete require.cache[require.resolve('../../src/auth')];
    const { getAuth, _resetAuth } = require('../../src/auth');
    _resetAuth();
    await assert.rejects(
      () => getAuth(),
      /GITDONE_SESSION_SECRET must be 64 hex chars/,
      `expected reject for ${JSON.stringify(bad)}`,
    );
  }
  // A valid 64-hex secret (mixed case) is accepted.
  process.env.GITDONE_SESSION_SECRET = 'AbCd'.repeat(16);
  delete require.cache[require.resolve('../../src/auth')];
  const { getAuth, _resetAuth } = require('../../src/auth');
  _resetAuth();
  const auth = await getAuth();
  assert.equal(typeof auth.login, 'function');
  auth.close();
  process.env.GITDONE_SESSION_SECRET = savedSecret;
  delete require.cache[require.resolve('../../src/auth')];
});

test('deriveHandle: case-insensitive and deterministic', async () => {
  delete require.cache[require.resolve('../../src/auth')];
  const { getAuth, _resetAuth } = require('../../src/auth');
  _resetAuth();
  const auth = await getAuth();
  const h1 = auth.deriveHandle('user@example.com');
  const h2 = auth.deriveHandle('USER@EXAMPLE.COM');
  const h3 = auth.deriveHandle('User@Example.Com');
  assert.equal(h1, h2, 'lowercase === uppercase');
  assert.equal(h1, h3, 'mixed === lowercase');
  assert.match(h1, /^[0-9a-f]{64}$/, '64-char hex handle');
  auth.close();
});

// --- sourceIp(): per-IP rate-limit anti-spoofing seam ---------------------
// gitdone supplies the trusted-proxy policy (config.trustedProxies, default
// loopback); knowless's determineSourceIp is the mechanism. These exercise the
// real resolver end-to-end so a knowless behaviour change can't silently break
// gitdone's per-IP login limiting.

const fakeReq = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

test('sourceIp: returns the raw peer when peer is NOT a trusted proxy (anti-spoof)', async () => {
  delete require.cache[require.resolve('../../src/auth')];
  const { getAuth, sourceIp, _resetAuth } = require('../../src/auth');
  _resetAuth();
  const auth = await getAuth();
  // A direct (non-proxy) client cannot spoof its IP via a forged XFF header.
  const ip = sourceIp(fakeReq('203.0.113.9', { 'x-forwarded-for': '1.2.3.4' }));
  assert.equal(ip, '203.0.113.9', 'untrusted peer ignores X-Forwarded-For');
  auth.close();
});

test('sourceIp: reads leftmost X-Forwarded-For when peer is a trusted proxy', async () => {
  delete require.cache[require.resolve('../../src/auth')];
  const { getAuth, sourceIp, _resetAuth } = require('../../src/auth');
  _resetAuth();
  const auth = await getAuth();
  const ip = sourceIp(fakeReq('127.0.0.1', { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' }));
  assert.equal(ip, '198.51.100.7', 'trusted proxy → real client from XFF');
  auth.close();
});

test('sourceIp: trusted proxy with no XFF falls back to the peer', async () => {
  delete require.cache[require.resolve('../../src/auth')];
  const { getAuth, sourceIp, _resetAuth } = require('../../src/auth');
  _resetAuth();
  const auth = await getAuth();
  assert.equal(sourceIp(fakeReq('127.0.0.1', {})), '127.0.0.1');
  auth.close();
});

test('sourceIp: throws if called before getAuth() bootstraps the resolver', async () => {
  delete require.cache[require.resolve('../../src/auth')];
  const { sourceIp, _resetAuth } = require('../../src/auth');
  _resetAuth();
  assert.throws(() => sourceIp(fakeReq('127.0.0.1')), /await getAuth\(\) before sourceIp/);
});
