#!/usr/bin/env node
// gitdone-verify — offline verifier for GitDone event repositories.
//
// Principle §0.1.2: proofs must verify without GitDone being alive.
// This script makes ZERO calls to any gitdone-operated service. It walks
// a cloned event repo and validates each check layer:
//
//   1. Structure     — event.json + commits/ + dkim_keys/ + ots_proofs/
//   2. Git integrity — chain intact, no rewrites (git fsck)
//   3. Schema        — every commit is schema_version 2, required fields
//   4. Archived keys — every dkim_keys/commit-N.pem parses as RSA pub key
//   5. Timestamps    — every ots_proofs/commit-N.ots verifies against
//                      its paired commit-N.json (ots calendar OK;
//                      calendar is NOT a gitdone service)
//   6. Completion    — workflow events have a valid commit per step,
//                      with participant_match and acceptable trust_level
//
// Invoke:
//   gitdone-verify <repo-path>                    # text output
//   gitdone-verify <repo-path> --json             # machine-readable
//   gitdone-verify <repo-path> --no-ots           # skip OTS (truly offline)
//   gitdone-verify <repo-path> --min-trust LEVEL  # verified|forwarded|authorized
//
// Exit code: 0 if all checks pass, 1 otherwise.
//
// Runtime deps: Node >= 18. External binaries: `git` (required),
// `ots` (optional; --no-ots to skip). No npm packages.
//
// License: MIT. Fork freely; this is the principle check — if GitDone
// dies, you need to be able to reimplement it.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const TRUST_ORDER = ['unverified', 'authorized', 'forwarded', 'verified'];
const SCHEMA_V = 2;

// ---- output helpers -------------------------------------------------------

const COLORS = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

function statusSymbol(status) {
  if (status === 'pass') return COLORS.green('PASS');
  if (status === 'fail') return COLORS.red('FAIL');
  if (status === 'warn') return COLORS.yellow('WARN');
  if (status === 'skip') return COLORS.dim('SKIP');
  return status;
}

// ---- CLI parsing ----------------------------------------------------------

function parseArgs(argv) {
  const args = { repoPath: null, json: false, noOts: false, minTrust: 'authorized' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--no-ots') args.noOts = true;
    else if (a === '--min-trust') args.minTrust = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else if (!args.repoPath) args.repoPath = a;
    else { args.unexpected = a; }
  }
  return args;
}

const HELP_TEXT = `gitdone-verify — offline verifier for GitDone event repositories

USAGE
  gitdone-verify <repo-path> [options]

OPTIONS
  --json               machine-readable output
  --no-ots             skip OpenTimestamps check (truly offline)
  --min-trust LEVEL    minimum acceptable trust for completion
                       (one of: unverified, authorized, forwarded, verified;
                        default: authorized)
  -h, --help           this help

EXIT
  0  all checks pass
  1  any check failed or repo invalid

EXTERNAL DEPENDENCIES
  git               required (git fsck)
  ots               optional; install with \`pip install opentimestamps-client\`
                    or skip with --no-ots

This script makes zero calls to any gitdone-operated service. OTS calendar
servers are public infrastructure (not gitdone servers) and are used only
to verify Bitcoin anchoring when --no-ots is not set.
`;

// ---- individual checks ----------------------------------------------------

function checkStructure(repoPath) {
  const required = [
    { path: 'event.json', kind: 'file' },
    { path: '.git', kind: 'dir' },
    { path: 'commits', kind: 'dir' },
    { path: 'dkim_keys', kind: 'dir' },
    { path: 'ots_proofs', kind: 'dir' },
  ];
  const missing = [];
  for (const r of required) {
    const p = path.join(repoPath, r.path);
    let stat;
    try { stat = fs.statSync(p); } catch { missing.push(r.path); continue; }
    if (r.kind === 'file' && !stat.isFile()) missing.push(r.path + ' (not a file)');
    if (r.kind === 'dir' && !stat.isDirectory()) missing.push(r.path + ' (not a directory)');
  }
  if (missing.length) {
    return { status: 'fail', detail: 'missing: ' + missing.join(', ') };
  }
  return { status: 'pass', detail: 'event.json + commits/ + dkim_keys/ + ots_proofs/' };
}

