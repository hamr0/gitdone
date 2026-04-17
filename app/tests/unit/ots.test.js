'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { stampFile, moveProofIntoTree } = require('../../src/ots');

// stampFile is a thin wrapper around the `ots` CLI, so unit tests cover
// error paths (binary missing, timeout) — the happy path is covered by the
// VPS deployment verification (can't run ots without network in CI).

test('stampFile: returns {error} when ots binary path is invalid', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-ots-'));
  try {
    const f = path.join(tmp, 'dummy.json');
    await fs.writeFile(f, '{}');
    const r = await stampFile(f, { bin: '/nonexistent/ots', timeoutMs: 3000 });
    assert.ok(r.error, 'error should be populated');
    assert.match(r.error, /not found|exit|ENOENT|timeout/i);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('moveProofIntoTree: renames .ots to ots_proofs/commit-NNN.ots', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-ots-move-'));
  try {
    await fs.mkdir(path.join(tmp, 'commits'), { recursive: true });
    await fs.mkdir(path.join(tmp, 'ots_proofs'), { recursive: true });
    const src = path.join(tmp, 'commits', 'commit-007.json.ots');
    await fs.writeFile(src, 'fake-proof-bytes');

    const rel = await moveProofIntoTree(src, tmp, '007');
    assert.equal(rel, path.join('ots_proofs', 'commit-007.ots'));
    const destAbs = path.join(tmp, rel);
    const content = await fs.readFile(destAbs, 'utf8');
    assert.equal(content, 'fake-proof-bytes');
    // Source should no longer exist
    await assert.rejects(() => fs.access(src));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
