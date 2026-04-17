'use strict';

// Tests for the offline gitdone-verify CLI.
//
// Each test builds a tiny fixture repo on disk (in os.tmpdir()) that
// mimics the shape of a real event repo enough to exercise one check
// function. OTS is NOT invoked in any test — we stub or bypass with
// --no-ots / checkOts(binary: '/bin/true') style fakes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  parseArgs,
  checkStructure,
  checkGitIntegrity,
  loadCommits,
  checkSchema,
  checkArchivedKeys,
  checkOts,
  checkCompletion,
  runAll,
  meetsTrust,
  TRUST_ORDER,
} = require('../gitdone-verify.js');

// ---- helpers --------------------------------------------------------------

function mkTmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdv-'));
  return dir;
}

function mkRepoStructure(dir) {
  fs.mkdirSync(path.join(dir, 'commits'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dkim_keys'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'ots_proofs'), { recursive: true });
  // minimal git repo
  spawnSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });
  spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@test'], { stdio: 'ignore' });
  spawnSync('git', ['-C', dir, 'config', 'user.name', 'test'], { stdio: 'ignore' });
  spawnSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false'], { stdio: 'ignore' });
}

function gitCommit(dir, msg = 'initial') {
  spawnSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
  spawnSync('git', ['-C', dir, 'commit', '-q', '-m', msg], { stdio: 'ignore' });
}

function sampleEvent(overrides = {}) {
  return {
    id: 'test-evt',
    type: 'event',
    flow: 'sequential',
    title: 'test',
    initiator: 'i@example.com',
    salt: '0'.repeat(64),
    steps: [
      { id: 'step1', name: 'First', participant: 'p1@example.com', status: 'pending' },
    ],
    ...overrides,
  };
}

function sampleCommit(overrides = {}) {
  return {
    schema_version: 2,
    event_id: 'test-evt',
    step_id: 'step1',
    sequence: 1,
    received_at: '2026-04-17T00:00:00Z',
    sender_hash: 'sha256:' + 'a'.repeat(64),
    sender_domain: 'example.com',
    message_id_hash: 'sha256:' + 'b'.repeat(64),
    trust_level: 'verified',
    participant_match: true,
    attachments: [],
    dkim: { signatures: [{ result: 'pass', domain: 'example.com', selector: 's', aligned: 'example.com' }] },
    spf: { result: 'pass' },
    dmarc: { result: 'pass' },
    arc: { result: 'none' },
    envelope: { client_ip: '127.0.0.1', client_helo: 'x' },
    raw_sha256: 'sha256:' + 'c'.repeat(64),
    raw_size: 100,
    dkim_key_file: null,
    ots_proof_file: null,
    ...overrides,
  };
}

// A valid minimal RSA public key PEM for archived-key tests.
function rsaPubPem() {
  const { publicKey } = require('node:crypto').generateKeyPairSync('rsa', { modulusLength: 2048 });
  return publicKey.export({ type: 'spki', format: 'pem' });
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- parseArgs ------------------------------------------------------------

test('parseArgs: positional repo path', () => {
  const r = parseArgs(['node', 'script', '/some/repo']);
  assert.equal(r.repoPath, '/some/repo');
  assert.equal(r.json, false);
});

test('parseArgs: flags', () => {
  const r = parseArgs(['node', 'script', '/repo', '--json', '--no-ots', '--min-trust', 'verified']);
  assert.equal(r.json, true);
  assert.equal(r.noOts, true);
  assert.equal(r.minTrust, 'verified');
});

test('parseArgs: help', () => {
  const r = parseArgs(['node', 'script', '--help']);
  assert.equal(r.help, true);
});

// ---- checkStructure --------------------------------------------------------

test('checkStructure: fails when event.json missing', () => {
  const d = mkTmpRepo();
  try {
    mkRepoStructure(d);
    // no event.json created
    const r = checkStructure(d);
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /event\.json/);
  } finally { cleanup(d); }
});

test('checkStructure: passes on well-formed repo', () => {
  const d = mkTmpRepo();
  try {
    mkRepoStructure(d);
    fs.writeFileSync(path.join(d, 'event.json'), '{}');
    const r = checkStructure(d);
    assert.equal(r.status, 'pass');
  } finally { cleanup(d); }
});

// ---- checkGitIntegrity -----------------------------------------------------

