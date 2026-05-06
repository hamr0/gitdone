'use strict';

// Unit tests for the proof-render helpers shared by the management
// dashboard and the proof-email composers.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  TRUST_LEVELS,
  TRUST_COLOR,
  aggregateTrust,
  truncHash,
  formatBytes,
  renderTrustLadder,
  renderTrustPill,
  renderAttachmentPill,
  renderProofReceipt,
  plainReceipt,
  otsStatusLabel,
} = require('../../src/web/proof-render');

function ladderHTML(achieved) {
  return renderTrustLadder({ achieved }).html;
}

test('aggregateTrust counts levels and surfaces modal + weakest', () => {
  const items = [
    { trust_level: 'verified' },
    { trust_level: 'verified' },
    { trust_level: 'forwarded' },
    { trust_level: 'authorized' },
  ];
  const r = aggregateTrust(items);
  assert.deepEqual(r.counts, { verified: 2, forwarded: 1, authorized: 1, unverified: 0 });
  assert.equal(r.modal, 'verified');
  assert.equal(r.weakest, 'authorized');
});

test('aggregateTrust ties break to higher trust level', () => {
  const items = [
    { trust_level: 'verified' },
    { trust_level: 'unverified' },
  ];
  const r = aggregateTrust(items);
  assert.equal(r.modal, 'verified', 'ties go to the higher trust level');
  assert.equal(r.weakest, 'unverified');
});

test('aggregateTrust returns nulls on empty input', () => {
  const r = aggregateTrust([]);
  assert.deepEqual(r.counts, { verified: 0, forwarded: 0, authorized: 0, unverified: 0 });
  assert.equal(r.modal, null);
  assert.equal(r.weakest, null);
});

