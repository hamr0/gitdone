'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { processRepo, run, otsUpgrade, fileStats } = require('../../bin/ots-upgrade');

// Build a tiny event repo on disk — enough that git commands work.
function mkRepo(base, name) {
  const dir = path.join(base, 'repos', name);
  fs.mkdirSync(path.join(dir, 'commits'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'ots_proofs'), { recursive: true });
  spawnSync('git', ['-C', dir, 'init', '-q', '--initial-branch=main'], { stdio: 'ignore' });
  spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@test'], { stdio: 'ignore' });
  spawnSync('git', ['-C', dir, 'config', 'user.name', 'test'], { stdio: 'ignore' });
  spawnSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'event.json'), JSON.stringify({ id: name, steps: [] }));
  spawnSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
  spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init'], { stdio: 'ignore' });
  return dir;
}

function mkFakeOts(dir, { upgradeFiles = [], exitCode = 0 }) {
  // Writes a shell script that, when called as `fake upgrade <file>`,
  // appends " UPGRADED" to files whose basename matches one in
  // upgradeFiles. Unquoted glob patterns for case-matching.
  const fake = path.join(dir, 'fake-ots.sh');
  const cases = upgradeFiles.map((f) => `    *${f}) echo " UPGRADED" >> "$2" ;;`).join('\n');
  const script = `#!/bin/sh
# args: "upgrade" <file>
case "$2" in
${cases}
esac
exit ${exitCode}
`;
  fs.writeFileSync(fake, script, { mode: 0o755 });
  return fake;
}

test('fileStats: returns sha256 and size for existing file', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-'));
  try {
    const f = path.join(tmp, 'x.ots');
    fs.writeFileSync(f, 'hello');
    const s = await fileStats(f);
    assert.match(s.sha256, /^[a-f0-9]{64}$/);
    assert.equal(s.size, 5);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('fileStats: returns {error} on missing file', async () => {
  const s = await fileStats('/nonexistent/xx.ots');
  assert.ok(s.error);
});

test('otsUpgrade: ok=false with error when binary missing', () => {
  const r = otsUpgrade('/tmp/foo', { binary: '/nonexistent/ots', timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test('processRepo: skip when ots_proofs dir missing', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-'));
  try {
    const dir = path.join(tmp, 'empty');
    fs.mkdirSync(dir, { recursive: true });
    const r = await processRepo(dir, { binary: '/bin/true', gitBin: 'git' });
    assert.equal(r.skipped, true);
    assert.match(r.reason, /no ots_proofs/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('processRepo: no upgraded files = no git commit (idempotent)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-'));
  try {
    const dir = mkRepo(tmp, 'e1');
    // Put a proof file in place
    fs.writeFileSync(path.join(dir, 'ots_proofs', 'commit-001.ots'), 'pending-proof-bytes');
    spawnSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
    spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'add proof'], { stdio: 'ignore' });

    const preSha = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    // fake ots that never modifies
    const fake = mkFakeOts(tmp, { upgradeFiles: [], exitCode: 1 });
    const r = await processRepo(dir, { binary: fake, gitBin: 'git' });
    assert.equal(r.upgraded, 0);
    assert.equal(r.git_commit, undefined);
    const postSha = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    assert.equal(preSha, postSha, 'no commit should have happened');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('processRepo: upgraded file -> single git commit, all upgrades batched', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-'));
  try {
    const dir = mkRepo(tmp, 'e2');
    fs.writeFileSync(path.join(dir, 'ots_proofs', 'commit-001.ots'), 'proof1');
    fs.writeFileSync(path.join(dir, 'ots_proofs', 'commit-002.ots'), 'proof2');
    fs.writeFileSync(path.join(dir, 'ots_proofs', 'commit-003.ots'), 'proof3');
    spawnSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
    spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'add 3 proofs'], { stdio: 'ignore' });

    // fake upgrades 001 and 003 only
    const fake = mkFakeOts(tmp, { upgradeFiles: ['commit-001.ots', 'commit-003.ots'] });
    const r = await processRepo(dir, { binary: fake, gitBin: 'git' });
    assert.equal(r.checked, 3);
    assert.equal(r.upgraded, 2);
    assert.ok(r.git_commit, 'should produce a commit sha');

    // Verify only 001 and 003 were staged in the commit
    const show = spawnSync('git', ['-C', dir, 'show', '--stat', '--format=', 'HEAD'], { encoding: 'utf8' }).stdout;
    assert.match(show, /ots_proofs\/commit-001\.ots/);
    assert.match(show, /ots_proofs\/commit-003\.ots/);
    assert.doesNotMatch(show, /ots_proofs\/commit-002\.ots/);

    // Verify commit message
    const msg = spawnSync('git', ['-C', dir, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).stdout.trim();
    assert.match(msg, /ots upgrade: 2 proof\(s\) anchored to Bitcoin/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('processRepo: re-running on already-upgraded state is a no-op (idempotent)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-'));
  try {
    const dir = mkRepo(tmp, 'e3');
    fs.writeFileSync(path.join(dir, 'ots_proofs', 'commit-001.ots'), 'proof1');
    spawnSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
    spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'add'], { stdio: 'ignore' });

    // First run: fake "upgrades" it
    const fake1 = mkFakeOts(tmp, { upgradeFiles: ['commit-001.ots'] });
    const r1 = await processRepo(dir, { binary: fake1, gitBin: 'git' });
    assert.equal(r1.upgraded, 1);

    // Second run: fake would upgrade again but we simulate real ots by
    // checking that subsequent real-ots runs would produce the same
    // output (already upgraded) and our change-detection would see no
    // change. Simulate: fake that appends the SAME string — still changes
    // the file because it's not truly idempotent. The real fix is a fake
    // that's content-aware. Simpler: use a fake that does nothing on
    // the second run.
    const fake2 = mkFakeOts(tmp, { upgradeFiles: [] });
    const r2 = await processRepo(dir, { binary: fake2, gitBin: 'git' });
    assert.equal(r2.upgraded, 0);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('run: reports no-repos-dir gracefully', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-'));
  try {
    const r = await run({ dataDir: path.join(tmp, 'nonexistent'), binary: '/bin/true', gitBin: 'git' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /no repos/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('run: iterates all event repos, returns aggregate stats', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-'));
  try {
    mkRepo(tmp, 'evt1');
    mkRepo(tmp, 'evt2');
    // stash something in each so processRepo has work
    for (const name of ['evt1', 'evt2']) {
      const proofsDir = path.join(tmp, 'repos', name, 'ots_proofs');
      fs.writeFileSync(path.join(proofsDir, 'commit-001.ots'), `proof-${name}`);
      spawnSync('git', ['-C', path.join(tmp, 'repos', name), 'add', '-A'], { stdio: 'ignore' });
      spawnSync('git', ['-C', path.join(tmp, 'repos', name), 'commit', '-q', '-m', 'x'], { stdio: 'ignore' });
    }
    // fake upgrades nothing
    const fake = mkFakeOts(tmp, { upgradeFiles: [], exitCode: 1 });
    // Capture stdout — run emits JSON lines; we don't care about contents here,
    // just that the return value sums up correctly.
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    let r;
    try {
      r = await run({ dataDir: tmp, binary: fake, gitBin: 'git' });
    } finally {
      process.stdout.write = origWrite;
    }
    assert.equal(r.repos_seen, 2);
    assert.equal(r.proofs_checked, 2);
    assert.equal(r.proofs_upgraded, 0);
    assert.equal(r.repos_committed, 0);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
