'use strict';

// Non-ASCII attachment filenames on inbound mail.
//
// Two code paths consume attachment filenames (parsed by mailparser):
//   1. attach+<id>@ reference-doc registration (bin/receive.js) records
//      { filename, size, sha256 } in event.reference_docs[].
//   2. forwardToOwner (src/forward.js) re-injects the original bytes
//      verbatim, so the encoded filename header must survive untouched.
// Fixtures use RFC 2231 (filename*=UTF-8''...) and RFC 2047 encoded-words
// (filename="=?UTF-8?B?...?="), plus an RFC 2231 continuation (filename*0*/1*).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RECEIVE = path.join(__dirname, '..', '..', 'bin', 'receive.js');
const NAME = 'résumé — 日本.pdf'; // résumé — 日本.pdf

// Disposition-header variants that must all decode to NAME.
const rfc2231 = "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9%20%E2%80%94%20%E6%97%A5%E6%9C%AC.pdf";
const rfc2047 = `attachment; filename="=?UTF-8?B?${Buffer.from(NAME).toString('base64')}?="`;
const rfc2231Cont = "attachment; filename*0*=UTF-8''r%C3%A9sum%C3%A9%20%E2%80%94; filename*1*=%20%E6%97%A5%E6%9C%AC.pdf";

function runReceive(eml, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      GITDONE_SESSION_SECRET: 'a'.repeat(64),
      GITDONE_SKIP_MX_CHECK: '1',
      GITDONE_LOG_FILE: '',
      GITDONE_LOG_STDOUT: 'true',
      GITDONE_OTS_BIN: '/nonexistent/ots',
      ...extraEnv,
    };
    const proc = spawn('node', [RECEIVE, ...args], { env });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (c) => { stdout += c.toString(); });
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.stdin.end(eml);
  });
}

function makeFakeSendmail(tmp) {
  const captureDir = path.join(tmp, 'captures');
  fssync.mkdirSync(captureDir, { recursive: true });
  const fake = path.join(tmp, 'fake-sendmail.sh');
  fssync.writeFileSync(fake,
    `#!/bin/sh
f=$(mktemp "${captureDir}/msg.XXXXXX")
cat > "$f"
exit 0
`, { mode: 0o755 });
  return { fake, captureDir };
}

function buildEml({ from, to, disposition, content }) {
  return Buffer.from([
    `From: ${from}`,
    `To: ${to}`,
    'Subject: signed doc',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="B"',
    '',
    '--B',
    'Content-Type: text/plain',
    '',
    'see attached',
    '',
    '--B',
    'Content-Type: application/pdf',
    `Content-Disposition: ${disposition}`,
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(content).toString('base64'),
    '',
    '--B--',
    '',
  ].join('\r\n'));
}

async function writeDeclEvent(tmp, id, overrides = {}) {
  await fs.mkdir(path.join(tmp, 'events'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'events', `${id}.json`), JSON.stringify({
    id, type: 'crypto', mode: 'declaration',
    title: 'unicode doc',
    initiator: 'boss@ex.com', signer: 'employee@ex.com',
    salt: `salt-${id}`,
    min_trust_level: 'unverified',
    details: 'Sign it.',
    activated_at: '2026-05-01T00:00:00Z',
    ...overrides,
  }));
}

const readEvent = async (tmp, id) =>
  JSON.parse(await fs.readFile(path.join(tmp, 'events', `${id}.json`), 'utf8'));

// Binary content with non-ASCII bytes, so size (bytes) is checked as bytes.
const CONTENT = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0xc3, 0xa9, 0x0d, 0x0a, 0x7f]);

const variants = [
  ["RFC 2231 filename*=UTF-8''", rfc2231],
  ['RFC 2047 encoded-word', rfc2047],
  ['RFC 2231 continuation filename*0*/1*', rfc2231Cont],
];

for (const [label, disposition] of variants) {
  test(`attach+: ${label} filename -> reference_docs records decoded Unicode name, size, sha256`, async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-nonascii-attach-'));
    try {
      const { fake } = makeFakeSendmail(tmp);
      await writeDeclEvent(tmp, 'na1');
      const eml = buildEml({
        from: 'boss@ex.com', to: 'attach+na1@git-done.com', disposition, content: CONTENT,
      });
      const r = await runReceive(eml,
        ['1.2.3.4', 'ex.com', 'boss@ex.com', 'attach+na1@git-done.com'],
        { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
      assert.equal(r.code, 0, r.stderr);
      const out = JSON.parse(r.stdout.trim());
      assert.equal(out.attach.accepted, true);
      assert.equal(out.attach.added, 1);

      const ev = await readEvent(tmp, 'na1');
      assert.equal(ev.reference_docs.length, 1);
      const d = ev.reference_docs[0];
      assert.equal(d.filename, NAME);
      assert.equal(d.size, CONTENT.length);
      assert.equal(d.sha256, 'sha256:' + crypto.createHash('sha256').update(CONTENT).digest('hex'));
    } finally { await fs.rm(tmp, { recursive: true, force: true }); }
  });

  test(`forward: ${label} filename -> forwarded byte-identical, header intact`, async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-nonascii-fwd-'));
    try {
      const { fake, captureDir } = makeFakeSendmail(tmp);
      await writeDeclEvent(tmp, 'nf1');
      const eml = buildEml({
        from: 'employee@ex.com', to: 'event+nf1@git-done.com', disposition, content: CONTENT,
      });
      const r = await runReceive(eml,
        ['1.2.3.4', 'ex.com', 'employee@ex.com', 'event+nf1@git-done.com'],
        { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
      assert.equal(r.code, 0, r.stderr);
      const records = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
      const main = records.find((x) => x.forward);
      assert.ok(main, 'no main record with forward');
      assert.equal(main.forward.ok, true);
      assert.equal(main.forward.to, 'boss@ex.com');

      let forwarded = null;
      for (const f of await fs.readdir(captureDir)) {
        const b = await fs.readFile(path.join(captureDir, f));
        if (b.toString('latin1').startsWith('X-GitDone-Event: nf1')) forwarded = b;
      }
      assert.ok(forwarded, 'no forwarded message captured');
      // Original bytes are the exact tail after the X-GitDone-* prefix.
      assert.ok(forwarded.subarray(forwarded.length - eml.length).equals(eml),
        'forwarded tail is not byte-identical to the original');
      assert.ok(forwarded.includes(Buffer.from(disposition)),
        'encoded Content-Disposition header was altered');
      assert.ok(forwarded.includes(Buffer.from(CONTENT.toString('base64'))),
        'attachment payload missing');
    } finally { await fs.rm(tmp, { recursive: true, force: true }); }
  });
}

test('strict signing: signer attaches same doc under a differently-encoded filename -> matches', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-nonascii-strict-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    await writeDeclEvent(tmp, 'ns1', { reference_url: 'https://example.com/doc.pdf' });
    const a = buildEml({
      from: 'boss@ex.com', to: 'attach+ns1@git-done.com', disposition: rfc2231, content: CONTENT,
    });
    let r = await runReceive(a,
      ['1.2.3.4', 'ex.com', 'boss@ex.com', 'attach+ns1@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r.code, 0, r.stderr);

    const s = buildEml({
      from: 'employee@ex.com', to: 'event+ns1@git-done.com', disposition: rfc2047, content: CONTENT,
    });
    r = await runReceive(s,
      ['1.2.3.4', 'ex.com', 'employee@ex.com', 'event+ns1@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r.code, 0, r.stderr);
    const records = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    const out = records.find((x) => x.completion);
    assert.ok(out);
    assert.equal(out.completion.applied, true, JSON.stringify(out.completion));
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});