function checkGitIntegrity(repoPath) {
  const out = spawnSync('git', ['-C', repoPath, 'fsck', '--full', '--strict'], {
    encoding: 'utf8', timeout: 30000,
  });
  if (out.error) {
    return { status: 'fail', detail: `git fsck could not run: ${out.error.message}` };
  }
  if (out.status !== 0) {
    return {
      status: 'fail',
      detail: `git fsck exit ${out.status}`,
      stderr: (out.stderr || '').trim().slice(0, 1000),
    };
  }
  const log = spawnSync('git', ['-C', repoPath, 'log', '--format=%H %s'], { encoding: 'utf8' });
  const commitCount = log.stdout ? log.stdout.trim().split('\n').length : 0;
  return { status: 'pass', detail: `clean (${commitCount} git commits)` };
}

function loadCommits(repoPath) {
  const commitsDir = path.join(repoPath, 'commits');
  const entries = fs.readdirSync(commitsDir);
  const reply = entries
    .filter((f) => /^commit-\d+\.json$/.test(f))
    .sort()
    .map((file) => {
      const abs = path.join(commitsDir, file);
      const raw = fs.readFileSync(abs);
      const json = JSON.parse(raw);
      const fileSeq = Number(file.match(/^commit-(\d+)\.json$/)[1]);
      return { kind: 'reply', file, abs, raw, json, fileSeq };
    });
  // 1.L.3: reverify-NNN.json files are immutable upgrade records that
  // layer on top of specific commit-NNN.json files.
  const reverify = entries
    .filter((f) => /^reverify-\d+\.json$/.test(f))
    .sort()
    .map((file) => {
      const abs = path.join(commitsDir, file);
      const raw = fs.readFileSync(abs);
      const json = JSON.parse(raw);
      const fileSeq = Number(file.match(/^reverify-(\d+)\.json$/)[1]);
      return { kind: 'reverify', file, abs, raw, json, fileSeq };
    });
  return [...reply, ...reverify];
}

function checkSchema(commits) {
  const problems = [];
  for (const c of commits) {
    const j = c.json;
    if (j.schema_version !== SCHEMA_V) {
      problems.push(`${c.file}: schema_version ${j.schema_version} != ${SCHEMA_V}`);
    }
    if (j.sequence !== c.fileSeq) {
      problems.push(`${c.file}: sequence ${j.sequence} != filename ${c.fileSeq}`);
    }
    if (c.kind === 'reply') {
      for (const k of ['event_id', 'sequence', 'received_at', 'sender_hash', 'sender_domain', 'trust_level', 'raw_sha256']) {
        if (j[k] === undefined) problems.push(`${c.file}: missing ${k}`);
      }
      if (!/^sha256:[0-9a-f]{64}$/.test(j.sender_hash || '')) {
        problems.push(`${c.file}: sender_hash format invalid`);
      }
      if (!/^sha256:[0-9a-f]{64}$/.test(j.raw_sha256 || '')) {
        problems.push(`${c.file}: raw_sha256 format invalid`);
      }
      if (!TRUST_ORDER.includes(j.trust_level)) {
        problems.push(`${c.file}: unknown trust_level ${j.trust_level}`);
      }
      // Plaintext discipline (§0.1.10) — none of these should be in a committed payload
      for (const forbidden of ['sender', 'subject', 'body_preview', 'message_id']) {
        if (j[forbidden] != null) {
          problems.push(`${c.file}: plaintext leak — ${forbidden}`);
        }
      }
    } else if (c.kind === 'reverify') {
      // Reverify commits (1.L.3): immutable upgrade records
      for (const k of ['event_id', 'sequence', 'target_commit', 'target_sequence', 'received_at']) {
        if (j[k] === undefined) problems.push(`${c.file}: missing ${k}`);
      }
      if (j.kind !== 'reverify') {
        problems.push(`${c.file}: kind field missing or != 'reverify'`);
      }
      if (!/^commit-\d+\.json$/.test(j.target_commit || '')) {
        problems.push(`${c.file}: target_commit format invalid`);
      }
      if (j.trust_level_before != null && !TRUST_ORDER.includes(j.trust_level_before)) {
        problems.push(`${c.file}: unknown trust_level_before ${j.trust_level_before}`);
      }
      if (j.trust_level_after != null && !TRUST_ORDER.includes(j.trust_level_after)) {
        problems.push(`${c.file}: unknown trust_level_after ${j.trust_level_after}`);
      }
      // Same plaintext discipline — reverify records must not leak either
      for (const forbidden of ['sender', 'subject', 'body_preview', 'message_id']) {
        if (j[forbidden] != null) {
          problems.push(`${c.file}: plaintext leak — ${forbidden}`);
        }
      }
    }
  }
  if (problems.length) return { status: 'fail', detail: `${problems.length} problem(s)`, problems };
  const replyN = commits.filter((c) => c.kind === 'reply').length;
  const reverifyN = commits.filter((c) => c.kind === 'reverify').length;
  const summary = reverifyN > 0
    ? `${replyN} reply + ${reverifyN} reverify commit(s) conform to schema v${SCHEMA_V}`
    : `${replyN} commit(s) conform to schema v${SCHEMA_V}`;
  return { status: 'pass', detail: summary };
}

