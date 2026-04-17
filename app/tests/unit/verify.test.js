'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { parseVerifyTag } = require('../../src/router');
const { findMatch } = require('../../src/verify');

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
