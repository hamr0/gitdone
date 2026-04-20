'use strict';

// Activation tokens are emailed to the initiator at event creation.
// Clicking the link proves email ownership before any participant is
// contacted. These tests cover the token lifecycle — create, peek,
// consume-is-single-use, and expiry — since that's the part receive.js
// and /activate/:token depend on.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let tmp;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-activation-'));
  process.env.GITDONE_DATA_DIR = tmp;
  delete require.cache[require.resolve('../../src/config')];
  delete require.cache[require.resolve('../../src/activation-token')];
});

after(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

test('createActivationToken writes a record and returns it', async () => {
  const { createActivationToken } = require('../../src/activation-token');
  const rec = await createActivationToken({
    eventId: 'abcdef1234', initiator: 'org@ex.com', managementToken: 'm'.repeat(32),
  });
  assert.match(rec.token, /^[a-f0-9]{32}$/);
  assert.equal(rec.event_id, 'abcdef1234');
  assert.equal(rec.initiator, 'org@ex.com');
  assert.equal(rec.management_token, 'm'.repeat(32));
  assert.ok(new Date(rec.expires_at).getTime() > Date.now());
  // On disk
  const data = await fs.readFile(path.join(tmp, 'activation_tokens', `${rec.token}.json`), 'utf8');
  assert.equal(JSON.parse(data).token, rec.token);
});

test('peekActivationToken returns the record without consuming it', async () => {
  const { createActivationToken, peekActivationToken } = require('../../src/activation-token');
  const rec = await createActivationToken({ eventId: 'ev', initiator: 'x@y.com' });
  const a = await peekActivationToken(rec.token);
  const b = await peekActivationToken(rec.token);
  assert.equal(a.token, rec.token);
  assert.equal(b.token, rec.token);
});

test('consumeActivationToken is single-use — second call returns null', async () => {
  const { createActivationToken, consumeActivationToken } = require('../../src/activation-token');
  const rec = await createActivationToken({ eventId: 'evsingle', initiator: 'x@y.com' });
  const first = await consumeActivationToken(rec.token);
  const second = await consumeActivationToken(rec.token);
  assert.equal(first.token, rec.token);
  assert.equal(second, null);
});

test('consumeActivationToken rejects malformed tokens without touching disk', async () => {
  const { consumeActivationToken } = require('../../src/activation-token');
  assert.equal(await consumeActivationToken(''), null);
  assert.equal(await consumeActivationToken('not-hex'), null);
  assert.equal(await consumeActivationToken('a'.repeat(31)), null);
  assert.equal(await consumeActivationToken('../etc/passwd'), null);
});

test('peekActivationToken returns null for expired records', async () => {
  const { createActivationToken, peekActivationToken } = require('../../src/activation-token');
  // TTL=0 → expires immediately.
  const rec = await createActivationToken({ eventId: 'evexp', initiator: 'x@y.com', ttlHours: 0 });
  // Force a tick so Date.now() advances past created_at.
  await new Promise((r) => setTimeout(r, 2));
  assert.equal(await peekActivationToken(rec.token), null);
});
