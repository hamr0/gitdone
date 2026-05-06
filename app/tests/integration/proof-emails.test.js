'use strict';

// Proof-emails integration:
//   1. A counting reply that completes a workflow event triggers a
//      proof email with the cryptographic receipt embedded.
//   2. The OTS-upgrade worker fires a proof-anchored follow-up once the
//      last pending OTS proof has been upgraded — and only once per
//      event (the .anchored-notified sentinel suppresses re-sends).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RECEIVE = path.join(__dirname, '..', '..', 'bin', 'receive.js');
const OTS_UPGRADE = path.join(__dirname, '..', '..', 'bin', 'ots-upgrade.js');

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
  // Capture every outbound message — preserve order with a counter so
  // we can find the proof email even when several land in one run.
  fssync.writeFileSync(fake,
    `#!/bin/sh
counter_file="${captureDir}/.counter"
n=$(cat "$counter_file" 2>/dev/null || echo 0)
n=$((n+1))
echo "$n" > "$counter_file"
body=$(mktemp "${captureDir}/${'$'}{n}_msg.XXXXXX")
cat > "$body"
to=$(grep -m1 -i '^To:' "$body" | sed 's/^[Tt]o:[[:space:]]*//' | tr -d '\\r')
safe=$(printf '%s' "$to" | sed 's/@/_at_/g' | tr -c 'a-zA-Z0-9._-' '_')
mv "$body" "${captureDir}/${'$'}{n}_${'$'}safe.eml"
exit 0
`, { mode: 0o755 });
  return { fake, captureDir };
}

const buildEml = (headers, body = 'reply body\r\n') =>
  Buffer.from(headers.join('\r\n') + '\r\n\r\n' + body);

