'use strict';

// 1.J unit tests — state transitions are pure, so we can exhaustively
// cover the decision tree without any I/O.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  shouldCount,
  applyReply,
  applyDedup,
  isComplete,
  firstPendingStep,
  meetsTrust,
  hashSender,
} = require('../../src/completion');

// -- builders --

// Default fixture = two-step chain (step 'two' depends on 'one'). Tests
// that want the old non-sequential behaviour pass `depends_on: []` for
// both steps via overrides.
function mkWorkflow(overrides = {}) {
  return {
    id: 'ev1', type: 'event', min_trust_level: 'verified',
    salt: 'a'.repeat(64),
    steps: [
      { id: 'one', name: 'one', participant: 'one@x.com', status: 'pending', depends_on: [] },
      { id: 'two', name: 'two', participant: 'two@x.com', status: 'pending', depends_on: ['one'] },
    ],
    ...overrides,
  };
}

function mkDeclaration(overrides = {}) {
  return {
    id: 'ev2', type: 'crypto', mode: 'declaration', min_trust_level: 'verified',
    signer: 'w@x.com',
    salt: 'b'.repeat(64),
    ...overrides,
  };
}

function mkAttestation(overrides = {}) {
  return {
    id: 'ev3', type: 'crypto', mode: 'attestation', min_trust_level: 'verified',
    threshold: 3, dedup: 'unique', allow_anonymous: false, replies: [],
    salt: 'c'.repeat(64),
    ...overrides,
  };
}

function mkCommit(overrides = {}) {
  return {
    sequence: 1, trust_level: 'verified', participant_match: true,
    step_id: 'one', sender_hash: 'h-one', sender_domain: 'x.com',
    received_at: '2026-04-19T00:00:00Z',
    ...overrides,
  };
}

// -- trust comparator --

test('meetsTrust: strict ordering', () => {
  const ev = { min_trust_level: 'authorized' };
  assert.equal(meetsTrust({ trust_level: 'verified' }, ev), true);
  assert.equal(meetsTrust({ trust_level: 'authorized' }, ev), true);
  assert.equal(meetsTrust({ trust_level: 'unverified' }, ev), false);
  const strict = { min_trust_level: 'verified' };
  assert.equal(meetsTrust({ trust_level: 'forwarded' }, strict), false);
});

// -- workflow with dependency graph --

test('workflow: step with unmet deps does not count', () => {
  const ev = mkWorkflow();   // two depends on one; one is pending
  assert.equal(shouldCount(ev, mkCommit({ step_id: 'one' })).count, true);
  const blocked = shouldCount(ev, mkCommit({ step_id: 'two' }));
  assert.equal(blocked.count, false);
  assert.match(blocked.reason, /unmet dependencies/);
});

test('workflow: no-dependency steps both count independently', () => {
  const ev = mkWorkflow({
    steps: [
      { id: 'one', participant: 'a@x.com', status: 'pending', depends_on: [] },
      { id: 'two', participant: 'b@x.com', status: 'pending', depends_on: [] },
    ],
  });
  assert.equal(shouldCount(ev, mkCommit({ step_id: 'two' })).count, true);
});

test('workflow: step requires_attachment blocks when commit has none', () => {
  const ev = mkWorkflow({
    steps: [
      { id: 'one', participant: 'a@x.com', status: 'pending', depends_on: [], requires_attachment: true },
    ],
  });
  const r = shouldCount(ev, mkCommit({ step_id: 'one', has_attachment: false }));
  assert.equal(r.count, false);
  assert.equal(r.reason, 'missing_attachment');
  assert.equal(r.step.id, 'one');   // step is returned so caller can compose the reply
});

test('workflow: step requires_attachment counts when has_attachment=true', () => {
  const ev = mkWorkflow({
    steps: [
      { id: 'one', participant: 'a@x.com', status: 'pending', depends_on: [], requires_attachment: true },
    ],
  });
  assert.equal(shouldCount(ev, mkCommit({ step_id: 'one', has_attachment: true })).count, true);
});

