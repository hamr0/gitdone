'use strict';

// 1.I unit tests — body composers produce the right content for each
// participant type. End-to-end sendmail behaviour is covered by the
// integration tests in tests/integration/web-notifications.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { workflowStepBody, declarationSignerBody, renderOrganiserStepList, renderProofBlock } = require('../../src/notifications');

test('workflowStepBody: names the step, position, reply-to, and organiser', () => {
  const body = workflowStepBody({
    event: { id: 'abc123xyz000', title: 'Q2 sign-off', initiator: 'boss@ex.com' },
    step: { id: 'legal', name: 'Legal review', participant: 'legal@ex.com' },
    stepIndex: 1,
    totalSteps: 3,
  });
  assert.match(body, /Event: Q2 sign-off/);
  assert.match(body, /Your step: Legal review \(step 2 of 3\)/);
  assert.match(body, /Organiser: boss@ex\.com/);
  assert.match(body, /Reply from legal@ex\.com to:/);
  assert.match(body, /event\+abc123xyz000-legal@/);
  assert.doesNotMatch(body, /Attachment:/);
  assert.doesNotMatch(body, /Aspirational date:/);
});

test('workflowStepBody: surfaces attachment + aspirational date in metadata block', () => {
  const body = workflowStepBody({
    event: { id: 'e1', title: 't', initiator: 'o@x.com' },
    step: {
      id: 's', name: 'Sign', participant: 'p@x.com',
      deadline: '2026-05-12', requires_attachment: true,
    },
    stepIndex: 0,
    totalSteps: 1,
  });
  assert.match(body, /Attachment: required/);
  assert.match(body, /Aspirational date: Tuesday, 2026-05-12/);
  // Both fields render before the reply-to block so the participant
  // sees them above the fold.
  assert.ok(body.indexOf('Attachment: required') < body.indexOf('Reply from'));
  assert.ok(body.indexOf('Aspirational date:') < body.indexOf('Reply from'));
});

test('workflowStepBody: aspirational date accepts full ISO timestamp (legacy data)', () => {
  const body = workflowStepBody({
    event: { id: 'e1', title: 't', initiator: 'o@x.com' },
    step: {
      id: 's', name: 'Sign', participant: 'p@x.com',
      deadline: '2026-05-12T12:00:00.000Z',
    },
    stepIndex: 0,
    totalSteps: 1,
  });
  assert.match(body, /Aspirational date: Tuesday, 2026-05-12/);
});

test('declarationSignerBody: names organiser, signer, reply-to', () => {
  const body = declarationSignerBody({
    event: {
      id: 'decl01',
      title: 'Witness statement',
      initiator: 'journo@ex.com',
      signer: 'witness@ex.com',
      mode: 'declaration',
      type: 'crypto',
    },
  });
  assert.match(body, /journo@ex\.com asked you to sign/);
  assert.match(body, /Event: Witness statement/);
  assert.match(body, /Reply from witness@ex\.com to:/);
  assert.match(body, /event\+decl01@/);
  // Declaration reply-to does NOT have a -step suffix
  assert.doesNotMatch(body, /event\+decl01-/);
});

