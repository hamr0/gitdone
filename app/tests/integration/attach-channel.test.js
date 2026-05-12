'use strict';

// Module 4a — attach+{id}@ reference-doc registration channel.
//
// Behaviour under test:
//   * initiator with 1 attachment → reference_docs[0] populated
//   * initiator with N attachments → all N appended in one shot
//   * two successive initiator emails → both batches stream in
//   * non-initiator → rejected ack, no state change
//   * non-crypto / unknown event → rejected
//   * no attachments → "no attachments" reply
//   * frozen (any counted reply already present) → "doc set frozen"
//   * bytes never persisted to disk (filesystem scan)
//   * derived gating: reference_url set + reference_docs empty → reply
//     bounces "awaiting reference documents" + commit lands in audit
//     trail; once docs land, a fresh reply counts.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RECEIVE = path.join(__dirname, '..', '..', 'bin', 'receive.js');

function runReceive(emlBuffer, envelopeArgs, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      GITDONE_LOG_FILE: '',
      GITDONE_LOG_STDOUT: 'true',
      GITDONE_OTS_BIN: '/nonexistent/ots',
      ...extraEnv,
    };
    const proc = spawn('node', [RECEIVE, ...envelopeArgs], { env });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (c) => { stdout += c.toString(); });
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.stdin.end(emlBuffer);
  });
}

function makeFakeSendmail(tmp) {
  const captureDir = path.join(tmp, 'captures');
  fssync.mkdirSync(captureDir, { recursive: true });
  const fake = path.join(tmp, 'fake-sendmail.sh');
  fssync.writeFileSync(fake,
    `#!/bin/sh
body=$(mktemp "${captureDir}/msg.XXXXXX")
cat > "$body"
to=$(grep -m1 -i '^To:' "$body" | sed 's/^[Tt]o:[[:space:]]*//' | tr -d '\\r')
safe=$(printf '%s' "$to" | sed 's/@/_at_/g' | tr -c 'a-zA-Z0-9._-' '_')
mv "$body" "${captureDir}/$safe.$(date +%N).eml"
exit 0
`, { mode: 0o755 });
  return { fake, captureDir };
}