test('checkGitIntegrity: passes on clean tiny repo', () => {
  const d = mkTmpRepo();
  try {
    mkRepoStructure(d);
    fs.writeFileSync(path.join(d, 'event.json'), JSON.stringify(sampleEvent()));
    gitCommit(d, 'event created');
    const r = checkGitIntegrity(d);
    assert.equal(r.status, 'pass');
    assert.match(r.detail, /1 git commit/);
  } finally { cleanup(d); }
});

test('checkGitIntegrity: fails when dir is not a git repo', () => {
  const d = mkTmpRepo();
  try {
    // no git init
    const r = checkGitIntegrity(d);
    assert.equal(r.status, 'fail');
  } finally { cleanup(d); }
});

// ---- checkSchema -----------------------------------------------------------

test('checkSchema: passes on correct commits', () => {
  const d = mkTmpRepo();
  try {
    mkRepoStructure(d);
    fs.writeFileSync(path.join(d, 'commits', 'commit-001.json'), JSON.stringify(sampleCommit()));
    fs.writeFileSync(path.join(d, 'commits', 'commit-002.json'), JSON.stringify(sampleCommit({ sequence: 2 })));
    const commits = loadCommits(d);
    const r = checkSchema(commits);
    assert.equal(r.status, 'pass');
  } finally { cleanup(d); }
});

test('checkSchema: detects schema_version mismatch', () => {
  const d = mkTmpRepo();
  try {
    mkRepoStructure(d);
    fs.writeFileSync(path.join(d, 'commits', 'commit-001.json'), JSON.stringify(sampleCommit({ schema_version: 1 })));
    const r = checkSchema(loadCommits(d));
    assert.equal(r.status, 'fail');
    assert.ok(r.problems.some((p) => /schema_version/.test(p)));
  } finally { cleanup(d); }
});

test('checkSchema: detects plaintext leak (sender / subject / body_preview / message_id)', () => {
  const d = mkTmpRepo();
  try {
    mkRepoStructure(d);
    fs.writeFileSync(path.join(d, 'commits', 'commit-001.json'),
      JSON.stringify(sampleCommit({ sender: 'leak@example.com', subject: 'oops', body_preview: 'no' })));
    const r = checkSchema(loadCommits(d));
    assert.equal(r.status, 'fail');
    assert.ok(r.problems.some((p) => /plaintext leak — sender/.test(p)));
    assert.ok(r.problems.some((p) => /plaintext leak — subject/.test(p)));
    assert.ok(r.problems.some((p) => /plaintext leak — body_preview/.test(p)));
  } finally { cleanup(d); }
});

test('checkSchema: detects filename/sequence mismatch', () => {
  const d = mkTmpRepo();
  try {
    mkRepoStructure(d);
    fs.writeFileSync(path.join(d, 'commits', 'commit-001.json'), JSON.stringify(sampleCommit({ sequence: 99 })));
    const r = checkSchema(loadCommits(d));
    assert.equal(r.status, 'fail');
    assert.ok(r.problems.some((p) => /sequence 99 != filename 1/.test(p)));
  } finally { cleanup(d); }
});

test('checkSchema: detects invalid hash formats', () => {
  const d = mkTmpRepo();
  try {
    mkRepoStructure(d);
    fs.writeFileSync(path.join(d, 'commits', 'commit-001.json'),
      JSON.stringify(sampleCommit({ sender_hash: 'not-sha256', raw_sha256: 'bad' })));
    const r = checkSchema(loadCommits(d));
    assert.equal(r.status, 'fail');
    assert.ok(r.problems.some((p) => /sender_hash format/.test(p)));
    assert.ok(r.problems.some((p) => /raw_sha256 format/.test(p)));
  } finally { cleanup(d); }
});

test('checkSchema: detects invalid trust_level', () => {
  const d = mkTmpRepo();
  try {
    mkRepoStructure(d);
    fs.writeFileSync(path.join(d, 'commits', 'commit-001.json'),
      JSON.stringify(sampleCommit({ trust_level: 'super-verified' })));
    const r = checkSchema(loadCommits(d));
    assert.equal(r.status, 'fail');
    assert.ok(r.problems.some((p) => /trust_level super-verified/.test(p)));
  } finally { cleanup(d); }
});

// ---- checkArchivedKeys -----------------------------------------------------

test('checkArchivedKeys: passes when PEM parses as RSA', () => {
  const d = mkTmpRepo();
  try {
    mkRepoStructure(d);
    fs.writeFileSync(path.join(d, 'dkim_keys', 'commit-001.pem'), rsaPubPem());
    fs.writeFileSync(path.join(d, 'commits', 'commit-001.json'),
      JSON.stringify(sampleCommit({ dkim_key_file: 'dkim_keys/commit-001.pem' })));
    const r = checkArchivedKeys(d, loadCommits(d));
    assert.equal(r.status, 'pass');
  } finally { cleanup(d); }
});

