'use strict';

// Phase 4 — notifyLifecycleEdge dispatcher.
//
// The dispatcher is a thin facade over the existing notify composers.
// These tests pin the three things the facade adds on top of the
// already-tested composers:
//
//   1. Routing — each edge reaches the right composer and produces
//      the expected recipient set.
//   2. Return normalisation — single-result composers (activated,
//      progressed) come back as arrays, so callers can always
//      .map/.find uniformly.
//   3. Edge side effect — edge==='closed' on a strict attestation
//      fires redactAttestorEmails post-notify; edge==='completed'
//      does NOT (the 0.24.8 contract: emails persist until the
//      terminal close).
//   4. Unknown edge throws.
//
// Run in a subprocess per scenario so GITDONE_SENDMAIL_BIN and
// GITDONE_DATA_DIR are frozen at module-load time the way production
// loads them. Mirrors the oversubscribe-revoke-reopen harness.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP = path.join(__dirname, '..', '..');

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

// Run a snippet of JS with notifications loaded under the given env.
// The snippet has `notify`, `edge helpers`, and `print(obj)` in scope.
// Returns parsed JSON the snippet printed via print().
function runInProc(snippet, env) {
  return new Promise((resolve, reject) => {
    const program = `
      'use strict';
      const notifications = require(${JSON.stringify(path.join(APP, 'src', 'notifications'))});
      const fs = require('node:fs');
      function print(o) { process.stdout.write('@@RESULT@@' + JSON.stringify(o) + '@@END@@'); }
      (async () => {
        try {
          ${snippet}
        } catch (err) {
          print({ __error: err.message || String(err) });
        }
      })();
    `;
    const child = spawn('node', ['-e', program], {
      env: { ...process.env, ...env },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      const m = stdout.match(/@@RESULT@@([\s\S]*?)@@END@@/);
      if (!m) return reject(new Error(`no result printed (exit ${code}). stderr: ${stderr}\nstdout: ${stdout}`));
      resolve({ result: JSON.parse(m[1]), stderr, code });
    });
  });
}

async function writeEvent(tmp, id, event) {
  await fs.mkdir(path.join(tmp, 'events'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'events', `${id}.json`), JSON.stringify(event));
}

async function readEvent(tmp, id) {
  return JSON.parse(await fs.readFile(path.join(tmp, 'events', `${id}.json`), 'utf8'));
}

// ---------------------------------------------------------------------------

