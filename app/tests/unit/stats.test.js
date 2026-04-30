'use strict';

// Counters are aggregates over a fresh walk of events/*.json. These
// tests fixture a small directory and assert the cardinalities, then
// add a corrupt file to confirm parse_errors is reported (instead of
// poisoning the whole run).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let tmp;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-stats-'));
  await fs.mkdir(path.join(tmp, 'events'));
  process.env.GITDONE_DATA_DIR = tmp;
  for (const m of ['../../src/config', '../../src/stats']) {
    delete require.cache[require.resolve(m)];
  }
});
after(async () => { if (tmp) await fs.rm(tmp, { recursive: true, force: true }); });

async function writeEvent(id, ev) {
  await fs.writeFile(path.join(tmp, 'events', `${id}.json`), JSON.stringify(ev));
}

test('collect: empty data dir returns zero counters and the snapshot timestamp', async () => {
  const { collect } = require('../../src/stats');
  const s = await collect();
  assert.equal(s.events_total, 0);
  assert.equal(s.unique_organisers, 0);
  assert.equal(s.unique_recipients_named, 0);
  assert.match(s.snapshot_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('collect: every category is counted on a populated set', async () => {
  // Workflow, completed (all steps done).
  await writeEvent('w_done', {
    id: 'w_done', type: 'event', initiator: 'org1@x.com',
    activated_at: '2026-01-01T00:00:00Z',
    completion: { status: 'complete', completed_at: '2026-01-05T00:00:00Z' },
    steps: [
      { id: 'a', participant: 'p1@x.com', status: 'complete' },
      { id: 'b', participant: 'p2@x.com', status: 'complete' },
    ],
  });
  // Workflow, closed early (organiser cut short — 1 of 2 done).
  await writeEvent('w_cut', {
    id: 'w_cut', type: 'event', initiator: 'org1@x.com',
    activated_at: '2026-01-01T00:00:00Z',
    completion: { status: 'complete', completed_at: '2026-01-05T00:00:00Z', closed_by: 'initiator' },
    steps: [
      { id: 'a', participant: 'p1@x.com', status: 'complete' },
      { id: 'b', participant: 'p3@x.com', status: 'pending' },
    ],
  });
  // Workflow, open.
  await writeEvent('w_open', {
    id: 'w_open', type: 'event', initiator: 'org2@x.com',
    activated_at: '2026-04-01T00:00:00Z',
    steps: [{ id: 'a', participant: 'p4@x.com', status: 'pending' }],
  });
  // Workflow, pending activation.
  await writeEvent('w_pend', {
    id: 'w_pend', type: 'event', initiator: 'org2@x.com',
    activated_at: null, created_at: '2026-04-29T00:00:00Z',
    steps: [{ id: 'a', participant: 'p5@x.com', status: 'pending' }],
  });
  // Workflow, archived.
  await writeEvent('w_arch', {
    id: 'w_arch', type: 'event', initiator: 'org1@x.com',
    activated_at: '2026-01-01T00:00:00Z',
    archived_at: '2026-04-01T00:00:00Z',
    steps: [{ id: 'a', participant: 'p1@x.com', status: 'pending' }],
  });
  // Crypto declaration, completed.
  await writeEvent('d_done', {
    id: 'd_done', type: 'crypto', mode: 'declaration', initiator: 'org3@x.com',
    activated_at: '2026-01-01T00:00:00Z',
    signer: 'witness@x.com',
    completion: { status: 'complete', completed_at: '2026-01-02T00:00:00Z' },
  });
  // Crypto attestation, with 3 replies.
  await writeEvent('att', {
    id: 'att', type: 'crypto', mode: 'attestation', initiator: 'org3@x.com',
    activated_at: '2026-01-01T00:00:00Z',
    threshold: 5, dedup: 'unique',
    replies: [{ sender_hash: 'a' }, { sender_hash: 'b' }, { sender_hash: 'c' }],
  });

  const { collect } = require('../../src/stats');
  const s = await collect();
  assert.equal(s.events_total, 7);
  // Organisers: org1, org2, org3 (case-insensitive lower).
  assert.equal(s.unique_organisers, 3);
  // Named recipients: workflow participants + declaration signer.
  // p1, p2, p3, p4, p5, witness — 6. (Attestation NOT counted.)
  assert.equal(s.unique_recipients_named, 6);
  assert.deepEqual(s.by_type, { event: 5, declaration: 1, attestation: 1 });
  assert.deepEqual(s.by_status, {
    pending_activation: 1, open: 2, completed: 2, closed_early: 1, archived: 1,
  });
  assert.deepEqual(s.completed_vs_incomplete, { completed: 2, incomplete: 5 });
  assert.equal(s.workflow_step_count_total, 7); // 2 + 2 + 1 + 1 + 1
  assert.equal(s.workflow_step_completed_total, 3); // w_done x2 + w_cut x1
  assert.equal(s.attestation_replies_total, 3);
  assert.equal(s.parse_errors, 0);
});

test('collect: corrupt JSON file is counted, not thrown', async () => {
  await fs.writeFile(path.join(tmp, 'events', 'bad.json'), '{not valid');
  const { collect } = require('../../src/stats');
  const s = await collect();
  assert.equal(s.parse_errors, 1);
  // Other counts still reflect the valid files.
  assert.equal(s.events_total, 7);
});