test('integration: counting reply that completes a workflow composes a proof email with the receipt', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-proof-'));
  try {
    const { fake, captureDir } = makeFakeSendmail(tmp);
    await fs.mkdir(path.join(tmp, 'events'), { recursive: true });
    // Single-step workflow so one reply completes the event.
    await fs.writeFile(path.join(tmp, 'events', 'pwf01.json'), JSON.stringify({
      id: 'pwf01', type: 'event',
      title: 'proof workflow',
      min_trust_level: 'unverified',
      initiator: 'boss@ex.com',
      salt: 'salt-pwf-01',
      activated_at: '2026-01-01T00:00:00Z',
      steps: [
        { id: 'one', name: 'Sign off', participant: 'one@ex.com', status: 'pending', depends_on: [] },
      ],
    }));
    const eml = buildEml([
      'From: one@ex.com', 'To: event+pwf01-one@git-done.com', 'Subject: done',
    ]);
    const r = await runReceive(eml,
      ['1.2.3.4', 'ex.com', 'one@ex.com', 'event+pwf01-one@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.completion.completed_event, true);

    // Proof email is one of the captured outbound messages — find the
    // one addressed to the organiser with the proof subject.
    const captures = await fs.readdir(captureDir);
    const proofFiles = captures.filter((n) => n.endsWith('_boss_at_ex.com.eml'));
    assert.ok(proofFiles.length, `no proof email to boss in ${captures.join(', ')}`);
    let proofBody = '';
    for (const f of proofFiles) {
      const txt = await fs.readFile(path.join(captureDir, f), 'utf8');
      if (/Subject: \[gitdone\] proof —/.test(txt)) { proofBody = txt; break; }
    }
    assert.ok(proofBody, 'no proof-subject email captured for organiser');
    // Proof body must include the cryptographic receipt + the offline
    // verify command + the durable-proof preface.
    assert.match(proofBody, /durable proof/);
    assert.match(proofBody, /DKIM\s+/);
    assert.match(proofBody, /Trust\s+/);
    assert.match(proofBody, /gitdone-verify pwf01/);

    // Event JSON now records the proof_email_message_id so the
    // OTS-anchored follow-up can thread to it.
    const ev = JSON.parse(await fs.readFile(path.join(tmp, 'events', 'pwf01.json'), 'utf8'));
    assert.match(ev.proof_email_message_id || '', /^<.+@/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('integration: OTS-upgrade fires a proof-anchored email exactly once when the last proof anchors', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-anchor-'));
  try {
    const { fake, captureDir } = makeFakeSendmail(tmp);
    // A complete declaration event with one OTS proof file, plus a
    // git repo (so the upgrade walker doesn't error on missing dirs).
    const eventId = 'panch01';
    await fs.mkdir(path.join(tmp, 'events'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'events', `${eventId}.json`), JSON.stringify({
      id: eventId, type: 'crypto', mode: 'declaration',
      title: 'declaration anchor',
      initiator: 'boss@ex.com', signer: 'sign@ex.com',
      salt: 'salt-anch-01',
      activated_at: '2026-01-01T00:00:00Z',
      completion: { status: 'complete', completed_at: '2026-04-01T00:00:00Z', commit_sequence: 1 },
      proof_email_message_id: '<proof.original@git-done.com>',
    }));
    const repo = path.join(tmp, 'repos', eventId);
    const proofsDir = path.join(repo, 'ots_proofs');
    await fs.mkdir(proofsDir, { recursive: true });
    // Init a real git repo so the upgrade worker's commit step works.
    const { execSync } = require('node:child_process');
    execSync('git init -q --initial-branch=main', { cwd: repo });
    execSync('git -c user.email=t@t -c user.name=t commit --allow-empty -m init -q', { cwd: repo });
    const proofFile = path.join(proofsDir, 'commit-001.ots');
    await fs.writeFile(proofFile, 'pending-pre');

    // Fake `ots` binary that:
    //   - exits 0 on the first call (mutates the file -> "upgraded")
    //   - exits 0 with no change on subsequent calls (already anchored)
    const fakeOts = path.join(tmp, 'fake-ots.sh');
    const sentinelFile = path.join(tmp, '.ots-called');
    fssync.writeFileSync(fakeOts,
      `#!/bin/sh
# args: upgrade <file>
file="$2"
if [ -f "${sentinelFile}" ]; then
  # Already anchored — exit 0, no change
  exit 0
fi
echo "anchored" > "$file"
touch "${sentinelFile}"
exit 0
`, { mode: 0o755 });

    // Run the upgrade worker once — should fire the anchored email.
    delete require.cache[require.resolve(OTS_UPGRADE)];
    process.env.GITDONE_DATA_DIR = tmp;
    process.env.GITDONE_OTS_BIN = fakeOts;
    process.env.GITDONE_SENDMAIL_BIN = fake;
    process.env.GITDONE_LOG_FILE = '';
    const otsUp = require(OTS_UPGRADE);
    const r1 = await otsUp.run({ dataDir: tmp, binary: fakeOts });
    assert.equal(r1.proofs_upgraded, 1);
    assert.equal(r1.proof_mails_sent, 2, 'one mail per recipient: initiator + signer');

    // The anchored sentinel exists.
    const sentinel = await fs.access(path.join(proofsDir, '.anchored-notified'))
      .then(() => true, () => false);
    assert.equal(sentinel, true, 'sentinel created');

    // Second run is a no-op for the anchored email — no new captures.
    const beforeCount = (await fs.readdir(captureDir)).filter((n) => n.endsWith('.eml')).length;
    const r2 = await otsUp.run({ dataDir: tmp, binary: fakeOts });
    assert.equal(r2.proof_mails_sent, 0, 'no re-send on second run');
    const afterCount = (await fs.readdir(captureDir)).filter((n) => n.endsWith('.eml')).length;
    assert.equal(afterCount, beforeCount);

    // Anchored email body sanity: subject, threading header,
    // gitdone-verify command.
    const captures = (await fs.readdir(captureDir)).filter((n) => n.endsWith('.eml'));
    let anchored = '';
    for (const f of captures) {
      const txt = await fs.readFile(path.join(captureDir, f), 'utf8');
      if (/Subject: \[gitdone\] proof anchored —/.test(txt)) { anchored = txt; break; }
    }
    assert.ok(anchored, 'no anchored email captured');
    assert.match(anchored, /In-Reply-To: <proof\.original@git-done\.com>/);
    assert.match(anchored, /References: <proof\.original@git-done\.com>/);
    assert.match(anchored, /gitdone-verify panch01/);
  } finally {
    delete process.env.GITDONE_OTS_BIN;
    delete process.env.GITDONE_SENDMAIL_BIN;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
