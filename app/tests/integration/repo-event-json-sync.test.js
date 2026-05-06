'use strict';

// Repo-as-proof-artifact invariant: every state transition on the
// master event JSON must also land in the per-event repo's
// working-tree event.json so the offline verifier reads the current
// state, not a stale snapshot from repo init.
//
// Coverage:
//   1. Activate → reply → close cycle: assert repo's event.json
//      mirrors the master after each transition.
//   2. Backfill script: stale repo event.json gets re-synced and a
//      fresh repo no-ops cleanly (idempotent).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RECEIVE = path.join(__dirname, '..', '..', 'bin', 'receive.js');
const BACKFILL = path.join(__dirname, '..', '..', 'bin', 'backfill-event-json.js');

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

function runBackfill(dataDir) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GITDONE_DATA_DIR: dataDir, GITDONE_OTS_BIN: '/nonexistent/ots' };
    const proc = spawn('node', [BACKFILL], { env });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (c) => { stdout += c.toString(); });
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
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

async function readMaster(dataDir, eventId) {
  return JSON.parse(await fs.readFile(
    path.join(dataDir, 'events', `${eventId}.json`), 'utf8'));
}

async function readRepoEventJson(dataDir, eventId) {
  return JSON.parse(await fs.readFile(
    path.join(dataDir, 'repos', eventId, 'event.json'), 'utf8'));
}

