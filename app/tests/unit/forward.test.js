'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildForwardMessage, forwardToOwner } = require('../../src/forward');

test('buildForwardMessage: prepends X-GitDone headers before original headers', () => {
  const raw = Buffer.from('From: a@x\r\nTo: event+demo-s1@g\r\nSubject: hi\r\n\r\nbody\r\n');
  const out = buildForwardMessage(raw, {
    eventId: 'demo', stepId: 's1', commitFile: 'commits/commit-001.json',
    trustLevel: 'verified', receivedAt: '2026-04-17T00:00:00Z',
  });
  const str = out.toString();
  assert.match(str, /^X-GitDone-Event: demo\r\n/);
  assert.match(str, /\r\nX-GitDone-Step: s1\r\n/);
  assert.match(str, /\r\nX-GitDone-Commit: commits\/commit-001\.json\r\n/);
  assert.match(str, /\r\nX-GitDone-Trust: verified\r\n/);
  assert.match(str, /\r\nX-GitDone-Received-At: 2026-04-17T00:00:00Z\r\n/);
  assert.match(str, /\r\nX-GitDone-Forwarded-At: .+\r\n/);
  // Original email bytes are preserved verbatim after our headers
  assert.ok(str.includes('From: a@x\r\nTo: event+demo-s1@g\r\nSubject: hi\r\n\r\nbody\r\n'));
});

test('buildForwardMessage: does not insert a blank line before original headers', () => {
  // Critical: if we accidentally emit \r\n\r\n before the original, the
  // original's headers become the forwarded body. This test catches that.
  const raw = Buffer.from('From: a@x\r\nSubject: s\r\n\r\nbody');
  const out = buildForwardMessage(raw, {
    eventId: 'e', stepId: 's', trustLevel: 'verified',
  }).toString();
  // Find the FIRST \r\n\r\n — it should be the original's, not introduced by us
  const firstBlankIdx = out.indexOf('\r\n\r\n');
  assert.ok(firstBlankIdx > 0);
  // Everything before the first blank line should be header lines
  const headerBlock = out.slice(0, firstBlankIdx);
  assert.ok(headerBlock.includes('X-GitDone-Event: e'));
  assert.ok(headerBlock.includes('From: a@x'));
  assert.ok(headerBlock.includes('Subject: s'));
});

test('buildForwardMessage: preserves raw bytes byte-for-byte', () => {
  // Some bytes that matter: \r\n line endings, 8-bit MIME, attachments
  // in base64. We must not touch any of this.
  const raw = Buffer.concat([
    Buffer.from('DKIM-Signature: v=1; a=rsa-sha256; d=x; s=y; b=abcd==\r\n', 'ascii'),
    Buffer.from('From: a@x\r\nSubject: s\r\n\r\n', 'ascii'),
    Buffer.from([0xC3, 0xA9, 0x0D, 0x0A]), // utf-8 é + CRLF
    Buffer.from('boundary body\r\n', 'ascii'),
  ]);
  const out = buildForwardMessage(raw, { eventId: 'e', stepId: 's' });
  // Original bytes appear intact at the end
  assert.ok(out.slice(-raw.length).equals(raw));
});

test('buildForwardMessage: rejects non-Buffer rawEmail', () => {
  assert.throws(() => buildForwardMessage('a string', { eventId: 'e' }));
});

test('buildForwardMessage: handles missing meta fields gracefully', () => {
  const raw = Buffer.from('From: a\r\n\r\nbody');
  const out = buildForwardMessage(raw, { eventId: 'e' }).toString();
  assert.match(out, /X-GitDone-Step: \r\n/); // empty but present
  assert.match(out, /X-GitDone-Commit: \r\n/);
  assert.match(out, /X-GitDone-Trust: unknown\r\n/);
});

test('forwardToOwner: fast-fails when no initiator', async () => {
  const r = await forwardToOwner({
    rawEmail: Buffer.from('anything'),
    initiator: null,
    eventId: 'e',
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no initiator/);
});

test('forwardToOwner: fast-fails on empty rawEmail', async () => {
  const r = await forwardToOwner({
    rawEmail: Buffer.alloc(0),
    initiator: 'owner@example.com',
    eventId: 'e',
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /empty/);
});

// Integration-ish: use a capture-stdin fake sendmail to verify the
// forwarded bytes and envelope args.
test('forwardToOwner: end-to-end via fake sendmail captures correct bytes and args', async () => {
  const tmp = path.join(os.tmpdir(), `fwd-test-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const stdinFile = path.join(tmp, 'stdin.dat');
  const argsFile = path.join(tmp, 'args.txt');
  const fake = path.join(tmp, 'fake-sendmail.sh');
  fs.writeFileSync(fake,
    `#!/bin/sh\necho "$@" > "${argsFile}"\ncat > "${stdinFile}"\nexit 0\n`,
    { mode: 0o755 });
  process.env.GITDONE_SENDMAIL_BIN = fake;
  try {
    // Have to re-require outbound to pick up env override
    delete require.cache[require.resolve('../../src/outbound')];
    delete require.cache[require.resolve('../../src/forward')];
    const { forwardToOwner: fwd } = require('../../src/forward');

    const rawEmail = Buffer.from(
      'From: participant@gmail.com\r\n' +
      'To: event+demo-step1@git-done.com\r\n' +
      'Subject: here are the docs\r\n' +
      'Date: Fri, 17 Apr 2026 00:00:00 GMT\r\n' +
      '\r\n' +
      'body with attachment below\r\n');
    const r = await fwd({
      rawEmail,
      initiator: 'owner@example.com',
      eventId: 'demo',
      stepId: 'step1',
      commitFile: 'commits/commit-001.json',
      trustLevel: 'verified',
      receivedAt: '2026-04-17T00:00:00Z',
    });
    assert.equal(r.ok, true);
    const argv = fs.readFileSync(argsFile, 'utf8').trim().split(/\s+/);
    // -i, -f <env>, --, owner@example.com
    assert.ok(argv.includes('-i'));
    const fIdx = argv.indexOf('-f');
    assert.ok(fIdx >= 0);
    assert.equal(argv[fIdx + 1], 'event+demo@git-done.com');
    assert.ok(argv.includes('--'));
    assert.ok(argv.includes('owner@example.com'));
    // -t must NOT be in args (we gave positional recipient)
    assert.ok(!argv.includes('-t'));

    const submitted = fs.readFileSync(stdinFile);
    const submittedStr = submitted.toString();
    assert.match(submittedStr, /^X-GitDone-Event: demo\r\n/);
    assert.ok(submitted.slice(-rawEmail.length).equals(rawEmail),
      'original email bytes preserved verbatim');
  } finally {
    delete process.env.GITDONE_SENDMAIL_BIN;
    delete require.cache[require.resolve('../../src/outbound')];
    delete require.cache[require.resolve('../../src/forward')];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
