'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildRawMessage, newMessageId, sendmail } = require('../../src/outbound');

test('newMessageId: RFC 5322 shape with domain', () => {
  const id = newMessageId('git-done.com');
  assert.match(id, /^<\d+\.[0-9a-f]{16}@git-done\.com>$/);
});

test('newMessageId: unique across rapid calls', () => {
  const set = new Set();
  for (let i = 0; i < 100; i++) set.add(newMessageId('example.com'));
  assert.equal(set.size, 100);
});

test('buildRawMessage: emits required headers in CRLF', () => {
  const raw = buildRawMessage({
    from: 'A <a@git-done.com>',
    to: 'b@example.com',
    subject: 'hi',
    body: 'hello world',
    domain: 'git-done.com',
  });
  // CRLF line endings
  assert.ok(raw.includes('\r\n'), 'has CRLF');
  assert.ok(!/(?<!\r)\n/.test(raw), 'no bare LF');
  // Required headers present
  assert.match(raw, /^From: A <a@git-done\.com>\r\n/);
  assert.match(raw, /\r\nTo: b@example\.com\r\n/);
  assert.match(raw, /\r\nSubject: hi\r\n/);
  assert.match(raw, /\r\nMessage-Id: <\d+\.[0-9a-f]{16}@git-done\.com>\r\n/);
  assert.match(raw, /\r\nDate: .+\r\n/);
  assert.match(raw, /\r\nAuto-Submitted: auto-replied\r\n/);
  assert.match(raw, /\r\nMIME-Version: 1\.0\r\n/);
  assert.match(raw, /\r\nContent-Type: text\/plain; charset=utf-8\r\n/);
  // Header/body separator and body at the end
  assert.match(raw, /\r\n\r\nhello world$/);
});

test('buildRawMessage: optional threading headers', () => {
  const raw = buildRawMessage({
    from: 'a@x',
    to: 'b@x',
    subject: 's',
    body: '.',
    inReplyTo: '<msg-1@example.com>',
    references: '<msg-1@example.com>',
    domain: 'x',
  });
  assert.match(raw, /\r\nIn-Reply-To: <msg-1@example\.com>\r\n/);
  assert.match(raw, /\r\nReferences: <msg-1@example\.com>\r\n/);
});

test('buildRawMessage: autoSubmitted override', () => {
  const raw = buildRawMessage({
    from: 'a@x', to: 'b@x', subject: 's', body: '.',
    autoSubmitted: 'auto-generated', domain: 'x',
  });
  assert.match(raw, /\r\nAuto-Submitted: auto-generated\r\n/);
});

test('buildRawMessage: suppress Auto-Submitted when false', () => {
  const raw = buildRawMessage({
    from: 'a@x', to: 'b@x', subject: 's', body: '.',
    autoSubmitted: false, domain: 'x',
  });
  assert.doesNotMatch(raw, /Auto-Submitted:/);
});

test('buildRawMessage: extraHeaders appended', () => {
  const raw = buildRawMessage({
    from: 'a@x', to: 'b@x', subject: 's', body: '.',
    extraHeaders: { 'X-GitDone-Event': 'demo123' },
    domain: 'x',
  });
  assert.match(raw, /\r\nX-GitDone-Event: demo123\r\n/);
});

test('buildRawMessage: throws on missing required fields', () => {
  assert.throws(() => buildRawMessage({ from: 'a', to: 'b', subject: 'c' }));
  assert.throws(() => buildRawMessage({ from: 'a', to: 'b', body: 'x' }));
  assert.throws(() => buildRawMessage({ from: 'a', subject: 'c', body: 'x' }));
  assert.throws(() => buildRawMessage({ to: 'b', subject: 'c', body: 'x' }));
});

test('buildRawMessage: body containing a single "." is passed through', () => {
  // sendmail -i is what makes this safe at the wire; at the build step
  // we just need to not mangle the body ourselves.
  const raw = buildRawMessage({
    from: 'a@x', to: 'b@x', subject: 's',
    body: 'line1\r\n.\r\nline3',
    domain: 'x',
  });
  assert.ok(raw.endsWith('line1\r\n.\r\nline3'));
});