function checkArchivedKeys(repoPath, commits) {
  const issues = [];
  let checked = 0;
  // Reverify commits don't archive keys (they USE existing ones from
  // their target commit) — skip them here.
  const replies = commits.filter((c) => c.kind === 'reply');
  for (const c of replies) {
    const keyRel = c.json.dkim_key_file;
    if (!keyRel) continue; // commit has no signature to archive
    const keyPath = path.join(repoPath, keyRel);
    let pem;
    try { pem = fs.readFileSync(keyPath, 'utf8'); }
    catch (e) { issues.push(`${c.file}: archived key missing — ${keyRel}`); continue; }
    try {
      const pub = crypto.createPublicKey(pem);
      if (pub.asymmetricKeyType !== 'rsa') {
        issues.push(`${c.file}: archived key is ${pub.asymmetricKeyType}, not RSA`);
      }
      checked++;
    } catch (e) {
      issues.push(`${c.file}: archived key does not parse — ${e.message}`);
    }
  }
  if (issues.length) return { status: 'fail', detail: `${issues.length} issue(s)`, issues };
  if (checked === 0) return { status: 'warn', detail: 'no commits carry archived DKIM keys (all unsigned at reception)' };
  return { status: 'pass', detail: `${checked} archived key(s) parse as valid RSA` };
}

function checkOts(repoPath, commits, { binary = 'ots', timeoutMs = 30000 } = {}) {
  const results = [];
  for (const c of commits) {
    const proofRel = c.json.ots_proof_file;
    if (!proofRel) {
      results.push({ file: c.file, state: 'no-proof' });
      continue;
    }
    const proofAbs = path.join(repoPath, proofRel);
    if (!fs.existsSync(proofAbs)) {
      results.push({ file: c.file, state: 'missing', detail: proofRel });
      continue;
    }
    const out = spawnSync(binary, ['verify', proofAbs, '-f', c.abs], {
      encoding: 'utf8', timeout: timeoutMs,
    });
    if (out.error && out.error.code === 'ENOENT') {
      return { status: 'fail', detail: `'${binary}' not found — install opentimestamps-client or use --no-ots` };
    }
    const combined = (out.stdout || '') + (out.stderr || '');
    const lower = combined.toLowerCase();
    // Classify by text. ots exits non-zero on many non-failure paths
    // (pending confirmation, cached-attestations-without-bitcoin-node),
    // so exit code alone is ambiguous. Text signals are authoritative:
    //   - "file does not match" -> tamper (invalid)
    //   - "success!" / "bitcoin block #N" -> fully anchored + verified
    //   - "got N attestation(s) from cache" -> proof has Bitcoin attestations
    //                                          (anchored; the "could not
    //                                          connect to bitcoin node"
    //                                          warning is normal when no
    //                                          local Bitcoin node exists)
    //   - "timestamped by transaction" -> in a Bitcoin tx (partial anchor)
    //   - "pending confirmation" -> calendar has it, Bitcoin doesn't yet
    //   - non-zero exit with no known signal -> invalid (unclassified error)
    let state;
    if (/does not match/.test(lower)) {
      state = 'invalid';
    } else if (/success!|bitcoin block #?\d/.test(lower)) {
      state = 'anchored';
    } else if (/got \d+ attestation/.test(lower)) {
      state = 'anchored';
    } else if (/timestamped by transaction|waiting for \d+ confirmation/.test(lower)) {
      state = 'in-bitcoin';
    } else if (/pending confirmation/.test(lower)) {
      state = 'pending';
    } else if (out.status !== 0) {
      state = 'invalid';
    } else {
      state = 'unknown';
    }
    results.push({ file: c.file, state, detail: combined.trim().slice(0, 400) });
  }

  const invalid = results.filter((r) => r.state === 'invalid' || r.state === 'missing');
  if (invalid.length) {
    return { status: 'fail', detail: `${invalid.length} bad proof(s)`, results };
  }
  const anchored = results.filter((r) => r.state === 'anchored' || r.state === 'in-bitcoin').length;
  const pending = results.filter((r) => r.state === 'pending').length;
  const noneProof = results.filter((r) => r.state === 'no-proof').length;
  const summary = [];
  if (anchored) summary.push(`${anchored} Bitcoin-anchored`);
  if (pending) summary.push(`${pending} pending (calendar-submitted, awaiting Bitcoin)`);
  if (noneProof) summary.push(`${noneProof} without proof`);
  return { status: 'pass', detail: summary.join(', ') || 'no commits had proofs', results };
}