test('checkArchivedKeys: fails when PEM is corrupt', () => {
  const d = mkTmpRepo();
  try {
    mkRepoStructure(d);
    fs.writeFileSync(path.join(d, 'dkim_keys', 'commit-001.pem'), 'not a real key');
    fs.writeFileSync(path.join(d, 'commits', 'commit-001.json'),
      JSON.stringify(sampleCommit({ dkim_key_file: 'dkim_keys/commit-001.pem' })));
    const r = checkArchivedKeys(d, loadCommits(d));
    assert.equal(r.status, 'fail');
    assert.ok(r.issues.some((i) => /does not parse/.test(i)));
  } finally { cleanup(d); }
});

test('checkArchivedKeys: fails when key file is claimed but missing', () => {
  const d = mkTmpRepo();
  try {
    mkRepoStructure(d);
    fs.writeFileSync(path.join(d, 'commits', 'commit-001.json'),
      JSON.stringify(sampleCommit({ dkim_key_file: 'dkim_keys/commit-001.pem' })));
    const r = checkArchivedKeys(d, loadCommits(d));
    assert.equal(r.status, 'fail');
    assert.ok(r.issues.some((i) => /archived key missing/.test(i)));
  } finally { cleanup(d); }
});

test('checkArchivedKeys: warn when no commits carry keys', () => {
  const d = mkTmpRepo();
  try {
    mkRepoStructure(d);
    fs.writeFileSync(path.join(d, 'commits', 'commit-001.json'),
      JSON.stringify(sampleCommit({ dkim_key_file: null })));
    const r = checkArchivedKeys(d, loadCommits(d));
    assert.equal(r.status, 'warn');
  } finally { cleanup(d); }
});

// ---- checkOts --------------------------------------------------------------

test('checkOts: fail when binary missing (friendly message)', () => {
  const d = mkTmpRepo();
  try {
    mkRepoStructure(d);
    fs.writeFileSync(path.join(d, 'ots_proofs', 'commit-001.ots'), 'fake');
    fs.writeFileSync(path.join(d, 'commits', 'commit-001.json'),
      JSON.stringify(sampleCommit({ ots_proof_file: 'ots_proofs/commit-001.ots' })));
    const r = checkOts(d, loadCommits(d), { binary: '/nonexistent/ots' });
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /install opentimestamps-client|--no-ots/);
  } finally { cleanup(d); }
});

test('checkOts: classifies tamper signal from stdout ("does not match")', () => {
  const d = mkTmpRepo();
  try {
    mkRepoStructure(d);
    fs.writeFileSync(path.join(d, 'ots_proofs', 'commit-001.ots'), 'stub');
    fs.writeFileSync(path.join(d, 'commits', 'commit-001.json'),
      JSON.stringify(sampleCommit({ ots_proof_file: 'ots_proofs/commit-001.ots' })));
    // Fake ots: a shell script that exits 1 and prints the tamper string
    const scriptPath = path.join(d, 'fake-ots.sh');
    fs.writeFileSync(scriptPath,
      `#!/bin/sh\necho "File does not match original!"\nexit 1\n`, { mode: 0o755 });
    const r = checkOts(d, loadCommits(d), { binary: scriptPath });
    assert.equal(r.status, 'fail');
    assert.ok(r.results.some((x) => x.state === 'invalid'));
  } finally { cleanup(d); }
});

test('checkOts: classifies anchored/in-bitcoin/pending from stdout', () => {
  const d = mkTmpRepo();
  try {
    mkRepoStructure(d);
    // three commits, each with its own "ots proof" and a fake script that
    // simulates the three non-tamper states
    for (const [i, text] of Object.entries({
      1: 'Success! Bitcoin block 870000',
      2: 'Calendar X: Timestamped by transaction abc; waiting for 6 confirmations',
      3: 'Calendar X: Pending confirmation in Bitcoin blockchain',
    })) {
      const idx = Number(i);
      const seq = String(idx).padStart(3, '0');
      fs.writeFileSync(path.join(d, 'ots_proofs', `commit-${seq}.ots`), 'stub');
      fs.writeFileSync(path.join(d, 'commits', `commit-${seq}.json`),
        JSON.stringify(sampleCommit({ sequence: idx, ots_proof_file: `ots_proofs/commit-${seq}.ots` })));
    }
    // fake ots that picks response based on -f filename arg (arg 4)
    // Invoked as: ots verify <proof> -f <commit.json>
    const fake = path.join(d, 'fake-ots.sh');
    fs.writeFileSync(fake, `#!/bin/sh
case "$4" in
  *commit-001.json) echo "Success! Bitcoin block 870000"; exit 0 ;;
  *commit-002.json) echo "Calendar X: Timestamped by transaction abc; waiting for 6 confirmations"; exit 1 ;;
  *commit-003.json) echo "Calendar X: Pending confirmation in Bitcoin blockchain"; exit 1 ;;
esac
`, { mode: 0o755 });
    const r = checkOts(d, loadCommits(d), { binary: fake });
    assert.equal(r.status, 'pass');
    const states = r.results.map((x) => x.state).sort();
    assert.deepEqual(states, ['anchored', 'in-bitcoin', 'pending']);
  } finally { cleanup(d); }
});

