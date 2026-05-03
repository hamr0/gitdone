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

// --- editEvent (Phase 1.J: organiser-driven step edits) ---

test('editEvent: rejects edit on completed step', async () => {
  const { editEvent, createEvent } = require('../../src/event-store');
  const ev = await createEvent({
    type: 'event', title: 'editfreeze', initiator: 'org@ex.com',
    steps: [
      { id: 'a', name: 'one', participant: 'a@ex.com', status: 'complete' },
      { id: 'b', name: 'two', participant: 'b@ex.com', status: 'pending' },
    ],
  });
  await assert.rejects(
    () => editEvent(ev.id, { steps: [{ id: 'a', participant: 'changed@ex.com' }] }),
    (err) => err.code === 'EVENT_STEP_FROZEN'
  );
});

test('editEvent: pending event — no audit commit, plain mutation', async () => {
  const { editEvent, createEvent, loadEvent } = require('../../src/event-store');
  const ev = await createEvent({
    type: 'event', title: 'pending edit', initiator: 'org@ex.com',
    steps: [{ id: 's', name: 'do', participant: 'old@ex.com', status: 'pending' }],
  });
  const result = await editEvent(ev.id, {
    title: 'new title',
    steps: [{ id: 's', participant: 'new@ex.com', deadline: '2026-06-01', requires_attachment: true }],
  });
  assert.equal(result.commitSequence, null, 'no audit commit for pending event');
  assert.equal(result.changes.length, 4, 'four field changes');
  const reloaded = await loadEvent(ev.id);
  assert.equal(reloaded.title, 'new title');
  assert.equal(reloaded.steps[0].participant, 'new@ex.com');
  assert.equal(reloaded.steps[0].deadline, '2026-06-01');
  assert.equal(reloaded.steps[0].requires_attachment, true);
});

test('editEvent: no-op when patch matches current state', async () => {
  const { editEvent, createEvent } = require('../../src/event-store');
  const ev = await createEvent({
    type: 'event', title: 'noop', initiator: 'org@ex.com',
    steps: [{ id: 's', name: 'do', participant: 'a@ex.com', status: 'pending' }],
  });
  const result = await editEvent(ev.id, { steps: [{ id: 's', participant: 'a@ex.com' }] });
  assert.equal(result.changes.length, 0);
  assert.equal(result.commitSequence, null);
});

test('editEvent: rejects invalid email', async () => {
  const { editEvent, createEvent } = require('../../src/event-store');
  const ev = await createEvent({
    type: 'event', title: 't', initiator: 'org@ex.com',
    steps: [{ id: 's', name: 'do', participant: 'a@ex.com', status: 'pending' }],
  });
  await assert.rejects(
    () => editEvent(ev.id, { steps: [{ id: 's', participant: 'not-an-email' }] }),
    (err) => err.code === 'BAD_EMAIL'
  );
});

test('editEvent: rejects edit on completed event', async () => {
  const { editEvent, createEvent } = require('../../src/event-store');
  const ev = await createEvent({
    type: 'event', title: 'done', initiator: 'org@ex.com',
    completion: { status: 'complete', completed_at: '2026-01-01T00:00:00Z' },
    steps: [{ id: 's', name: 'do', participant: 'a@ex.com', status: 'complete' }],
  });
  await assert.rejects(
    () => editEvent(ev.id, { title: 'new' }),
    (err) => err.code === 'EVENT_COMPLETE'
  );
});

test('editEvent: activated event writes an audit commit; participant change is hashed', async () => {
  const { editEvent, createEvent, activateEvent, generateEventSalt } = require('../../src/event-store');
  const { initRepoIfNeeded, repoPath, listCommits } = require('../../src/gitrepo');
  const ev = await createEvent({
    type: 'event', title: 'audit', initiator: 'org@ex.com',
    salt: generateEventSalt(),
    steps: [{ id: 's', name: 'do', participant: 'old@ex.com', status: 'pending' }],
  });
  await activateEvent(ev.id);
  // Repo is created lazily on first reply normally; init it explicitly so
  // the edit commit lands in the same place.
  const { event: activated } = await activateEvent(ev.id);
  await initRepoIfNeeded(ev.id, activated);

  const result = await editEvent(ev.id, {
    steps: [{ id: 's', participant: 'new@ex.com', deadline: '2026-07-01' }],
  }, { organiserHandle: 'h_test' });

  assert.equal(typeof result.commitSequence, 'number');
  assert.ok(result.commitSequence >= 1);
  const commits = await listCommits(ev.id);
  const editCommit = commits.find((c) => c.kind === 'event_edit');
  assert.ok(editCommit, 'audit commit written');
  // Participant change is hashed (no plaintext leak).
  const partChange = editCommit.changes.find((c) => c.field === 'participant');
  assert.ok(partChange.from_hash.startsWith('sha256:'));
  assert.ok(partChange.to_hash.startsWith('sha256:'));
  assert.equal(partChange.from, undefined);
  assert.equal(partChange.to, undefined);
  // Deadline change is plaintext.
  const dlChange = editCommit.changes.find((c) => c.field === 'deadline');
  assert.equal(dlChange.to, '2026-07-01');
});