function buildAttachEml({ from, to, subject = 'register docs', attachments = [] }) {
  const boundary = 'BOUNDARY';
  const parts = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain',
    '',
    'see attached',
    '',
  ];
  for (const a of attachments) {
    const b64 = Buffer.from(a.content).toString('base64');
    parts.push(
      `--${boundary}`,
      `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${a.filename}"`,
      `Content-Disposition: attachment; filename="${a.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      b64,
      ''
    );
  }
  parts.push(`--${boundary}--`, '');
  return Buffer.from(parts.join('\r\n'));
}

function buildPlainEml({ from, to, subject = 'hi' }) {
  return Buffer.from([
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    '', 'body', '',
  ].join('\r\n'));
}

async function writeDeclEvent(tmp, id, overrides = {}) {
  await fs.mkdir(path.join(tmp, 'events'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'events', `${id}.json`), JSON.stringify({
    id, type: 'crypto', mode: 'declaration',
    title: 'pink slip',
    initiator: 'boss@ex.com', signer: 'employee@ex.com',
    salt: `salt-${id}`,
    min_trust_level: 'unverified',
    details: 'Sign your departure paperwork.',
    activated_at: '2026-05-01T00:00:00Z',
    ...overrides,
  }));
}

async function writeAttEvent(tmp, id, overrides = {}) {
  await fs.mkdir(path.join(tmp, 'events'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'events', `${id}.json`), JSON.stringify({
    id, type: 'crypto', mode: 'attestation',
    title: 'quorum',
    initiator: 'chair@ex.com',
    threshold: 3, dedup: 'accumulating', replies: [],
    salt: `salt-${id}`,
    min_trust_level: 'unverified',         // accept unsigned mail through attach+ auth
    details: 'Vouch for X.',
    activated_at: '2026-05-01T00:00:00Z',
    ...overrides,
  }));
}

// ---------------------------------------------------------------------------

test('attach+: initiator with 1 attachment → reference_docs[0] populated', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-attach-1-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    await writeDeclEvent(tmp, 'a1');
    const eml = buildAttachEml({
      from: 'boss@ex.com', to: 'attach+a1@git-done.com',
      attachments: [{ filename: 'contract.pdf', contentType: 'application/pdf', content: 'PDF-BYTES-1' }],
    });
    const r = await runReceive(eml,
      ['1.2.3.4', 'ex.com', 'boss@ex.com', 'attach+a1@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.kind, 'attach_command');
    assert.equal(out.attach.accepted, true);
    assert.equal(out.attach.added, 1);

    const ev = JSON.parse(await fs.readFile(path.join(tmp, 'events', 'a1.json'), 'utf8'));
    assert.equal(ev.reference_docs.length, 1);
    const d = ev.reference_docs[0];
    assert.equal(d.filename, 'contract.pdf');
    assert.equal(d.size, Buffer.byteLength('PDF-BYTES-1'));
    assert.match(d.sha256, /^sha256:[0-9a-f]{64}$/);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('attach+: initiator with N attachments → all N appended in one go', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-attach-N-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    await writeDeclEvent(tmp, 'aN');
    const eml = buildAttachEml({
      from: 'boss@ex.com', to: 'attach+aN@git-done.com',
      attachments: [
        { filename: 'a.pdf', content: 'AAA' },
        { filename: 'b.pdf', content: 'BBBB' },
        { filename: 'c.pdf', content: 'CCCCC' },
      ],
    });
    const r = await runReceive(eml,
      ['1.2.3.4', 'ex.com', 'boss@ex.com', 'attach+aN@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r.code, 0, r.stderr);
    const ev = JSON.parse(await fs.readFile(path.join(tmp, 'events', 'aN.json'), 'utf8'));
    assert.equal(ev.reference_docs.length, 3);
    assert.deepEqual(ev.reference_docs.map((d) => d.filename), ['a.pdf', 'b.pdf', 'c.pdf']);
    assert.deepEqual(ev.reference_docs.map((d) => d.size), [3, 4, 5]);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('attach+: two successive initiator emails → entries stream in', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-attach-2x-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    await writeDeclEvent(tmp, 'a2');
    for (const f of ['first.pdf', 'second.pdf']) {
      const eml = buildAttachEml({
        from: 'boss@ex.com', to: 'attach+a2@git-done.com',
        attachments: [{ filename: f, content: `body-${f}` }],
      });
      const r = await runReceive(eml,
        ['1.2.3.4', 'ex.com', 'boss@ex.com', 'attach+a2@git-done.com'],
        { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
      assert.equal(r.code, 0, r.stderr);
    }
    const ev = JSON.parse(await fs.readFile(path.join(tmp, 'events', 'a2.json'), 'utf8'));
    assert.equal(ev.reference_docs.length, 2);
    assert.deepEqual(ev.reference_docs.map((d) => d.filename), ['first.pdf', 'second.pdf']);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('attach+: non-initiator → rejected, no reference_docs change', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-attach-noni-'));
  try {
    const { fake, captureDir } = makeFakeSendmail(tmp);
    await writeDeclEvent(tmp, 'an1');
    const eml = buildAttachEml({
      from: 'stranger@elsewhere.com', to: 'attach+an1@git-done.com',
      attachments: [{ filename: 'evil.pdf', content: 'should not stick' }],
    });
    const r = await runReceive(eml,
      ['1.2.3.4', 'elsewhere.com', 'stranger@elsewhere.com', 'attach+an1@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.attach.accepted, false);
    assert.match(out.attach.reason, /not the event initiator/);
    const ev = JSON.parse(await fs.readFile(path.join(tmp, 'events', 'an1.json'), 'utf8'));
    assert.ok(!ev.reference_docs || ev.reference_docs.length === 0);
    // Ack body explains it.
    const captures = await fs.readdir(captureDir);
    assert.ok(captures.length > 0, 'expected an ack to the stranger');
    const body = await fs.readFile(path.join(captureDir, captures[0]), 'utf8');
    assert.match(body, /Only the event initiator/);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('attach+: unknown event id → rejected ack, no state change', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-attach-nf-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    await fs.mkdir(path.join(tmp, 'events'), { recursive: true });
    const eml = buildAttachEml({
      from: 'boss@ex.com', to: 'attach+ghostxyz@git-done.com',
      attachments: [{ filename: 'x.pdf', content: 'x' }],
    });
    const r = await runReceive(eml,
      ['1.2.3.4', 'ex.com', 'boss@ex.com', 'attach+ghostxyz@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.attach.accepted, false);
    assert.match(out.attach.reason, /unknown event/);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('attach+: workflow event → rejected (crypto-only channel)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-attach-wf-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    await fs.mkdir(path.join(tmp, 'events'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'events', 'wf1.json'), JSON.stringify({
      id: 'wf1', type: 'event', title: 'wf', initiator: 'boss@ex.com',
      salt: 'salt-wf1', min_trust_level: 'unverified',
      activated_at: '2026-05-01T00:00:00Z',
      steps: [{ id: 'a', name: 'a', participant: 'a@ex.com', status: 'pending', depends_on: [] }],
    }));
    const eml = buildAttachEml({
      from: 'boss@ex.com', to: 'attach+wf1@git-done.com',
      attachments: [{ filename: 'x.pdf', content: 'x' }],
    });
    const r = await runReceive(eml,
      ['1.2.3.4', 'ex.com', 'boss@ex.com', 'attach+wf1@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.attach.accepted, false);
    assert.match(out.attach.reason, /not a crypto event/);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('attach+: no attachments → "no attachments" ack, no reference_docs change', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-attach-empty-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    await writeDeclEvent(tmp, 'ae1');
    const eml = buildPlainEml({ from: 'boss@ex.com', to: 'attach+ae1@git-done.com' });
    const r = await runReceive(eml,
      ['1.2.3.4', 'ex.com', 'boss@ex.com', 'attach+ae1@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.attach.accepted, false);
    assert.match(out.attach.reason, /no attachments/);
    const ev = JSON.parse(await fs.readFile(path.join(tmp, 'events', 'ae1.json'), 'utf8'));
    assert.ok(!ev.reference_docs || ev.reference_docs.length === 0);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('attach+: frozen after first counted reply → bounces with explanation', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-attach-frozen-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    // Attestation event with one synthetic reply already counted.
    await writeAttEvent(tmp, 'af1', {
      replies: [{ sender_hash: 'sha256:dead', received_at: '2026-05-02T00:00:00Z', sequence: 1, trust_level: 'unverified' }],
    });
    const eml = buildAttachEml({
      from: 'chair@ex.com', to: 'attach+af1@git-done.com',
      attachments: [{ filename: 'late.pdf', content: 'late' }],
    });
    const r = await runReceive(eml,
      ['1.2.3.4', 'ex.com', 'chair@ex.com', 'attach+af1@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.attach.accepted, false);
    assert.match(out.attach.reason, /frozen/);
    const ev = JSON.parse(await fs.readFile(path.join(tmp, 'events', 'af1.json'), 'utf8'));
    assert.ok(!ev.reference_docs || ev.reference_docs.length === 0,
      'frozen events must not append');
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('attach+: bytes never persisted to disk (filesystem scan)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-attach-discard-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    await writeDeclEvent(tmp, 'ad1');
    const SECRET = 'DEADBEEF-SECRET-NEEDLE-IN-HAYSTACK';
    const eml = buildAttachEml({
      from: 'boss@ex.com', to: 'attach+ad1@git-done.com',
      attachments: [{ filename: 'secret.txt', content: SECRET }],
    });
    const r = await runReceive(eml,
      ['1.2.3.4', 'ex.com', 'boss@ex.com', 'attach+ad1@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r.code, 0, r.stderr);

    // Walk the data dir; no file under data/ should contain the secret
    // bytes. The captures/ dir is the fake sendmail's outbound dump, not
    // gitdone's storage — exclude it.
    async function scan(dir) {
      const out = [];
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'captures') continue;        // mail capture, not storage
          if (e.name === 'fake-sendmail.sh') continue;
          out.push(...await scan(p));
        } else if (e.isFile()) {
          if (p.endsWith('fake-sendmail.sh')) continue;
          out.push(p);
        }
      }
      return out;
    }
    const files = await scan(tmp);
    for (const f of files) {
      const buf = await fs.readFile(f);
      assert.ok(!buf.includes(SECRET), `secret bytes leaked into ${f}`);
    }
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('derived gating: reference_url set + no docs → reply bounces "awaiting reference documents"', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-gating-noddocs-'));
  try {
    const { fake, captureDir } = makeFakeSendmail(tmp);
    await writeDeclEvent(tmp, 'g1', {
      reference_url: 'https://example.com/contract.pdf',
    });
    const eml = buildPlainEml({
      from: 'employee@ex.com', to: 'event+g1@git-done.com', subject: 'I sign',
    });
    const r = await runReceive(eml,
      ['1.2.3.4', 'ex.com', 'employee@ex.com', 'event+g1@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r.code, 0, r.stderr);
    // receive.js emits one main log + a participant_auto_reply on
    // rejection — parse all lines, pick the main record.
    const records = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    const out = records.find((rr) => rr.completion);
    assert.ok(out, 'no main record with completion');
    assert.equal(out.completion.applied, false);
    assert.equal(out.completion.decision.reason, 'awaiting_reference_docs');
    // Ack body explains it.
    const all = await fs.readdir(captureDir);
    const employeeAcks = all.filter((f) => f.startsWith('employee_at_ex.com'));
    assert.ok(employeeAcks.length, `no ack to employee in ${all.join(',')}`);
    const body = await fs.readFile(path.join(captureDir, employeeAcks[0]), 'utf8');
    assert.match(body, /Awaiting reference documents/);
    assert.match(body, /example\.com\/contract\.pdf/);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('derived gating + strict signing: after docs register, signer attaches matching file → counts', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-gating-thaw-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    await writeDeclEvent(tmp, 'g2', {
      reference_url: 'https://example.com/doc.pdf',
    });
    // 1. Initiator registers a doc via attach+.
    const a = buildAttachEml({
      from: 'boss@ex.com', to: 'attach+g2@git-done.com',
      attachments: [{ filename: 'doc.pdf', content: 'PDFBYTES' }],
    });
    const ra = await runReceive(a,
      ['1.2.3.4', 'ex.com', 'boss@ex.com', 'attach+g2@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(ra.code, 0, ra.stderr);
    // 2. Signer attaches the SAME bytes — strict mode requires it.
    const b = buildAttachEml({
      from: 'employee@ex.com', to: 'event+g2@git-done.com', subject: 'signed',
      attachments: [{ filename: 'doc.pdf', content: 'PDFBYTES' }],
    });
    const rb = await runReceive(b,
      ['1.2.3.4', 'ex.com', 'employee@ex.com', 'event+g2@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(rb.code, 0, rb.stderr);
    const records = rb.stdout.trim().split('\n').map((l) => JSON.parse(l));
    const out = records.find((rr) => rr.completion);
    assert.ok(out, 'no main record with completion');
    assert.equal(out.completion.applied, true);
    assert.equal(out.completion.completed_event, true);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('counted-reply ack body lists reference_docs', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-ack-doclist-'));
  try {
    const { fake, captureDir } = makeFakeSendmail(tmp);
    await writeDeclEvent(tmp, 'ad2');
    // Register a doc first.
    const a = buildAttachEml({
      from: 'boss@ex.com', to: 'attach+ad2@git-done.com',
      attachments: [{ filename: 'plan.pdf', content: 'PLANBYTES' }],
    });
    const ra = await runReceive(a,
      ['1.2.3.4', 'ex.com', 'boss@ex.com', 'attach+ad2@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(ra.code, 0, ra.stderr);
    // Signer reply lands; ack should enumerate docs.
    const b = buildPlainEml({
      from: 'employee@ex.com', to: 'event+ad2@git-done.com', subject: 'signed',
    });
    const rb = await runReceive(b,
      ['1.2.3.4', 'ex.com', 'employee@ex.com', 'event+ad2@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(rb.code, 0, rb.stderr);
    const out = JSON.parse(rb.stdout.trim());
    assert.equal(out.completion.applied, true);

    const all = await fs.readdir(captureDir);
    const employeeAcks = all.filter((f) => f.startsWith('employee_at_ex.com'));
    assert.ok(employeeAcks.length, 'no ack to signer');
    let body = '';
    for (const f of employeeAcks) {
      const txt = await fs.readFile(path.join(captureDir, f), 'utf8');
      if (/Reference documents/.test(txt)) { body = txt; break; }
    }
    assert.ok(body, 'no Reference-documents block in any signer ack');
    assert.match(body, /plan\.pdf/);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});
