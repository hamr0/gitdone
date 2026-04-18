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

test('commitReply: writes commit-NNN.json (v2 schema) and creates a git commit', async () => {
  const { commitReply, generateEventSalt } = require('../../src/gitrepo');
  const event = { id: 'testD', title: 'D', salt: generateEventSalt(), steps: [{ id: 'step1' }] };
  const ctx = {
    eventId: 'testD',
    stepId: 'step1',
    receivedAt: '2026-04-17T14:22:00Z',
    envelope: { sender: 'alice@example.com', client_ip: '1.2.3.4' },
    from: 'alice@example.com',
    trustLevel: 'verified',
    participantMatch: true,
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
  assert.equal(saved.schema_version, 2);
  assert.equal(saved.event_id, 'testD');
  assert.equal(saved.step_id, 'step1');
  // Principle §0.1.10 — no plaintext leaks:
  assert.equal(saved.sender, undefined);
  assert.equal(saved.subject, undefined);
  assert.equal(saved.body_preview, undefined);
  assert.equal(saved.message_id, undefined);
  // But hashed + domain survive:
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

test('buildCommitMetadata: same salt + same sender → same hash (dedup works)', () => {
  const { buildCommitMetadata } = require('../../src/gitrepo');
  const event = { salt: 'fixed-salt' };
  const ctx1 = { eventId: 'x', receivedAt: 'now', envelope: { sender: 'Alice@Example.com' }, from: null };
  const ctx2 = { eventId: 'x', receivedAt: 'now', envelope: { sender: 'alice@example.com' }, from: null };
  const m1 = buildCommitMetadata(1, ctx1, event);
  const m2 = buildCommitMetadata(1, ctx2, event);
  assert.equal(m1.sender_hash, m2.sender_hash); // lowercased → same
});

test('buildCommitMetadata: different salt → different hash (cross-event isolation)', () => {
  const { buildCommitMetadata } = require('../../src/gitrepo');
  const ctx = { eventId: 'x', receivedAt: 'now', envelope: { sender: 'alice@example.com' }, from: null };
  const m1 = buildCommitMetadata(1, ctx, { salt: 'salt-A' });
  const m2 = buildCommitMetadata(1, ctx, { salt: 'salt-B' });
  assert.notEqual(m1.sender_hash, m2.sender_hash);
});

test('buildCommitMetadata: no salt falls back to unsalted hash (legacy compat)', () => {
  const { buildCommitMetadata, saltedSenderHash } = require('../../src/gitrepo');
  const ctx = { eventId: 'x', receivedAt: 'now', envelope: { sender: 'alice@example.com' }, from: null };
  const m = buildCommitMetadata(1, ctx, {});
  // Still produces a hash but predictable (without salt protection)
  assert.match(m.sender_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(m.sender_hash, saltedSenderHash('alice@example.com', null));
});

test('generateEventSalt: produces 64-char hex (32 bytes)', () => {
  const { generateEventSalt } = require('../../src/gitrepo');
  const a = generateEventSalt();
  const b = generateEventSalt();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.match(b, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

// 1.L.3 — reverify (contested-commit upgrade) tests

test('loadCommit: returns null when commit missing', async () => {
  const { loadCommit } = require('../../src/gitrepo');
  const r = await loadCommit('nonexistent', 1);
  assert.equal(r, null);
});

test('nextReverifySequence: starts at 1 on fresh repo', async () => {
  const { initRepoIfNeeded, nextReverifySequence } = require('../../src/gitrepo');
  const ev = { id: 'reverifyA', title: 'Reverify A', steps: [] };
  const { root } = await initRepoIfNeeded('reverifyA', ev);
  assert.equal(await nextReverifySequence(root), 1);
});

test('commitReverify: writes reverify-NNN.json (separate namespace from commit-NNN)', async () => {
  const { initRepoIfNeeded, commitReply, commitReverify, buildCommitMetadata } = require('../../src/gitrepo');
  const ev = { id: 'reverifyB', title: 'Reverify B', salt: 'pub-salt-b', steps: [] };
  await initRepoIfNeeded('reverifyB', ev);

  // Seed one reply commit
  const ctx = { eventId: 'reverifyB', stepId: 'step1', receivedAt: '2026-04-18T00:00:00Z',
    envelope: { sender: 'alice@example.com' }, from: 'alice@example.com',
    trustLevel: 'authorized', participantMatch: true, attachments: [],
    dkim: { signatures: [{ result: 'fail', domain: 'example.com', selector: 's' }] },
    spf: { result: 'pass' }, dmarc: { result: 'pass' }, arc: { result: 'none' },
    rawSha256: 'sha256:' + 'a'.repeat(64), rawSize: 100,
    dkimArchive: null };
  const replyRes = await commitReply('reverifyB', ev, ctx);
  assert.equal(replyRes.file, path.join('commits', 'commit-001.json'));

  // Now submit a reverify for commit-001
  const reverifyRes = await commitReverify('reverifyB', ev, 1, {
    trust_level_before: 'authorized',
    trust_level_after: 'verified',
    upgraded: true,
    dkim_reverify: { ok: true, result: 'pass' },
    evidence: { raw_sha256: 'sha256:' + 'b'.repeat(64), raw_size: 150 },
  }, '2026-04-18T01:00:00Z');

  assert.equal(reverifyRes.file, path.join('commits', 'reverify-001.json'));
  assert.equal(reverifyRes.target_commit, 'commit-001.json');

  // File exists with expected content
  const fs2 = require('node:fs/promises');
  const pathMod = require('node:path');
  const { repoPath } = require('../../src/gitrepo');
  const body = JSON.parse(await fs2.readFile(
    pathMod.join(repoPath('reverifyB'), 'commits', 'reverify-001.json'), 'utf8'));
  assert.equal(body.schema_version, 2);
  assert.equal(body.kind, 'reverify');
  assert.equal(body.target_commit, 'commit-001.json');
  assert.equal(body.target_sequence, 1);
  assert.equal(body.upgraded, true);
  assert.equal(body.trust_level_before, 'authorized');
  assert.equal(body.trust_level_after, 'verified');
  assert.deepEqual(body.dkim_reverify, { ok: true, result: 'pass' });

  // Original commit-001.json UNTOUCHED
  const original = JSON.parse(await fs2.readFile(
    pathMod.join(repoPath('reverifyB'), 'commits', 'commit-001.json'), 'utf8'));
  assert.equal(original.trust_level, 'authorized'); // unchanged
});

test('commitReverify: sequence auto-increments independently of reply commits', async () => {
  const { initRepoIfNeeded, commitReverify } = require('../../src/gitrepo');
  const ev = { id: 'reverifyC', title: 'Reverify C', salt: 's', steps: [] };
  await initRepoIfNeeded('reverifyC', ev);

  const r1 = await commitReverify('reverifyC', ev, 1, { upgraded: false }, '2026-04-18T00:00:00Z');
  const r2 = await commitReverify('reverifyC', ev, 1, { upgraded: true }, '2026-04-18T01:00:00Z');
  assert.equal(r1.sequence, 1);
  assert.equal(r2.sequence, 2);
  assert.notEqual(r1.file, r2.file);
});

test('commitReverify: produces an OTS proof path (even if stamping fails gracefully)', async () => {
  const { initRepoIfNeeded, commitReverify } = require('../../src/gitrepo');
  const ev = { id: 'reverifyD', title: 'Reverify D', salt: 's', steps: [] };
  await initRepoIfNeeded('reverifyD', ev);

  const r = await commitReverify('reverifyD', ev, 5, {
    upgraded: false,
    dkim_reverify: { ok: false, reason: 'test' },
  }, '2026-04-18T00:00:00Z');
  // Either stamp ran and path is set, or stamp failed and path is null +
  // ots_archive error is recorded. Both acceptable per existing 1.E contract.
  const fs2 = require('node:fs/promises');
  const pathMod = require('node:path');
  const { repoPath } = require('../../src/gitrepo');
  const body = JSON.parse(await fs2.readFile(
    pathMod.join(repoPath('reverifyD'), r.file), 'utf8'));
  // At least one of these is true:
  assert.ok(body.ots_proof_file || (body.ots_archive && body.ots_archive.error));
});
