'use strict';

// Sweep covers three time-based transitions that are awkward to trigger
// from integration tests (the real system runs hourly via systemd).
// These tests drive the pure functions directly with synthetic times.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let tmp;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-sweep-'));
  await fs.mkdir(path.join(tmp, 'events'));
  await fs.mkdir(path.join(tmp, 'activation_tokens'));
  process.env.GITDONE_DATA_DIR = tmp;
  for (const m of ['../../src/config', '../../src/event-store', '../../src/sweep']) {
    delete require.cache[require.resolve(m)];
  }
});

after(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

async function writeEvent(id, ev) {
  await fs.writeFile(path.join(tmp, 'events', `${id}.json`), JSON.stringify(ev, null, 2));
}
async function readEvent(id) {
  return JSON.parse(await fs.readFile(path.join(tmp, 'events', `${id}.json`), 'utf8'));
}
async function eventExists(id) {
  try { await fs.stat(path.join(tmp, 'events', `${id}.json`)); return true; }
  catch { return false; }
}

test('referenceClockMs: uses max pending deadline when set', () => {
  const { referenceClockMs } = require('../../src/sweep');
  const ms = referenceClockMs({
    activated_at: '2026-01-01T00:00:00Z',
    type: 'event',
    steps: [
      { status: 'complete', deadline: '2030-01-01T00:00:00Z' }, // ignored
      { status: 'pending', deadline: '2026-02-01T00:00:00Z' },
      { status: 'pending', deadline: '2026-03-15T00:00:00Z' }, // max pending
    ],
  });
  assert.equal(ms, new Date('2026-03-15T00:00:00Z').getTime());
});

test('referenceClockMs: falls back to activated_at when no deadlines', () => {
  const { referenceClockMs } = require('../../src/sweep');
  const ms = referenceClockMs({
    activated_at: '2026-01-01T00:00:00Z',
    type: 'event',
    steps: [
      { status: 'pending' }, { status: 'pending' },
    ],
  });
  assert.equal(ms, new Date('2026-01-01T00:00:00Z').getTime());
});

test('referenceClockMs: null for never-activated events', () => {
  const { referenceClockMs } = require('../../src/sweep');
  assert.equal(referenceClockMs({ activated_at: null }), null);
});

test('sweepPendingActivation deletes events older than TTL', async () => {
  const { sweepPendingActivation } = require('../../src/sweep');
  await writeEvent('staleactiv', {
    id: 'staleactiv', type: 'event', activated_at: null,
    created_at: '2026-01-01T00:00:00Z', initiator: 'a@b.com',
  });
  await writeEvent('freshactiv', {
    id: 'freshactiv', type: 'event', activated_at: null,
    // 30 min old at the synthetic "now" below
    created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    initiator: 'c@d.com',
  });
  await writeEvent('alreadyactiv', {
    id: 'alreadyactiv', type: 'event', activated_at: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
  });
  const now = new Date('2026-01-05T00:00:00Z').getTime(); // 4 days later
  const deleted = await sweepPendingActivation({ now, ttlHours: 72 });
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].id, 'staleactiv');
  assert.equal(await eventExists('staleactiv'), false);
  assert.equal(await eventExists('freshactiv'), true);
  assert.equal(await eventExists('alreadyactiv'), true);
});