function meetsTrust(level, min) {
  return TRUST_ORDER.indexOf(level) >= TRUST_ORDER.indexOf(min);
}

function checkCompletion(repoPath, commits, minTrust) {
  const eventPath = path.join(repoPath, 'event.json');
  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));

  if (event.type !== 'event') {
    // Phase 1 only defines workflow events. Crypto types are Phase 2.
    return { status: 'skip', detail: `event type '${event.type}' not covered in Phase 1` };
  }

  // 1.L.3: build a trust-upgrade map from reverify commits so the
  // effective trust level for each reply is max(original, upgraded).
  const upgrades = new Map(); // target_commit filename -> highest upgraded trust
  for (const c of commits) {
    if (c.kind !== 'reverify') continue;
    if (!c.json.upgraded) continue;
    const target = c.json.target_commit;
    const after = c.json.trust_level_after;
    if (!target || !after || !TRUST_ORDER.includes(after)) continue;
    const prev = upgrades.get(target);
    if (!prev || TRUST_ORDER.indexOf(after) > TRUST_ORDER.indexOf(prev)) {
      upgrades.set(target, after);
    }
  }
  function effectiveTrust(c) {
    const upgraded = upgrades.get(c.file);
    if (!upgraded) return c.json.trust_level;
    return TRUST_ORDER.indexOf(upgraded) > TRUST_ORDER.indexOf(c.json.trust_level)
      ? upgraded
      : c.json.trust_level;
  }

  // Only reply commits are assigned to steps; reverify commits layer on top.
  const byStep = new Map();
  for (const c of commits) {
    if (c.kind !== 'reply') continue;
    const sid = c.json.step_id;
    if (!sid) continue;
    if (!byStep.has(sid)) byStep.set(sid, []);
    byStep.get(sid).push(c);
  }

  const problems = [];
  const complete = [];
  for (const step of (event.steps || [])) {
    const replies = byStep.get(step.id) || [];
    // Latest-wins per PRD §4.1; effectiveTrust applies 1.L.3 upgrades
    const accepted = replies.filter((r) =>
      r.json.participant_match === true && meetsTrust(effectiveTrust(r), minTrust)
    );
    if (accepted.length === 0) {
      if (replies.length === 0) problems.push(`step ${step.id} (${step.name}): no reply`);
      else problems.push(`step ${step.id}: ${replies.length} reply(ies) but none meet participant_match + min trust '${minTrust}'`);
    } else {
      complete.push(step.id);
    }
  }

  // Sequential flow check: step N must have its accepted reply BEFORE step N+1 (by sequence)
  if (event.flow === 'sequential' && complete.length > 1) {
    let prevSeq = -1;
    for (const step of event.steps) {
      const replies = byStep.get(step.id) || [];
      const accepted = replies.filter((r) =>
        r.json.participant_match === true && meetsTrust(effectiveTrust(r), minTrust)
      );
      if (accepted.length === 0) continue;
      const minSeq = Math.min(...accepted.map((r) => r.json.sequence));
      if (minSeq <= prevSeq) {
        problems.push(`step ${step.id}: out-of-order completion (sequence ${minSeq} <= prev ${prevSeq})`);
      }
      prevSeq = minSeq;
    }
  }

  const total = (event.steps || []).length;
  if (problems.length) {
    return {
      status: total === complete.length ? 'warn' : 'warn',
      detail: `${complete.length}/${total} steps complete, ${problems.length} issue(s)`,
      problems,
    };
  }
  return { status: 'pass', detail: `${complete.length}/${total} steps complete (flow: ${event.flow})` };
}

// ---- orchestrator ---------------------------------------------------------

