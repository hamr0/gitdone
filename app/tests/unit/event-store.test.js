'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

let tmpDir;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-test-'));
  process.env.GITDONE_DATA_DIR = tmpDir;
  // Clear the cached config singleton so it picks up our env.
  delete require.cache[require.resolve('../../src/config')];
  delete require.cache[require.resolve('../../src/event-store')];
  await fs.mkdir(path.join(tmpDir, 'events'), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, 'events', 'demo123.json'),
    JSON.stringify({
      id: 'demo123',
      type: 'event',
      flow: 'sequential',
      title: 'Demo',
      initiator: 'init@example.com',
      steps: [
        { id: 'step1', name: 'Legal review', participant: 'legal@example.com', status: 'pending' },
        { id: 'step2', name: 'CEO sign', participant: 'CEO@example.com', status: 'pending' },
      ],
    })
  );
});

after(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

test('loadEvent: returns parsed event when file exists', async () => {
  const { loadEvent } = require('../../src/event-store');
  const event = await loadEvent('demo123');
  assert.ok(event);
  assert.equal(event.id, 'demo123');
  assert.equal(event.steps.length, 2);
});

test('loadEvent: returns null for unknown event id', async () => {
  const { loadEvent } = require('../../src/event-store');
  assert.equal(await loadEvent('nonexistent'), null);
});

test('loadEvent: rejects invalid id (path traversal guard)', async () => {
  const { loadEvent } = require('../../src/event-store');
  assert.equal(await loadEvent('../passwd'), null);
  assert.equal(await loadEvent(''), null);
  assert.equal(await loadEvent(null), null);
  assert.equal(await loadEvent('a/b'), null);
});

test('findStep: locates step by id', async () => {
  const { loadEvent, findStep } = require('../../src/event-store');
  const event = await loadEvent('demo123');
  const step = findStep(event, 'step1');
  assert.equal(step.name, 'Legal review');
});

test('findStep: returns null when step missing', async () => {
  const { loadEvent, findStep } = require('../../src/event-store');
  const event = await loadEvent('demo123');
  assert.equal(findStep(event, 'stepZZZ'), null);
});

test('findStep: tolerates null event / null stepId', async () => {
  const { findStep } = require('../../src/event-store');
  assert.equal(findStep(null, 'step1'), null);
  assert.equal(findStep({ steps: [] }, null), null);
});

test('senderMatchesStep: case-insensitive email match', async () => {
  const { loadEvent, findStep, senderMatchesStep } = require('../../src/event-store');
  const event = await loadEvent('demo123');
  const step = findStep(event, 'step2'); // participant CEO@example.com
  assert.equal(senderMatchesStep('ceo@example.com', step), true);
  assert.equal(senderMatchesStep('CEO@example.com', step), true);
  assert.equal(senderMatchesStep('  ceo@example.com  ', step), true);
});

test('senderMatchesStep: mismatch returns false', async () => {
  const { loadEvent, findStep, senderMatchesStep } = require('../../src/event-store');
  const event = await loadEvent('demo123');
  const step = findStep(event, 'step1');
  assert.equal(senderMatchesStep('attacker@evil.com', step), false);
});

test('senderMatchesStep: tolerates null inputs', async () => {
  const { senderMatchesStep } = require('../../src/event-store');
  assert.equal(senderMatchesStep(null, null), false);
  assert.equal(senderMatchesStep('a@b', { participant: null }), false);
});