test('renderTrustLadder fills the achieved rung in its trust colour', () => {
  for (const lv of TRUST_LEVELS) {
    const html = ladderHTML(lv);
    const c = TRUST_COLOR[lv];
    // The active rung carries `background:<color>` AND data-level matches.
    assert.match(html, new RegExp(`data-level="${lv}"[^>]*style="background:${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      `${lv} rung should be filled with ${c}`);
  }
});

test('renderTrustLadder outlines passed rungs in their own colour', () => {
  // Achieved = verified → forwarded/authorized/unverified all "passed".
  const html = ladderHTML('verified');
  for (const lv of ['forwarded', 'authorized', 'unverified']) {
    const c = TRUST_COLOR[lv];
    assert.match(html, new RegExp(`data-level="${lv}"[^>]*style="border-color:${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      `${lv} rung should be outlined in ${c}`);
  }
});

test('renderTrustLadder dims rungs above achieved', () => {
  // Achieved = authorized → forwarded + verified are above.
  const html = ladderHTML('authorized');
  // Both above-rungs should carry the dim grey border + text colour.
  for (const lv of ['forwarded', 'verified']) {
    assert.match(html, new RegExp(`data-level="${lv}"[^>]*style="border-color:#30363d;color:#6e7681"`),
      `${lv} rung should be dimmed when above achieved`);
  }
});

test('renderTrustLadder with null achieved dims every rung', () => {
  const html = ladderHTML(null);
  for (const lv of TRUST_LEVELS) {
    assert.match(html, new RegExp(`data-level="${lv}"[^>]*style="border-color:#30363d;color:#6e7681"`),
      `${lv} rung should be dimmed when no level achieved`);
  }
});

test('renderTrustPill emits a class-tagged span coloured by level', () => {
  const r = renderTrustPill({ level: 'verified' });
  assert.match(r.html, /trust-pill trust-verified/);
  assert.match(r.html, /color:#3fb950/);
  assert.match(r.html, /DKIM-VERIFIED/);
});

test('renderTrustPill returns empty for missing/unknown level', () => {
  assert.equal(renderTrustPill({ level: null }).html, '');
  assert.equal(renderTrustPill({ level: 'something-else' }).html, '');
});

test('truncHash returns sha256:head4...tail4', () => {
  assert.equal(
    truncHash('sha256:2a30ee44aabbccddee9988776655ec4c0'),
    'sha256:2a30…c4c0',
  );
  assert.equal(
    truncHash('2a30ee44aabbccddee9988776655ec4c0'),
    'sha256:2a30…c4c0',
  );
  assert.equal(truncHash(null), '');
  assert.equal(truncHash(''), '');
});

test('renderProofReceipt includes DKIM line, gitdone-verify command, and copyable class', () => {
  const commit = {
    raw_sha256: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    trust_level: 'verified',
    dkim: { signatures: [{ result: 'pass', domain: 'example.com', selector: 'gd1', algorithm: 'rsa-sha256', aligned: true }] },
    spf: { result: 'pass' },
    dmarc: { result: 'pass' },
    arc: { result: 'none', chain_length: 0 },
    ots_proof_file: 'ots_proofs/commit-001.ots',
  };
  const html = renderProofReceipt(commit, 'abc123').html;
  assert.match(html, /header\.i=@example\.com/);
  assert.match(html, /selector gd1/);
  assert.match(html, /rsa-sha256/);
  assert.match(html, /aligned/);
  assert.match(html, /pending Bitcoin upgrade/);
  assert.match(html, /class="copyable"/);
  assert.match(html, /\$ gitdone-verify abc123/);
});

test('otsStatusLabel surfaces anchored when ots_anchored set', () => {
  assert.match(
    otsStatusLabel({ ots_proof_file: 'ots_proofs/commit-001.ots', ots_anchored: true, ots_block: 850123 }),
    /anchored at block 850123/,
  );
  assert.match(
    otsStatusLabel({ ots_proof_file: 'ots_proofs/commit-001.ots', ots_anchored: true }),
    /anchored to Bitcoin/,
  );
  assert.match(
    otsStatusLabel({ ots_proof_file: 'ots_proofs/commit-001.ots' }),
    /pending Bitcoin upgrade/,
  );
  assert.equal(
    otsStatusLabel({ ots_archive: { error: 'ots not found' } }),
    'error: ots not found',
  );
});

test('renderProofReceipt surfaces attachment filenames + truncated hashes when present', () => {
  const commit = {
    raw_sha256: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    trust_level: 'verified',
    dkim: { signatures: [{ result: 'pass', domain: 'example.com', selector: 'gd1', algorithm: 'rsa-sha256', aligned: true }] },
    spf: { result: 'pass' }, dmarc: { result: 'pass' }, arc: { result: 'none' },
    attachments: [
      { filename: 'contract.pdf', sha256: 'sha256:aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff66667777888899990000', size: 102400 },
      { filename: 'photo.jpg', sha256: 'sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff', size: 524288 },
    ],
  };
  const html = renderProofReceipt(commit, 'abc123').html;
  assert.match(html, /Attachments/);
  assert.match(html, /contract\.pdf/);
  assert.match(html, /photo\.jpg/);
  assert.match(html, /sha256:aaaa…0000/);
  assert.match(html, /sha256:1111…ffff/);
});

test('renderProofReceipt omits attachment block when none recorded', () => {
  const commit = {
    raw_sha256: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    trust_level: 'verified',
    dkim: { signatures: [{ result: 'pass', domain: 'example.com' }] },
    spf: { result: 'pass' }, dmarc: { result: 'pass' }, arc: { result: 'none' },
    attachments: [],
  };
  const html = renderProofReceipt(commit, 'abc123').html;
  assert.doesNotMatch(html, /Attachments/);
});

test('renderAttachmentPill renders green paperclip + count, hidden when count is zero', () => {
  const empty = renderAttachmentPill({ count: 0, stepId: 's1' }).html;
  assert.equal(empty, '');
  const pill = renderAttachmentPill({ count: 3, stepId: 's1' }).html;
  assert.match(pill, /attach-pill/);
  assert.match(pill, /📎 3/);
  assert.match(pill, /color:#3fb950/);
  assert.match(pill, /data-step="s1"/);
});

test('formatBytes returns human-readable sizes', () => {
  assert.equal(formatBytes(0), '');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(1024 * 1024 * 3), '3.0 MB');
});

test('plainReceipt appends an Attachments section when present, ASCII-only', () => {
  const commit = {
    raw_sha256: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    trust_level: 'verified',
    dkim: { signatures: [{ result: 'pass', domain: 'example.com', selector: 'gd1', algorithm: 'rsa-sha256', aligned: true }] },
    spf: { result: 'pass' }, dmarc: { result: 'pass' }, arc: { result: 'none' },
    ots_proof_file: 'ots_proofs/commit-001.ots',
    attachments: [
      { filename: 'contract.pdf', sha256: 'sha256:aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff66667777888899990000', size: 102400 },
    ],
  };
  const txt = plainReceipt(commit);
  assert.doesNotMatch(txt, /·/);
  assert.match(txt, /Attachments/);
  assert.match(txt, /contract\.pdf/);
  assert.match(txt, /sha256:aaaa…0000/);
});

test('plainReceipt is ASCII-only', () => {
  const commit = {
    raw_sha256: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    trust_level: 'verified',
    dkim: { signatures: [{ result: 'pass', domain: 'example.com', selector: 'gd1', algorithm: 'rsa-sha256', aligned: true }] },
    spf: { result: 'pass' },
    dmarc: { result: 'pass' },
    arc: { result: 'pass', chain_length: 2 },
    ots_proof_file: 'ots_proofs/commit-001.ots',
  };
  const txt = plainReceipt(commit);
  // U+00B7 middle dot must not leak into outbound mail.
  assert.doesNotMatch(txt, /·/);
  assert.match(txt, /DKIM/);
  assert.match(txt, /SPF/);
  assert.match(txt, /DMARC/);
  assert.match(txt, /ARC/);
  assert.match(txt, /OTS/);
  assert.match(txt, /Raw hash/);
  assert.match(txt, /Trust/);
});
