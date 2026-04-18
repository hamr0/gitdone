'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let tmp;
let magicToken;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-magic-'));
  process.env.GITDONE_DATA_DIR = tmp;
  delete require.cache[require.resolve('../../src/config')];
  delete require.cache[require.resolve('../../src/magic-token')];
  magicToken = require('../../src/magic-token');
});

after(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

test('createToken: persists a 32-hex token with event + expiry', async () => {
  const r = await magicToken.createToken({ eventId: 'abc123', initiator: 'i@x.com' });
  assert.match(r.token, /^[a-f0-9]{32}$/);
  assert.equal(r.event_id, 'abc123');
  assert.equal(r.initiator, 'i@x.com');
  assert.ok(new Date(r.expires_at).getTime() > Date.now());
  // file exists on disk
  const file = path.join(tmp, 'magic_tokens', `${r.token}.json`);
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(parsed.token, r.token);
  assert.equal(parsed.event_id, 'abc123');
});

test('loadToken: returns record for a valid token', async () => {
  const r = await magicToken.createToken({ eventId: 'ev1', initiator: 'a@b.com' });
  const loaded = await magicToken.loadToken(r.token);
  assert.ok(loaded);
  assert.equal(loaded.event_id, 'ev1');
  assert.equal(loaded.initiator, 'a@b.com');
});

test('loadToken: returns null for unknown token', async () => {
  const fake = 'f'.repeat(32);
  const loaded = await magicToken.loadToken(fake);
  assert.equal(loaded, null);
});

test('loadToken: rejects malformed token without touching disk', async () => {
  assert.equal(await magicToken.loadToken(''), null);
  assert.equal(await magicToken.loadToken('not-hex'), null);
  assert.equal(await magicToken.loadToken('../etc/passwd'), null);
  assert.equal(await magicToken.loadToken('a'.repeat(31)), null);
  assert.equal(await magicToken.loadToken('g'.repeat(32)), null); // g not hex
});

test('loadToken: returns null for expired token', async () => {
  const r = await magicToken.createToken({ eventId: 'ev2', initiator: 'a@b.com', ttlDays: 30 });
  // Rewrite the file with expires_at in the past
  const file = path.join(tmp, 'magic_tokens', `${r.token}.json`);
  const rec = JSON.parse(await fs.readFile(file, 'utf8'));
  rec.expires_at = new Date(Date.now() - 1000).toISOString();
  await fs.writeFile(file, JSON.stringify(rec));
  assert.equal(await magicToken.loadToken(r.token), null);
});

test('createToken: rejects missing eventId or initiator', async () => {
  await assert.rejects(() => magicToken.createToken({ initiator: 'a@b.com' }), /eventId/);
  await assert.rejects(() => magicToken.createToken({ eventId: 'x' }), /initiator/);
});

test('generateToken: returns unique 32-hex strings', () => {
  const a = magicToken.generateToken();
  const b = magicToken.generateToken();
  assert.match(a, /^[a-f0-9]{32}$/);
  assert.notEqual(a, b);
});
