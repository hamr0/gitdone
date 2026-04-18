'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

let tmp;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-create-'));
  process.env.GITDONE_DATA_DIR = tmp;
  delete require.cache[require.resolve('../../src/config')];
  delete require.cache[require.resolve('../../src/event-store')];
});

after(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

test('generateEventId: 12-char alphanumeric', () => {
  const { generateEventId } = require('../../src/event-store');
  for (let i = 0; i < 20; i++) {
    const id = generateEventId();
    assert.match(id, /^[a-z0-9]{12}$/);
  }
});

test('generateEventId: distinct across rapid calls', () => {
  const { generateEventId } = require('../../src/event-store');
  const set = new Set();
  for (let i = 0; i < 200; i++) set.add(generateEventId());
  assert.equal(set.size, 200);
});

test('generateEventSalt: 64-hex (32 bytes)', () => {
  const { generateEventSalt } = require('../../src/event-store');
  const s = generateEventSalt();
  assert.match(s, /^[0-9a-f]{64}$/);
});

test('createEvent: writes valid event.json with generated id + salt + created_at', async () => {
  const { createEvent, loadEvent } = require('../../src/event-store');
  const event = await createEvent({
    type: 'event',
    title: 'hello',
    initiator: 'a@b.com',
    flow: 'sequential',
    steps: [],
  });
  assert.match(event.id, /^[a-z0-9]{12}$/);
  assert.match(event.salt, /^[0-9a-f]{64}$/);
  assert.match(event.created_at, /^\d{4}-\d{2}-\d{2}T/);

  // Round-trip through loadEvent
  const loaded = await loadEvent(event.id);
  assert.deepEqual(loaded, event);
});

test('createEvent: refuses to overwrite existing id', async () => {
  const { createEvent } = require('../../src/event-store');
  const first = await createEvent({ type: 'event', title: 'x', initiator: 'a@b.com', steps: [] });
  await assert.rejects(
    createEvent({ id: first.id, type: 'event', title: 'x', initiator: 'a@b.com', steps: [] }),
    /already exists/,
  );
});

test('createEvent: rejects invalid (non-alphanumeric) id', async () => {
  const { createEvent } = require('../../src/event-store');
  await assert.rejects(
    createEvent({ id: '../etc/passwd', type: 'event', title: 'x', initiator: 'a@b.com', steps: [] }),
    /invalid id/,
  );
});

test('createEvent: preserves caller-supplied salt (for deterministic tests)', async () => {
  const { createEvent } = require('../../src/event-store');
  const ev = await createEvent({
    type: 'event', title: 'x', initiator: 'a@b.com', steps: [],
    salt: 'f'.repeat(64),
  });
  assert.equal(ev.salt, 'f'.repeat(64));
});