// Integration-ish: sendmail() with a fake binary. We verify that the
// promise resolves with ok:false when the binary exits non-zero, and
// with ok:true when it exits zero. Uses /bin/true and /bin/false so no
// test fixture is needed.
test('sendmail: ok=true when binary exits 0', async () => {
  const r = await sendmail({
    from: 'x@y', rawMessage: 'whatever', binary: '/bin/true',
  });
  assert.equal(r.ok, true);
});

test('sendmail: ok=false when binary exits non-zero', async () => {
  const r = await sendmail({
    from: 'x@y', rawMessage: 'whatever', binary: '/bin/false',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 1);
});

test('sendmail: ok=false when binary missing', async () => {
  const r = await sendmail({
    from: 'x@y', rawMessage: 'whatever', binary: '/nonexistent/sendmail',
  });
  assert.equal(r.ok, false);
  assert.ok(r.reason || r.code);
});

test('sendmail: empty message fast-fails', async () => {
  const r = await sendmail({ from: 'x@y', rawMessage: '', binary: '/bin/true' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty message');
});

test('sendmail: positional recipients mode uses `--` separator, no -t', async () => {
  const tmp = path.join(os.tmpdir(), `outbound-args-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const argsFile = path.join(tmp, 'args.txt');
  const script = path.join(tmp, 'fake.sh');
  fs.writeFileSync(script, `#!/bin/sh\necho "$@" > "${argsFile}"\nexit 0\n`, { mode: 0o755 });
  try {
    const r = await sendmail({
      from: 'env@x',
      rawMessage: 'hello',
      binary: script,
      to: ['a@x', 'b@x'],
    });
    assert.equal(r.ok, true);
    const args = fs.readFileSync(argsFile, 'utf8').trim().split(/\s+/);
    assert.ok(!args.includes('-t'), 'positional mode must not pass -t');
    assert.ok(args.includes('--'), 'must use -- to terminate options');
    assert.ok(args.includes('a@x'));
    assert.ok(args.includes('b@x'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('sendmail: default (no to[]) still uses -t', async () => {
  const tmp = path.join(os.tmpdir(), `outbound-args2-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const argsFile = path.join(tmp, 'args.txt');
  const script = path.join(tmp, 'fake.sh');
  fs.writeFileSync(script, `#!/bin/sh\necho "$@" > "${argsFile}"\nexit 0\n`, { mode: 0o755 });
  try {
    const r = await sendmail({ from: 'env@x', rawMessage: 'hi', binary: script });
    assert.equal(r.ok, true);
    const args = fs.readFileSync(argsFile, 'utf8').trim().split(/\s+/);
    assert.ok(args.includes('-t'));
    assert.ok(!args.includes('--'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('sendmail: pipes rawMessage to stdin of binary', async () => {
  // Use `cat` as the fake sendmail — it copies stdin to stdout, exits 0.
  // We can't easily capture stdout from spawn here, but cat succeeds on
  // any input, confirming stdin is wired and child completes cleanly.
  const tmp = path.join(os.tmpdir(), `outbound-test-${Date.now()}.txt`);
  // Actually use a shell script that captures stdin to a file.
  const script = path.join(os.tmpdir(), `outbound-test-${Date.now()}.sh`);
  fs.writeFileSync(script, `#!/bin/sh\ncat > "${tmp}"\n`, { mode: 0o755 });
  try {
    const r = await sendmail({
      from: 'x@y',
      rawMessage: 'STDIN-MARKER-abc123',
      binary: script,
    });
    assert.equal(r.ok, true);
    const captured = fs.readFileSync(tmp, 'utf8');
    assert.equal(captured, 'STDIN-MARKER-abc123');
  } finally {
    try { fs.unlinkSync(script); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
  }
});