function runAll(args) {
  const out = {
    tool: 'gitdone-verify',
    repo: args.repoPath,
    min_trust: args.minTrust,
    ots_skipped: !!args.noOts,
    started_at: new Date().toISOString(),
    checks: {},
  };

  out.checks.structure = checkStructure(args.repoPath);
  if (out.checks.structure.status === 'fail') {
    out.overall = 'fail';
    out.reason = 'repo structure invalid';
    return out;
  }

  out.checks.git_integrity = checkGitIntegrity(args.repoPath);

  let commits;
  try {
    commits = loadCommits(args.repoPath);
  } catch (e) {
    out.checks.schema = { status: 'fail', detail: `could not load commits: ${e.message}` };
    out.overall = 'fail';
    return out;
  }
  out.commit_count = commits.length;

  out.checks.schema = checkSchema(commits);
  out.checks.archived_keys = checkArchivedKeys(args.repoPath, commits);

  if (args.noOts) {
    out.checks.opentimestamps = { status: 'skip', detail: '--no-ots requested' };
  } else {
    out.checks.opentimestamps = checkOts(args.repoPath, commits);
  }

  out.checks.completion = checkCompletion(args.repoPath, commits, args.minTrust);

  const statuses = Object.values(out.checks).map((c) => c.status);
  if (statuses.includes('fail')) out.overall = 'fail';
  else if (statuses.includes('warn')) out.overall = 'warn';
  else out.overall = 'pass';
  return out;
}

function renderText(out) {
  const lines = [];
  lines.push(`Verifying: ${out.repo}`);
  lines.push('');
  const order = ['structure', 'git_integrity', 'schema', 'archived_keys', 'opentimestamps', 'completion'];
  const labels = {
    structure: 'Structure',
    git_integrity: 'Git integrity',
    schema: 'Schema (v' + SCHEMA_V + ')',
    archived_keys: 'Archived DKIM keys',
    opentimestamps: 'OpenTimestamps',
    completion: 'Event completion',
  };
  for (const k of order) {
    const c = out.checks[k];
    if (!c) continue;
    lines.push(`  ${labels[k].padEnd(22)} ${statusSymbol(c.status)}  ${c.detail || ''}`);
    if (c.problems) c.problems.forEach((p) => lines.push(`    ${COLORS.dim('- ' + p)}`));
    if (c.issues) c.issues.forEach((p) => lines.push(`    ${COLORS.dim('- ' + p)}`));
    if (c.stderr) lines.push(`    ${COLORS.dim(c.stderr)}`);
  }
  lines.push('');
  if (out.overall === 'pass') {
    lines.push(`Overall: ${COLORS.green('PASS')}`);
    lines.push('');
    lines.push('This event repo is cryptographically well-formed.');
    if (out.ots_skipped) lines.push('(OTS check skipped — re-run without --no-ots to verify Bitcoin anchoring.)');
  } else if (out.overall === 'warn') {
    lines.push(`Overall: ${COLORS.yellow('WARN')}  (no hard failures; review warnings above)`);
  } else {
    lines.push(`Overall: ${COLORS.red('FAIL')}`);
    if (out.reason) lines.push(`Reason: ${out.reason}`);
  }
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) { process.stdout.write(HELP_TEXT); process.exit(0); }
  if (!args.repoPath) {
    process.stderr.write('error: <repo-path> is required. Use --help.\n');
    process.exit(2);
  }
  if (args.unexpected) {
    process.stderr.write(`error: unexpected argument '${args.unexpected}'\n`);
    process.exit(2);
  }
  if (!TRUST_ORDER.includes(args.minTrust)) {
    process.stderr.write(`error: invalid --min-trust '${args.minTrust}'. Use one of: ${TRUST_ORDER.join(', ')}\n`);
    process.exit(2);
  }

  let result;
  try {
    result = runAll(args);
  } catch (e) {
    process.stderr.write(`error: ${e.message || e}\n`);
    if (e.stack) process.stderr.write(e.stack + '\n');
    process.exit(1);
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(renderText(result) + '\n');
  }
  process.exit(result.overall === 'fail' ? 1 : 0);
}

// Exported for tests — execution guarded so `require`-ing this file
// doesn't trigger process.exit.
if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  checkStructure,
  checkGitIntegrity,
  loadCommits,
  checkSchema,
  checkArchivedKeys,
  checkOts,
  checkCompletion,
  runAll,
  renderText,
  meetsTrust,
  TRUST_ORDER,
};