test('renderOrganiserStepList: marks active steps with ▸ and labels deps', () => {
  const event = {
    steps: [
      { id: 'a', name: 'audio', participant: 'a@x.com', deadline: '2026-05-06', depends_on: [] },
      { id: 'v', name: 'video', participant: 'v@x.com', deadline: '2026-05-07', depends_on: ['a'] },
    ],
  };
  const out = renderOrganiserStepList(event, ['a']);
  const lines = out.split('\n');
  assert.match(lines[0], /▸ 1\. audio → a@x\.com/);
  assert.match(lines[0], /deadline 2026-05-06/);
  // Non-active step gets a leading space placeholder, no ▸.
  assert.match(lines[1], /^    2\. video/);
  assert.doesNotMatch(lines[1], /▸/);
  assert.match(lines[1], /after #1/);
});

test('renderOrganiserStepList: completed status renders as DONE', () => {
  const event = {
    steps: [
      { id: 'a', name: 'audio', participant: 'a@x.com', status: 'complete', depends_on: [] },
      { id: 'v', name: 'video', participant: 'v@x.com', depends_on: ['a'] },
    ],
  };
  const out = renderOrganiserStepList(event, ['v']);
  assert.match(out, /1\. audio.*\[DONE\]/);
  assert.match(out, /▸ 2\. video.*\[pending\]/);
});

// --- proof receipt block ----------------------------------------------

const sampleVerifiedCommit = {
  schema_version: 2, sequence: 1, sender_domain: 'example.com',
  trust_level: 'verified',
  dkim: { signatures: [{ result: 'pass', domain: 'example.com', selector: 'gd1', algorithm: 'rsa-sha256', aligned: true }] },
  spf: { result: 'pass' },
  dmarc: { result: 'pass' },
  arc: { result: 'none', chain_length: 0 },
  raw_sha256: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  ots_proof_file: 'ots_proofs/commit-001.ots',
};

test('renderProofBlock for declaration is ASCII-only and includes DKIM line', () => {
  const event = { id: 'd1', type: 'crypto', mode: 'declaration', title: 'D' };
  const block = renderProofBlock(event, [sampleVerifiedCommit]);
  assert.match(block, /Cryptographic receipt/);
  assert.match(block, /DKIM\s+pass/);
  assert.match(block, /Trust\s+verified/);
  // No middle dot (U+00B7) — outbound is ASCII-only.
  assert.doesNotMatch(block, /·/);
});

test('renderProofBlock for workflow surfaces step name + sender domain per receipt', () => {
  const event = {
    id: 'w1', type: 'event', title: 'W',
    steps: [
      { id: 's1', name: 'First', participant: 'a@example.com' },
      { id: 's2', name: 'Second', participant: 'b@example.com' },
    ],
  };
  const block = renderProofBlock(event, [
    { ...sampleVerifiedCommit, step_id: 's1', sender_domain: 'a.example.com', sequence: 1 },
    { ...sampleVerifiedCommit, step_id: 's2', sender_domain: 'b.example.com', sequence: 2 },
  ]);
  assert.match(block, /Step 1: First \(a\.example\.com\)/);
  assert.match(block, /Step 2: Second \(b\.example\.com\)/);
});

test('renderProofBlock for attestation summarises modal trust + counts', () => {
  const event = { id: 'a1', type: 'crypto', mode: 'attestation', title: 'A', threshold: 3, replies: [] };
  const block = renderProofBlock(event, [
    { ...sampleVerifiedCommit, sequence: 1 },
    { ...sampleVerifiedCommit, sequence: 2 },
    { ...sampleVerifiedCommit, trust_level: 'forwarded', sequence: 3 },
  ]);
  assert.match(block, /Replies counted\s+3/);
  assert.match(block, /Modal trust\s+verified/);
  assert.match(block, /Verified\s+2/);
  assert.match(block, /Forwarded\s+1/);
});

test('renderProofBlock attestation: revoked senders surface as audit/revoked/effective triple', () => {
  // Module 9 — durable proof must match the audit trail AND tell the
  // reader what counted after revocation. Trust counts are computed
  // over the effective (non-revoked) subset.
  const event = {
    id: 'a2', type: 'crypto', mode: 'attestation', title: 'A', threshold: 2,
    replies: [],
    revoked_senders: [{ sender_hash: 'h-msn' }],
  };
  const block = renderProofBlock(event, [
    { ...sampleVerifiedCommit, sender_hash: 'h-msn', sequence: 1 },
    { ...sampleVerifiedCommit, sender_hash: 'h-msn', sequence: 2 },
    { ...sampleVerifiedCommit, sender_hash: 'h-gmail', sequence: 3 },
  ]);
  // Raw commit counts; threshold-level dedup is the subject's job.
  assert.match(block, /Replies in audit\s+3/);
  assert.match(block, /Revoked\s+2/);
  assert.match(block, /Effective\s+1/);
  // Trust counts are over effective subset only — gmail.
  assert.match(block, /Verified\s+1/);
  // The pre-revoke "Replies counted" label is gone when revoke present.
  assert.doesNotMatch(block, /Replies counted/);
});

test('renderProofBlock attestation: no revoked_senders → keeps original "Replies counted" label', () => {
  // Regression guard for the existing test contract above.
  const event = { id: 'a3', type: 'crypto', mode: 'attestation', threshold: 2, replies: [] };
  const block = renderProofBlock(event, [{ ...sampleVerifiedCommit, sequence: 1 }]);
  assert.match(block, /Replies counted\s+1/);
  assert.doesNotMatch(block, /Replies in audit/);
});

test('renderProofBlock returns "" when no commits provided', () => {
  const event = { id: 'x', type: 'event', steps: [] };
  assert.equal(renderProofBlock(event, []), '');
  assert.equal(renderProofBlock(event, null), '');
});