test('reply path syncs repo event.json with master state', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-syncrepo-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    await fs.mkdir(path.join(tmp, 'events'));
    await fs.writeFile(path.join(tmp, 'events', 'syncrep01.json'), JSON.stringify({
      id: 'syncrep01', type: 'event',
      title: 'Sync repo test',
      min_trust_level: 'unverified',
      initiator: 'boss@ex.com',
      salt: 'salt-syncrep-01',
      activated_at: '2026-01-01T00:00:00Z',
      steps: [
        { id: 'one', participant: 'one@ex.com', status: 'pending', depends_on: [] },
      ],
    }));

    const eml = buildEml([
      'From: one@ex.com', 'To: event+syncrep01-one@git-done.com', 'Subject: done',
    ]);
    const r = await runReceive(eml,
      ['1.2.3.4', 'ex.com', 'one@ex.com', 'event+syncrep01-one@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r.code, 0, r.stderr);

    const master = await readMaster(tmp, 'syncrep01');
    const repoView = await readRepoEventJson(tmp, 'syncrep01');

    // Both should agree on completion / step state.
    assert.equal(master.completion.status, 'complete');
    assert.equal(repoView.completion.status, 'complete',
      'repo event.json must reflect completion after reply');
    assert.equal(repoView.steps[0].status, 'complete');
    assert.deepEqual(repoView.steps, master.steps);
    assert.equal(repoView.completion.commit_sequence, master.completion.commit_sequence);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('declaration close cycle: repo event.json mirrors master', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-syncrepo-decl-'));
  try {
    const { fake } = makeFakeSendmail(tmp);
    await fs.mkdir(path.join(tmp, 'events'));
    await fs.writeFile(path.join(tmp, 'events', 'syncdecl1.json'), JSON.stringify({
      id: 'syncdecl1', type: 'crypto', mode: 'declaration',
      title: 'Decl sync test',
      min_trust_level: 'unverified',
      initiator: 'journo@ex.com', signer: 'witness@ex.com',
      salt: 'salt-syncdecl-01',
      activated_at: '2026-01-01T00:00:00Z',
    }));

    const eml = buildEml([
      'From: witness@ex.com', 'To: event+syncdecl1@git-done.com', 'Subject: I declare',
    ]);
    await runReceive(eml,
      ['1.2.3.4', 'ex.com', 'witness@ex.com', 'event+syncdecl1@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });

    const master = await readMaster(tmp, 'syncdecl1');
    const repoView = await readRepoEventJson(tmp, 'syncdecl1');
    assert.equal(master.completion.status, 'complete');
    assert.equal(repoView.completion.status, 'complete');
    assert.equal(repoView.completion.completed_at, master.completion.completed_at);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('backfill script: stale repos get re-synced, idempotent on second run', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-backfill-'));
  try {
    // Build two repos with stale event.json snapshots.
    const { initRepoIfNeeded } = require('../../src/gitrepo');
    process.env.GITDONE_DATA_DIR = tmp;
    delete require.cache[require.resolve('../../src/config')];
    delete require.cache[require.resolve('../../src/gitrepo')];
    const reInit = require('../../src/gitrepo').initRepoIfNeeded;

    const eventA = {
      id: 'bfA', title: 'Stale A', type: 'event',
      salt: 'salt-bf-a',
      activated_at: '2026-01-01T00:00:00Z',
      steps: [{ id: 'step1', participant: 'a@ex.com', status: 'pending', depends_on: [] }],
    };
    const eventB = {
      id: 'bfB', title: 'Stale B', type: 'crypto', mode: 'declaration',
      salt: 'salt-bf-b', signer: 'sig@ex.com',
      activated_at: '2026-01-02T00:00:00Z',
    };

    await fs.mkdir(path.join(tmp, 'events'), { recursive: true });
    // Master JSON reflects FUTURE state (completion already happened),
    // but the repo was init'd at the OLD pre-completion state — the
    // exact stale-repo bug we're fixing.
    await reInit('bfA', eventA);
    await reInit('bfB', eventB);

    const masterA = {
      ...eventA,
      steps: [{ ...eventA.steps[0], status: 'complete', completed_at: '2026-02-01T00:00:00Z', commit_sequence: 1 }],
      completion: { status: 'complete', completed_at: '2026-02-01T00:00:00Z', commit_sequence: 1 },
    };
    const masterB = {
      ...eventB,
      completion: { status: 'complete', completed_at: '2026-02-02T00:00:00Z', commit_sequence: 1 },
    };
    await fs.writeFile(path.join(tmp, 'events', 'bfA.json'), JSON.stringify(masterA, null, 2) + '\n');
    await fs.writeFile(path.join(tmp, 'events', 'bfB.json'), JSON.stringify(masterB, null, 2) + '\n');

    // Sanity: the repo's event.json is currently STALE (no completion).
    const beforeA = await readRepoEventJson(tmp, 'bfA');
    assert.equal(beforeA.completion, undefined);
    const beforeB = await readRepoEventJson(tmp, 'bfB');
    assert.equal(beforeB.completion, undefined);

    // Run backfill.
    const r = await runBackfill(tmp);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /bfA\tsynced/);
    assert.match(r.stdout, /bfB\tsynced/);

    // Repos now mirror master.
    const afterA = await readRepoEventJson(tmp, 'bfA');
    assert.equal(afterA.completion.status, 'complete');
    assert.equal(afterA.steps[0].status, 'complete');
    const afterB = await readRepoEventJson(tmp, 'bfB');
    assert.equal(afterB.completion.status, 'complete');

    // Second run: idempotent — no new commits.
    const simpleGit = require('simple-git');
    const logBeforeA = await simpleGit(path.join(tmp, 'repos', 'bfA')).log();
    const r2 = await runBackfill(tmp);
    assert.equal(r2.code, 0, r2.stderr);
    assert.match(r2.stdout, /bfA\tup-to-date/);
    assert.match(r2.stdout, /bfB\tup-to-date/);
    const logAfterA = await simpleGit(path.join(tmp, 'repos', 'bfA')).log();
    assert.equal(logAfterA.total, logBeforeA.total, 'no new commits on idempotent re-run');
  } finally {
    delete process.env.GITDONE_DATA_DIR;
    delete require.cache[require.resolve('../../src/config')];
    delete require.cache[require.resolve('../../src/gitrepo')];
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