test('workflow: step without requires_attachment ignores has_attachment flag', () => {
  const ev = mkWorkflow({
    steps: [
      { id: 'one', participant: 'a@x.com', status: 'pending', depends_on: [] },
    ],
  });
  assert.equal(shouldCount(ev, mkCommit({ step_id: 'one', has_attachment: false })).count, true);
});

test('workflow: low trust does not count', () => {
  const ev = mkWorkflow();
  const r = shouldCount(ev, mkCommit({ trust_level: 'unverified' }));
  assert.equal(r.count, false);
  assert.match(r.reason, /trust/);
});

test('workflow: participant_match=false does not count', () => {
  const ev = mkWorkflow();
  const r = shouldCount(ev, mkCommit({ participant_match: false }));
  assert.equal(r.count, false);
  assert.match(r.reason, /participant/);
});

test('workflow: completing both steps marks event complete', () => {
  let ev = mkWorkflow();
  let r = applyReply(ev, mkCommit({ sequence: 1, step_id: 'one' }));
  assert.equal(r.applied, true);
  assert.equal(r.event.steps[0].status, 'complete');
  assert.equal(isComplete(r.event), false);
  r = applyReply(r.event, mkCommit({ sequence: 2, step_id: 'two', sender_hash: 'h-two' }));
  assert.equal(r.applied, true);
  assert.equal(r.event.steps[1].status, 'complete');
  assert.equal(isComplete(r.event), true);
  assert.equal(r.event.completion.commit_sequence, 2);
});

test('workflow: step completed marks completed_at + commit_sequence', () => {
  const ev = mkWorkflow();
  const r = applyReply(ev, mkCommit({ sequence: 7 }), { now: '2026-05-01T00:00:00Z' });
  assert.equal(r.event.steps[0].completed_at, '2026-05-01T00:00:00Z');
  assert.equal(r.event.steps[0].commit_sequence, 7);
});

test('workflow: step already complete is rejected', () => {
  const ev = mkWorkflow();
  const r1 = applyReply(ev, mkCommit());
  const r2 = applyReply(r1.event, mkCommit({ sequence: 2 }));
  assert.equal(r2.applied, false);
  assert.match(r2.decision.reason, /already complete/);
});

test('firstPendingStep: returns null when all done', () => {
  const ev = mkWorkflow({
    steps: [
      { id: 'one', status: 'complete' },
      { id: 'two', status: 'complete' },
    ],
  });
  assert.equal(firstPendingStep(ev), null);
});

// -- declaration --

test('declaration: matching signer counts and completes', () => {
  const ev = mkDeclaration();
  const sig_hash = hashSender('w@x.com', ev.salt);
  const r = applyReply(ev, mkCommit({ sender_hash: sig_hash, step_id: null, sequence: 4 }));
  assert.equal(r.applied, true);
  assert.equal(isComplete(r.event), true);
  assert.equal(r.event.completion.commit_sequence, 4);
});

test('declaration: wrong sender does not count', () => {
  const ev = mkDeclaration();
  const wrong = hashSender('random@other.com', ev.salt);
  const r = applyReply(ev, mkCommit({ sender_hash: wrong, step_id: null }));
  assert.equal(r.applied, false);
  assert.match(r.decision.reason, /signer/);
  assert.equal(isComplete(r.event), false);
});

test('declaration: second reply after completion does not re-count', () => {
  const ev = mkDeclaration();
  const sig_hash = hashSender('w@x.com', ev.salt);
  const r1 = applyReply(ev, mkCommit({ sender_hash: sig_hash, step_id: null, sequence: 4 }));
  const r2 = applyReply(r1.event, mkCommit({ sender_hash: sig_hash, step_id: null, sequence: 5 }));
  assert.equal(r2.applied, false);
  assert.match(r2.decision.reason, /already signed/);
});

// -- attestation --

test('attestation unique: distinct senders count toward threshold', () => {
  let ev = mkAttestation({ threshold: 3, dedup: 'unique' });
  for (let i = 0; i < 3; i++) {
    const r = applyReply(ev, mkCommit({ sender_hash: `s${i}`, step_id: null, sequence: i + 1 }));
    assert.equal(r.applied, true);
    ev = r.event;
  }
  assert.equal(isComplete(ev), true);
  assert.equal(ev.replies.length, 3);
});

