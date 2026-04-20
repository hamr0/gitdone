'use strict';

// 1.J end-to-end: pipe synthetic replies through bin/receive.js and
// assert that event JSON, per-event git repo, completion commit, and
// cascade notifications all land correctly. OTS is stubbed to a
// nonexistent binary so commits record a stamp error and move on —
// lets these tests run offline and in seconds.

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
mv "$body" "${captureDir}/$safe.eml"
exit 0
`, { mode: 0o755 });
  return { fake, captureDir };
}

const buildEml = (headers, body = 'reply body\r\n') =>
  Buffer.from(headers.join('\r\n') + '\r\n\r\n' + body);

async function readEvent(tmp, eventId) {
  return JSON.parse(await fs.readFile(path.join(tmp, 'events', `${eventId}.json`), 'utf8'));
}

test('sequential workflow: step 1 reply completes step 1 and cascades to step 2', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-j-seq-'));
  try {
    const { fake, captureDir } = makeFakeSendmail(tmp);
    await fs.mkdir(path.join(tmp, 'events'));
    await fs.writeFile(path.join(tmp, 'events', 'evseq01.json'), JSON.stringify({
      id: 'evseq01', type: 'event',
      min_trust_level: 'unverified',   // let unsigned mail count in tests
      initiator: 'boss@ex.com',
      salt: 'salt-seq-01',
      activated_at: '2026-01-01T00:00:00Z',
      steps: [
        { id: 'one', name: 'Step one', participant: 'one@ex.com', status: 'pending', depends_on: [] },
        { id: 'two', name: 'Step two', participant: 'two@ex.com', status: 'pending', depends_on: ['one'] },
      ],
    }));

    // Reply from step 1's participant.
    const eml1 = buildEml([
      'From: one@ex.com', 'To: event+evseq01-one@git-done.com', 'Subject: done 1',
    ]);
    const r1 = await runReceive(eml1,
      ['1.2.3.4', 'ex.com', 'one@ex.com', 'event+evseq01-one@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r1.code, 0, r1.stderr);
    const out1 = JSON.parse(r1.stdout.trim());
    assert.equal(out1.accepted, true);
    assert.equal(out1.routing.participant_match, true);
    assert.equal(out1.completion.applied, true);
    assert.equal(out1.completion.completed_step, 'one');
    assert.equal(out1.completion.completed_event, false);
    assert.deepEqual(out1.completion.cascade.notified, ['two']);
    assert.equal(out1.completion.cascade.triggered_by, 'one');

    // step 2 should have a notification capture file
    const captures = await fs.readdir(captureDir);
    assert.ok(captures.includes('two_at_ex.com.eml'), 'step 2 got notified');
    const notif = await fs.readFile(path.join(captureDir, 'two_at_ex.com.eml'), 'utf8');
    assert.match(notif, /event\+evseq01-two@/);

    // Event JSON: step one complete, event not yet done.
    const ev1 = await readEvent(tmp, 'evseq01');
    assert.equal(ev1.steps[0].status, 'complete');
    assert.equal(ev1.steps[1].status, 'pending');
    assert.equal(ev1.completion && ev1.completion.status, 'open');

    // Reply from step 2's participant.
    const eml2 = buildEml([
      'From: two@ex.com', 'To: event+evseq01-two@git-done.com', 'Subject: done 2',
    ]);
    const r2 = await runReceive(eml2,
      ['1.2.3.4', 'ex.com', 'two@ex.com', 'event+evseq01-two@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    const out2 = JSON.parse(r2.stdout.trim());
    assert.equal(out2.completion.applied, true);
    assert.equal(out2.completion.completed_event, true);
    assert.ok(out2.completion.completion_commit, 'completion commit recorded in log');

    const ev2 = await readEvent(tmp, 'evseq01');
    assert.equal(ev2.completion.status, 'complete');
    assert.match(ev2.completion.completed_at, /^\d{4}-/);

    // completion.json written to the per-event repo.
    const repoPath = path.join(tmp, 'repos', 'evseq01');
    const complete = JSON.parse(await fs.readFile(path.join(repoPath, 'commits', 'completion.json'), 'utf8'));
    assert.equal(complete.kind, 'completion');
    assert.equal(complete.event_type, 'event');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('non-sequential workflow: replies count in any order, no cascade', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-j-ns-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    await fs.mkdir(path.join(tmp, 'events'));
    await fs.writeFile(path.join(tmp, 'events', 'evns01.json'), JSON.stringify({
      id: 'evns01', type: 'event',
      min_trust_level: 'unverified', initiator: 'boss@ex.com',
      salt: 'salt-ns-01',
      activated_at: '2026-01-01T00:00:00Z',
      steps: [
        { id: 'a', participant: 'a@ex.com', status: 'pending', depends_on: [] },
        { id: 'b', participant: 'b@ex.com', status: 'pending', depends_on: [] },
      ],
    }));
    // Reply to step B first — non-sequential accepts it.
    const eml = buildEml([
      'From: b@ex.com', 'To: event+evns01-b@git-done.com', 'Subject: b',
    ]);
    const r = await runReceive(eml,
      ['1.2.3.4', 'ex.com', 'b@ex.com', 'event+evns01-b@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.completion.applied, true);
    assert.equal(out.completion.completed_step, 'b');
    assert.equal(out.completion.cascade, undefined);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('declaration: signer reply completes the event', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-j-decl-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    await fs.mkdir(path.join(tmp, 'events'));
    await fs.writeFile(path.join(tmp, 'events', 'evdecl01.json'), JSON.stringify({
      id: 'evdecl01', type: 'crypto', mode: 'declaration',
      min_trust_level: 'unverified',
      initiator: 'journo@ex.com', signer: 'witness@ex.com',
      salt: 'salt-decl-01',
      activated_at: '2026-01-01T00:00:00Z',
    }));
    const eml = buildEml([
      'From: witness@ex.com', 'To: event+evdecl01@git-done.com', 'Subject: I hereby declare',
    ]);
    const r = await runReceive(eml,
      ['1.2.3.4', 'ex.com', 'witness@ex.com', 'event+evdecl01@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.completion.applied, true, JSON.stringify(out.completion));
    assert.equal(out.completion.completed_event, true);
    const ev = await readEvent(tmp, 'evdecl01');
    assert.equal(ev.completion.status, 'complete');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('declaration: reply from wrong sender does not complete', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-j-decl2-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    await fs.mkdir(path.join(tmp, 'events'));
    await fs.writeFile(path.join(tmp, 'events', 'evdecl02.json'), JSON.stringify({
      id: 'evdecl02', type: 'crypto', mode: 'declaration',
      min_trust_level: 'unverified',
      initiator: 'j@ex.com', signer: 'witness@ex.com',
      salt: 'salt-decl-02',
      activated_at: '2026-01-01T00:00:00Z',
    }));
    const eml = buildEml([
      'From: random@other.com', 'To: event+evdecl02@git-done.com', 'Subject: not the signer',
    ]);
    const r = await runReceive(eml,
      ['1.2.3.4', 'other.com', 'random@other.com', 'event+evdecl02@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.completion.applied, false);
    const ev = await readEvent(tmp, 'evdecl02');
    // Completion object may exist (open) or be absent; what matters is it's not complete.
    if (ev.completion) assert.notEqual(ev.completion.status, 'complete');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('attestation unique: two distinct senders reach threshold=2 and complete', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-j-att-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    await fs.mkdir(path.join(tmp, 'events'));
    await fs.writeFile(path.join(tmp, 'events', 'evatt01.json'), JSON.stringify({
      id: 'evatt01', type: 'crypto', mode: 'attestation',
      min_trust_level: 'unverified',
      allow_anonymous: true, threshold: 2, dedup: 'unique', replies: [],
      initiator: 'chair@ex.com', salt: 'salt-att-01',
      activated_at: '2026-01-01T00:00:00Z',
    }));

    const sendFrom = async (email) => {
      const eml = buildEml([
        `From: ${email}`, 'To: event+evatt01@git-done.com',
        `Subject: I vouch for hamr`,
      ]);
      return runReceive(eml,
        ['1.2.3.4', 'ex.com', email, 'event+evatt01@git-done.com'],
        { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    };

    const r1 = await sendFrom('voucher1@ex.com');
    const out1 = JSON.parse(r1.stdout.trim());
    assert.equal(out1.completion.applied, true);
    assert.equal(out1.completion.completed_event, false);

    const r2 = await sendFrom('voucher2@ex.com');
    const out2 = JSON.parse(r2.stdout.trim());
    assert.equal(out2.completion.applied, true);
    assert.equal(out2.completion.completed_event, true);

    const ev = await readEvent(tmp, 'evatt01');
    assert.equal(ev.replies.length, 2);
    assert.equal(ev.completion.status, 'complete');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('attestation: duplicate sender does not advance threshold (unique dedup)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-j-att2-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    await fs.mkdir(path.join(tmp, 'events'));
    await fs.writeFile(path.join(tmp, 'events', 'evatt02.json'), JSON.stringify({
      id: 'evatt02', type: 'crypto', mode: 'attestation',
      min_trust_level: 'unverified', allow_anonymous: true,
      threshold: 2, dedup: 'unique', replies: [],
      initiator: 'c@ex.com', salt: 'salt-att-02',
      activated_at: '2026-01-01T00:00:00Z',
    }));

    const send = () => runReceive(
      buildEml([
        'From: same@ex.com', 'To: event+evatt02@git-done.com', 'Subject: repeat',
      ]),
      ['1.2.3.4', 'ex.com', 'same@ex.com', 'event+evatt02@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });

    await send(); await send(); await send();
    const ev = await readEvent(tmp, 'evatt02');
    assert.equal(ev.replies.length, 3, 'unique dedup keeps audit trail');
    assert.notEqual(ev.completion && ev.completion.status, 'complete');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
