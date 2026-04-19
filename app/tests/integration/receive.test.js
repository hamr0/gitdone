'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const RECEIVE = path.join(__dirname, '..', '..', 'bin', 'receive.js');

function runReceive(emlBuffer, envelopeArgs = [], extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      // file logging disabled — stdout only, easy to capture
      GITDONE_LOG_FILE: '',
      GITDONE_LOG_STDOUT: 'true',
      ...extraEnv,
    };
    const proc = spawn('node', [RECEIVE, ...envelopeArgs], { env });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c) => { stdout += c.toString(); });
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.stdin.end(emlBuffer);
  });
}

const buildEml = (headers, body = 'hello\r\n') =>
  Buffer.from(headers.join('\r\n') + '\r\n\r\n' + body);

test('integration: unsigned email is accepted as unverified, fields parsed', async () => {
  const eml = buildEml([
    'From: alice@example.com',
    'To: test+demo-step1@git-done.com',
    'Subject: integration test',
    'Message-ID: <test-001@example.com>',
    'Date: Fri, 17 Apr 2026 10:00:00 +0000',
  ]);
  const { code, stdout, stderr } = await runReceive(eml, [
    '198.51.100.1', 'mta.example.com', 'alice@example.com', 'test+demo-step1@git-done.com',
  ]);
  assert.equal(code, 0, `non-zero exit. stderr: ${stderr}`);
  const out = JSON.parse(stdout.trim());
  assert.equal(out.accepted, true);
  assert.equal(out.trust_level, 'unverified'); // unsigned
  assert.equal(out.from, 'alice@example.com');
  assert.equal(out.subject, 'integration test');
  assert.equal(out.envelope.client_ip, '198.51.100.1');
  assert.equal(out.envelope.recipient, 'test+demo-step1@git-done.com');
  assert.match(out.raw_sha256, /^sha256:[a-f0-9]{64}$/);
});

test('integration: Auto-Submitted is rejected, no DKIM work performed', async () => {
  const eml = buildEml([
    'From: ooo@example.com',
    'To: test@git-done.com',
    'Auto-Submitted: auto-replied',
    'Subject: out of office',
  ]);
  const { code, stdout } = await runReceive(eml);
  assert.equal(code, 0);
  const out = JSON.parse(stdout.trim());
  assert.equal(out.accepted, false);
  assert.match(out.rejection_reason, /^auto-submitted/);
  assert.equal(out.from, 'ooo@example.com');
});

test('integration: List-Id is rejected', async () => {
  const eml = buildEml([
    'From: announce@example.com',
    'To: test@git-done.com',
    'List-Id: <announce.example.com>',
    'Subject: announcement',
  ]);
  const { code, stdout } = await runReceive(eml);
  assert.equal(code, 0);
  const out = JSON.parse(stdout.trim());
  assert.equal(out.accepted, false);
  assert.match(out.rejection_reason, /mailing list/);
});

test('integration: noreply@ sender is rejected', async () => {
  const eml = buildEml([
    'From: noreply@bigservice.com',
    'To: test@git-done.com',
    'Subject: reset',
  ]);
  const { code, stdout } = await runReceive(eml);
  assert.equal(code, 0);
  const out = JSON.parse(stdout.trim());
  assert.equal(out.accepted, false);
  assert.match(out.rejection_reason, /system sender/);
});

test('integration: empty stdin exits 2', async () => {
  const { code, stderr } = await runReceive(Buffer.alloc(0));
  assert.equal(code, 2);
  assert.match(stderr, /empty stdin/);
});

