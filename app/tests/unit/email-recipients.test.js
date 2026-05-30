'use strict';

// Unit tests for the single recipient resolver. One test per
// (edge, event-kind, salient state) combination. The resolver is
// the load-bearing piece for the 0.25.0 email-system refactor —
// every outbound lifecycle notification routes through it, so
// drift here would resurface the multi-source-of-truth class of
// bug that 0.24.7/0.24.8 fixed.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getRecipients, ROLES, SUPPORTED_EDGES } = require('../../src/email-recipients');

function workflow(overrides = {}) {
  return {
    id: 'w1', type: 'event',
    title: 't',
    initiator: 'chair@ex.com',
    steps: [
      { id: 's1', name: 'A', participant: 'alice@ex.com', status: 'complete' },
      { id: 's2', name: 'B', participant: 'bob@ex.com', status: 'pending' },
    ],
    ...overrides,
  };
}

function declaration(overrides = {}) {
  return {
    id: 'd1', type: 'crypto', mode: 'declaration',
    title: 't',
    initiator: 'chair@ex.com',
    signer: 'signer@ex.com',
    ...overrides,
  };
}

function strictAtt(overrides = {}) {
  return {
    id: 'a1', type: 'crypto', mode: 'attestation',
    title: 't',
    initiator: 'chair@ex.com',
    threshold: 2,
    reference_url: 'https://ex.com/p',
    reference_docs: [{ filename: 'a.pdf', sha256: 'sha256:aaa' }],
    attestor_progress: {
      'sha256:1': { complete: true, email: 'alice@ex.com' },
      'sha256:2': { complete: true, email: 'bob@ex.com' },
    },
    ...overrides,
  };
}

function looseAtt(overrides = {}) {
  return {
    id: 'l1', type: 'crypto', mode: 'attestation',
    title: 't',
    initiator: 'chair@ex.com',
    threshold: 2,
    replies: [{ sender_hash: 'sha256:x', sender_domain: 'ex.com' }],
    ...overrides,
  };
}

function emails(map) {
  return Array.from(map.keys()).sort();
}

// ---------------------------------------------------------------------------

test('unknown edge throws', () => {
  assert.throws(() => getRecipients(workflow(), 'whatever'),
    /unknown lifecycle edge: whatever/);
});

test('null event returns empty map', () => {
  assert.equal(getRecipients(null, 'completed').size, 0);
  assert.equal(getRecipients(undefined, 'closed').size, 0);
});

test('SUPPORTED_EDGES is the canonical edge set', () => {
  assert.deepEqual(
    [...SUPPORTED_EDGES].sort(),
    ['activated', 'anchored', 'archived', 'closed', 'completed', 'overdue', 'progressed']
  );
});

// --- activated ----------------------------------------------------------

test('activated: workflow → organiser only', () => {
  const r = getRecipients(workflow(), 'activated');
  assert.deepEqual(emails(r), ['chair@ex.com']);
  assert.equal(r.get('chair@ex.com'), ROLES.ORGANISER);
});

test('activated: declaration → organiser only (signer invite is a separate edge)', () => {
  const r = getRecipients(declaration(), 'activated');
  assert.deepEqual(emails(r), ['chair@ex.com']);
});

test('activated: strict attestation → organiser only', () => {
  const r = getRecipients(strictAtt(), 'activated');
  assert.deepEqual(emails(r), ['chair@ex.com']);
});

// --- progressed --------------------------------------------------------

test('progressed: any kind → organiser only', () => {
  assert.deepEqual(emails(getRecipients(workflow(), 'progressed')), ['chair@ex.com']);
  assert.deepEqual(emails(getRecipients(declaration(), 'progressed')), ['chair@ex.com']);
  assert.deepEqual(emails(getRecipients(strictAtt(), 'progressed')), ['chair@ex.com']);
});

// --- completed --------------------------------------------------------

test('completed: workflow → organiser + every named participant', () => {
  const r = getRecipients(workflow(), 'completed');
  assert.deepEqual(emails(r),
    ['alice@ex.com', 'bob@ex.com', 'chair@ex.com']);
  assert.equal(r.get('chair@ex.com'), ROLES.ORGANISER);
  assert.equal(r.get('alice@ex.com'), ROLES.PARTICIPANT);
  assert.equal(r.get('bob@ex.com'), ROLES.PARTICIPANT);
});

test('completed: declaration → organiser + signer', () => {
  const r = getRecipients(declaration(), 'completed');
  assert.deepEqual(emails(r), ['chair@ex.com', 'signer@ex.com']);
  assert.equal(r.get('signer@ex.com'), ROLES.SIGNER);
});

test('completed: strict attestation → organiser + every attestor with stored email', () => {
  const r = getRecipients(strictAtt(), 'completed');
  assert.deepEqual(emails(r),
    ['alice@ex.com', 'bob@ex.com', 'chair@ex.com']);
  assert.equal(r.get('alice@ex.com'), ROLES.ATTESTOR);
  assert.equal(r.get('bob@ex.com'), ROLES.ATTESTOR);
});

test('completed: strict attestation with redacted emails → organiser only', () => {
  // Models the post-close state: attestor_emails_redacted_at set,
  // every attestor_progress[h].email cleared to null.
  const ev = strictAtt({
    attestor_emails_redacted_at: '2026-05-28T00:00:00Z',
    attestor_progress: {
      'sha256:1': { complete: true, email: null },
      'sha256:2': { complete: true, email: null },
    },
  });
  assert.deepEqual(emails(getRecipients(ev, 'completed')), ['chair@ex.com']);
});

