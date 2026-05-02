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
