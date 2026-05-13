'use strict';

// Module 8 — revoke+{id}@ attestation-revocation channel.
//
// Behaviour under test:
//   * initiator with body listing one attestor email → that hash drops from
//     revoked + count goes 2→1; locking dedup flips completion open; audit
//     trail (replies[]) untouched
//   * non-initiator → rejected ack, no state change
//   * unknown email in body → not_found list in ack; no revoke commit
//   * empty / no parseable emails → "no targets" ack
//   * wrong event type (declaration) → rejected
//   * unknown event id → rejected

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RECEIVE = path.join(__dirname, '..', '..', 'bin', 'receive.js');
const { hashSender } = require('../../src/completion');

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

function buildPlainEml({ from, to, subject = 'revoke', body = '' }) {
  return Buffer.from([
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    '',
    body,
    '',
  ].join('\r\n'));
}

async function writeAttEvent(tmp, id, overrides = {}) {
  await fs.mkdir(path.join(tmp, 'events'), { recursive: true });
  const event = {
    id, type: 'crypto', mode: 'attestation',
    title: 'quorum',
    initiator: 'chair@ex.com',
    threshold: 2, dedup: 'unique',
    salt: `salt-${id}`,
    min_trust_level: 'unverified',
    details: 'Vouch for X.',
    activated_at: '2026-05-01T00:00:00Z',
    replies: [],
    ...overrides,
  };
  await fs.writeFile(path.join(tmp, 'events', `${id}.json`), JSON.stringify(event));
  return event;
}

// ---------------------------------------------------------------------------

