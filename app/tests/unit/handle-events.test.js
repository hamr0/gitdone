'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let tmp;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-handle-events-'));
  process.env.GITDONE_DATA_DIR = tmp;
  delete require.cache[require.resolve('../../src/config')];
  delete require.cache[require.resolve('../../src/web/handle-events')];
});

after(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

// Minimal deriveHandle stub: HMAC is tested in auth.test.js.
// Here we just need deterministic handle → email mapping.
const SECRET = 'x'.repeat(64);
const { createHmac } = require('node:crypto');
function stubDeriveHandle(email) {
  return createHmac('sha256', SECRET).update(email.trim().toLowerCase()).digest('hex');
}

async function writeEvent(dir, id, initiator, created_at = '2026-01-01T00:00:00.000Z') {
  const evDir = path.join(dir, 'events');
  await fs.mkdir(evDir, { recursive: true });
  await fs.writeFile(
    path.join(evDir, `${id}.json`),
    JSON.stringify({ id, initiator, created_at }),
  );
}

test('findEventsByHandle: returns events matching the handle', async () => {
  const { createEventFinder } = require('../../src/web/handle-events');
  const findEventsByHandle = createEventFinder(stubDeriveHandle);

  await writeEvent(tmp, 'ev1', 'alice@example.com', '2026-01-02T00:00:00.000Z');
  await writeEvent(tmp, 'ev2', 'bob@example.com');

  const handle = stubDeriveHandle('alice@example.com');
  const results = await findEventsByHandle(handle);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'ev1');
});

test('findEventsByHandle: case-insensitive via deriveHandle normalisation', async () => {
  const { createEventFinder } = require('../../src/web/handle-events');
  const findEventsByHandle = createEventFinder(stubDeriveHandle);

  await writeEvent(tmp, 'ev3', 'Alice@EXAMPLE.COM');

  // stubDeriveHandle lowercases before hashing, matching the stored initiator
  const handle = stubDeriveHandle('alice@example.com');
  const results = await findEventsByHandle(handle);
  // ev1 + ev3 both belong to alice
  assert.ok(results.some((e) => e.id === 'ev3'), 'mixed-case initiator matched');
});

test('findEventsByHandle: returns empty array when no events dir exists', async () => {
  const tmpEmpty = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-he-empty-'));
  process.env.GITDONE_DATA_DIR = tmpEmpty;
  delete require.cache[require.resolve('../../src/config')];
  delete require.cache[require.resolve('../../src/web/handle-events')];
  try {
    const { createEventFinder } = require('../../src/web/handle-events');
    const find = createEventFinder(stubDeriveHandle);
    const result = await find(stubDeriveHandle('x@y.com'));
    assert.deepEqual(result, []);
  } finally {
    await fs.rm(tmpEmpty, { recursive: true, force: true });
    process.env.GITDONE_DATA_DIR = tmp;
    delete require.cache[require.resolve('../../src/config')];
    delete require.cache[require.resolve('../../src/web/handle-events')];
  }
});

test('findEventsByHandle: returns empty array for unknown handle', async () => {
  const { createEventFinder } = require('../../src/web/handle-events');
  const findEventsByHandle = createEventFinder(stubDeriveHandle);

  const handle = stubDeriveHandle('nobody@example.com');
  const results = await findEventsByHandle(handle);
  assert.deepEqual(results, []);
});

test('findEventsByHandle: sorts most-recent first', async () => {
  const tmpSort = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-he-sort-'));
  process.env.GITDONE_DATA_DIR = tmpSort;
  delete require.cache[require.resolve('../../src/config')];
  delete require.cache[require.resolve('../../src/web/handle-events')];
  try {
    const { createEventFinder } = require('../../src/web/handle-events');
    const find = createEventFinder(stubDeriveHandle);

    const evDir = path.join(tmpSort, 'events');
    await fs.mkdir(evDir, { recursive: true });
    const initiator = 'sort@example.com';
    for (const [id, ts] of [
      ['old', '2026-01-01T00:00:00.000Z'],
      ['new', '2026-03-01T00:00:00.000Z'],
      ['mid', '2026-02-01T00:00:00.000Z'],
    ]) {
      await fs.writeFile(
        path.join(evDir, `${id}.json`),
        JSON.stringify({ id, initiator, created_at: ts }),
      );
    }

    const handle = stubDeriveHandle(initiator);
    const results = await find(handle);
    assert.deepEqual(results.map((e) => e.id), ['new', 'mid', 'old']);
  } finally {
    await fs.rm(tmpSort, { recursive: true, force: true });
    process.env.GITDONE_DATA_DIR = tmp;
    delete require.cache[require.resolve('../../src/config')];
    delete require.cache[require.resolve('../../src/web/handle-events')];
  }
});

test('findEventsByHandle: returns empty array for null/empty handle', async () => {
  const { createEventFinder } = require('../../src/web/handle-events');
  const findEventsByHandle = createEventFinder(stubDeriveHandle);
  assert.deepEqual(await findEventsByHandle(null), []);
  assert.deepEqual(await findEventsByHandle(''), []);
});

test('createEventFinder: throws if deriveHandle is not a function', () => {
  const { createEventFinder } = require('../../src/web/handle-events');
  assert.throws(() => createEventFinder('notafunction'), /deriveHandle must be a function/);
});
