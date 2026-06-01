'use strict';

// Unit tests for src/bundle.js: tar streaming a fake event repo, MIME
// multipart attachment builder, filename helpers.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const zlib = require('node:zlib');
const { Writable } = require('node:stream');

function freshRequire(mod) {
  const r = path.resolve(__dirname, '..', '..', mod);
  delete require.cache[require.resolve(r)];
  return require(r);
}

async function withTmpDataDir(fn) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitdone-bundle-unit-'));
  const prevData = process.env.GITDONE_DATA_DIR;
  process.env.GITDONE_DATA_DIR = tmp;
  // Reload modules that read config at require-time.
  freshRequire('src/config');
  freshRequire('src/gitrepo');
  const bundle = freshRequire('src/bundle');
  try {
    return await fn({ tmp, bundle });
  } finally {
    if (prevData != null) process.env.GITDONE_DATA_DIR = prevData;
    else delete process.env.GITDONE_DATA_DIR;
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

// Build a minimal fake event repo on disk: data/repos/<id>/{.git,
// event.json, commits/}. We don't need real git history — `tar` just
// archives the directory tree.
async function fakeEventRepo(dataDir, eventId, payload = {}) {
  const root = path.join(dataDir, 'repos', eventId);
  await fsp.mkdir(path.join(root, '.git'), { recursive: true });
  await fsp.mkdir(path.join(root, 'commits'), { recursive: true });
  await fsp.mkdir(path.join(root, 'dkim_keys'), { recursive: true });
  await fsp.mkdir(path.join(root, 'ots_proofs'), { recursive: true });
  const ev = { id: eventId, title: 'Fake event', ...payload };
  await fsp.writeFile(path.join(root, 'event.json'), JSON.stringify(ev, null, 2) + '\n');
  await fsp.writeFile(path.join(root, 'commits', 'commit-001.json'), '{"sequence":1,"hello":"world"}\n');
  return root;
}

test('bundleFilename: gitdone-<id>-YYYYMMDD.tar.gz, UTC date', () => {
  // Use a fixed date in UTC.
  const d = new Date(Date.UTC(2026, 4, 6, 12, 0, 0));
  // Test inside the wrapper to load module
  const bundle = require('../../src/bundle');
  const fn = bundle.bundleFilename('evABC123', d);
  assert.equal(fn, 'gitdone-evABC123-20260506.tar.gz');
});

test('locateRepo: returns ok=false when repo missing', async () => {
  await withTmpDataDir(async ({ bundle }) => {
    const r = await bundle.locateRepo('evNoExist');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_repo');
  });
});

test('locateRepo: rejects bad event id', async () => {
  await withTmpDataDir(async ({ bundle }) => {
    const r = await bundle.locateRepo('../../etc/passwd');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bad_event_id');
  });
});

test('streamBundle: pipes a valid gzip containing event.json', async () => {
  await withTmpDataDir(async ({ tmp, bundle }) => {
    await fakeEventRepo(tmp, 'evbun01');
    const chunks = [];
    const sink = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
    });
    const r = await bundle.streamBundle('evbun01', sink);
    assert.equal(r.ok, true);
    assert.ok(r.bytes > 0, 'bytes counter advanced');

    const buf = Buffer.concat(chunks);
    // gzip magic
    assert.equal(buf[0], 0x1f);
    assert.equal(buf[1], 0x8b);
    // gunzip → still tar; we don't parse tar by hand. Use system tar
    // to list. AlmaLinux 8 / Fedora both ship it.
    const tmpFile = path.join(tmp, 'out.tar.gz');
    await fsp.writeFile(tmpFile, buf);
    const r2 = spawnSync('tar', ['-tzf', tmpFile], { encoding: 'utf8' });
    assert.equal(r2.status, 0, `tar -tzf failed: ${r2.stderr}`);
    const list = r2.stdout.split('\n').filter(Boolean);
    assert.ok(list.some((p) => p === 'evbun01/event.json' || p === 'evbun01/event.json/'),
      `expected evbun01/event.json in archive, got:\n${list.join('\n')}`);
    assert.ok(list.some((p) => p.startsWith('evbun01/commits/')),
      'expected commits/ entries');
    assert.ok(list.some((p) => p.startsWith('evbun01/dkim_keys')),
      'expected dkim_keys/ entries');
  });
});

