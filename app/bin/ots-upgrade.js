#!/usr/bin/env node
// 1.E+ — scheduled OTS upgrade worker.
//
// Context: at commit time (1.E), `ots stamp` produces a calendar-pending
// .ots proof. The proof is valid, but the Bitcoin attestation isn't
// folded in yet — it lives on the calendar server. `ots verify` masks
// this today by querying calendars live. If the calendars died before
// we upgraded, proofs would be lost.
//
// This worker runs on a timer (every 6h via systemd) and:
//   1. Walks $dataDir/repos/*/ots_proofs/*.ots
//   2. Snapshots each file's sha256
//   3. Runs `ots upgrade` on each
//   4. If the file's sha256 changed, the calendar attestation was
//      merged in — that proof is now fully Bitcoin-anchored locally.
//   5. Per repo, `git add + git commit` any upgraded files with ONE
//      commit message summarising the batch.
//
// Idempotent: already-upgraded proofs are no-ops. No changes = no git
// commit. Safe to run at any frequency.
//
// Runs as the `gitdone` user (systemd unit enforces). Failures are
// logged JSON-lines to stdout (captured by journalctl) and stderr.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const config = require('../src/config');

const OTS_BIN = config.otsBin || '/usr/local/bin/ots';
const GIT_BIN = process.env.GITDONE_GIT_BIN || 'git';
const UPGRADE_TIMEOUT_MS = 60_000;

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// Snapshot: file sha256 + size (for structured reporting).
async function fileStats(abs) {
  try {
    const buf = await fsp.readFile(abs);
    return { sha256: sha256Hex(buf), size: buf.length };
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

// Run `ots upgrade <file>` in-place. Returns { ok, stdout, stderr, exit }.
function otsUpgrade(file, { binary = OTS_BIN, timeoutMs = UPGRADE_TIMEOUT_MS } = {}) {
  const out = spawnSync(binary, ['upgrade', file], {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  if (out.error) {
    return { ok: false, error: out.error.message || String(out.error), exit: null };
  }
  return {
    ok: out.status === 0,
    exit: out.status,
    stdout: (out.stdout || '').trim(),
    stderr: (out.stderr || '').trim(),
  };
}

// Walk a single event repo: upgrade every .ots file, track which files
// changed, make a single git commit with all upgrades if any.
async function processRepo(repoDir, { binary = OTS_BIN, gitBin = GIT_BIN } = {}) {
  const proofsDir = path.join(repoDir, 'ots_proofs');
  let entries;
  try {
    entries = await fsp.readdir(proofsDir);
  } catch (err) {
    return { repo: repoDir, skipped: true, reason: `no ots_proofs dir: ${err.message || err}` };
  }
  const proofs = entries.filter((e) => e.endsWith('.ots'));
  if (proofs.length === 0) {
    return { repo: repoDir, checked: 0, upgraded: 0 };
  }

  const upgraded = [];
  const errors = [];
  for (const name of proofs) {
    const abs = path.join(proofsDir, name);
    const before = await fileStats(abs);
    const result = otsUpgrade(abs, { binary });
    const after = await fileStats(abs);

    const changed = !before.error && !after.error && before.sha256 !== after.sha256;
    if (changed) {
      upgraded.push({
        file: path.join('ots_proofs', name),
        before_sha256: before.sha256,
        after_sha256: after.sha256,
        size_before: before.size,
        size_after: after.size,
      });
    }
    // `ots upgrade` exits 1 when a proof is still pending Bitcoin and
    // nothing can be merged — that's NOT an error for our purposes, just
    // "no work to do yet". Only surface errors when the binary itself
    // blew up (ENOENT, timeout) or both before/after snapshots failed.
    if (result.error || (before.error && after.error)) {
      errors.push({ file: name, reason: result.error || before.error || after.error });
    }
  }

  const summary = {
    repo: repoDir,
    checked: proofs.length,
    upgraded: upgraded.length,
    errors: errors.length,
  };
  if (upgraded.length === 0) {
    if (errors.length) summary.error_detail = errors;
    return summary;
  }

  // Stage and commit the upgraded proofs.
  const relFiles = upgraded.map((u) => u.file);
  const addRes = spawnSync(gitBin, ['-C', repoDir, 'add', ...relFiles], { encoding: 'utf8' });
  if (addRes.status !== 0) {
    summary.git_add_error = (addRes.stderr || addRes.stdout || '').trim();
    return summary;
  }
  const msg = `ots upgrade: ${upgraded.length} proof(s) anchored to Bitcoin`;
  const commitRes = spawnSync(gitBin, ['-C', repoDir, 'commit', '-m', msg], { encoding: 'utf8' });
  if (commitRes.status !== 0) {
    summary.git_commit_error = (commitRes.stderr || commitRes.stdout || '').trim();
    return summary;
  }
  // Extract the commit sha from git's stdout "[main abc1234] ..."
  const shaMatch = (commitRes.stdout || '').match(/\[[^\]]*\s([0-9a-f]{7,40})\]/);
  summary.git_commit = shaMatch ? shaMatch[1] : null;
  summary.upgraded_files = upgraded;
  return summary;
}

// Entry.
async function run({ dataDir = config.dataDir, binary = OTS_BIN, gitBin = GIT_BIN } = {}) {
  const started_at = new Date().toISOString();
  emit({ kind: 'ots_upgrade_start', started_at, data_dir: dataDir });

  const reposDir = path.join(dataDir, 'repos');
  let eventDirs;
  try {
    eventDirs = await fsp.readdir(reposDir, { withFileTypes: true });
  } catch (err) {
    emit({ kind: 'ots_upgrade_error', reason: `no repos dir: ${err.message || err}` });
    return { ok: false, reason: 'no repos dir' };
  }
  const repos = eventDirs.filter((d) => d.isDirectory()).map((d) => path.join(reposDir, d.name));

  let totalChecked = 0;
  let totalUpgraded = 0;
  let reposWithCommits = 0;
  for (const repo of repos) {
    const r = await processRepo(repo, { binary, gitBin });
    emit({ kind: 'ots_upgrade_repo', ...r });
    totalChecked += r.checked || 0;
    totalUpgraded += r.upgraded || 0;
    if (r.git_commit) reposWithCommits++;
  }

  const finished_at = new Date().toISOString();
  const summary = {
    kind: 'ots_upgrade_done',
    started_at,
    finished_at,
    repos_seen: repos.length,
    proofs_checked: totalChecked,
    proofs_upgraded: totalUpgraded,
    repos_committed: reposWithCommits,
  };
  emit(summary);
  return summary;
}

if (require.main === module) {
  run().then((r) => {
    process.exit(r && r.ok === false ? 1 : 0);
  }).catch((err) => {
    process.stderr.write(`ots-upgrade: ${err && err.stack || err}\n`);
    process.exit(1);
  });
}

module.exports = { processRepo, otsUpgrade, run, fileStats };
