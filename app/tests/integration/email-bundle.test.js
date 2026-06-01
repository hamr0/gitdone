'use strict';

// Integration: bundle+<id>@ email command. The initiator emails the
// command, receive.js packages the per-event repo as .tar.gz, and the
// reply contains the archive as a base64 attachment with the right
// Content-Type / Content-Disposition.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const RECEIVE = path.join(__dirname, '..', '..', 'bin', 'receive.js');

function runReceive(emlBuffer, envelopeArgs, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      GITDONE_LOG_FILE: '',
      GITDONE_LOG_STDOUT: 'true',
      GITDONE_OTS_BIN: '/nonexistent/ots',
      ...extraEnv,
    };
    const proc = spawn('node', [RECEIVE, ...envelopeArgs], { env });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (c) => { stdout += c.toString(); });
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.stdin.end(emlBuffer);
  });
}

function makeFakeSendmail(tmp) {
  const captureDir = path.join(tmp, 'captures');
  fssync.mkdirSync(captureDir, { recursive: true });
  const fake = path.join(tmp, 'fake-sendmail.sh');
  fssync.writeFileSync(fake,
    `#!/bin/sh
body=$(mktemp "${captureDir}/msg.XXXXXX")
cat > "$body"
to=$(grep -m1 -i '^To:' "$body" | sed 's/^[Tt]o:[[:space:]]*//' | tr -d '\\r')
safe=$(printf '%s' "$to" | sed 's/@/_at_/g' | tr -c 'a-zA-Z0-9._-' '_')
mv "$body" "${captureDir}/$safe.$(date +%N).eml"
exit 0
`, { mode: 0o755 });
  return { fake, captureDir };
}

const buildEml = (headers, body = '\r\n') =>
  Buffer.from(headers.join('\r\n') + '\r\n\r\n' + body);

async function capturesFor(dir, toAddress) {
  const safe = toAddress.replace('@', '_at_').replace(/[^a-zA-Z0-9._-]/g, '_');
  const all = await fs.readdir(dir);
  const mine = all.filter((f) => f.startsWith(`${safe}.`) && f.endsWith('.eml'));
  const bodies = [];
  for (const f of mine) bodies.push(await fs.readFile(path.join(dir, f)));
  return bodies;
}

async function fakeRepo(tmp, id) {
  const root = path.join(tmp, 'repos', id);
  await fs.mkdir(path.join(root, '.git'), { recursive: true });
  await fs.mkdir(path.join(root, 'commits'), { recursive: true });
  await fs.mkdir(path.join(root, 'dkim_keys'), { recursive: true });
  await fs.mkdir(path.join(root, 'ots_proofs'), { recursive: true });
  await fs.writeFile(path.join(root, 'event.json'),
    JSON.stringify({ id, title: 'bundle me' }, null, 2) + '\n');
  await fs.writeFile(path.join(root, 'commits', 'commit-001.json'),
    JSON.stringify({ sequence: 1, hello: 'world' }) + '\n');
}

// Pull the base64 attachment out of a multipart MIME message and return
// it as a Buffer of decoded bytes. Returns null if the part isn't found.
function extractAttachment(rawBuf) {
  const raw = rawBuf.toString('binary');
  const ctMatch = raw.match(/Content-Type: multipart\/mixed; boundary="([^"]+)"/i);
  if (!ctMatch) return null;
  const boundary = ctMatch[1];
  const parts = raw.split(`--${boundary}`);
  for (const part of parts) {
    if (!/Content-Disposition: attachment/i.test(part)) continue;
    if (!/Content-Transfer-Encoding: base64/i.test(part)) continue;
    // Body starts after the first blank line in the part.
    const idx = part.indexOf('\r\n\r\n');
    if (idx < 0) continue;
    const b64 = part.slice(idx + 4).replace(/[^A-Za-z0-9+/=]/g, '');
    return Buffer.from(b64, 'base64');
  }
  return null;
}

