'use strict';

// Regression test for the 0.24.8 contract — locks the behaviour
// before the 0.25.0 email-system refactor (recipient resolver +
// notifyLifecycleEdge unification).
//
// Three claims under test, in one end-to-end strict-attestation
// lifecycle:
//
//   1. Strict-attestation attestor emails persist in
//      attestor_progress[h].email through the active lifetime.
//      Module 4e's "redact on first proof email" pattern was
//      structurally broken under revoke-reopen-recomplete and
//      oversubscribe; 0.24.8 defers redaction to close.
//
//   2. The proof email fires on every legitimate threshold-reach
//      edge — natural reach AND revoke-reopen-recomplete. The
//      stamp gate compares completion.completed_at vs
//      proof_email_sent_at; a fresh completed_at after reopen
//      legitimately re-fires the proof.
//
//   3. Redaction (attestor_emails_redacted_at + clearing every
//      stored email) fires on close-by-initiator. That's the
//      terminal signal; not at threshold reach, not at first
//      proof send.
//
// Lifecycle: threshold 2, 2 docs, three attestors with distinct
// addresses under the test DKIM domain. A partial → B+C full →
// reach → revoke B → reopen → A completes 2nd doc → recomplete →
// close+ → redact.
//
// Why DKIM? unique dedup (the only mode where revoke can reopen
// completion) requires DKIM-verified replies. The shared DKIM
// helper + stub DNS resolver pattern from e2e-proof.test.js gets
// us trust='verified' without touching real mail infrastructure.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RECEIVE = path.join(__dirname, '..', '..', 'bin', 'receive.js');
const { hashSender } = require('../../src/completion');
const { signDkim } = require('../helpers/dkim-sign');

const DKIM_DOMAIN = 'test.example.com';
const DKIM_SELECTOR = 'test1';
const DKIM_PRIV_PATH = path.join(__dirname, '..', 'fixtures', 'dkim', `${DKIM_DOMAIN}.private.pem`);
const DKIM_PRIV_PEM = fssync.readFileSync(DKIM_PRIV_PATH, 'utf8');

function writeDnsStub(filePath, domain, selector) {
  const pubB64 = crypto
    .createPublicKey(crypto.createPrivateKey(DKIM_PRIV_PEM))
    .export({ type: 'spki', format: 'der' })
    .toString('base64');
  fssync.writeFileSync(filePath, JSON.stringify({
    [`${selector}._domainkey.${domain}`]: `v=DKIM1; k=rsa; p=${pubB64}`,
    [`_dmarc.${domain}`]: 'v=DMARC1; p=none; adkim=r; aspf=r',
  }));
}

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

// Build a multipart MIME message with the headers required by the
// shared DKIM helper (from, to, subject, date, message-id).
function buildAttachEml({ from, to, subject = 'msg', messageId, attachments = [] }) {
  const boundary = 'BOUNDARY';
  const parts = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${messageId}>`,
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

function buildPlainEml({ from, to, subject = 'msg', messageId, body = '' }) {
  return Buffer.from([
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${messageId}>`,
    '',
    body,
    '',
  ].join('\r\n'));
}

async function signed(eml) {
  return signDkim(eml, {
    domain: DKIM_DOMAIN,
    selector: DKIM_SELECTOR,
    privateKeyPem: DKIM_PRIV_PEM,
  });
}

async function readEvent(tmp, id) {
  return JSON.parse(await fs.readFile(path.join(tmp, 'events', `${id}.json`), 'utf8'));
}

async function clearCaptures(captureDir) {
  for (const f of await fs.readdir(captureDir)) {
    await fs.unlink(path.join(captureDir, f));
  }
}

// Scan captured outbound mail and return the set of To: addresses
// across messages whose Subject contains "[signedreply] proof ". This is
// the durable proof-email subject family — per-reply acks and command
// receipts use other prefixes and are filtered out.
async function proofRecipientSet(captureDir) {
  const set = new Set();
  for (const f of await fs.readdir(captureDir)) {
    const body = await fs.readFile(path.join(captureDir, f), 'utf8');
    const subjectLine = body.split(/\r?\n/).find((l) => /^Subject:/i.test(l)) || '';
    if (!/\[signedreply\] proof /i.test(subjectLine)) continue;
    const toLine = body.split(/\r?\n/).find((l) => /^To:/i.test(l)) || '';
    const m = toLine.match(/<([^>]+)>|([\w.+-]+@[\w.-]+)/);
    if (m) set.add((m[1] || m[2]).toLowerCase());
  }
  return set;
}

