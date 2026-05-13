'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatProgressBlock } = require('../../src/ack-progress');

test('declaration: reads reference_docs[].signed_at', () => {
  const event = {
    type: 'crypto',
    mode: 'declaration',
    reference_docs: [
      { filename: 'a.pdf', sha256: 'sha256:aaa', signed_at: '2026-01-01' },
      { filename: 'b.pdf', sha256: 'sha256:bbb', signed_at: null },
    ],
  };
  const out = formatProgressBlock(event);
  assert.match(out, /Progress: 1 of 2 signed\./);
  assert.match(out, /\[x\] a\.pdf/);
  assert.match(out, /\[ \] b\.pdf/);
});

test('attestation: reads attestor_progress[hash].signed_doc_hashes per sender', () => {
  const event = {
    type: 'crypto',
    mode: 'attestation',
    reference_docs: [
      { filename: 'shipping.pdf', sha256: 'sha256:cac0' },
      { filename: 'invoice.pdf', sha256: 'sha256:0602' },
    ],
    attestor_progress: {
      hashA: { signed_doc_hashes: ['sha256:cac0'], complete: false },
      hashB: { signed_doc_hashes: ['sha256:cac0', 'sha256:0602'], complete: true },
    },
  };
  // Sender A has signed only shipping — expect [x] shipping, [ ] invoice.
  const outA = formatProgressBlock(event, { senderHash: 'hashA' });
  assert.match(outA, /Progress: 1 of 2 signed\./);
  assert.match(outA, /\[x\] shipping\.pdf/);
  assert.match(outA, /\[ \] invoice\.pdf/);
  assert.doesNotMatch(outA, /\[x\] invoice/);

  // Sender B has signed both — expect both checked, no "Still needed:".
  const outB = formatProgressBlock(event, { senderHash: 'hashB' });
  assert.match(outB, /Progress: 2 of 2 signed\./);
  assert.match(outB, /\[x\] shipping\.pdf/);
  assert.match(outB, /\[x\] invoice\.pdf/);
  assert.doesNotMatch(outB, /Still needed:/);
});

test('attestation: unknown sender hash falls back to all-open', () => {
  const event = {
    type: 'crypto',
    mode: 'attestation',
    reference_docs: [
      { filename: 'a.pdf', sha256: 'sha256:aaa' },
      { filename: 'b.pdf', sha256: 'sha256:bbb' },
    ],
    attestor_progress: {
      hashA: { signed_doc_hashes: ['sha256:aaa'], complete: false },
    },
  };
  // Brand-new sender hashC who has signed nothing yet — both docs open.
  const out = formatProgressBlock(event, { senderHash: 'hashC' });
  assert.match(out, /Progress: 0 of 2 signed\./);
  assert.match(out, /\[ \] a\.pdf/);
  assert.match(out, /\[ \] b\.pdf/);
  assert.doesNotMatch(out, /Matched:/);
});

test('attestation: ignores reference_docs[].signed_at (declaration-only field)', () => {
  // The bug being fixed: previously the ack body read reference_docs.signed_at
  // for both modes. In attestation that field is never set per-attestor, so
  // an attestor who had already signed doc 1 saw an ack saying [ ] [ ] (both
  // open) when sending a wrong attachment for doc 2. Now we read per-sender.
  const event = {
    type: 'crypto',
    mode: 'attestation',
    reference_docs: [
      { filename: 'shipping.pdf', sha256: 'sha256:cac0', signed_at: null },
      { filename: 'invoice.pdf', sha256: 'sha256:0602', signed_at: null },
    ],
    attestor_progress: {
      hashMsn: { signed_doc_hashes: ['sha256:cac0'], complete: false },
    },
  };
  const out = formatProgressBlock(event, { senderHash: 'hashMsn' });
  assert.match(out, /Progress: 1 of 2 signed\./);
  assert.match(out, /\[x\] shipping\.pdf/);
});
