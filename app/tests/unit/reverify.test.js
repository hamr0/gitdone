'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractCandidateEmail,
  pickSigner,
  resolveUpgrade,
  formatReverifyReportBody,
} = require('../../src/reverify');

test('resolveUpgrade: already-verified does not re-upgrade', () => {
  const r = resolveUpgrade('verified');
  assert.equal(r.upgradeTo, null);
  assert.match(r.reason, /already verified/);
});

test('resolveUpgrade: unverified/authorized/forwarded upgrade to verified on DKIM pass', () => {
  for (const level of ['unverified', 'authorized', 'forwarded']) {
    const r = resolveUpgrade(level);
    assert.equal(r.upgradeTo, 'verified', `from ${level}`);
    assert.equal(r.reason, null);
  }
});

test('resolveUpgrade: unknown level yields null upgrade with descriptive reason', () => {
  const r = resolveUpgrade('unicorn');
  assert.equal(r.upgradeTo, null);
  assert.match(r.reason, /unknown source trust level: unicorn/);
});

test('extractCandidateEmail: prefers message/rfc822 attachment over others', () => {
  const parsed = {
    attachments: [
      { content: Buffer.from('pdf bytes'), contentType: 'application/pdf' },
      { content: Buffer.from('the inner .eml'), contentType: 'message/rfc822' },
    ],
  };
  const bytes = extractCandidateEmail(parsed);
  assert.equal(bytes.toString(), 'the inner .eml');
});

test('extractCandidateEmail: falls back to first attachment when no rfc822', () => {
  const parsed = {
    attachments: [
      { content: Buffer.from('raw bytes'), contentType: 'application/octet-stream' },
    ],
  };
  assert.equal(extractCandidateEmail(parsed).toString(), 'raw bytes');
});

test('extractCandidateEmail: null when no attachments', () => {
  assert.equal(extractCandidateEmail({ attachments: [] }), null);
  assert.equal(extractCandidateEmail({}), null);
  assert.equal(extractCandidateEmail(null), null);
});

test('pickSigner: prefers result=pass signature', () => {
  const commit = {
    dkim: {
      signatures: [
        { result: 'fail', domain: 'a.com', selector: 's1' },
        { result: 'pass', domain: 'b.com', selector: 's2' },
      ],
    },
  };
  assert.deepEqual(pickSigner(commit), { domain: 'b.com', selector: 's2' });
});

test('pickSigner: falls back to any signature with domain+selector', () => {
  const commit = {
    dkim: {
      signatures: [{ result: 'fail', domain: 'a.com', selector: 's1' }],
    },
  };
  assert.deepEqual(pickSigner(commit), { domain: 'a.com', selector: 's1' });
});

test('pickSigner: null when no signatures', () => {
  assert.equal(pickSigner({ dkim: { signatures: [] } }), null);
  assert.equal(pickSigner({ dkim: {} }), null);
  assert.equal(pickSigner({}), null);
  assert.equal(pickSigner(null), null);
});

test('pickSigner: ignores signatures missing domain or selector', () => {
  const commit = {
    dkim: {
      signatures: [
        { result: 'none', domain: null, selector: null, comment: 'message not signed' },
      ],
    },
  };
  assert.equal(pickSigner(commit), null);
});

// formatReverifyReportBody coverage

test('formatReverifyReportBody: NOT FOUND case', () => {
  const body = formatReverifyReportBody('demo', 99, { found: false, reason: 'no commit-099.json in event demo' });
  assert.match(body, /Event: demo/);
  assert.match(body, /Target: commit-099\.json/);
  assert.match(body, /NOT FOUND/);
  assert.match(body, /no commit-099\.json/);
});

test('formatReverifyReportBody: UPGRADED case', () => {
  const body = formatReverifyReportBody('demo', 3, {
    found: true,
    upgraded: true,
    trust_level_before: 'authorized',
    trust_level_after: 'verified',
    signer: { domain: 'gmail.com', selector: '20251104' },
    evidence: { raw_sha256: 'sha256:abc' },
    dkim_reverify: { ok: true, result: 'pass' },
  });
  assert.match(body, /UPGRADED/);
  assert.match(body, /authorized -> verified/);
  assert.match(body, /PASS against archived key/);
  assert.match(body, /gmail\.com \/ 20251104/);
  assert.match(body, /sha256:abc/);
  assert.doesNotMatch(body, /NOT UPGRADED/);
});

test('formatReverifyReportBody: DKIM-fail branch explains rather than alarms', () => {
  const body = formatReverifyReportBody('demo', 3, {
    found: true,
    upgraded: false,
    trust_level_before: 'authorized',
    trust_level_after: 'authorized',
    dkim_reverify: { ok: false, reason: 'no DKIM-Signature header in forwarded content' },
  });
  assert.match(body, /NOT UPGRADED/);
  assert.match(body, /stays: authorized/);
  assert.match(body, /DKIM re-verification: FAIL/);
  assert.match(body, /no DKIM-Signature header/);
});

test('formatReverifyReportBody: already-verified no-op branch', () => {
  const body = formatReverifyReportBody('demo', 3, {
    found: true,
    upgraded: false,
    trust_level_before: 'verified',
    trust_level_after: 'verified',
    policy_note: 'already verified',
    dkim_reverify: { ok: true, result: 'pass' },
  });
  assert.match(body, /NOT UPGRADED/);
  assert.match(body, /DKIM verified, but no upgrade applies/);
  assert.match(body, /Policy: already verified/);
});

test('formatReverifyReportBody: output is CRLF (no bare LF)', () => {
  const body = formatReverifyReportBody('e', 1, { found: true, upgraded: false, trust_level_before: 'unverified', trust_level_after: 'unverified', dkim_reverify: { ok: false, reason: 'x' } });
  assert.ok(!/(?<!\r)\n/.test(body));
});
