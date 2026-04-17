// OpenTimestamps anchor. Spawns the `ots` CLI (python `opentimestamps-client`)
// to create a Bitcoin-anchored timestamp proof for a file. The initial proof
// written by `ots stamp` is a "pending" — multi-calendar commitment that
// upgrades to a full Bitcoin proof within ~6 confirmations (~1h). The file
// the commit points at is the pending proof; auditors run `ots upgrade`
// later to refresh with the confirmed Bitcoin anchor.
//
// Failure modes (NOT blocking for delivery):
//   - `ots` binary missing             → { error: 'ots not found' }
//   - network / calendar server down   → non-zero exit, stderr captured
//   - unknown                          → timeout
//
// Everything is accept-with-flag: commit metadata records the outcome
// (proof file path OR error string); delivery proceeds either way.

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const config = require('./config');

function runOts(args, { cwd, timeoutMs = 30000, bin = config.otsBin } = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    const proc = spawn(bin, args, { cwd });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({ code: -1, stdout, stderr, error: 'ots timeout' });
    }, timeoutMs);
    proc.stdout.on('data', (c) => { stdout += c.toString(); });
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', (err) => {
      clearTimeout(timer);
      // ENOENT → ots binary missing
      const reason = err.code === 'ENOENT' ? 'ots not found' : err.message;
      resolve({ code: -1, stdout, stderr, error: reason });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// Stamp the file at `absPath`. ots writes `<absPath>.ots` next to the input.
// Returns { proof_path: absolute path to .ots file } on success, or
// { error: reason } on failure.
async function stampFile(absPath, opts = {}) {
  const res = await runOts(['stamp', absPath], opts);
  if (res.error) return { error: res.error };
  if (res.code !== 0) return { error: `ots exit ${res.code}: ${res.stderr.trim().slice(0, 200)}` };
  const proof = absPath + '.ots';
  try {
    const st = await fs.stat(proof);
    if (!st.isFile()) return { error: 'ots proof file missing after stamp' };
    return { proof_path: proof };
  } catch {
    return { error: 'ots proof file missing after stamp' };
  }
}

// Move a stamp produced at <jsonPath>.ots to the canonical
// ots_proofs/commit-NNN.ots location. Returns repo-relative path.
async function moveProofIntoTree(srcProofAbs, repoRoot, seqStr) {
  const destRel = path.join('ots_proofs', `commit-${seqStr}.ots`);
  const destAbs = path.join(repoRoot, destRel);
  await fs.rename(srcProofAbs, destAbs);
  return destRel;
}

module.exports = { stampFile, moveProofIntoTree };