test('0.24.8 contract: emails persist through reach + revoke + recomplete; redact only on close', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-oversubrev-'));
  try {
    const { fake, captureDir } = makeFakeSendmail(tmp);
    const dnsStubPath = path.join(tmp, 'dns-stub.json');
    writeDnsStub(dnsStubPath, DKIM_DOMAIN, DKIM_SELECTOR);

    const baseEnv = {
      GITDONE_DATA_DIR: tmp,
      GITDONE_SENDMAIL_BIN: fake,
      GITDONE_TEST_DNS_FILE: dnsStubPath,
    };

    const id = 'orr1';
    const initiator = `chair@${DKIM_DOMAIN}`;
    const alice = `alice@${DKIM_DOMAIN}`;
    const bob = `bob@${DKIM_DOMAIN}`;
    const carol = `carol@${DKIM_DOMAIN}`;

    await fs.mkdir(path.join(tmp, 'events'), { recursive: true });
    // unique dedup so threshold reach auto-completes (and revoke
    // reopens). min_trust_level: verified — replies are DKIM-signed
    // against the stub-DNS-served test.example.com so they pass.
    await fs.writeFile(path.join(tmp, 'events', `${id}.json`), JSON.stringify({
      id, type: 'crypto', mode: 'attestation',
      title: 'oversubscribe revoke regression',
      initiator,
      threshold: 2, dedup: 'unique', replies: [],
      salt: `salt-${id}`,
      min_trust_level: 'verified',
      details: 'attest.',
      activated_at: '2026-05-01T00:00:00Z',
      reference_url: 'https://example.com/post',
    }));

    const aliceKey = hashSender(alice, `salt-${id}`);
    const bobKey = hashSender(bob, `salt-${id}`);
    const carolKey = hashSender(carol, `salt-${id}`);

    // ------------------------------------------------------------------
    // Phase 0: initiator registers TWO docs via attach+, freezing the
    // strict-mode doc set.
    // ------------------------------------------------------------------
    const reg = await signed(buildAttachEml({
      from: initiator, to: `attach+${id}@git-done.com`,
      messageId: `reg@${DKIM_DOMAIN}`,
      attachments: [
        { filename: 'a.pdf', content: 'AA' },
        { filename: 'b.pdf', content: 'BB' },
      ],
    }));
    await runReceive(reg,
      ['1.2.3.4', DKIM_DOMAIN, initiator, `attach+${id}@git-done.com`],
      baseEnv);
    let ev = await readEvent(tmp, id);
    assert.equal((ev.reference_docs || []).length, 2,
      'two reference docs registered');

    await clearCaptures(captureDir);

    // ------------------------------------------------------------------
    // Phase 1: Alice signs partial (a.pdf only) — bucket incomplete,
    // does not count toward threshold, email is NOT yet stored
    // (justBucketComplete=false).
    // ------------------------------------------------------------------
    const aPartial = await signed(buildAttachEml({
      from: alice, to: `event+${id}@git-done.com`,
      messageId: `a1@${DKIM_DOMAIN}`,
      attachments: [{ filename: 'a.pdf', content: 'AA' }],
    }));
    await runReceive(aPartial,
      ['1.2.3.4', DKIM_DOMAIN, alice, `event+${id}@git-done.com`],
      baseEnv);
    ev = await readEvent(tmp, id);
    assert.equal(ev.attestor_progress[aliceKey].complete, false,
      "alice's bucket incomplete after partial");
    assert.equal(ev.attestor_progress[aliceKey].email, null,
      "alice's email not yet stored — bucket hasn't completed");

    // ------------------------------------------------------------------
    // Phase 2: Bob signs both → bucket completes, count = 1/2.
    // bob's email IS stored (justBucketComplete=true on this reply).
    // ------------------------------------------------------------------
    const bFull = await signed(buildAttachEml({
      from: bob, to: `event+${id}@git-done.com`,
      messageId: `b1@${DKIM_DOMAIN}`,
      attachments: [
        { filename: 'a.pdf', content: 'AA' },
        { filename: 'b.pdf', content: 'BB' },
      ],
    }));
    await runReceive(bFull,
      ['1.2.3.4', DKIM_DOMAIN, bob, `event+${id}@git-done.com`],
      baseEnv);
    ev = await readEvent(tmp, id);
    assert.equal(ev.attestor_progress[bobKey].complete, true,
      "bob's bucket complete");
    assert.equal(ev.attestor_progress[bobKey].email, bob,
      "bob's email stored on bucket-completing reply");
    assert.notEqual(ev.completion && ev.completion.status, 'complete',
      'threshold (2) not yet reached — event still open');

    await clearCaptures(captureDir);

    // ------------------------------------------------------------------
    // Phase 3: Carol signs both → bucket completes, count = 2/2 →
    // threshold reach → unique dedup auto-completes → proof email
    // fires to organiser + every attestor with a stored email.
    // ------------------------------------------------------------------
    const cFull = await signed(buildAttachEml({
      from: carol, to: `event+${id}@git-done.com`,
      messageId: `c1@${DKIM_DOMAIN}`,
      attachments: [
        { filename: 'a.pdf', content: 'AA' },
        { filename: 'b.pdf', content: 'BB' },
      ],
    }));
    await runReceive(cFull,
      ['1.2.3.4', DKIM_DOMAIN, carol, `event+${id}@git-done.com`],
      baseEnv);
    ev = await readEvent(tmp, id);
    assert.equal(ev.completion && ev.completion.status, 'complete',
      'event complete at threshold reach (unique dedup)');
    assert.equal(ev.attestor_progress[carolKey].email, carol,
      "carol's email stored on her bucket-completing reply");
    assert.ok(!ev.attestor_emails_redacted_at,
      '0.24.8 contract: redaction MUST NOT fire at threshold reach');

    let recipients = await proofRecipientSet(captureDir);
    assert.ok(recipients.has(initiator),
      'organiser receives the proof email at threshold reach');
    assert.ok(recipients.has(bob),
      "bob (complete bucket, email persisted) receives proof at reach");
    assert.ok(recipients.has(carol),
      'carol (the reach-tripping attestor) receives proof at reach');
    assert.ok(!recipients.has(alice),
      "alice (incomplete bucket, no email stored) does NOT receive proof at reach");

    const stampAfterReach = ev.proof_email_sent_at;
    assert.ok(stampAfterReach,
      'proof_email_sent_at stamped after the reach burst');

    // ------------------------------------------------------------------
    // Phase 4: Initiator revokes Bob via revoke+. Under unique dedup
    // this drops count from 2 to 1 (< threshold), reopening completion.
    // Bob's attestor_progress entry (and stored email) are NOT mutated —
    // audit trail is preserved.
    // ------------------------------------------------------------------
    const revokeEml = await signed(buildPlainEml({
      from: initiator, to: `revoke+${id}@git-done.com`,
      subject: 'revoke', messageId: `rev@${DKIM_DOMAIN}`,
      body: `${bob}\nreason: signed by mistake\n`,
    }));
    await runReceive(revokeEml,
      ['1.2.3.4', DKIM_DOMAIN, initiator, `revoke+${id}@git-done.com`],
      baseEnv);
    ev = await readEvent(tmp, id);
    assert.equal(ev.completion.status, 'open',
      'revoke dropped count below threshold → completion reopened');
    assert.equal((ev.revoked_senders || []).length, 1);
    assert.equal(ev.revoked_senders[0].sender_hash, bobKey);
    assert.equal(ev.attestor_progress[bobKey].complete, true,
      "bob's bucket state preserved post-revoke (audit trail)");
    assert.equal(ev.attestor_progress[bobKey].email, bob,
      "bob's stored email preserved post-revoke");
    assert.ok(!ev.attestor_emails_redacted_at,
      'redaction still not fired — revoke is not a terminal edge');

    await clearCaptures(captureDir);

    // ------------------------------------------------------------------
    // Phase 5: Alice signs the SECOND doc → her bucket flips
    // false→true (justBucketComplete=true, so her email is stored
    // NOW). Recount: alice + carol = 2 (bob excluded via revoked
    // set) → threshold reached again → completion flips
    // open→complete with a fresh completed_at. The proof-email gate
    // sees completed_at > proof_email_sent_at and re-fires.
    // ------------------------------------------------------------------
    // Small sleep so the new completed_at is strictly greater than
    // the prior proof_email_sent_at stamp (ISO ms precision; subprocess
    // overhead usually covers this but a small pad makes the test
    // deterministic).
    await new Promise((r) => setTimeout(r, 10));
    const aRest = await signed(buildAttachEml({
      from: alice, to: `event+${id}@git-done.com`,
      messageId: `a2@${DKIM_DOMAIN}`,
      attachments: [{ filename: 'b.pdf', content: 'BB' }],
    }));
    await runReceive(aRest,
      ['1.2.3.4', DKIM_DOMAIN, alice, `event+${id}@git-done.com`],
      baseEnv);
    ev = await readEvent(tmp, id);
    assert.equal(ev.attestor_progress[aliceKey].complete, true,
      "alice's bucket complete after second-doc reply");
    assert.equal(ev.attestor_progress[aliceKey].email, alice,
      "alice's email stored on her bucket-completing reply (the 0.24.8 fix — pre-patch this was lost because the alreadyRedacted gate blocked storage)");
    assert.equal(ev.completion.status, 'complete',
      'event recomplete after alice fills her bucket');
    assert.ok(ev.completion.completed_at > stampAfterReach,
      'recompletion has a strictly-greater completed_at than prior stamp');
    assert.ok(!ev.attestor_emails_redacted_at,
      'redaction still not fired — recomplete is not a terminal edge');

    recipients = await proofRecipientSet(captureDir);
    assert.ok(recipients.has(initiator),
      'organiser receives the recomplete proof email');
    assert.ok(recipients.has(alice),
      "alice (the recompleting attestor) receives the recomplete proof — this is the regression: pre-0.24.8, alice's email was never stored so she was unreachable on recomplete");
    assert.ok(recipients.has(carol),
      "carol (still complete, not revoked, email persisted) receives the recomplete proof");

    // ------------------------------------------------------------------
    // Phase 6: Initiator closes the event. The dashboard-close handler
    // (server.js) and the close+ committed branch (receive.js) both
    // call redactAttestorEmails directly — we exercise that leaf here
    // to verify the terminal-edge redaction contract end-to-end on the
    // same event we just recompleted. (close+ as a route is rejected
    // with already_complete after a natural recomplete; the wiring of
    // the close+ committed branch is covered by email-commands tests
    // on simpler events.)
    // ------------------------------------------------------------------
    // redactAttestorEmails reads config.dataDir at module-load time, so
    // we run it in a clean subprocess with GITDONE_DATA_DIR pointed at
    // our test temp dir. Matches what the dashboard-close handler in
    // server.js does on a complete event.
    await new Promise((resolve, reject) => {
      const completionPath = path.join(__dirname, '..', '..', 'src', 'completion.js');
      const child = spawn(
        'node',
        ['-e', `require(${JSON.stringify(completionPath)}).redactAttestorEmails(${JSON.stringify(id)}).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });`],
        { env: { ...process.env, GITDONE_DATA_DIR: tmp } },
      );
      let stderr = '';
      child.stderr.on('data', (c) => { stderr += c.toString(); });
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`redact subprocess exit ${code}: ${stderr}`)));
    });

    ev = await readEvent(tmp, id);
    assert.ok(ev.attestor_emails_redacted_at,
      'attestor_emails_redacted_at MUST be stamped after close-by-initiator');
    for (const [k, p] of Object.entries(ev.attestor_progress)) {
      assert.equal(p.email, null,
        `attestor ${k} email MUST be redacted post-close`);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
