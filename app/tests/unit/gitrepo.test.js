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


// syncEventJson — the proof-artifact-stays-fresh helper

test('syncEventJson: no-op when repo does not exist', async () => {
  const { syncEventJson } = require('../../src/gitrepo');
  const r = await syncEventJson('neverActivated', { id: 'neverActivated', title: 'X' }, 'msg');
  assert.equal(r.synced, false);
  assert.equal(r.reason, 'no_repo');
});

test('syncEventJson: no commit when event.json bytes match HEAD', async () => {
  const { initRepoIfNeeded, syncEventJson, repoPath } = require('../../src/gitrepo');
  const event = { id: 'syncA', title: 'Sync A', steps: [] };
  await initRepoIfNeeded('syncA', event);
  const simpleGit = require('simple-git');
  const before = (await simpleGit(repoPath('syncA')).log()).total;

  // Same event object — bytes will match what initRepoIfNeeded wrote.
  const r = await syncEventJson('syncA', event, 'no-change attempt');
  assert.equal(r.synced, false);
  assert.equal(r.reason, 'no_change');

  const after = (await simpleGit(repoPath('syncA')).log()).total;
  assert.equal(after, before, 'no new commit when content unchanged');
});

test('syncEventJson: commits when event content changes', async () => {
  const { initRepoIfNeeded, syncEventJson, repoPath } = require('../../src/gitrepo');
  const event = { id: 'syncB', title: 'Sync B', steps: [] };
  await initRepoIfNeeded('syncB', event);
  const simpleGit = require('simple-git');
  const before = (await simpleGit(repoPath('syncB')).log()).total;

  const updated = { ...event, title: 'Sync B (updated)', activated_at: '2026-05-06T00:00:00Z' };
  const r = await syncEventJson('syncB', updated, 'event activated');
  assert.equal(r.synced, true);
  assert.match(r.sha, /^[0-9a-f]+$/);

  // event.json on disk reflects the update
  const onDisk = JSON.parse(await fs.readFile(path.join(repoPath('syncB'), 'event.json'), 'utf8'));
  assert.equal(onDisk.title, 'Sync B (updated)');
  assert.equal(onDisk.activated_at, '2026-05-06T00:00:00Z');

  // Git log gained exactly one new commit with the supplied message
  const log = await simpleGit(repoPath('syncB')).log();
  assert.equal(log.total, before + 1);
  assert.match(log.latest.message, /event activated/);
});

test('syncEventJson: reflects deeply-nested completion mutations', async () => {
  const { initRepoIfNeeded, syncEventJson, repoPath } = require('../../src/gitrepo');
  const event = { id: 'syncC', title: 'Sync C', type: 'crypto', mode: 'declaration',
    signer: 'witness@ex.com', steps: [] };
  await initRepoIfNeeded('syncC', event);

  const completed = {
    ...event,
    completion: { status: 'complete', completed_at: '2026-05-06T12:00:00Z', commit_sequence: 1 },
  };
  const r = await syncEventJson('syncC', completed, 'reply 001 counted: declaration');
  assert.equal(r.synced, true);

  const onDisk = JSON.parse(await fs.readFile(path.join(repoPath('syncC'), 'event.json'), 'utf8'));
  assert.equal(onDisk.completion.status, 'complete');
  assert.equal(onDisk.completion.commit_sequence, 1);
});

test('syncEventJson: rejects bad event ids (path-traversal guard)', async () => {
  const { syncEventJson } = require('../../src/gitrepo');
  await assert.rejects(
    () => syncEventJson('../bad', { id: '../bad' }, 'msg'),
    /invalid eventId/
  );
});

// Byte-strict no-diff invariant. The no-change check inside syncEventJson
// uses `git status` against the working-tree file — that's BYTE strict.
// JSON.stringify is order-stable in JS (V8 preserves insertion order),
// so two events with the same keys in the same order serialize to the
// same bytes. But keys inserted in a DIFFERENT order serialize to
// different bytes — and we WANT that to produce a commit so a future
// refactor that reorders keys (or changes indent) does not silently
// pollute the ledger. The test below pins both directions:
//   - identical bytes → no_change (already covered above)
//   - reordered keys  → bytes differ → commit fires
// If either direction regresses, the proof ledger drifts. The fix is
// either (a) put back stable serialization or (b) replace the
// byte-strict check with a content-strict one.
test('syncEventJson: byte-strict — reordered keys serialize differently and commit', async () => {
  const { initRepoIfNeeded, syncEventJson, repoPath } = require('../../src/gitrepo');
  const simpleGit = require('simple-git');
  // Build two objects with the same content but different insertion order.
  const eventAB = { id: 'syncOrder', title: 'Order Test', steps: [] };
  const eventBA = { title: 'Order Test', id: 'syncOrder', steps: [] };
  await initRepoIfNeeded('syncOrder', eventAB);
  const before = (await simpleGit(repoPath('syncOrder')).log()).total;

  // Sanity: the two objects ARE byte-different when serialized.
  const sA = JSON.stringify(eventAB, null, 2) + '\n';
  const sB = JSON.stringify(eventBA, null, 2) + '\n';
  assert.notEqual(sA, sB,
    'V8 stopped preserving insertion order — invariant assumption violated');

  // Re-syncing with identical bytes is a no-op.
  const same = await syncEventJson('syncOrder', eventAB, 'identical');
  assert.equal(same.synced, false);
  assert.equal(same.reason, 'no_change');

  // Re-syncing with reordered keys produces a commit. This is the
  // load-bearing assertion: it pins the byte-strict behaviour so a
  // future change that switches to content-equal comparison must
  // either preserve this invariant explicitly or update this test.
  const reordered = await syncEventJson('syncOrder', eventBA, 'reordered keys');
  assert.equal(reordered.synced, true,
    'reordered keys should produce a new commit under byte-strict check');
  const after = (await simpleGit(repoPath('syncOrder')).log()).total;
  assert.equal(after, before + 1, 'exactly one new commit for the reorder');
});
