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

// Walk an event repo's commits/ dir, returning the set of OTS proof
// files still pending Bitcoin (i.e. ots verify says "calendar"-only).
// Cheaper signal: just count how many .ots files exist that haven't
// changed in this run. We don't shell out to `ots verify` — we trust
// the upgrade-changed-the-file signal as the authoritative "anchored
// in Bitcoin now" event.
async function listOtsProofs(repoDir) {
  const proofsDir = path.join(repoDir, 'ots_proofs');
  let entries;
  try { entries = await fsp.readdir(proofsDir); } catch { return []; }
  return entries.filter((e) => e.endsWith('.ots'));
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
  // pendingAfter — files that ots couldn't fully merge in this run
  // (exit non-zero with no error). Used as the signal that the event
  // hasn't fully anchored yet; if pendingAfter == 0 AND any file
  // upgraded this run, the event just crossed the fully-anchored
  // threshold and the proof-anchored email fires.
  let pendingAfter = 0;
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
    } else if (!result.error && result.exit !== 0) {
      // ots upgrade returned non-zero with no spawn error → "still
      // pending Bitcoin upgrade" per the comment below.
      pendingAfter += 1;
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
    pending_after: pendingAfter,
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

// Sentinel: per-event "fully-anchored proof email already sent". Once
// this file exists, we never re-send. Lives next to ots_proofs/ so it
// stays with the repo backup.
const ANCHORED_NOTIFIED = '.anchored-notified';

async function isAnchoredNotified(repoDir) {
  try {
    await fsp.access(path.join(repoDir, 'ots_proofs', ANCHORED_NOTIFIED));
    return true;
  } catch { return false; }
}

async function markAnchoredNotified(repoDir) {
  const dir = path.join(repoDir, 'ots_proofs');
  try { await fsp.mkdir(dir, { recursive: true }); } catch {}
  await fsp.writeFile(path.join(dir, ANCHORED_NOTIFIED), new Date().toISOString() + '\n');
}

// Locate the event JSON for an event repo (path basename = event id).
async function loadEventForRepo(dataDir, repoDir) {
  const eventId = path.basename(repoDir);
  try {
    const raw = await fsp.readFile(path.join(dataDir, 'events', `${eventId}.json`), 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

// Entry.
async function run({ dataDir = config.dataDir, binary = OTS_BIN, gitBin = GIT_BIN, sendProofMail = true } = {}) {
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
  let proofMailsSent = 0;
  for (const repo of repos) {
    const r = await processRepo(repo, { binary, gitBin });
    emit({ kind: 'ots_upgrade_repo', ...r });
    totalChecked += r.checked || 0;
    totalUpgraded += r.upgraded || 0;
    if (r.git_commit) reposWithCommits++;
    // Fully-anchored transition: this run upgraded one or more files,
    // no files are still pending after, and the event hasn't been
    // notified yet. Only the event-completion path is interesting —
    // events still in flight (pending workflow steps) keep
    // accumulating new proofs and aren't anchor-stable.
    if (sendProofMail
        && !r.skipped
        && (r.upgraded || 0) > 0
        && (r.pending_after || 0) === 0
        && !(await isAnchoredNotified(repo))) {
      const event = await loadEventForRepo(dataDir, repo);
      const isComplete = event && event.completion && event.completion.status === 'complete';
      if (event && isComplete) {
        try {
          // Lazy require — keeps the script lean when running without
          // sendmail (tests) and matches the established pattern.
          const { notifyProofAnchored } = require('../src/notifications');
          const lastUpgrade = (r.upgraded_files && r.upgraded_files[0]) || null;
          const results = await notifyProofAnchored(event, {
            anchorInfo: {
              anchored_at: new Date().toISOString(),
              proof_path: lastUpgrade ? `${event.id}/${lastUpgrade.file}` : null,
            },
          });
          await markAnchoredNotified(repo);
          proofMailsSent += results.length;
          emit({ kind: 'ots_proof_anchored_notified', event_id: event.id, recipients: results.map((x) => ({ to: x.to, ok: x.ok })) });
        } catch (err) {
          emit({ kind: 'ots_proof_anchored_error', event_id: event && event.id, reason: err.message || String(err) });
        }
      }
    }
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
    proof_mails_sent: proofMailsSent,
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

module.exports = {
  processRepo,
  otsUpgrade,
  run,
  fileStats,
  isAnchoredNotified,
  markAnchoredNotified,
  loadEventForRepo,
};