test('checkOts: fail when proof file claimed but missing', () => {
  const d = mkTmpRepo();
  try {
    mkRepoStructure(d);
    fs.writeFileSync(path.join(d, 'commits', 'commit-001.json'),
      JSON.stringify(sampleCommit({ ots_proof_file: 'ots_proofs/nope.ots' })));
    // Use /bin/true so we don't shell out to real ots
    const r = checkOts(d, loadCommits(d), { binary: '/bin/true' });
    assert.equal(r.status, 'fail');
    assert.ok(r.results.some((x) => x.state === 'missing'));
  } finally { cleanup(d); }
});

// ---- checkCompletion -------------------------------------------------------

test('checkCompletion: passes when all steps have accepted replies', () => {
  const d = mkTmpRepo();
  try {
    mkRepoStructure(d);
    const ev = sampleEvent({
      steps: [
        { id: 'step1', name: 'A', participant: 'p1@e.com', status: 'pending' },
        { id: 'step2', name: 'B', participant: 'p2@e.com', status: 'pending' },
      ],
    });
    fs.writeFileSync(path.join(d, 'event.json'), JSON.stringify(ev));
    fs.writeFileSync(path.join(d, 'commits', 'commit-001.json'),
      JSON.stringify(sampleCommit({ sequence: 1, step_id: 'step1', participant_match: true, trust_level: 'verified' })));
    fs.writeFileSync(path.join(d, 'commits', 'commit-002.json'),
      JSON.stringify(sampleCommit({ sequence: 2, step_id: 'step2', participant_match: true, trust_level: 'verified' })));
    const r = checkCompletion(d, loadCommits(d), 'verified');
    assert.equal(r.status, 'pass');
    assert.match(r.detail, /2\/2 steps/);
  } finally { cleanup(d); }
});

test('checkCompletion: warns when a step has no reply', () => {
  const d = mkTmpRepo();
  try {
    mkRepoStructure(d);
    const ev = sampleEvent({
      steps: [
        { id: 'step1', name: 'A', participant: 'p1@e.com', status: 'pending' },
        { id: 'step2', name: 'B', participant: 'p2@e.com', status: 'pending' },
      ],
    });
    fs.writeFileSync(path.join(d, 'event.json'), JSON.stringify(ev));
    fs.writeFileSync(path.join(d, 'commits', 'commit-001.json'),
      JSON.stringify(sampleCommit({ sequence: 1, step_id: 'step1', participant_match: true, trust_level: 'verified' })));
    const r = checkCompletion(d, loadCommits(d), 'verified');
    assert.equal(r.status, 'warn');
    assert.ok(r.problems.some((p) => /step2.*no reply/.test(p)));
  } finally { cleanup(d); }
});

test('checkCompletion: warns when reply fails participant_match', () => {
  const d = mkTmpRepo();
  try {
    mkRepoStructure(d);
    const ev = sampleEvent();
    fs.writeFileSync(path.join(d, 'event.json'), JSON.stringify(ev));
    fs.writeFileSync(path.join(d, 'commits', 'commit-001.json'),
      JSON.stringify(sampleCommit({ participant_match: false, trust_level: 'verified' })));
    const r = checkCompletion(d, loadCommits(d), 'verified');
    assert.equal(r.status, 'warn');
    assert.ok(r.problems.some((p) => /participant_match/.test(p)));
  } finally { cleanup(d); }
});