test('findNewlyOverdue picks events past threshold, skips already-nudged', async () => {
  const { findNewlyOverdue } = require('../../src/sweep');
  const now = new Date('2026-06-01T00:00:00Z').getTime();
  // Past threshold, not nudged → picked.
  await writeEvent('overdueA', {
    id: 'overdueA', type: 'event',
    activated_at: '2026-01-01T00:00:00Z',  // ~5 months ago
    created_at: '2026-01-01T00:00:00Z', initiator: 'a@b.com',
    steps: [{ status: 'pending', participant: 'p@x.com', deadline: '2026-02-01T00:00:00Z' }],
  });
  // Already nudged → skipped.
  await writeEvent('overdueNudged', {
    id: 'overdueNudged', type: 'event',
    activated_at: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z', initiator: 'a@b.com',
    nudged_overdue_at: '2026-05-20T00:00:00Z',
    steps: [{ status: 'pending', participant: 'p@x.com', deadline: '2026-02-01T00:00:00Z' }],
  });
  // Under threshold → skipped.
  await writeEvent('fresh', {
    id: 'fresh', type: 'event',
    activated_at: '2026-05-30T00:00:00Z',
    created_at: '2026-05-30T00:00:00Z', initiator: 'a@b.com',
    steps: [{ status: 'pending', participant: 'p@x.com' }],
  });
  const picked = await findNewlyOverdue({ now, overdueNudgeDays: 14 });
  const ids = picked.map((p) => p.event.id);
  assert.ok(ids.includes('overdueA'));
  assert.ok(!ids.includes('overdueNudged'));
  assert.ok(!ids.includes('fresh'));
});

test('archiveStale sets archived_at on stale events only', async () => {
  const { archiveStale } = require('../../src/sweep');
  const now = new Date('2026-06-01T00:00:00Z').getTime();
  // Way past archive threshold (45d) → archived.
  await writeEvent('staleArch', {
    id: 'staleArch', type: 'event',
    activated_at: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z', initiator: 'a@b.com',
    steps: [{ status: 'pending', participant: 'p@x.com' }],
  });
  // Complete event → never archived (it's already terminal).
  await writeEvent('done', {
    id: 'done', type: 'event',
    activated_at: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z', initiator: 'a@b.com',
    completion: { status: 'complete', completed_at: '2026-01-05T00:00:00Z' },
    steps: [{ status: 'complete', participant: 'p@x.com' }],
  });
  // Already archived → not re-stamped.
  await writeEvent('wasArch', {
    id: 'wasArch', type: 'event',
    activated_at: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z', initiator: 'a@b.com',
    archived_at: '2026-04-01T00:00:00Z',
    steps: [{ status: 'pending', participant: 'p@x.com' }],
  });
  const archived = await archiveStale({ now, archiveDays: 45 });
  const ids = archived.map((a) => a.id);
  assert.ok(ids.includes('staleArch'));
  assert.ok(!ids.includes('done'));
  assert.ok(!ids.includes('wasArch'));
  const after = await readEvent('staleArch');
  assert.ok(after.archived_at);
  assert.equal(after.archive_reason, 'auto_stale');
});

test('unarchive clears archived_at', async () => {
  const { unarchive } = require('../../src/sweep');
  await writeEvent('toRestore', {
    id: 'toRestore', type: 'event',
    activated_at: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z', initiator: 'a@b.com',
    archived_at: '2026-05-01T00:00:00Z', archive_reason: 'auto_stale',
    steps: [{ status: 'pending', participant: 'p@x.com' }],
  });
  const restored = await unarchive('toRestore');
  assert.equal(restored.archived_at, undefined);
  assert.equal(restored.archive_reason, undefined);
  const onDisk = await readEvent('toRestore');
  assert.equal(onDisk.archived_at, undefined);
});

test('shouldCount* gates on archived_at', () => {
  delete require.cache[require.resolve('../../src/completion')];
  const { shouldCount } = require('../../src/completion');
  const event = {
    id: 'arx', type: 'event', min_trust_level: 'verified',
    salt: 'z'.repeat(64),
    activated_at: '2026-01-01T00:00:00Z',
    archived_at: '2026-05-01T00:00:00Z',
    steps: [{ id: 'one', name: 'one', participant: 'p@x.com', status: 'pending', depends_on: [] }],
  };
  const commit = {
    event_id: 'arx', step_id: 'one', trust_level: 'verified',
    participant_match: true, has_attachment: false,
  };
  const r = shouldCount(event, commit);
  assert.equal(r.count, false);
  assert.equal(r.reason, 'event archived');
});
