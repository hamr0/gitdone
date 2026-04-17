'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

let tmp;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-repo-'));
  process.env.GITDONE_DATA_DIR = tmp;
  delete require.cache[require.resolve('../../src/config')];
  delete require.cache[require.resolve('../../src/gitrepo')];
});

after(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

test('initRepoIfNeeded: creates fresh repo with event.json first commit', async () => {
  const { initRepoIfNeeded, repoPath } = require('../../src/gitrepo');
  const event = { id: 'testA', title: 'Test A', steps: [] };
  const r = await initRepoIfNeeded('testA', event);
  assert.equal(r.initialised, true);
  assert.equal(r.root, repoPath('testA'));

  // event.json exists with expected content
  const evt = JSON.parse(await fs.readFile(path.join(r.root, 'event.json'), 'utf8'));
  assert.equal(evt.id, 'testA');
  // subdirs exist
  for (const d of ['commits', 'dkim_keys', 'ots_proofs']) {
    assert.equal((await fs.stat(path.join(r.root, d))).isDirectory(), true);
  }
  // a commit exists in git history
  const simpleGit = require('simple-git');
  const git = simpleGit(r.root);
  const log = await git.log();
  assert.equal(log.total, 1);
  assert.match(log.latest.message, /event created/);
});

test('initRepoIfNeeded: idempotent — does not reinit existing repo', async () => {
  const { initRepoIfNeeded } = require('../../src/gitrepo');
  const r1 = await initRepoIfNeeded('testA', { id: 'testA', title: 'Test A', steps: [] });
  assert.equal(r1.initialised, false);
});

test('initRepoIfNeeded: rejects bad event ids (path traversal guard)', async () => {
  const { initRepoIfNeeded } = require('../../src/gitrepo');
  await assert.rejects(
    () => initRepoIfNeeded('../bad', { id: '../bad' }),
    /invalid eventId/
  );
});

test('nextSequence: returns 1 on empty commits dir', async () => {
  const { nextSequence, initRepoIfNeeded } = require('../../src/gitrepo');
  const { root } = await initRepoIfNeeded('testB', { id: 'testB', title: 'B', steps: [] });
  assert.equal(await nextSequence(root), 1);
});

test('nextSequence: finds max then +1, ignores non-matching files', async () => {
  const { nextSequence, initRepoIfNeeded } = require('../../src/gitrepo');
  const { root } = await initRepoIfNeeded('testC', { id: 'testC', title: 'C', steps: [] });
  await fs.writeFile(path.join(root, 'commits', 'commit-001.json'), '{}');
  await fs.writeFile(path.join(root, 'commits', 'commit-012.json'), '{}');
  await fs.writeFile(path.join(root, 'commits', 'not-a-commit.txt'), 'x');
  await fs.writeFile(path.join(root, 'commits', 'commit-003.json'), '{}');
  assert.equal(await nextSequence(root), 13);
});

test('commitReply: writes commit-NNN.json and creates a git commit', async () => {
  const { commitReply, repoPath } = require('../../src/gitrepo');
  const event = { id: 'testD', title: 'D', steps: [{ id: 'step1' }] };
  const ctx = {
    eventId: 'testD',
    stepId: 'step1',
    receivedAt: '2026-04-17T14:22:00Z',
    envelope: { sender: 'alice@example.com', client_ip: '1.2.3.4' },
    from: 'alice@example.com',
    trustLevel: 'verified',
    participantMatch: true,
    subject: 'hello',
    bodyPreview: 'hi there',
    messageId: '<abc@ex.com>',
    attachments: [{ filename: 'x.pdf', size: 100, sha256: 'sha256:deadbeef' }],
    dkim: { result: 'pass' },
    rawSha256: 'sha256:feed',
    rawSize: 500,
  };
  const r = await commitReply('testD', event, ctx);
  assert.ok(r.sha, 'commit sha returned');
  assert.equal(r.sequence, 1);
  assert.match(r.file, /^commits\/commit-001\.json$/);

  const saved = JSON.parse(await fs.readFile(path.join(r.repo_path, r.file), 'utf8'));
  assert.equal(saved.event_id, 'testD');
  assert.equal(saved.step_id, 'step1');
  assert.equal(saved.sender, 'alice@example.com');
  assert.equal(saved.sender_domain, 'example.com');
  assert.match(saved.sender_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(saved.trust_level, 'verified');
  assert.equal(saved.attachments.length, 1);

  // Second reply increments sequence
  const r2 = await commitReply('testD', event, ctx);
  assert.equal(r2.sequence, 2);
  assert.match(r2.file, /^commits\/commit-002\.json$/);

  // Git log has 3 commits: initial + 2 replies
  const simpleGit = require('simple-git');
  const log = await simpleGit(r.repo_path).log();
  assert.equal(log.total, 3);
});

test('buildCommitMetadata: sender_hash is lower-cased then hashed (stable)', async () => {
  const { buildCommitMetadata } = require('../../src/gitrepo');
  const ctx1 = { eventId: 'x', receivedAt: 'now', envelope: { sender: 'Alice@Example.com' }, from: null };
  const ctx2 = { eventId: 'x', receivedAt: 'now', envelope: { sender: 'alice@example.com' }, from: null };
  const m1 = buildCommitMetadata(1, ctx1);
  const m2 = buildCommitMetadata(1, ctx2);
  assert.equal(m1.sender_hash, m2.sender_hash);
});