test('bundleToBuffer: returns Buffer that decompresses', async () => {
  await withTmpDataDir(async ({ tmp, bundle }) => {
    await fakeEventRepo(tmp, 'evbuf01');
    const r = await bundle.bundleToBuffer('evbuf01');
    assert.equal(r.ok, true);
    assert.ok(Buffer.isBuffer(r.buffer));
    // Inflate the gzip envelope: should not throw.
    const unzipped = zlib.gunzipSync(r.buffer);
    assert.ok(unzipped.length > 0);
    // tar magic at offset 257 ('ustar\0' or 'ustar  ').
    const magic = unzipped.slice(257, 263).toString('utf8');
    assert.ok(/^ustar/.test(magic), `expected ustar magic, got: ${JSON.stringify(magic)}`);
  });
});

test('bundleToBuffer: missing repo → ok=false', async () => {
  await withTmpDataDir(async ({ bundle }) => {
    const r = await bundle.bundleToBuffer('evGoneTimeline');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_repo');
  });
});

test('buildAttachmentMessage: multipart/mixed with base64 attachment', () => {
  const bundle = require('../../src/bundle');
  const msg = bundle.buildAttachmentMessage({
    from: 'gitdone <bundle+ev1@git-done.com>',
    to: 'org@example.com',
    subject: '[signedreply] proof bundle — "Demo"',
    body: 'Attached.',
    attachment: {
      filename: 'gitdone-ev1-20260506.tar.gz',
      contentType: 'application/gzip',
      content: Buffer.from('hello world\n'),
    },
    inReplyTo: '<orig@host>',
    references: '<orig@host>',
    domain: 'git-done.com',
  });
  // Headers
  assert.match(msg, /^From: gitdone <bundle\+ev1@git-done\.com>/m);
  assert.match(msg, /^To: org@example\.com/m);
  assert.match(msg, /^Subject: \[signedreply\] proof bundle — "Demo"/m);
  assert.match(msg, /^MIME-Version: 1\.0/m);
  assert.match(msg, /^Content-Type: multipart\/mixed; boundary="gitdone_[a-f0-9]+"/m);
  assert.match(msg, /^In-Reply-To: <orig@host>/m);
  // Body part
  assert.match(msg, /Content-Type: text\/plain; charset=utf-8/);
  assert.match(msg, /Attached\./);
  // Attachment part
  assert.match(msg, /Content-Type: application\/gzip; name="gitdone-ev1-20260506\.tar\.gz"/);
  assert.match(msg, /Content-Transfer-Encoding: base64/);
  assert.match(msg, /Content-Disposition: attachment; filename="gitdone-ev1-20260506\.tar\.gz"/);
  // The base64 of "hello world\n"
  assert.match(msg, /aGVsbG8gd29ybGQK/);
  // Final boundary
  assert.match(msg, /--gitdone_[a-f0-9]+--\r\n$/);
});

test('buildAttachmentMessage: sanitizes CR/LF in filename and subject', () => {
  const bundle = require('../../src/bundle');
  const msg = bundle.buildAttachmentMessage({
    from: 'a@x', to: 'b@y',
    subject: 'sub\r\nInjected: 1',
    body: 'hi',
    attachment: {
      filename: 'evil"\\name\nlf.tar.gz',
      contentType: 'application/gzip',
      content: Buffer.from(''),
    },
    domain: 'git-done.com',
  });
  // No CR/LF in subject line apart from the trailing \r\n.
  const subjLine = msg.split('\r\n').find((l) => l.startsWith('Subject:'));
  assert.equal(subjLine, 'Subject: sub Injected: 1');
  // Filename: quotes/backslashes/lf replaced.
  assert.match(msg, /filename="evil__name_lf\.tar\.gz"/);
  // Should not have an injected header.
  assert.doesNotMatch(msg, /^Injected: 1/m);
});

test('asciiFilename: strips non-ASCII and shell-unsafe chars', () => {
  const bundle = require('../../src/bundle');
  assert.equal(bundle.asciiFilename('plain.tar.gz'), 'plain.tar.gz');
  assert.equal(bundle.asciiFilename('héllo.tar.gz'), 'h_llo.tar.gz');
  assert.equal(bundle.asciiFilename('with"quote\\back.tar.gz'), 'with_quote_back.tar.gz');
});
