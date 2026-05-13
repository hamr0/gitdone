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
    activated_at: '2026-01-01T00:00:00Z',
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
    activated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function mkAttestation(overrides = {}) {
  return {
    id: 'ev3', type: 'crypto', mode: 'attestation',
    initiator: 'organiser@x.com',
    threshold: 3, dedup: 'unique', replies: [],
    salt: 'c'.repeat(64),
    activated_at: '2026-01-01T00:00:00Z',
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

test('attestation accumulating: every reply counts; threshold stamps anchor but does not lock', () => {
  let ev = mkAttestation({ threshold: 3, dedup: 'accumulating' });
  for (let i = 0; i < 3; i++) {
    const r = applyReply(ev, mkCommit({ sender_hash: 'same', step_id: null, sequence: i + 1 }));
    ev = r.event;
  }
  // Accumulating does NOT lock at threshold — completion stays open.
  assert.equal(isComplete(ev), false);
  // ...but the proof anchor is stamped on first crossing.
  assert.ok(ev.threshold_reached_at, 'threshold_reached_at stamped');
  assert.equal(ev.threshold_reached_count, 3);
  assert.equal(ev.replies.length, 3);
});

test('attestation accumulating: late reply past threshold still counts and extends replies[]', () => {
  let ev = mkAttestation({ threshold: 2, dedup: 'accumulating' });
  for (let i = 0; i < 2; i++) {
    const r = applyReply(ev, mkCommit({ sender_hash: 's' + i, step_id: null, sequence: i + 1 }));
    ev = r.event;
  }
  const stampedAt = ev.threshold_reached_at;
  assert.ok(stampedAt, 'first crossing stamped');
  // Late reply past threshold
  const r = applyReply(ev, mkCommit({ sender_hash: 's2', step_id: null, sequence: 3 }));
  assert.equal(r.applied, true, 'late reply still counts for accumulating');
  ev = r.event;
  assert.equal(ev.replies.length, 3, 'late reply extends replies[]');
  assert.equal(ev.threshold_reached_at, stampedAt, 'threshold_reached_at NOT re-stamped');
  assert.equal(ev.threshold_reached_count, 2, 'threshold_reached_count is the value at first crossing');
  assert.equal(isComplete(ev), false);
});

test('attestation accumulating: threshold_reached_at stamped on first crossing only', () => {
  let ev = mkAttestation({ threshold: 1, dedup: 'accumulating' });
  const r1 = applyReply(ev, mkCommit({ sender_hash: 'a', step_id: null, sequence: 1 }), { now: '2026-05-01T00:00:00Z' });
  ev = r1.event;
  assert.equal(ev.threshold_reached_at, '2026-05-01T00:00:00Z');
  const r2 = applyReply(ev, mkCommit({ sender_hash: 'b', step_id: null, sequence: 2 }), { now: '2026-05-02T00:00:00Z' });
  ev = r2.event;
  assert.equal(ev.threshold_reached_at, '2026-05-01T00:00:00Z', 'not re-stamped on later replies');
});

test('attestation unique: post-threshold reply rejected with already complete', () => {
  let ev = mkAttestation({ threshold: 1, dedup: 'unique' });
  const r1 = applyReply(ev, mkCommit({ sender_hash: 's1', step_id: null, sequence: 1 }));
  ev = r1.event;
  assert.equal(isComplete(ev), true);
  const r2 = applyReply(ev, mkCommit({ sender_hash: 's2', step_id: null, sequence: 2 }));
  assert.equal(r2.applied, false);
  assert.match(r2.decision.reason, /already complete/);
});

test('attestation: initiator self-reply rejected for all three dedup rules', () => {
  for (const dedup of ['unique', 'latest', 'accumulating']) {
    const ev = mkAttestation({ dedup });
    const sigHash = require('../../src/completion').hashSender(ev.initiator, ev.salt);
    const r = applyReply(ev, mkCommit({ sender_hash: sigHash, step_id: null, sequence: 1 }));
    assert.equal(r.applied, false, `dedup=${dedup}: initiator self-reply must not count`);
    assert.match(r.decision.reason, /initiator|self-reply/, `dedup=${dedup}: reason mentions initiator`);
  }
});

test('attestation unique/latest: low trust rejected; accumulating accepts', () => {
  // Trust policy is now dedup-derived. unique/latest require DKIM-verified;
  // accumulating counts both verified and unverified.
  const uniq = mkAttestation({ dedup: 'unique' });
  const r1 = applyReply(uniq, mkCommit({ trust_level: 'unverified', step_id: null, sender_hash: 's1' }));
  assert.equal(r1.applied, false);
  assert.match(r1.decision.reason, /DKIM-verified/);

  const latest = mkAttestation({ dedup: 'latest' });
  const r2 = applyReply(latest, mkCommit({ trust_level: 'unverified', step_id: null, sender_hash: 's1' }));
  assert.equal(r2.applied, false);

  const accum = mkAttestation({ dedup: 'accumulating' });
  const r3 = applyReply(accum, mkCommit({ trust_level: 'unverified', step_id: null, sender_hash: 's1' }));
  assert.equal(r3.applied, true);
});

// Regression: strict-mode attestation under unique dedup must flip
// event.completion.status to 'complete' on the threshold-tripping reply.
// Before this fix, the strict branch checked `!event.completion`, which
// was already truthy ({status:'open',...}) after the first reply, so
// completion never flipped. The dashboard showed "active" forever and
// post-threshold attestors weren't being rejected by shouldCount's
// already-complete gate.
test('strict attestation unique: threshold-tripping reply flips completion to complete', () => {
  const DOC_HASH = 'sha256:' + 'a'.repeat(64);
  let ev = mkAttestation({
    threshold: 2,
    dedup: 'unique',
    reference_url: 'https://example.com/doc',
    reference_docs: [{ filename: 'doc.pdf', sha256: DOC_HASH, size: 100 }],
  });
  const matchingAttachment = [{ filename: 'doc.pdf', sha256: DOC_HASH, size: 100 }];

  // Attestor 1 signs the doc. Threshold not yet reached.
  const r1 = applyReply(ev, mkCommit({
    sender_hash: 's1', step_id: null, sequence: 1,
    attachments: matchingAttachment,
  }), { now: '2026-05-12T16:00:00Z' });
  assert.equal(r1.applied, true);
  assert.equal(r1.completedEvent, false);
  assert.equal(isComplete(r1.event), false);
  // After first reply the completion record exists but is open — this is
  // the state the (pre-fix) bug then read as "already complete" via
  // `!event.completion`.
  assert.equal(r1.event.completion.status, 'open');
  ev = r1.event;

  // Attestor 2 signs — threshold of 2 is now reached and completion MUST
  // flip to 'complete'.
  const r2 = applyReply(ev, mkCommit({
    sender_hash: 's2', step_id: null, sequence: 2,
    attachments: matchingAttachment,
  }), { now: '2026-05-12T16:03:00Z' });
  assert.equal(r2.applied, true);
  assert.equal(r2.completedEvent, true, 'completedEvent must fire so receive.js sends the proof email');
  assert.equal(r2.event.completion.status, 'complete', 'completion.status must flip to "complete"');
  assert.equal(r2.event.completion.completed_at, '2026-05-12T16:03:00Z');
  assert.equal(r2.event.completion.commit_sequence, 2);
  assert.equal(isComplete(r2.event), true);

  // Post-completion gating: a third unique attestor must now be rejected
  // by shouldCount's already-complete branch (was silently overcounting
  // before the fix).
  const r3 = applyReply(r2.event, mkCommit({
    sender_hash: 's3', step_id: null, sequence: 3,
    attachments: matchingAttachment,
  }));
  assert.equal(r3.applied, false);
  assert.match(r3.decision.reason, /already complete/);
});

// Module 4e — strict attestation persists the attestor email on the
// reply that fills their bucket so the proof email can reach them.
// Loose attestation MUST NOT (anonymity-friendly posture is the whole
// point of the loose mode). attestor_emails_redacted_at blocks new
// stores after the one-shot completion notification has fired.
test('strict attestation 4e: stores attestor email on bucket-completing reply', () => {
  const H = 'sha256:' + 'b'.repeat(64);
  let ev = mkAttestation({
    threshold: 2,
    dedup: 'unique',
    reference_url: 'https://example.com/x',
    reference_docs: [{ filename: 'x.pdf', sha256: H, size: 10 }],
  });
  const attach = [{ filename: 'x.pdf', sha256: H, size: 10 }];

  // Bucket-completing reply stores the email.
  const r = applyReply(ev, mkCommit({
    sender_hash: 's1', step_id: null, sequence: 1,
    attachments: attach, sender_email: 'alice@gmail.com',
  }));
  assert.equal(r.applied, true);
  assert.equal(r.event.attestor_progress.s1.complete, true);
  assert.equal(r.event.attestor_progress.s1.email, 'alice@gmail.com');
});

// Module 6.5 — under strict mode, a reply only counts if it adds at
// least one new manifest hash to the attestor's bucket. Re-signing
// the same doc set goes to audit only. This makes strict counting
// consistent across all three dedup rules: a signer is a signer,
// counted once when their bucket fills.
test('strict attestation 6.5: re-signing an already-complete bucket rejects as strict_already_signed', () => {
  const H = 'sha256:' + 'd'.repeat(64);
  const attach = [{ filename: 'x.pdf', sha256: H, size: 10 }];
  // Seed event with an attestor whose bucket is already complete.
  let ev = mkAttestation({
    threshold: 5,
    dedup: 'accumulating', // would normally count every reply
    reference_url: 'https://example.com/x',
    reference_docs: [{ filename: 'x.pdf', sha256: H, size: 10 }],
    attestor_progress: {
      s1: {
        signed_doc_hashes: [H],
        complete: true,
        completed_at: '2026-05-13T00:00:00Z',
        first_seen_at: '2026-05-13T00:00:00Z',
        sender_domain: 'gmail.com',
      },
    },
    replies: [{ sequence: 1, sender_hash: 's1', trust_level: 'verified',
                received_at: '2026-05-13T00:00:00Z', sender_domain: 'gmail.com' }],
  });
  // Same sender re-signs the same doc — bucket already covers it.
  const r = applyReply(ev, mkCommit({
    sender_hash: 's1', step_id: null, sequence: 2,
    attachments: attach,
  }));
  assert.equal(r.applied, false, 'redundant re-sign must NOT count');
  assert.equal(r.decision.reason, 'strict_already_signed');
});

test('strict attestation 6.5: partial bucket + reply with same hash also rejects', () => {
  const H1 = 'sha256:' + 'e'.repeat(64);
  const H2 = 'sha256:' + 'f'.repeat(64);
  // Two-doc manifest, attestor has signed doc1 only.
  let ev = mkAttestation({
    threshold: 2,
    dedup: 'unique',
    reference_url: 'https://example.com/x',
    reference_docs: [
      { filename: 'a.pdf', sha256: H1, size: 10 },
      { filename: 'b.pdf', sha256: H2, size: 10 },
    ],
    attestor_progress: {
      s1: { signed_doc_hashes: [H1], complete: false, first_seen_at: '2026-05-13T00:00:00Z' },
    },
    replies: [{ sequence: 1, sender_hash: 's1', trust_level: 'verified',
                received_at: '2026-05-13T00:00:00Z', sender_domain: 'gmail.com' }],
  });
  // Re-sends doc1 only — already in bucket. Rejected.
  const r1 = applyReply(ev, mkCommit({
    sender_hash: 's1', step_id: null, sequence: 2,
    attachments: [{ filename: 'a.pdf', sha256: H1, size: 10 }],
  }));
  assert.equal(r1.applied, false);
  assert.equal(r1.decision.reason, 'strict_already_signed');
  // Now sends doc2 — adds a new hash, bucket completes. Counted.
  const r2 = applyReply(ev, mkCommit({
    sender_hash: 's1', step_id: null, sequence: 3,
    attachments: [{ filename: 'b.pdf', sha256: H2, size: 10 }],
  }));
  assert.equal(r2.applied, true);
  assert.equal(r2.event.attestor_progress.s1.complete, true);
});

test('strict attestation 4e: post-redaction reply does NOT re-introduce email', () => {
  const H = 'sha256:' + 'c'.repeat(64);
  // accumulating dedup so we can keep applying past threshold
  let ev = mkAttestation({
    threshold: 1,
    dedup: 'accumulating',
    reference_url: 'https://example.com/x',
    reference_docs: [{ filename: 'x.pdf', sha256: H, size: 10 }],
    attestor_emails_redacted_at: '2026-05-12T17:00:00Z',
  });
  const r = applyReply(ev, mkCommit({
    sender_hash: 's-late', step_id: null, sequence: 1,
    attachments: [{ filename: 'x.pdf', sha256: H, size: 10 }],
    sender_email: 'late@gmail.com',
    trust_level: 'verified',
  }));
  assert.equal(r.applied, true);
  assert.equal(r.event.attestor_progress['s-late'].complete, true);
  assert.equal(r.event.attestor_progress['s-late'].email, null, 'must NOT store email post-redact');
});

test('loose attestation 4e: never stores attestor email (anonymity-friendly)', () => {
  // No reference_url + reference_docs → loose mode, not strict.
  let ev = mkAttestation({ threshold: 2, dedup: 'unique' });
  const r = applyReply(ev, mkCommit({
    sender_hash: 's1', step_id: null, sequence: 1,
    sender_email: 'alice@gmail.com',
  }));
  assert.equal(r.applied, true);
  // Loose attestation uses the replies[] path, no attestor_progress entry.
  assert.equal(r.event.attestor_progress, undefined);
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
