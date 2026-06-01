'use strict';

// Module 4c — strict signing.
//
// Behaviour under test:
//   * declaration: activation with reference_url set + no docs HOLDS the
//     signer invite.
//   * declaration: first attach+ email registers the canonical doc set,
//     freezes it, fires the signer invite (with file list + hashes).
//   * declaration: signer reply with matching attachment → counted as
//     a partial sign; event stays open if more docs pending.
//   * declaration: signer reply matching the LAST pending doc → event
//     completes.
//   * declaration: signer reply with filename match but byte mismatch
//     → attachment_set_mismatch reject + diff in ack body.
//   * declaration: signer reply with no attachments → strict_no_matching
//     reject.
//   * attestation: per-attestor progress map; an attestor counts toward
//     threshold only when they've signed ALL docs.
//   * second attach+ email after first batch (strict mode frozen-from-1) → bounce.
//   * extras (unrelated attachments) are ignored, do not block matches.

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

function buildAttachEml({ from, to, subject = 'msg', attachments = [] }) {
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
    'reply',
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
    title: 'strict decl',
    initiator: 'boss@ex.com', signer: 'employee@ex.com',
    salt: `salt-${id}`,
    min_trust_level: 'unverified',
    details: 'Sign these docs.',
    activated_at: '2026-05-01T00:00:00Z',
    ...overrides,
  }));
}

async function writeAttEvent(tmp, id, overrides = {}) {
  await fs.mkdir(path.join(tmp, 'events'), { recursive: true });
  // accumulating dedup so unsigned test mail counts (no DKIM-required gate
  // on the reply path), and min_trust_level: 'unverified' so the initiator
  // command auth (attach+) accepts the unsigned test sender.
  await fs.writeFile(path.join(tmp, 'events', `${id}.json`), JSON.stringify({
    id, type: 'crypto', mode: 'attestation',
    title: 'strict att',
    initiator: 'chair@ex.com',
    threshold: 2, dedup: 'accumulating', replies: [],
    salt: `salt-${id}`,
    min_trust_level: 'unverified',
    details: 'Attest.',
    activated_at: '2026-05-01T00:00:00Z',
    ...overrides,
  }));
}

function lines(stdout) {
  return stdout.trim().split('\n').map((l) => JSON.parse(l));
}
function mainRecord(stdout) {
  return lines(stdout).find((r) => r.completion);
}

// ---------------------------------------------------------------------------