test('checkCompletion: --min-trust gates trust level', () => {
  const d = mkTmpRepo();
  try {
    mkRepoStructure(d);
    fs.writeFileSync(path.join(d, 'event.json'), JSON.stringify(sampleEvent()));
    fs.writeFileSync(path.join(d, 'commits', 'commit-001.json'),
      JSON.stringify(sampleCommit({ participant_match: true, trust_level: 'authorized' })));
    // authorized should pass default min_trust 'authorized'
    const r1 = checkCompletion(d, loadCommits(d), 'authorized');
    assert.equal(r1.status, 'pass');
    // authorized should NOT pass when min is 'verified'
    const r2 = checkCompletion(d, loadCommits(d), 'verified');
    assert.equal(r2.status, 'warn');
  } finally { cleanup(d); }
});

test('checkCompletion: detects sequential-flow out-of-order completion', () => {
  const d = mkTmpRepo();
  try {
    mkRepoStructure(d);
    const ev = sampleEvent({
      flow: 'sequential',
      steps: [
        { id: 'step1', name: 'A', participant: 'p1@e.com', status: 'pending' },
        { id: 'step2', name: 'B', participant: 'p2@e.com', status: 'pending' },
      ],
    });
    fs.writeFileSync(path.join(d, 'event.json'), JSON.stringify(ev));
    // step2 replied BEFORE step1 (sequence 1 vs 2)
    fs.writeFileSync(path.join(d, 'commits', 'commit-001.json'),
      JSON.stringify(sampleCommit({ sequence: 1, step_id: 'step2', participant_match: true, trust_level: 'verified' })));
    fs.writeFileSync(path.join(d, 'commits', 'commit-002.json'),
      JSON.stringify(sampleCommit({ sequence: 2, step_id: 'step1', participant_match: true, trust_level: 'verified' })));
    const r = checkCompletion(d, loadCommits(d), 'verified');
    assert.equal(r.status, 'warn');
    assert.ok(r.problems.some((p) => /out-of-order/.test(p)));
  } finally { cleanup(d); }
});

test('checkCompletion: skips when event type is not workflow', () => {
  const d = mkTmpRepo();
  try {
    mkRepoStructure(d);
    fs.writeFileSync(path.join(d, 'event.json'), JSON.stringify({ type: 'crypto', mode: 'declaration' }));
    const r = checkCompletion(d, [], 'verified');
    assert.equal(r.status, 'skip');
  } finally { cleanup(d); }
});

// ---- meetsTrust ------------------------------------------------------------

test('meetsTrust: orders trust levels correctly', () => {
  assert.equal(meetsTrust('verified', 'authorized'), true);
  assert.equal(meetsTrust('authorized', 'verified'), false);
  assert.equal(meetsTrust('verified', 'verified'), true);
  assert.equal(meetsTrust('unverified', 'authorized'), false);
});

test('TRUST_ORDER is monotonically increasing severity', () => {
  // unverified < authorized < forwarded < verified
  assert.deepEqual(TRUST_ORDER, ['unverified', 'authorized', 'forwarded', 'verified']);
});

// ---- runAll ----------------------------------------------------------------

test('runAll: fails fast when repo structure invalid', () => {
  const d = mkTmpRepo();
  try {
    // empty dir — no event.json, no git, etc.
    const r = runAll({ repoPath: d, minTrust: 'authorized', noOts: true });
    assert.equal(r.overall, 'fail');
    assert.equal(r.checks.structure.status, 'fail');
  } finally { cleanup(d); }
});

test('runAll: end-to-end pass on a complete synthetic repo', () => {
  const d = mkTmpRepo();
  try {
    mkRepoStructure(d);
    fs.writeFileSync(path.join(d, 'event.json'), JSON.stringify(sampleEvent()));
    fs.writeFileSync(path.join(d, 'dkim_keys', 'commit-001.pem'), rsaPubPem());
    fs.writeFileSync(path.join(d, 'commits', 'commit-001.json'),
      JSON.stringify(sampleCommit({
        dkim_key_file: 'dkim_keys/commit-001.pem',
        participant_match: true,
        trust_level: 'verified',
      })));
    gitCommit(d, 'fixture commit');
    const r = runAll({ repoPath: d, minTrust: 'verified', noOts: true });
    assert.equal(r.overall, 'pass');
    assert.equal(r.checks.structure.status, 'pass');
    assert.equal(r.checks.git_integrity.status, 'pass');
    assert.equal(r.checks.schema.status, 'pass');
    assert.equal(r.checks.archived_keys.status, 'pass');
    assert.equal(r.checks.opentimestamps.status, 'skip');
    assert.equal(r.checks.completion.status, 'pass');
  } finally { cleanup(d); }
});
