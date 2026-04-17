'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { parseVerifyTag } = require('../../src/router');
const { findMatch, formatVerifyReportBody } = require('../../src/verify');

const sha256Tagged = (buf) =>
  'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');

test('parseVerifyTag: recognises verify+{id}@', () => {
  assert.deepEqual(parseVerifyTag('verify+demo123@git-done.com'), { eventId: 'demo123' });
});

test('parseVerifyTag: rejects event+ and other kinds', () => {
  assert.equal(parseVerifyTag('event+demo123-step1@git-done.com'), null);
  assert.equal(parseVerifyTag('stats+demo123@git-done.com'), null);
});

test('parseVerifyTag: rejects non-alphanumeric eventIds (traversal guard)', () => {
  assert.equal(parseVerifyTag('verify+../evil@git-done.com'), null);
  assert.equal(parseVerifyTag('verify+a.b@git-done.com'), null);
});

test('findMatch: matches raw_email by sha256', () => {
  const bytes = Buffer.from('a fake email body');
  const hash = sha256Tagged(bytes);
  const commits = [{ file: 'commit-001.json', raw_sha256: hash, attachments: [] }];
  const r = findMatch(bytes, commits);
  assert.equal(r.matchType, 'raw_email');
  assert.equal(r.commit.file, 'commit-001.json');
});

test('findMatch: matches attachment by sha256', () => {
  const bytes = Buffer.from('pretend PDF bytes');
  const hash = sha256Tagged(bytes);
  const commits = [
    { file: 'commit-001.json', raw_sha256: 'sha256:unrelated', attachments: [{ filename: 'x.pdf', sha256: hash }] },
  ];
  const r = findMatch(bytes, commits);
  assert.equal(r.matchType, 'attachment');
  assert.equal(r.attachment.filename, 'x.pdf');
});

test('findMatch: returns none when no match', () => {
  const r = findMatch(Buffer.from('nothing'), [{ raw_sha256: 'sha256:xxx', attachments: [] }]);
  assert.equal(r.matchType, 'none');
});

test('buildVerificationReport: returns matched=false + reason when event has no commits', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-verify-'));
  try {
    process.env.GITDONE_DATA_DIR = tmp;
    // Force config + verify re-require so the new dataDir is picked up
    delete require.cache[require.resolve('../../src/config')];
    delete require.cache[require.resolve('../../src/verify')];
    const { buildVerificationReport } = require('../../src/verify');
    const fakeParsed = { attachments: [] };
    const r = await buildVerificationReport('ghostEvent', fakeParsed);
    assert.equal(r.matched, false);
    assert.match(r.reason, /no commits found/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('buildVerificationReport: reports per-attachment findings with hashes', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-verify-'));
  try {
    process.env.GITDONE_DATA_DIR = tmp;
    delete require.cache[require.resolve('../../src/config')];
    delete require.cache[require.resolve('../../src/verify')];
    const { buildVerificationReport } = require('../../src/verify');

    // Set up a fake repo with one commit carrying an attachment hash
    const attachBytes = Buffer.from('mystery attachment bytes');
    const attachHash = sha256Tagged(attachBytes);
    const repoDir = path.join(tmp, 'repos', 'eventA');
    await fs.mkdir(path.join(repoDir, 'commits'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'commits', 'commit-001.json'), JSON.stringify({
      schema_version: 2,
      event_id: 'eventA',
      raw_sha256: 'sha256:unrelated',
      attachments: [{ filename: 'mystery.bin', sha256: attachHash }],
    }));

    // The forwarded email carries that same attachment
    const fakeParsed = { attachments: [{ filename: 'mystery.bin', content: attachBytes, contentType: 'application/octet-stream' }] };
    const r = await buildVerificationReport('eventA', fakeParsed);
    assert.equal(r.event_id, 'eventA');
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].match_type, 'attachment');
    assert.equal(r.findings[0].matched_commit, 'commit-001.json');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// formatVerifyReportBody — renders the verify report as email body text

test('formatVerifyReportBody: happy path with raw_email match', () => {
  const report = {
    event_id: 'demo123',
    verified_at: '2026-04-17T20:00:00Z',
    commit_count: 2,
    attachment_count: 1,
    findings: [{
      filename: 'contract.pdf',
      content_type: 'application/pdf',
      size: 1234,
      sha256: 'sha256:abc',
      match_type: 'raw_email',
      matched_commit: 'commit-002.json',
      dkim_reverify: { ok: true, result: 'pass' },
    }],
  };
  const body = formatVerifyReportBody(report);
  assert.match(body, /Event ID: demo123/);
  assert.match(body, /Commits in event: 2/);
  assert.match(body, /MATCH/);
  assert.match(body, /commit-002\.json/);
  assert.match(body, /DKIM re-verification against archived key: PASS/);
  assert.doesNotMatch(body, /NO MATCH/);
});

test('formatVerifyReportBody: no-match case', () => {
  const report = {
    event_id: 'demo123',
    verified_at: '2026-04-17T20:00:00Z',
    commit_count: 5,
    attachment_count: 1,
    findings: [{
      filename: 'not-ours.png',
      size: 42,
      sha256: 'sha256:zzz',
      match_type: 'none',
    }],
  };
  const body = formatVerifyReportBody(report);
  assert.match(body, /NO MATCH/);
  assert.match(body, /sha256:zzz/);
  assert.doesNotMatch(body, /Matched commit/);
});

test('formatVerifyReportBody: no-attachments case has guidance', () => {
  const report = {
    event_id: 'demo123',
    commit_count: 1,
    attachment_count: 0,
    findings: [],
  };
  const body = formatVerifyReportBody(report);
  assert.match(body, /No verifiable attachments/);
  assert.match(body, /Attach the file/);
});

test('formatVerifyReportBody: empty-event case (no commits)', () => {
  const report = {
    event_id: 'demo123',
    matched: false,
    reason: 'no commits found for event demo123',
    attachment_count: 0,
  };
  const body = formatVerifyReportBody(report);
  assert.match(body, /no commits found for event demo123/);
});

test('formatVerifyReportBody: DKIM re-verify failure is explained, not alarming', () => {
  const report = {
    event_id: 'demo123',
    verified_at: '2026-04-17T20:00:00Z',
    commit_count: 1,
    attachment_count: 1,
    findings: [{
      filename: 'forwarded.eml',
      size: 9999,
      sha256: 'sha256:abc',
      match_type: 'message_id',
      matched_commit: 'commit-001.json',
      dkim_reverify: { ok: false, reason: 'no DKIM-Signature header in forwarded content' },
    }],
  };
  const body = formatVerifyReportBody(report);
  assert.match(body, /DKIM re-verification: not available/);
  assert.match(body, /mail clients strip DKIM headers/);
  assert.match(body, /OpenTimestamps anchor/);
});

test('formatVerifyReportBody: output is CRLF-ready (no bare LF)', () => {
  const report = { event_id: 'x', commit_count: 0, attachment_count: 0, findings: [] };
  const body = formatVerifyReportBody(report);
  // formatter uses \r\n joins; no bare \n anywhere
  assert.ok(!/(?<!\r)\n/.test(body), 'must not contain bare LF');
});