test('completed: loose attestation → organiser only (no stored PII)', () => {
  assert.deepEqual(emails(getRecipients(looseAtt(), 'completed')),
    ['chair@ex.com']);
});

test('completed: strict attestation excludes a revoked attestor from the proof email', () => {
  // Regression (0.26.x, event 3dryizzzu4pi): bob was revoked after a
  // first threshold crossing; a later attestor re-crossed and the
  // recompletion proof email still reached the revoked bob. Revoke
  // must drop them from every lifecycle recipient set — they no longer
  // count toward the threshold and must not be named in the proof.
  const ev = strictAtt({
    revoked_senders: [{ sender_hash: 'sha256:2', revoked_at: '2026-05-30T00:00:00Z', reason: 'wrong email' }],
  });
  const r = getRecipients(ev, 'completed');
  assert.deepEqual(emails(r), ['alice@ex.com', 'chair@ex.com']);
  assert.equal(r.has('bob@ex.com'), false);
});

test('closed: strict attestation also excludes a revoked attestor', () => {
  const ev = strictAtt({
    revoked_senders: [{ sender_hash: 'sha256:1' }],
  });
  assert.deepEqual(emails(getRecipients(ev, 'closed')), ['bob@ex.com', 'chair@ex.com']);
});

// --- closed -----------------------------------------------------------

test('closed: shape matches completed (workflow)', () => {
  assert.deepEqual(emails(getRecipients(workflow(), 'closed')),
    emails(getRecipients(workflow(), 'completed')));
});

test('closed: shape matches completed (declaration)', () => {
  assert.deepEqual(emails(getRecipients(declaration(), 'closed')),
    emails(getRecipients(declaration(), 'completed')));
});

test('closed: shape matches completed (strict attestation, pre-redact)', () => {
  assert.deepEqual(emails(getRecipients(strictAtt(), 'closed')),
    emails(getRecipients(strictAtt(), 'completed')));
});

// --- anchored ---------------------------------------------------------

test('anchored: workflow → organiser + only contributing participants', () => {
  const r = getRecipients(workflow(), 'anchored');
  // bob's step is pending — excluded from anchored cohort.
  assert.deepEqual(emails(r), ['alice@ex.com', 'chair@ex.com']);
});

test('anchored: declaration → organiser + signer', () => {
  assert.deepEqual(emails(getRecipients(declaration(), 'anchored')),
    ['chair@ex.com', 'signer@ex.com']);
});

test('anchored: strict attestation → organiser only (emails redacted by close, anchor fires post-close)', () => {
  // Even with emails still present, attestation anchor goes
  // organiser-only by policy: no per-attestor anchor receipts.
  assert.deepEqual(emails(getRecipients(strictAtt(), 'anchored')),
    ['chair@ex.com']);
});

test('anchored: loose attestation → organiser only', () => {
  assert.deepEqual(emails(getRecipients(looseAtt(), 'anchored')),
    ['chair@ex.com']);
});

// --- archived ---------------------------------------------------------

test('archived: any kind → organiser only', () => {
  assert.deepEqual(emails(getRecipients(workflow(), 'archived')), ['chair@ex.com']);
  assert.deepEqual(emails(getRecipients(declaration(), 'archived')), ['chair@ex.com']);
  assert.deepEqual(emails(getRecipients(strictAtt(), 'archived')), ['chair@ex.com']);
});

// --- overdue ----------------------------------------------------------

test('overdue: workflow → organiser + every still-pending participant', () => {
  const r = getRecipients(workflow(), 'overdue');
  // alice complete, bob pending — alice excluded.
  assert.deepEqual(emails(r), ['bob@ex.com', 'chair@ex.com']);
});

test('overdue: declaration → organiser only', () => {
  assert.deepEqual(emails(getRecipients(declaration(), 'overdue')),
    ['chair@ex.com']);
});

// --- role-preservation edge case --------------------------------------

test('organiser is preserved when also listed as a step participant on their own event', () => {
  const ev = workflow({
    initiator: 'self@ex.com',
    steps: [{ id: 's1', name: 'A', participant: 'self@ex.com', status: 'complete' }],
  });
  const r = getRecipients(ev, 'completed');
  assert.equal(r.size, 1);
  assert.equal(r.get('self@ex.com'), ROLES.ORGANISER,
    'organiser role must not be downgraded to participant');
});

// --- case normalisation ------------------------------------------------

test('email keys are lowercased even when the event stores mixed case', () => {
  const ev = workflow({
    initiator: 'Chair@Ex.COM',
    steps: [{ id: 's1', name: 'A', participant: 'Alice@Ex.com', status: 'complete' }],
  });
  const r = getRecipients(ev, 'completed');
  assert.deepEqual(emails(r), ['alice@ex.com', 'chair@ex.com']);
});

// --- insertion order: organiser first when present --------------------

test('organiser is the first key when present (caller can rely on this)', () => {
  for (const ev of [workflow(), declaration(), strictAtt()]) {
    const keys = Array.from(getRecipients(ev, 'completed').keys());
    assert.equal(keys[0], 'chair@ex.com',
      `organiser must be first key for ${ev.type}/${ev.mode || ''}`);
  }
});