test('attestation unique: duplicate sender does not advance count', () => {
  let ev = mkAttestation({ threshold: 2, dedup: 'unique' });
  for (let i = 0; i < 3; i++) {
    const r = applyReply(ev, mkCommit({ sender_hash: 'same-sender', step_id: null, sequence: i + 1 }));
    assert.equal(r.applied, true);   // always applied (audit), but count is distinct
    ev = r.event;
  }
  assert.equal(isComplete(ev), false, 'threshold not met via one distinct sender');
  // replies keeps all entries for unique dedup
  assert.equal(ev.replies.length, 3);
});

test('attestation latest: replies[] pruned to one per sender', () => {
  let ev = mkAttestation({ threshold: 5, dedup: 'latest' });
  for (let i = 0; i < 4; i++) {
    const r = applyReply(ev, mkCommit({ sender_hash: 's1', step_id: null, sequence: i + 1, received_at: `2026-04-1${i}T00:00:00Z` }));
    ev = r.event;
  }
  assert.equal(ev.replies.length, 1, 'latest dedup keeps one entry per sender');
  assert.equal(ev.replies[0].sequence, 4);
});

test('attestation accumulating: every reply counts, no threshold dedup', () => {
  let ev = mkAttestation({ threshold: 3, dedup: 'accumulating' });
  for (let i = 0; i < 3; i++) {
    const r = applyReply(ev, mkCommit({ sender_hash: 'same', step_id: null, sequence: i + 1 }));
    ev = r.event;
  }
  assert.equal(isComplete(ev), true);
  assert.equal(ev.replies.length, 3);
});

test('attestation: low trust rejected unless allow_anonymous', () => {
  const strict = mkAttestation({ allow_anonymous: false });
  const r1 = applyReply(strict, mkCommit({ trust_level: 'unverified', step_id: null }));
  assert.equal(r1.applied, false);

  const loose = mkAttestation({ allow_anonymous: true });
  const r2 = applyReply(loose, mkCommit({ trust_level: 'unverified', step_id: null }));
  assert.equal(r2.applied, true);
});

test('attestation: replies after completion still commit but do not re-count', () => {
  let ev = mkAttestation({ threshold: 1, dedup: 'unique' });
  const r1 = applyReply(ev, mkCommit({ sender_hash: 's1', step_id: null, sequence: 1 }));
  assert.equal(isComplete(r1.event), true);
  const r2 = applyReply(r1.event, mkCommit({ sender_hash: 's2', step_id: null, sequence: 2 }));
  assert.equal(r2.applied, false);
  assert.match(r2.decision.reason, /already complete/);
});

// -- applyDedup direct --

test('applyDedup accumulating: count == replies.length', () => {
  const replies = [
    { sender_hash: 'a', sequence: 1 },
    { sender_hash: 'a', sequence: 2 },
    { sender_hash: 'b', sequence: 3 },
  ];
  assert.deepEqual(applyDedup(replies, 'accumulating'), { replies, count: 3 });
});

test('applyDedup unique: counts distinct senders, keeps all replies', () => {
  const replies = [
    { sender_hash: 'a', sequence: 1 },
    { sender_hash: 'a', sequence: 2 },
    { sender_hash: 'b', sequence: 3 },
  ];
  const r = applyDedup(replies, 'unique');
  assert.equal(r.count, 2);
  assert.equal(r.replies.length, 3);
});

test('applyDedup latest: keeps one per sender, count == distinct', () => {
  const replies = [
    { sender_hash: 'a', sequence: 1 },
    { sender_hash: 'a', sequence: 2 },
    { sender_hash: 'b', sequence: 3 },
  ];
  const r = applyDedup(replies, 'latest');
  assert.equal(r.count, 2);
  assert.equal(r.replies.length, 2);
  // the `a` entry kept is the latest-inserted (seq 2)
  const aEntry = r.replies.find((x) => x.sender_hash === 'a');
  assert.equal(aEntry.sequence, 2);
});