test('strict declaration: first attach+ fires signer invite + freezes', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-strict-invite-'));
  try {
    const { fake, captureDir } = makeFakeSendmail(tmp);
    await writeDeclEvent(tmp, 's1', {
      reference_url: 'https://example.com/contract.pdf',
    });
    // Initiator registers two docs in ONE email.
    const a = buildAttachEml({
      from: 'boss@ex.com', to: 'attach+s1@git-done.com',
      attachments: [
        { filename: 'a.pdf', content: 'AAAA' },
        { filename: 'b.pdf', content: 'BBBB' },
      ],
    });
    const r = await runReceive(a,
      ['1.2.3.4', 'ex.com', 'boss@ex.com', 'attach+s1@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.attach.accepted, true);
    assert.ok(Array.isArray(out.attach.signer_invited),
      'expected signer_invited array on attach outcome');
    // Signer received the invite with file list + hash mentions.
    const all = await fs.readdir(captureDir);
    const signer = all.filter((f) => f.startsWith('employee_at_ex.com'));
    assert.ok(signer.length, `no invite to signer in ${all.join(',')}`);
    let inviteBody = '';
    for (const f of signer) {
      const txt = await fs.readFile(path.join(captureDir, f), 'utf8');
      if (/please sign/.test(txt) || /asked you to sign/.test(txt)) { inviteBody = txt; break; }
    }
    assert.ok(inviteBody, 'invite not found');
    assert.match(inviteBody, /a\.pdf/);
    assert.match(inviteBody, /b\.pdf/);
    assert.match(inviteBody, /sha256:/);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('strict declaration: second attach+ batch bounces (frozen from first email)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-strict-frozen-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    await writeDeclEvent(tmp, 's2', {
      reference_url: 'https://example.com/contract.pdf',
    });
    const a1 = buildAttachEml({
      from: 'boss@ex.com', to: 'attach+s2@git-done.com',
      attachments: [{ filename: 'a.pdf', content: 'AAAA' }],
    });
    const r1 = await runReceive(a1,
      ['1.2.3.4', 'ex.com', 'boss@ex.com', 'attach+s2@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r1.code, 0, r1.stderr);
    const a2 = buildAttachEml({
      from: 'boss@ex.com', to: 'attach+s2@git-done.com',
      attachments: [{ filename: 'b.pdf', content: 'BBBB' }],
    });
    const r2 = await runReceive(a2,
      ['1.2.3.4', 'ex.com', 'boss@ex.com', 'attach+s2@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r2.code, 0, r2.stderr);
    const out2 = JSON.parse(r2.stdout.trim());
    assert.equal(out2.attach.accepted, false);
    assert.match(out2.attach.reason, /frozen/);
    const ev = JSON.parse(await fs.readFile(path.join(tmp, 'events', 's2.json'), 'utf8'));
    assert.equal(ev.reference_docs.length, 1);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('strict declaration: matching attachment counts as partial; event stays open', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-strict-partial-'));
  try {
    const { fake, captureDir } = makeFakeSendmail(tmp);
    await writeDeclEvent(tmp, 's3', {
      reference_url: 'https://example.com/contract.pdf',
    });
    // Two docs registered.
    const a = buildAttachEml({
      from: 'boss@ex.com', to: 'attach+s3@git-done.com',
      attachments: [
        { filename: 'a.pdf', content: 'AAAA' },
        { filename: 'b.pdf', content: 'BBBB' },
      ],
    });
    await runReceive(a,
      ['1.2.3.4', 'ex.com', 'boss@ex.com', 'attach+s3@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    // Signer attaches only ONE.
    const b = buildAttachEml({
      from: 'employee@ex.com', to: 'event+s3@git-done.com',
      attachments: [{ filename: 'a.pdf', content: 'AAAA' }],
    });
    const rb = await runReceive(b,
      ['1.2.3.4', 'ex.com', 'employee@ex.com', 'event+s3@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(rb.code, 0, rb.stderr);
    const out = mainRecord(rb.stdout);
    assert.equal(out.completion.applied, true);
    assert.equal(out.completion.completed_event, false, 'event must NOT complete on partial');

    const ev = JSON.parse(await fs.readFile(path.join(tmp, 'events', 's3.json'), 'utf8'));
    assert.ok(ev.reference_docs[0].signed_at);
    assert.ok(!ev.reference_docs[1].signed_at);

    // Ack lists matched / still needed.
    const all = await fs.readdir(captureDir);
    const signerAcks = all.filter((f) => f.startsWith('employee_at_ex.com'));
    let body = '';
    for (const f of signerAcks) {
      const txt = await fs.readFile(path.join(captureDir, f), 'utf8');
      if (/Signed in progress/.test(txt) || /Progress: 1 of 2/.test(txt)) { body = txt; break; }
    }
    assert.ok(body, `no progress ack in ${signerAcks.join(',')}`);
    assert.match(body, /\[x\] a\.pdf/);
    assert.match(body, /\[ \] b\.pdf/);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('strict declaration: signer receives "Signed" final ack on the completing reply', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-strict-finalack-'));
  try {
    const { fake, captureDir } = makeFakeSendmail(tmp);
    await writeDeclEvent(tmp, 'sf1', {
      reference_url: 'https://example.com/contract.pdf',
    });
    const a = buildAttachEml({
      from: 'boss@ex.com', to: 'attach+sf1@git-done.com',
      attachments: [
        { filename: 'a.pdf', content: 'AAAA' },
        { filename: 'b.pdf', content: 'BBBB' },
      ],
    });
    await runReceive(a,
      ['1.2.3.4', 'ex.com', 'boss@ex.com', 'attach+sf1@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    // Signer reply #1 (partial).
    await runReceive(buildAttachEml({
      from: 'employee@ex.com', to: 'event+sf1@git-done.com',
      attachments: [{ filename: 'a.pdf', content: 'AAAA' }],
    }),
      ['1.2.3.4', 'ex.com', 'employee@ex.com', 'event+sf1@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    // Signer reply #2 (completes).
    await runReceive(buildAttachEml({
      from: 'employee@ex.com', to: 'event+sf1@git-done.com',
      attachments: [{ filename: 'b.pdf', content: 'BBBB' }],
    }),
      ['1.2.3.4', 'ex.com', 'employee@ex.com', 'event+sf1@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    // Signer should have received a "Signed" final ack (subject differs
    // from the in-progress one).
    const all = await fs.readdir(captureDir);
    const signerAcks = all.filter((f) => f.startsWith('employee_at_ex.com'));
    assert.ok(signerAcks.length, 'no signer ack captures at all');
    let finalAckBody = '';
    for (const f of signerAcks) {
      const txt = await fs.readFile(path.join(captureDir, f), 'utf8');
      if (/Subject: \[signedreply\] Signed —/.test(txt)) { finalAckBody = txt; break; }
    }
    assert.ok(finalAckBody, `no final "Signed —" ack to signer in ${signerAcks.join(',')}`);
    assert.match(finalAckBody, /declaration is now final/);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('strict declaration: matching the last pending doc completes the event', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-strict-complete-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    await writeDeclEvent(tmp, 's4', {
      reference_url: 'https://example.com/contract.pdf',
    });
    const a = buildAttachEml({
      from: 'boss@ex.com', to: 'attach+s4@git-done.com',
      attachments: [
        { filename: 'a.pdf', content: 'AAAA' },
        { filename: 'b.pdf', content: 'BBBB' },
      ],
    });
    await runReceive(a,
      ['1.2.3.4', 'ex.com', 'boss@ex.com', 'attach+s4@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    // Reply #1: sign a.pdf
    const b1 = buildAttachEml({
      from: 'employee@ex.com', to: 'event+s4@git-done.com',
      attachments: [{ filename: 'a.pdf', content: 'AAAA' }],
    });
    await runReceive(b1,
      ['1.2.3.4', 'ex.com', 'employee@ex.com', 'event+s4@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    // Reply #2: sign b.pdf — should complete.
    const b2 = buildAttachEml({
      from: 'employee@ex.com', to: 'event+s4@git-done.com',
      attachments: [{ filename: 'b.pdf', content: 'BBBB' }],
    });
    const r2 = await runReceive(b2,
      ['1.2.3.4', 'ex.com', 'employee@ex.com', 'event+s4@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    const out2 = mainRecord(r2.stdout);
    assert.equal(out2.completion.applied, true);
    assert.equal(out2.completion.completed_event, true);
    const ev = JSON.parse(await fs.readFile(path.join(tmp, 'events', 's4.json'), 'utf8'));
    assert.equal(ev.completion.status, 'complete');
    assert.ok(ev.reference_docs.every((d) => d.signed_at));
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('strict declaration: filename match + byte mismatch → attachment_set_mismatch + diff in ack', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-strict-mismatch-'));
  try {
    const { fake, captureDir } = makeFakeSendmail(tmp);
    await writeDeclEvent(tmp, 's5', {
      reference_url: 'https://example.com/contract.pdf',
    });
    const a = buildAttachEml({
      from: 'boss@ex.com', to: 'attach+s5@git-done.com',
      attachments: [{ filename: 'doc.pdf', content: 'ORIGINAL' }],
    });
    await runReceive(a,
      ['1.2.3.4', 'ex.com', 'boss@ex.com', 'attach+s5@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    // Signer attaches a DIFFERENT bytes for the same filename.
    const b = buildAttachEml({
      from: 'employee@ex.com', to: 'event+s5@git-done.com',
      attachments: [{ filename: 'doc.pdf', content: 'TAMPERED' }],
    });
    const rb = await runReceive(b,
      ['1.2.3.4', 'ex.com', 'employee@ex.com', 'event+s5@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    const out = mainRecord(rb.stdout);
    assert.equal(out.completion.applied, false);
    assert.equal(out.completion.decision.reason, 'attachment_set_mismatch');
    const ev = JSON.parse(await fs.readFile(path.join(tmp, 'events', 's5.json'), 'utf8'));
    assert.ok(!ev.reference_docs[0].signed_at, 'must not mark doc signed on mismatch');
    // Ack body contains the diff.
    const all = await fs.readdir(captureDir);
    const signerAcks = all.filter((f) => f.startsWith('employee_at_ex.com'));
    let body = '';
    for (const f of signerAcks) {
      const txt = await fs.readFile(path.join(captureDir, f), 'utf8');
      if (/hash mismatch/i.test(txt)) { body = txt; break; }
    }
    assert.ok(body, `no mismatch ack in ${signerAcks.join(',')}`);
    assert.match(body, /doc\.pdf/);
    assert.match(body, /expected:/);
    assert.match(body, /got:/);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('strict declaration: signer reply with no matching attachments → strict_no_matching', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-strict-nomatch-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    await writeDeclEvent(tmp, 's6', {
      reference_url: 'https://example.com/contract.pdf',
    });
    const a = buildAttachEml({
      from: 'boss@ex.com', to: 'attach+s6@git-done.com',
      attachments: [{ filename: 'real.pdf', content: 'REAL' }],
    });
    await runReceive(a,
      ['1.2.3.4', 'ex.com', 'boss@ex.com', 'attach+s6@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    // Signer replies with totally unrelated file.
    const b = buildAttachEml({
      from: 'employee@ex.com', to: 'event+s6@git-done.com',
      attachments: [{ filename: 'random.pdf', content: 'NOTHING' }],
    });
    const rb = await runReceive(b,
      ['1.2.3.4', 'ex.com', 'employee@ex.com', 'event+s6@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    const out = mainRecord(rb.stdout);
    assert.equal(out.completion.applied, false);
    assert.equal(out.completion.decision.reason, 'strict_no_matching_attachments');
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('strict declaration: extras (unrelated attachments) are ignored, do not block real matches', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-strict-extras-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    await writeDeclEvent(tmp, 's7', {
      reference_url: 'https://example.com/contract.pdf',
    });
    const a = buildAttachEml({
      from: 'boss@ex.com', to: 'attach+s7@git-done.com',
      attachments: [{ filename: 'real.pdf', content: 'REAL' }],
    });
    await runReceive(a,
      ['1.2.3.4', 'ex.com', 'boss@ex.com', 'attach+s7@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    // Signer attaches the real doc + an extra that doesn't match anything.
    const b = buildAttachEml({
      from: 'employee@ex.com', to: 'event+s7@git-done.com',
      attachments: [
        { filename: 'real.pdf', content: 'REAL' },
        { filename: 'signature.png', content: 'PNGBYTES' },
      ],
    });
    const rb = await runReceive(b,
      ['1.2.3.4', 'ex.com', 'employee@ex.com', 'event+s7@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    const out = mainRecord(rb.stdout);
    assert.equal(out.completion.applied, true);
    assert.equal(out.completion.completed_event, true);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

// Module 4e — strict-attestation only: the threshold-tripping reply
// fires a proof email to every counted attestor (read from
// attestor_progress[*].email), then those emails are redacted from
// event.json and attestor_emails_redacted_at is stamped. Loose
// attestation keeps the anonymity-friendly posture (no emails stored,
// no attestor proof notification).
test('strict attestation 4e: completion notification reaches attestors + redact runs', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-strict-att-4e-'));
  try {
    const { fake, captureDir } = makeFakeSendmail(tmp);
    await writeAttEvent(tmp, 'sa4e', {
      reference_url: 'https://example.com/post',
    });
    // Initiator registers one doc (keeps the test compact).
    const reg = buildAttachEml({
      from: 'chair@ex.com', to: 'attach+sa4e@git-done.com',
      attachments: [{ filename: 'doc.pdf', content: 'XX' }],
    });
    await runReceive(reg,
      ['1.2.3.4', 'ex.com', 'chair@ex.com', 'attach+sa4e@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });

    // Attestor 1 signs — bucket completes, but threshold (2) not yet reached.
    const a1 = buildAttachEml({
      from: 'alice@ex.com', to: 'event+sa4e@git-done.com',
      attachments: [{ filename: 'doc.pdf', content: 'XX' }],
    });
    await runReceive(a1,
      ['1.2.3.4', 'ex.com', 'alice@ex.com', 'event+sa4e@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    let ev = JSON.parse(await fs.readFile(path.join(tmp, 'events', 'sa4e.json'), 'utf8'));
    const aliceKey = Object.keys(ev.attestor_progress)[0];
    assert.equal(ev.attestor_progress[aliceKey].complete, true);
    assert.equal(ev.attestor_progress[aliceKey].email, 'alice@ex.com',
      'expected attestor email persisted on bucket-completing reply');
    assert.ok(!ev.attestor_emails_redacted_at, 'redaction must not fire pre-threshold');

    // Clear captures so we only look at the proof-email burst that
    // follows the threshold-tripping reply.
    for (const f of await fs.readdir(captureDir)) await fs.unlink(path.join(captureDir, f));

    // Attestor 2 signs — threshold reached, completion notification fires.
    const a2 = buildAttachEml({
      from: 'bob@ex.com', to: 'event+sa4e@git-done.com',
      attachments: [{ filename: 'doc.pdf', content: 'XX' }],
    });
    await runReceive(a2,
      ['1.2.3.4', 'ex.com', 'bob@ex.com', 'event+sa4e@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });

    // Read every captured outbound mail and bucket by To: header. The
    // proof email subject is "[signedreply] proof — ..."; participant acks
    // and the per-reply attestation receipt are also captured, so we
    // filter to the proof subject.
    const captureFiles = await fs.readdir(captureDir);
    const proofRecipients = new Set();
    for (const f of captureFiles) {
      const body = await fs.readFile(path.join(captureDir, f), 'utf8');
      const subjectLine = body.split(/\r?\n/).find((l) => /^Subject:/i.test(l)) || '';
      if (!/\[signedreply\] proof /.test(subjectLine)) continue;
      const toLine = body.split(/\r?\n/).find((l) => /^To:/i.test(l)) || '';
      const m = toLine.match(/<([^>]+)>|([\w.+-]+@[\w.-]+)/);
      if (m) proofRecipients.add((m[1] || m[2]).toLowerCase());
    }
    assert.ok(proofRecipients.has('chair@ex.com'), 'initiator must receive the proof email');
    assert.ok(proofRecipients.has('alice@ex.com'), 'attestor 1 must receive the proof email (4e)');
    assert.ok(proofRecipients.has('bob@ex.com'), 'attestor 2 must receive the proof email (4e)');

    // Body shape contract: organiser gets aggregate, attestor does NOT.
    // The privacy split is the whole point of separate bodies for
    // organiser vs attestor on attestation events.
    let organiserBody = '';
    let aliceBody = '';
    for (const f of captureFiles) {
      const body = await fs.readFile(path.join(captureDir, f), 'utf8');
      const subjectLine = body.split(/\r?\n/).find((l) => /^Subject:/i.test(l)) || '';
      if (!/\[signedreply\] proof /.test(subjectLine)) continue;
      const toLine = body.split(/\r?\n/).find((l) => /^To:/i.test(l)) || '';
      if (/chair@ex\.com/i.test(toLine)) organiserBody = body;
      if (/alice@ex\.com/i.test(toLine)) aliceBody = body;
    }
    assert.ok(organiserBody && aliceBody, 'expected both organiser and alice bodies captured');
    // Organiser body MUST surface aggregate trust posture. The receipt
    // header is "Attestors complete" for strict mode (vs "Signers" /
    // "Replies" for loose modes); either form proves the aggregate
    // block was rendered.
    assert.match(organiserBody, /Attestors complete|Signers|^Replies\s+\d/im, 'organiser body should include the aggregate receipt block');
    assert.match(organiserBody, /Modal trust/i, 'organiser body should include modal trust posture');
    assert.match(organiserBody, /Mode: Attestation/i, 'organiser body should declare mode');
    // Alice's body MUST NOT include aggregate counts (over-share guard).
    assert.doesNotMatch(aliceBody, /Modal trust/i, 'attestor body must NOT leak modal trust');
    assert.doesNotMatch(aliceBody, /Attestors complete/i, 'attestor body must NOT leak aggregate count');
    assert.doesNotMatch(aliceBody, /Modal trust/i, 'attestor body must NOT leak modal trust');
    assert.match(aliceBody, /Your receipt/i, 'attestor body should carry their OWN receipt block');
    assert.match(aliceBody, /YOUR record only/, 'attestor body should state the privacy framing explicitly');
    // Reference URL + doc manifest should be echoed in both.
    assert.match(organiserBody, /Reference: https:\/\/example\.com\/post/);
    assert.match(aliceBody, /Reference: https:\/\/example\.com\/post/);
    assert.match(organiserBody, /doc\.pdf\s+sha256:/);
    assert.match(aliceBody, /doc\.pdf\s+sha256:/);

    // Post-send: emails MUST persist in attestor_progress through the
    // active lifetime so revoke-reopen-recomplete and oversubscribe
    // flows can still reach every eligible attestor. Redaction is
    // deferred to the close-by-initiator path (and dashboard close,
    // and archive sweep). See receive.js close+ handler + server.js
    // dashboard-close handler for the redaction call sites.
    ev = JSON.parse(await fs.readFile(path.join(tmp, 'events', 'sa4e.json'), 'utf8'));
    let anyEmail = false;
    for (const p of Object.values(ev.attestor_progress)) {
      if (p && typeof p.email === 'string' && p.email.includes('@')) anyEmail = true;
    }
    assert.ok(anyEmail, 'at least one attestor_progress.email must persist post-send');
    assert.ok(!ev.attestor_emails_redacted_at, 'attestor_emails_redacted_at must NOT be set pre-close');
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('strict attestation: per-attestor progress; partial does not count, full sign counts', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-strict-att-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    await writeAttEvent(tmp, 'sa1', {
      reference_url: 'https://example.com/post',
    });
    // Initiator registers two docs.
    const a = buildAttachEml({
      from: 'chair@ex.com', to: 'attach+sa1@git-done.com',
      attachments: [
        { filename: 'a.pdf', content: 'AA' },
        { filename: 'b.pdf', content: 'BB' },
      ],
    });
    await runReceive(a,
      ['1.2.3.4', 'ex.com', 'chair@ex.com', 'attach+sa1@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });

    // Attestor 1 signs only a.pdf — must not count toward threshold yet.
    const b1 = buildAttachEml({
      from: 'alice@ex.com', to: 'event+sa1@git-done.com',
      attachments: [{ filename: 'a.pdf', content: 'AA' }],
    });
    const r1 = await runReceive(b1,
      ['1.2.3.4', 'ex.com', 'alice@ex.com', 'event+sa1@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    const out1 = mainRecord(r1.stdout);
    assert.equal(out1.completion.applied, true);
    let ev = JSON.parse(await fs.readFile(path.join(tmp, 'events', 'sa1.json'), 'utf8'));
    const aliceKey = Object.keys(ev.attestor_progress).find((k) => ev.attestor_progress[k].signed_doc_hashes.length === 1);
    assert.ok(aliceKey, 'expected alice progress entry');
    assert.equal(ev.attestor_progress[aliceKey].complete, false);

    // Attestor 1 sends second email with b.pdf — now complete, counts as 1.
    const b2 = buildAttachEml({
      from: 'alice@ex.com', to: 'event+sa1@git-done.com',
      attachments: [{ filename: 'b.pdf', content: 'BB' }],
    });
    const r2 = await runReceive(b2,
      ['1.2.3.4', 'ex.com', 'alice@ex.com', 'event+sa1@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    const out2 = mainRecord(r2.stdout);
    assert.equal(out2.completion.applied, true);
    ev = JSON.parse(await fs.readFile(path.join(tmp, 'events', 'sa1.json'), 'utf8'));
    assert.equal(ev.attestor_progress[aliceKey].complete, true);
    // Threshold is 2, only 1 complete attestor — event still open.
    assert.notEqual(ev.completion && ev.completion.status, 'complete');

    // Attestor 2 signs both in one go → 2 complete attestors, threshold
    // crossed. Under accumulating dedup the event itself stays open
    // (organiser closes explicitly), but threshold_reached_at is stamped.
    const b3 = buildAttachEml({
      from: 'bob@ex.com', to: 'event+sa1@git-done.com',
      attachments: [
        { filename: 'a.pdf', content: 'AA' },
        { filename: 'b.pdf', content: 'BB' },
      ],
    });
    const r3 = await runReceive(b3,
      ['1.2.3.4', 'ex.com', 'bob@ex.com', 'event+sa1@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    const out3 = mainRecord(r3.stdout);
    assert.equal(out3.completion.applied, true);
    ev = JSON.parse(await fs.readFile(path.join(tmp, 'events', 'sa1.json'), 'utf8'));
    const completeCount = Object.values(ev.attestor_progress).filter((p) => p.complete).length;
    assert.equal(completeCount, 2, 'two complete attestors expected');
    assert.ok(ev.threshold_reached_at, 'expected threshold_reached_at to be stamped');
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});