test('routing: activated (workflow) → single organiser result, normalised to array', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-nle-act-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    const event = {
      id: 'w1', type: 'event', title: 't', initiator: 'chair@ex.com',
      activated_at: '2026-05-01T00:00:00Z',
      steps: [{ id: 's1', name: 'A', participant: 'alice@ex.com', status: 'pending', depends_on: [] }],
    };
    const { result } = await runInProc(
      `const ev = ${JSON.stringify(event)};
       const r = await notifications.notifyLifecycleEdge(ev, 'activated', { sendResults: [{ to: 'alice@ex.com', ok: true }] });
       print({ isArray: Array.isArray(r), len: r.length, tos: r.map(x => x.to) });`,
      { GITDONE_SENDMAIL_BIN: fake, GITDONE_DATA_DIR: tmp });
    assert.equal(result.isArray, true, 'result must be an array');
    assert.equal(result.len, 1, 'activation notifies the organiser only');
    assert.deepEqual(result.tos, ['chair@ex.com']);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('routing: progressed (workflow step done) → single organiser result, normalised to array', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-nle-prog-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    const event = {
      id: 'w2', type: 'event', title: 't', initiator: 'chair@ex.com',
      activated_at: '2026-05-01T00:00:00Z',
      steps: [
        { id: 's1', name: 'A', participant: 'alice@ex.com', status: 'complete', depends_on: [] },
        { id: 's2', name: 'B', participant: 'bob@ex.com', status: 'pending', depends_on: ['s1'] },
      ],
    };
    const { result } = await runInProc(
      `const ev = ${JSON.stringify(event)};
       const r = await notifications.notifyLifecycleEdge(ev, 'progressed', { completedStepId: 's1', newlyActiveSteps: [ev.steps[1]] });
       print({ isArray: Array.isArray(r), len: r.length, tos: r.map(x => x.to) });`,
      { GITDONE_SENDMAIL_BIN: fake, GITDONE_DATA_DIR: tmp });
    assert.equal(result.isArray, true);
    assert.equal(result.len, 1, 'step-progress notifies the organiser');
    assert.deepEqual(result.tos, ['chair@ex.com']);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('routing: completed (workflow) → organiser + every participant', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-nle-comp-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    const event = {
      id: 'w3', type: 'event', title: 't', initiator: 'chair@ex.com',
      completion: { status: 'complete', completed_at: '2026-05-02T00:00:00Z' },
      steps: [
        { id: 's1', name: 'A', participant: 'alice@ex.com', status: 'complete', depends_on: [] },
        { id: 's2', name: 'B', participant: 'bob@ex.com', status: 'complete', depends_on: [] },
      ],
    };
    const { result } = await runInProc(
      `const ev = ${JSON.stringify(event)};
       const r = await notifications.notifyLifecycleEdge(ev, 'completed', {});
       print({ isArray: Array.isArray(r), tos: r.map(x => x.to).sort() });`,
      { GITDONE_SENDMAIL_BIN: fake, GITDONE_DATA_DIR: tmp });
    assert.equal(result.isArray, true);
    assert.deepEqual(result.tos, ['alice@ex.com', 'bob@ex.com', 'chair@ex.com']);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('unknown edge throws', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-nle-bad-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    const { result } = await runInProc(
      `const r = await notifications.notifyLifecycleEdge({ id: 'x', type: 'event', initiator: 'a@b.com', steps: [] }, 'frobnicate', {});
       print({ ok: true });`,
      { GITDONE_SENDMAIL_BIN: fake, GITDONE_DATA_DIR: tmp });
    assert.ok(result.__error, 'unknown edge must throw');
    assert.match(result.__error, /unknown edge "frobnicate"/);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('null event → empty array, no throw', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-nle-null-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    const { result } = await runInProc(
      `const r = await notifications.notifyLifecycleEdge(null, 'completed', {});
       print({ isArray: Array.isArray(r), len: r.length });`,
      { GITDONE_SENDMAIL_BIN: fake, GITDONE_DATA_DIR: tmp });
    assert.equal(result.isArray, true);
    assert.equal(result.len, 0);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test("side effect: closed + strict attestation → redactAttestorEmails fires post-notify", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-nle-redact-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    const id = 'a1';
    await writeEvent(tmp, id, {
      id, type: 'crypto', mode: 'attestation', title: 't',
      initiator: 'chair@ex.com', threshold: 2, dedup: 'unique',
      salt: `salt-${id}`, min_trust_level: 'unverified',
      reference_url: 'https://ex.com/p',
      reference_docs: [{ filename: 'a.pdf', sha256: 'sha256:aaa' }],
      completion: { status: 'complete', completed_at: '2026-05-02T00:00:00Z', closed_by: 'initiator' },
      attestor_progress: {
        'sha256:1': { complete: true, email: 'alice@ex.com' },
        'sha256:2': { complete: true, email: 'bob@ex.com' },
      },
    });
    const { result } = await runInProc(
      `const ev = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(tmp, 'events', id + '.json'))}, 'utf8'));
       const r = await notifications.notifyLifecycleEdge(ev, 'closed', { commits: [] });
       print({ tos: r.map(x => x.to).sort() });`,
      { GITDONE_SENDMAIL_BIN: fake, GITDONE_DATA_DIR: tmp });
    // All attestors-with-email + organiser got the close proof email
    // (resolver read the still-present emails BEFORE redaction).
    assert.deepEqual(result.tos, ['alice@ex.com', 'bob@ex.com', 'chair@ex.com']);
    // ...and THEN redaction fired.
    const after = await readEvent(tmp, id);
    assert.ok(after.attestor_emails_redacted_at,
      'closed edge must stamp attestor_emails_redacted_at');
    for (const [k, p] of Object.entries(after.attestor_progress)) {
      assert.equal(p.email, null, `attestor ${k} email must be redacted`);
    }
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test("side effect: completed + strict attestation → does NOT redact (0.24.8 contract)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-nle-noredact-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    const id = 'a2';
    await writeEvent(tmp, id, {
      id, type: 'crypto', mode: 'attestation', title: 't',
      initiator: 'chair@ex.com', threshold: 2, dedup: 'unique',
      salt: `salt-${id}`, min_trust_level: 'unverified',
      reference_url: 'https://ex.com/p',
      reference_docs: [{ filename: 'a.pdf', sha256: 'sha256:aaa' }],
      completion: { status: 'complete', completed_at: '2026-05-02T00:00:00Z' },
      attestor_progress: {
        'sha256:1': { complete: true, email: 'alice@ex.com' },
        'sha256:2': { complete: true, email: 'bob@ex.com' },
      },
    });
    await runInProc(
      `const ev = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(tmp, 'events', id + '.json'))}, 'utf8'));
       const r = await notifications.notifyLifecycleEdge(ev, 'completed', { commits: [] });
       print({ tos: r.map(x => x.to).sort() });`,
      { GITDONE_SENDMAIL_BIN: fake, GITDONE_DATA_DIR: tmp });
    const after = await readEvent(tmp, id);
    assert.ok(!after.attestor_emails_redacted_at,
      'completed edge must NOT redact — emails persist until close');
    assert.equal(after.attestor_progress['sha256:1'].email, 'alice@ex.com',
      'attestor email must persist through completed edge');
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});