test('integration: routing — matched event, matched step, matched participant', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-int-'));
  try {
    await fs.mkdir(path.join(tmp, 'events'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'events', 'demo123.json'), JSON.stringify({
      id: 'demo123', type: 'event', salt: 'test-salt-demo123',
      steps: [{ id: 'step1', participant: 'legal@example.com', status: 'pending', depends_on: [] }],
    }));
    const eml = buildEml([
      'From: legal@example.com',
      'To: event+demo123-step1@git-done.com',
      'Subject: routing happy path',
    ]);
    const { code, stdout } = await runReceive(
      eml,
      ['198.51.100.1', 'mta.example.com', 'legal@example.com', 'event+demo123-step1@git-done.com'],
      { GITDONE_DATA_DIR: tmp }
    );
    assert.equal(code, 0);
    const out = JSON.parse(stdout.trim());
    assert.equal(out.routing.address_kind, 'event');
    assert.equal(out.routing.event_id, 'demo123');
    assert.equal(out.routing.step_id, 'step1');
    assert.equal(out.routing.matched, true);
    assert.equal(out.routing.step_found, true);
    assert.equal(out.routing.participant_match, true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('integration: routing — known event, sender does NOT match step participant', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-int-'));
  try {
    await fs.mkdir(path.join(tmp, 'events'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'events', 'demo456.json'), JSON.stringify({
      id: 'demo456', salt: 'test-salt-demo456',
      steps: [{ id: 'step1', participant: 'expected@example.com' }],
    }));
    const eml = buildEml([
      'From: imposter@evil.com',
      'To: event+demo456-step1@git-done.com',
      'Subject: wrong sender',
    ]);
    const { code, stdout } = await runReceive(
      eml,
      ['1.2.3.4', 'evil.com', 'imposter@evil.com', 'event+demo456-step1@git-done.com'],
      { GITDONE_DATA_DIR: tmp }
    );
    assert.equal(code, 0);
    const out = JSON.parse(stdout.trim());
    // Accepted (we never reject on routing); flagged via participant_match=false
    assert.equal(out.accepted, true);
    assert.equal(out.routing.matched, true);
    assert.equal(out.routing.step_found, true);
    assert.equal(out.routing.participant_match, false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('integration: routing — unknown event id', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-int-'));
  try {
    await fs.mkdir(path.join(tmp, 'events'), { recursive: true });
    const eml = buildEml([
      'From: a@b.com',
      'To: event+ghost-step1@git-done.com',
      'Subject: ghost event',
    ]);
    const { code, stdout } = await runReceive(
      eml,
      ['1.1.1.1', 'b.com', 'a@b.com', 'event+ghost-step1@git-done.com'],
      { GITDONE_DATA_DIR: tmp }
    );
    assert.equal(code, 0);
    const out = JSON.parse(stdout.trim());
    assert.equal(out.routing.address_kind, 'event');
    assert.equal(out.routing.event_id, 'ghost');
    assert.equal(out.routing.matched, false);
    assert.equal(out.routing.step_found, null);
    assert.equal(out.routing.participant_match, null);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('integration: routing — non-event address (plain "test@") leaves routing fields null', async () => {
  const eml = buildEml([
    'From: a@b.com',
    'To: test@git-done.com',
    'Subject: untagged',
  ]);
  const { code, stdout } = await runReceive(
    eml,
    ['1.1.1.1', 'b.com', 'a@b.com', 'test@git-done.com']
  );
  assert.equal(code, 0);
  const out = JSON.parse(stdout.trim());
  assert.equal(out.routing.address_kind, null);
  assert.equal(out.routing.event_id, null);
  assert.equal(out.routing.matched, false);
});

test('integration: 1.C — matched reply is committed to event git repo', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-commit-'));
  try {
    await fs.mkdir(path.join(tmp, 'events'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'events', 'demoA.json'), JSON.stringify({
      id: 'demoA', title: 'Commit test',
      salt: 'test-salt-demoA',
      steps: [{ id: 'step1', participant: 'alice@ex.com' }],
    }));
    const eml = buildEml([
      'From: alice@ex.com',
      'To: event+demoA-step1@git-done.com',
      'Subject: 1.C commit test',
      'Message-ID: <c1@ex.com>',
    ]);
    const { code, stdout } = await runReceive(
      eml,
      ['198.51.100.9', 'mta.ex.com', 'alice@ex.com', 'event+demoA-step1@git-done.com'],
      { GITDONE_DATA_DIR: tmp }
    );
    assert.equal(code, 0);
    const out = JSON.parse(stdout.trim());
    assert.equal(out.accepted, true);
    assert.ok(out.git_commit, 'git_commit should be populated');
    assert.ok(out.git_commit.sha, 'commit sha present');
    assert.equal(out.git_commit.sequence, 1);
    assert.match(out.git_commit.file, /^commits\/commit-001\.json$/);

    // Inspect repo: should have 2 commits (init + reply)
    const simpleGit = require('simple-git');
    const repoDir = path.join(tmp, 'repos', 'demoA');
    const log = await simpleGit(repoDir).log();
    assert.equal(log.total, 2);
    assert.match(log.all[0].message, /^reply 001: demoA step step1/);

    // Read the commit metadata back
    const saved = JSON.parse(await fs.readFile(path.join(repoDir, 'commits', 'commit-001.json'), 'utf8'));
    assert.equal(saved.schema_version, 2);
    assert.equal(saved.event_id, 'demoA');
    assert.equal(saved.step_id, 'step1');
    // Principle §0.1.10 — no plaintext leaks in committed metadata
    assert.equal(saved.sender, undefined);
    assert.equal(saved.subject, undefined);
    assert.equal(saved.body_preview, undefined);
    assert.equal(saved.message_id, undefined);
    // But salted hash + domain survive
    assert.equal(saved.sender_domain, 'ex.com');
    assert.match(saved.sender_hash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(saved.participant_match, true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('integration: 1.C — second reply increments sequence', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-commit2-'));
  try {
    await fs.mkdir(path.join(tmp, 'events'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'events', 'demoB.json'), JSON.stringify({
      id: 'demoB', salt: 'test-salt-demoB', steps: [{ id: 'step1', participant: 'a@b.com' }],
    }));
    const env = { GITDONE_DATA_DIR: tmp };
    const mk = (msgId) => buildEml([
      'From: a@b.com',
      'To: event+demoB-step1@git-done.com',
      `Subject: seq test`,
      `Message-ID: <${msgId}@b.com>`,
    ]);
    const args = ['1.1.1.1', 'b.com', 'a@b.com', 'event+demoB-step1@git-done.com'];

    const r1 = await runReceive(mk('m1'), args, env);
    const r2 = await runReceive(mk('m2'), args, env);
    const o1 = JSON.parse(r1.stdout.trim());
    const o2 = JSON.parse(r2.stdout.trim());
    assert.equal(o1.git_commit.sequence, 1);
    assert.equal(o2.git_commit.sequence, 2);

    const simpleGit = require('simple-git');
    const log = await simpleGit(path.join(tmp, 'repos', 'demoB')).log();
    assert.equal(log.total, 3); // init + 2 replies
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('integration: 1.C — unknown event id → accepted, no commit', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-orphan-'));
  try {
    await fs.mkdir(path.join(tmp, 'events'), { recursive: true });
    const eml = buildEml([
      'From: who@example.com',
      'To: event+ghost-step1@git-done.com',
      'Subject: orphan',
    ]);
    const { code, stdout } = await runReceive(
      eml,
      ['1.1.1.1', 'ex.com', 'who@example.com', 'event+ghost-step1@git-done.com'],
      { GITDONE_DATA_DIR: tmp }
    );
    assert.equal(code, 0);
    const out = JSON.parse(stdout.trim());
    assert.equal(out.accepted, true);
    assert.equal(out.routing.matched, false);
    assert.equal(out.git_commit, null);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('integration: attachment hash is deterministic', async () => {
  // Two MIME emails carrying the same attachment bytes should hash the same.
  const boundary = 'BOUNDARY';
  const attachContent = Buffer.from('hello attachment world').toString('base64');
  const mkEml = (subject) => Buffer.from([
    'From: alice@example.com',
    'To: test@git-done.com',
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain',
    '',
    'see attached',
    '',
    `--${boundary}`,
    'Content-Type: text/plain; name="hello.txt"',
    'Content-Disposition: attachment; filename="hello.txt"',
    'Content-Transfer-Encoding: base64',
    '',
    attachContent,
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n'));

  const r1 = await runReceive(mkEml('first'));
  const r2 = await runReceive(mkEml('second'));
  const out1 = JSON.parse(r1.stdout.trim());
  const out2 = JSON.parse(r2.stdout.trim());
  assert.equal(out1.attachments.length, 1, 'expected one attachment');
  assert.equal(out2.attachments.length, 1);
  assert.equal(out1.attachments[0].sha256, out2.attachments[0].sha256, 'attachment hash should be deterministic');
});
