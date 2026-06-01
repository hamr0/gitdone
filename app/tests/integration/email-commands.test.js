'use strict';

// End-to-end: pipe a stats+/remind+/close+ email through bin/receive.js
// and check that the initiator gets the right reply back, the event
// state flips on close, and pending participants get re-invited on
// remind. OTS is stubbed (GITDONE_OTS_BIN=/nonexistent).

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
# If the same recipient is hit twice, keep both
mv "$body" "${captureDir}/$safe.$(date +%N).eml"
exit 0
`, { mode: 0o755 });
  return { fake, captureDir };
}

const buildEml = (headers, body = '\r\n') =>
  Buffer.from(headers.join('\r\n') + '\r\n\r\n' + body);

async function readEvent(tmp, id) {
  return JSON.parse(await fs.readFile(path.join(tmp, 'events', `${id}.json`), 'utf8'));
}

async function capturesFor(dir, toAddress) {
  const safe = toAddress.replace('@', '_at_').replace(/[^a-zA-Z0-9._-]/g, '_');
  const all = await fs.readdir(dir);
  const mine = all.filter((f) => f.startsWith(`${safe}.`) && f.endsWith('.eml'));
  const bodies = [];
  for (const f of mine) bodies.push(await fs.readFile(path.join(dir, f), 'utf8'));
  return bodies;
}

test('stats+ from the initiator: reply lists step statuses', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-cmd-stats-'));
  try {
    const { fake, captureDir } = makeFakeSendmail(tmp);
    await fs.mkdir(path.join(tmp, 'events'));
    await fs.writeFile(path.join(tmp, 'events', 'evstats01.json'), JSON.stringify({
      id: 'evstats01', type: 'event',
      min_trust_level: 'unverified',      // accept unsigned test mail
      initiator: 'boss@ex.com', title: 'Q2',
      salt: 'salt-stats',
      activated_at: '2026-01-01T00:00:00Z',
      steps: [
        { id: 'one', name: 'Legal', participant: 'l@ex.com', status: 'complete', completed_at: '2026-04-19T00:00:00Z', depends_on: [] },
        { id: 'two', name: 'Design', participant: 'd@ex.com', status: 'pending', depends_on: ['one'] },
      ],
    }));
    const eml = buildEml([
      'From: boss@ex.com', 'To: stats+evstats01@git-done.com', 'Subject: stats please',
    ]);
    const r = await runReceive(eml,
      ['1.2.3.4', 'ex.com', 'boss@ex.com', 'stats+evstats01@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.kind, 'initiator_command');
    assert.equal(out.command.command, 'stats');
    assert.equal(out.command.authenticated, true);

    const replies = await capturesFor(captureDir, 'boss@ex.com');
    assert.equal(replies.length, 1);
    const reply = replies[0];
    assert.match(reply, /Subject: \[signedreply\] stats "Q2" \[1\/2\] step done/);
    assert.match(reply, /\[x\] Legal/);
    assert.match(reply, /\[ \] Design/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('stats+ from a random sender: rejected with reason', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-cmd-noauth-'));
  try {
    const { fake, captureDir } = makeFakeSendmail(tmp);
    await fs.mkdir(path.join(tmp, 'events'));
    await fs.writeFile(path.join(tmp, 'events', 'evna01.json'), JSON.stringify({
      id: 'evna01', type: 'event',
      min_trust_level: 'unverified', initiator: 'boss@ex.com', title: 't',
      salt: 'salt-na',
      activated_at: '2026-01-01T00:00:00Z',
      steps: [{ id: 'a', participant: 'a@ex.com', status: 'pending', depends_on: [] }],
    }));
    const eml = buildEml([
      'From: random@elsewhere.com', 'To: stats+evna01@git-done.com', 'Subject: stats',
    ]);
    const r = await runReceive(eml,
      ['1.2.3.4', 'elsewhere.com', 'random@elsewhere.com', 'stats+evna01@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.command.authenticated, false);
    assert.match(out.command.reason, /not the event initiator/);

    const replies = await capturesFor(captureDir, 'random@elsewhere.com');
    assert.equal(replies.length, 1);
    assert.match(replies[0], /Command rejected/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('remind+ resends invitation to pending-first-step participant', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-cmd-remind-'));
  try {
    const { fake, captureDir } = makeFakeSendmail(tmp);
    await fs.mkdir(path.join(tmp, 'events'));
    await fs.writeFile(path.join(tmp, 'events', 'evr01.json'), JSON.stringify({
      id: 'evr01', type: 'event',
      min_trust_level: 'unverified', initiator: 'boss@ex.com', title: 'Q3',
      salt: 'salt-r',
      activated_at: '2026-01-01T00:00:00Z',
      steps: [
        { id: 'one', name: 'Legal', participant: 'l@ex.com', status: 'pending', depends_on: [] },
        { id: 'two', name: 'Design', participant: 'd@ex.com', status: 'pending', depends_on: ['one'] },
      ],
    }));
    const eml = buildEml([
      'From: boss@ex.com', 'To: remind+evr01@git-done.com', 'Subject: poke them',
    ]);
    const r = await runReceive(eml,
      ['1.2.3.4', 'ex.com', 'boss@ex.com', 'remind+evr01@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.command.authenticated, true);
    assert.ok(Array.isArray(out.command.sent_to));

    // Legal should have received a notification; design should NOT.
    const lCaptures = await capturesFor(captureDir, 'l@ex.com');
    const dCaptures = await capturesFor(captureDir, 'd@ex.com');
    assert.equal(lCaptures.length, 1, 'step-1 participant got reminded');
    assert.equal(dCaptures.length, 0, 'step-2 participant did not (sequential)');
    // Reminder subject carries the "reminder" tag so the participant's MUA
    // can disambiguate this from the original invite.
    assert.match(lCaptures[0], /Subject: \[signedreply\] "reminder" Q3 — Legal \[1\/2\] — your step/);

    // Initiator also got the summary reply.
    const summary = await capturesFor(captureDir, 'boss@ex.com');
    assert.equal(summary.length, 1);
    assert.match(summary[0], /Reminders sent/);
    assert.match(summary[0], /Subject: \[signedreply\] reminded "Q3" \[0\/2\] step done/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('close+ first reply: pending intent, no completion commit', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-cmd-close-pending-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    await fs.mkdir(path.join(tmp, 'events'));
    await fs.writeFile(path.join(tmp, 'events', 'evc01.json'), JSON.stringify({
      id: 'evc01', type: 'crypto', mode: 'attestation',
      min_trust_level: 'unverified', initiator: 'c@ex.com',
      threshold: 99, dedup: 'unique', replies: [],
      title: 'abandon this', salt: 'salt-close',
      activated_at: '2026-01-01T00:00:00Z',
    }));
    const eml = buildEml(['From: c@ex.com', 'To: close+evc01@git-done.com', 'Subject: close']);
    const r = await runReceive(eml,
      ['1.2.3.4', 'ex.com', 'c@ex.com', 'close+evc01@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.command.authenticated, true);
    assert.equal(out.command.close_kind, 'pending_started');
    assert.ok(!out.command.completion_commit, 'no completion commit on first reply');

    const ev = await readEvent(tmp, 'evc01');
    assert.equal(ev.completion, undefined, 'event not yet complete');
    assert.ok(ev.pending_close && ev.pending_close.token, 'pending_close persisted');
    assert.ok(/^[a-f0-9]{8}$/.test(ev.pending_close.token), 'token is 8 hex chars');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('close+ confirm with matching token: commits completion', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-cmd-close-confirm-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    await fs.mkdir(path.join(tmp, 'events'));
    // Pre-seed a pending_close so the second reply commits.
    const futureExp = new Date(Date.now() + 25 * 60 * 1000).toISOString();
    await fs.writeFile(path.join(tmp, 'events', 'evc02.json'), JSON.stringify({
      id: 'evc02', type: 'event',
      min_trust_level: 'unverified', initiator: 'c@ex.com', title: 'wedding',
      salt: 'salt-close-2', activated_at: '2026-01-01T00:00:00Z',
      steps: [{ id: 's1', name: 'Audio', participant: 'a@ex.com', status: 'pending', depends_on: [] }],
      pending_close: { token: 'deadbeef', created_at: '2026-01-02T00:00:00Z', expires_at: futureExp },
    }));
    const eml = buildEml([
      'From: c@ex.com', 'To: close+evc02@git-done.com',
      'Subject: CONFIRM deadbeef',
    ]);
    const r = await runReceive(eml,
      ['1.2.3.4', 'ex.com', 'c@ex.com', 'close+evc02@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.command.close_kind, 'committed');
    assert.ok(out.command.completion_commit, 'completion commit recorded');

    const ev = await readEvent(tmp, 'evc02');
    assert.equal(ev.completion.status, 'complete');
    assert.equal(ev.completion.closed_by, 'initiator');
    assert.equal(ev.pending_close, undefined, 'pending_close cleared');

    const repo = path.join(tmp, 'repos', 'evc02');
    const complete = JSON.parse(await fs.readFile(path.join(repo, 'commits', 'completion.json'), 'utf8'));
    assert.equal(complete.kind, 'completion');
    assert.equal(complete.summary.closed_by, 'initiator');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('close+ confirm with mismatched token: no commit, body explains', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-cmd-close-mismatch-'));
  try {
    const { fake, captureDir } = makeFakeSendmail(tmp);
    await fs.mkdir(path.join(tmp, 'events'));
    const futureExp = new Date(Date.now() + 25 * 60 * 1000).toISOString();
    await fs.writeFile(path.join(tmp, 'events', 'evc03.json'), JSON.stringify({
      id: 'evc03', type: 'event',
      min_trust_level: 'unverified', initiator: 'c@ex.com', title: 'wedding',
      salt: 'salt-close-3', activated_at: '2026-01-01T00:00:00Z',
      steps: [{ id: 's1', name: 'Audio', participant: 'a@ex.com', status: 'pending', depends_on: [] }],
      pending_close: { token: 'deadbeef', created_at: '2026-01-02T00:00:00Z', expires_at: futureExp },
    }));
    const eml = buildEml([
      'From: c@ex.com', 'To: close+evc03@git-done.com',
      'Subject: CONFIRM cafebabe',
    ]);
    const r = await runReceive(eml,
      ['1.2.3.4', 'ex.com', 'c@ex.com', 'close+evc03@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.command.close_kind, 'token_mismatch');
    assert.ok(!out.command.completion_commit, 'no completion commit on mismatch');

    const ev = await readEvent(tmp, 'evc03');
    assert.equal(ev.completion, undefined);
    assert.equal(ev.pending_close.token, 'deadbeef', 'original token preserved');

    const replies = await capturesFor(captureDir, 'c@ex.com');
    assert.equal(replies.length, 1);
    assert.match(replies[0], /token mismatch, retry/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