test('revoke+: initiator revokes one of two attestors → count drops, completion reopens, audit trail intact', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-revoke-basic-'));
  try {
    const { fake, captureDir } = makeFakeSendmail(tmp);
    const id = 'r1';
    const salt = `salt-${id}`;
    const h1 = hashSender('bob@ex.com', salt);
    const h2 = hashSender('carol@ex.com', salt);
    await writeAttEvent(tmp, id, {
      replies: [
        { sender_hash: h1, sender_domain: 'ex.com', sequence: 1, received_at: '2026-05-10T00:00:00Z', trust_level: 'verified' },
        { sender_hash: h2, sender_domain: 'ex.com', sequence: 2, received_at: '2026-05-11T00:00:00Z', trust_level: 'verified' },
      ],
      completion: { status: 'complete', completed_at: '2026-05-11T00:00:00Z', commit_sequence: 2 },
    });
    const eml = buildPlainEml({
      from: 'chair@ex.com', to: `revoke+${id}@git-done.com`,
      body: 'bob@ex.com\nreason: signed by mistake\n',
    });
    const r = await runReceive(eml,
      ['1.2.3.4', 'ex.com', 'chair@ex.com', `revoke+${id}@git-done.com`],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.kind, 'revoke_command');
    assert.equal(out.revoke.accepted, true);
    assert.equal(out.revoke.revoked, 1);
    assert.equal(out.revoke.count_after, 1);
    assert.equal(out.revoke.reopened, true);

    const ev = JSON.parse(await fs.readFile(path.join(tmp, 'events', `${id}.json`), 'utf8'));
    assert.equal(ev.revoked_senders.length, 1);
    assert.equal(ev.revoked_senders[0].sender_hash, h1);
    assert.equal(ev.revoked_senders[0].reason, 'signed by mistake');
    // Audit trail intact.
    assert.equal(ev.replies.length, 2);
    // Completion flipped back to open.
    assert.equal(ev.completion.status, 'open');
    assert.ok(ev.completion.reopened_at);

    // Ack body shows the revoked email + new count.
    const captures = await fs.readdir(captureDir);
    assert.ok(captures.length > 0, 'expected an ack to the initiator');
    const body = await fs.readFile(path.join(captureDir, captures[0]), 'utf8');
    assert.match(body, /Revoked 1 attestor/);
    assert.match(body, /bob@ex\.com/);
    assert.match(body, /New count: 1 \/ 2/);
    assert.match(body, /reopened/);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('revoke+: non-initiator rejected, no state change', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-revoke-noni-'));
  try {
    const { fake, captureDir } = makeFakeSendmail(tmp);
    const id = 'r2';
    const salt = `salt-${id}`;
    const h1 = hashSender('bob@ex.com', salt);
    await writeAttEvent(tmp, id, {
      replies: [{ sender_hash: h1, sender_domain: 'ex.com', sequence: 1, received_at: '2026-05-10T00:00:00Z', trust_level: 'verified' }],
    });
    const eml = buildPlainEml({
      from: 'stranger@elsewhere.com', to: `revoke+${id}@git-done.com`,
      body: 'bob@ex.com',
    });
    const r = await runReceive(eml,
      ['1.2.3.4', 'elsewhere.com', 'stranger@elsewhere.com', `revoke+${id}@git-done.com`],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.revoke.accepted, false);
    assert.match(out.revoke.reason, /not the event initiator/);
    const ev = JSON.parse(await fs.readFile(path.join(tmp, 'events', `${id}.json`), 'utf8'));
    assert.ok(!ev.revoked_senders || ev.revoked_senders.length === 0);
    const captures = await fs.readdir(captureDir);
    const body = await fs.readFile(path.join(captureDir, captures[0]), 'utf8');
    assert.match(body, /Only the event initiator/);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('revoke+: unknown email in body → not_found list, no revoke commit, no state change', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-revoke-nf-'));
  try {
    const { fake, captureDir } = makeFakeSendmail(tmp);
    const id = 'r3';
    const salt = `salt-${id}`;
    const h1 = hashSender('bob@ex.com', salt);
    await writeAttEvent(tmp, id, {
      replies: [{ sender_hash: h1, sender_domain: 'ex.com', sequence: 1, received_at: '2026-05-10T00:00:00Z', trust_level: 'verified' }],
    });
    const eml = buildPlainEml({
      from: 'chair@ex.com', to: `revoke+${id}@git-done.com`,
      body: 'ghost@nowhere.example\n',
    });
    const r = await runReceive(eml,
      ['1.2.3.4', 'ex.com', 'chair@ex.com', `revoke+${id}@git-done.com`],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.revoke.accepted, false);
    assert.match(out.revoke.reason, /no matching attestors/);
    const ev = JSON.parse(await fs.readFile(path.join(tmp, 'events', `${id}.json`), 'utf8'));
    assert.ok(!ev.revoked_senders || ev.revoked_senders.length === 0);
    const captures = await fs.readdir(captureDir);
    const body = await fs.readFile(path.join(captureDir, captures[0]), 'utf8');
    assert.match(body, /None of the addresses/);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('revoke+: empty body → "no targets" ack', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-revoke-empty-'));
  try {
    const { fake, captureDir } = makeFakeSendmail(tmp);
    const id = 'r4';
    await writeAttEvent(tmp, id);
    const eml = buildPlainEml({
      from: 'chair@ex.com', to: `revoke+${id}@git-done.com`,
      body: '\n',
    });
    const r = await runReceive(eml,
      ['1.2.3.4', 'ex.com', 'chair@ex.com', `revoke+${id}@git-done.com`],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.revoke.accepted, false);
    assert.match(out.revoke.reason, /no targets/);
    const captures = await fs.readdir(captureDir);
    const body = await fs.readFile(path.join(captureDir, captures[0]), 'utf8');
    assert.match(body, /No revocation targets found/);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('revoke+: declaration event → rejected', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-revoke-decl-'));
  try {
    const { fake, captureDir } = makeFakeSendmail(tmp);
    await fs.mkdir(path.join(tmp, 'events'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'events', 'r5.json'), JSON.stringify({
      id: 'r5', type: 'crypto', mode: 'declaration',
      title: 'pink slip',
      initiator: 'chair@ex.com', signer: 'employee@ex.com',
      salt: 'salt-r5', min_trust_level: 'unverified',
      activated_at: '2026-05-01T00:00:00Z',
    }));
    const eml = buildPlainEml({
      from: 'chair@ex.com', to: 'revoke+r5@git-done.com',
      body: 'employee@ex.com',
    });
    const r = await runReceive(eml,
      ['1.2.3.4', 'ex.com', 'chair@ex.com', 'revoke+r5@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.revoke.accepted, false);
    assert.match(out.revoke.reason, /not an attestation event/);
    const captures = await fs.readdir(captureDir);
    const body = await fs.readFile(path.join(captureDir, captures[0]), 'utf8');
    assert.match(body, /only applies to crypto attestation/);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('revoke+: attribution-style line ("On Tue, bob <bob@ex.com> wrote:") → no targets', async () => {
  // Module 8 I3 hardening — a stray attribution line (some mobile clients
  // flatten reply quoting and drop the `>` prefix) must NOT match as a
  // revoke target. The strict line shape requires the trimmed line to
  // consist of ONLY the email (optionally angle-wrapped, optionally
  // `revoke:` prefixed).
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-revoke-attr-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    const id = 'r6';
    const salt = `salt-${id}`;
    const h1 = hashSender('bob@ex.com', salt);
    await writeAttEvent(tmp, id, {
      replies: [{ sender_hash: h1, sender_domain: 'ex.com', sequence: 1, received_at: '2026-05-10T00:00:00Z', trust_level: 'verified' }],
    });
    const eml = buildPlainEml({
      from: 'chair@ex.com', to: `revoke+${id}@git-done.com`,
      body: 'On Tue, bob <bob@ex.com> wrote:\nhi all',
    });
    const r = await runReceive(eml,
      ['1.2.3.4', 'ex.com', 'chair@ex.com', `revoke+${id}@git-done.com`],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.revoke.accepted, false);
    assert.match(out.revoke.reason, /no targets/);
    // Bob is still counted — the attribution line did not revoke him.
    const ev = JSON.parse(await fs.readFile(path.join(tmp, 'events', `${id}.json`), 'utf8'));
    assert.ok(!ev.revoked_senders || ev.revoked_senders.length === 0);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('revoke+: re-revoking the same attestor is a dedup no-op', async () => {
  // Module 8 — repeated revoke commits should not double-write
  // revoked_senders[] entries. applyRevoke dedups against the
  // pre-existing hash set.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-revoke-dedup-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    const id = 'r7';
    const salt = `salt-${id}`;
    const h1 = hashSender('bob@ex.com', salt);
    const h2 = hashSender('carol@ex.com', salt);
    await writeAttEvent(tmp, id, {
      replies: [
        { sender_hash: h1, sender_domain: 'ex.com', sequence: 1, received_at: '2026-05-10T00:00:00Z', trust_level: 'verified' },
        { sender_hash: h2, sender_domain: 'ex.com', sequence: 2, received_at: '2026-05-11T00:00:00Z', trust_level: 'verified' },
      ],
    });
    // First revoke: bob.
    const eml1 = buildPlainEml({
      from: 'chair@ex.com', to: `revoke+${id}@git-done.com`,
      body: 'bob@ex.com',
    });
    let r = await runReceive(eml1,
      ['1.2.3.4', 'ex.com', 'chair@ex.com', `revoke+${id}@git-done.com`],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r.code, 0, r.stderr);
    // Second revoke: same email, expected no-op at the data layer.
    const eml2 = buildPlainEml({
      from: 'chair@ex.com', to: `revoke+${id}@git-done.com`,
      body: 'bob@ex.com',
    });
    r = await runReceive(eml2,
      ['1.2.3.4', 'ex.com', 'chair@ex.com', `revoke+${id}@git-done.com`],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r.code, 0, r.stderr);
    const ev = JSON.parse(await fs.readFile(path.join(tmp, 'events', `${id}.json`), 'utf8'));
    assert.equal(ev.revoked_senders.length, 1);
    assert.equal(ev.revoked_senders[0].sender_hash, h1);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('revoke+: unknown event id → rejected', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-revoke-ghost-'));
  try {
    const { fake, captureDir } = makeFakeSendmail(tmp);
    await fs.mkdir(path.join(tmp, 'events'), { recursive: true });
    const eml = buildPlainEml({
      from: 'chair@ex.com', to: 'revoke+ghostxyz@git-done.com',
      body: 'bob@ex.com',
    });
    const r = await runReceive(eml,
      ['1.2.3.4', 'ex.com', 'chair@ex.com', 'revoke+ghostxyz@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.revoke.accepted, false);
    assert.match(out.revoke.reason, /unknown event/);
    const captures = await fs.readdir(captureDir);
    const body = await fs.readFile(path.join(captureDir, captures[0]), 'utf8');
    assert.match(body, /No such event/);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});