test('bundle+ from initiator: replies with .tar.gz attachment', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-bundle-email-'));
  try {
    const { fake, captureDir } = makeFakeSendmail(tmp);
    await fs.mkdir(path.join(tmp, 'events'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'events', 'evbn001.json'), JSON.stringify({
      id: 'evbn001', type: 'event',
      min_trust_level: 'unverified',
      initiator: 'boss@ex.com', title: 'bundle test',
      salt: 'salt-bundle', activated_at: '2026-01-01T00:00:00Z',
      steps: [{ id: 'one', name: 'L', participant: 'l@ex.com', status: 'pending', depends_on: [] }],
    }));
    await fakeRepo(tmp, 'evbn001');

    const eml = buildEml([
      'From: boss@ex.com',
      'To: bundle+evbn001@git-done.com',
      'Subject: please bundle',
    ]);
    const r = await runReceive(eml,
      ['1.2.3.4', 'ex.com', 'boss@ex.com', 'bundle+evbn001@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r.code, 0, `receive failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.kind, 'initiator_command');
    assert.equal(out.command.command, 'bundle');
    assert.equal(out.command.authenticated, true);
    assert.equal(out.command.bundle_ok, true);
    assert.ok(out.command.bundle_size > 0);

    const replies = await capturesFor(captureDir, 'boss@ex.com');
    assert.equal(replies.length, 1);
    const raw = replies[0];
    const text = raw.toString('utf8');
    assert.match(text, /Subject: \[signedreply\] proof bundle — "bundle test"/);
    assert.match(text, /Content-Type: multipart\/mixed; boundary="gitdone_/);
    assert.match(text, /Content-Type: application\/gzip; name="gitdone-evbn001-\d{8}\.tar\.gz"/);
    assert.match(text, /Content-Disposition: attachment; filename="gitdone-evbn001-\d{8}\.tar\.gz"/);
    assert.match(text, /gitdone-verify evbn001/);

    // Decode the attachment and verify it's a real tar.gz containing
    // event.json from the per-event repo.
    const attBuf = extractAttachment(raw);
    assert.ok(attBuf, 'attachment payload extracted');
    assert.equal(attBuf[0], 0x1f);
    assert.equal(attBuf[1], 0x8b);
    const outFile = path.join(tmp, 'fromemail.tar.gz');
    await fs.writeFile(outFile, attBuf);
    const ls = spawnSync('tar', ['-tzf', outFile], { encoding: 'utf8' });
    assert.equal(ls.status, 0, `tar -tzf failed: ${ls.stderr}`);
    assert.match(ls.stdout, /evbn001\/event\.json/);
    assert.match(ls.stdout, /evbn001\/commits\//);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('bundle+ when no repo exists: replies with "no proof yet" body, no attachment', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-bundle-empty-'));
  try {
    const { fake, captureDir } = makeFakeSendmail(tmp);
    await fs.mkdir(path.join(tmp, 'events'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'events', 'evbn002.json'), JSON.stringify({
      id: 'evbn002', type: 'event',
      min_trust_level: 'unverified',
      initiator: 'boss@ex.com', title: 'no commits yet',
      salt: 'salt-empty', activated_at: '2026-01-01T00:00:00Z',
      steps: [{ id: 'one', name: 'L', participant: 'l@ex.com', status: 'pending', depends_on: [] }],
    }));
    // No fakeRepo() — the audit trail is empty.

    const eml = buildEml([
      'From: boss@ex.com',
      'To: bundle+evbn002@git-done.com',
      'Subject: bundle',
    ]);
    const r = await runReceive(eml,
      ['1.2.3.4', 'ex.com', 'boss@ex.com', 'bundle+evbn002@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.command.bundle_ok, false);

    const replies = await capturesFor(captureDir, 'boss@ex.com');
    assert.equal(replies.length, 1);
    const text = replies[0].toString('utf8');
    assert.match(text, /Subject: \[signedreply\] no proof yet — "no commits yet"/);
    assert.match(text, /hasn't received any\s*\r?\nreplies/);
    assert.doesNotMatch(text, /Content-Disposition: attachment/);
    assert.doesNotMatch(text, /multipart\/mixed/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('bundle+ from random sender: rejected, no attachment leaked', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-bundle-noauth-'));
  try {
    const { fake, captureDir } = makeFakeSendmail(tmp);
    await fs.mkdir(path.join(tmp, 'events'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'events', 'evbn003.json'), JSON.stringify({
      id: 'evbn003', type: 'event',
      min_trust_level: 'unverified',
      initiator: 'real@ex.com', title: 'private',
      salt: 'salt-na', activated_at: '2026-01-01T00:00:00Z',
      steps: [{ id: 'one', name: 'L', participant: 'l@ex.com', status: 'pending', depends_on: [] }],
    }));
    await fakeRepo(tmp, 'evbn003');
    const eml = buildEml([
      'From: snoop@elsewhere.com',
      'To: bundle+evbn003@git-done.com',
      'Subject: gimme',
    ]);
    const r = await runReceive(eml,
      ['1.2.3.4', 'elsewhere.com', 'snoop@elsewhere.com', 'bundle+evbn003@git-done.com'],
      { GITDONE_DATA_DIR: tmp, GITDONE_SENDMAIL_BIN: fake });
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.command.authenticated, false);
    const replies = await capturesFor(captureDir, 'snoop@elsewhere.com');
    assert.equal(replies.length, 1);
    const text = replies[0].toString('utf8');
    assert.match(text, /Command rejected/);
    assert.doesNotMatch(text, /Content-Disposition: attachment/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
