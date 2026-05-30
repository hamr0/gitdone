'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { replyAck } = require('../../src/email-bodies');

// Regression (0.26.x, event 3mfj9afh3qx0): strict attestation counted
// distinct *repliers* in the per-reply ack subject + "Replies so far"
// line, so a partial signer (some reference docs still pending) plus one
// complete attestor read "[2/2]" / "2/2" while the engine, stat band and
// proof receipt all read "1/2". The threshold unit for strict mode is a
// *complete attestor bucket*, not a replier.

const SHA_SHIP = 'sha256:cac0';
const SHA_INV = 'sha256:0602';

function strictEvent(overrides = {}) {
  return {
    id: 'e1', type: 'crypto', mode: 'attestation', dedup: 'unique',
    title: 'i bought your laptop',
    initiator: 'avoidaccess@msn.com',
    threshold: 2,
    reference_url: 'https://drive.google.com/x',
    reference_docs: [
      { filename: 'braun-shipping.pdf', sha256: SHA_SHIP },
      { filename: 'braun-invoice.pdf', sha256: SHA_INV },
    ],
    // hash A: complete (both docs). hash B: partial (shipping only).
    attestor_progress: {
      'sha256:A': { complete: true, signed_doc_hashes: [SHA_SHIP, SHA_INV] },
      'sha256:B': { complete: false, signed_doc_hashes: [SHA_SHIP] },
    },
    replies: [
      { sender_hash: 'sha256:A', trust_level: 'verified' },
      { sender_hash: 'sha256:A', trust_level: 'verified' },
      { sender_hash: 'sha256:B', trust_level: 'verified' },
    ],
    ...overrides,
  };
}

// ctx as receive.js builds it for an accepted attestation reply.
const ctx = (senderHash) => ({
  ackSenderHash: senderHash,
  completion: { completed_event: false },
});

test('strict attestation ack counts complete attestor buckets, not repliers', () => {
  // Partial signer B's ack: 1 attestor complete (A), B still pending.
  const { subject, body } = replyAck.acceptedAttestation(strictEvent(), ctx('sha256:B'));
  assert.match(subject, /\[1\/2\]/, `subject should read 1/2, got: ${subject}`);
  assert.doesNotMatch(subject, /\[2\/2\]/);
  assert.match(body, /Replies so far: 1\/2\./);
  assert.doesNotMatch(body, /Replies so far: 2\/2/);
  // B's own checklist: shipping signed, invoice pending.
  assert.match(body, /\[x\] braun-shipping\.pdf/);
  assert.match(body, /\[ \] braun-invoice\.pdf/);
});

test('strict attestation ack reaches complete when both buckets fill', () => {
  const ev = strictEvent({
    attestor_progress: {
      'sha256:A': { complete: true, signed_doc_hashes: [SHA_SHIP, SHA_INV] },
      'sha256:B': { complete: true, signed_doc_hashes: [SHA_SHIP, SHA_INV] },
    },
  });
  const { subject, body } = replyAck.acceptedAttestation(ev, {
    ackSenderHash: 'sha256:B',
    completion: { completed_event: true },
  });
  assert.match(subject, /Attestation complete/);
  assert.match(subject, /\[2\/2\]/);
  assert.match(body, /Threshold reached \(2\)\. The audit trail is sealed\./);
});

test('strict attestation ack excludes a revoked complete attestor from the count', () => {
  const ev = strictEvent({
    revoked_senders: [{ sender_hash: 'sha256:A' }],
  });
  // A (complete) revoked, B partial → 0 complete attestors count.
  const { subject, body } = replyAck.acceptedAttestation(ev, ctx('sha256:B'));
  assert.match(subject, /\[0\/2\]/);
  assert.match(body, /Replies so far: 0\/2\./);
});

test('strict attestation verified subset diverges when a contributing reply was unverified', () => {
  const ev = strictEvent({
    attestor_progress: {
      'sha256:A': { complete: true, signed_doc_hashes: [SHA_SHIP, SHA_INV] },
      'sha256:C': { complete: true, signed_doc_hashes: [SHA_SHIP, SHA_INV] },
    },
    replies: [
      { sender_hash: 'sha256:A', trust_level: 'verified' },
      { sender_hash: 'sha256:A', trust_level: 'verified' },
      // C's bucket filled, but one contributing reply was unverified.
      { sender_hash: 'sha256:C', trust_level: 'verified' },
      { sender_hash: 'sha256:C', trust_level: 'unverified' },
    ],
  });
  const { subject } = replyAck.acceptedAttestation(ev, {
    ackSenderHash: 'sha256:C',
    completion: { completed_event: true },
  });
  // 2 complete, only 1 fully-verified → dual count shown.
  assert.match(subject, /\[2\/2 · 1 verified\]/, `got: ${subject}`);
});
