'use strict';

// 1.H.4 integration: POST /events mints a magic token, submits a
// management-link email via sendmail(1), and /manage/:token validates it.
// Uses a fake sendmail shell script (same pattern as forward.test.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const querystring = require('node:querystring');

let tmp;
let server;
let port;

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitdone-web-manage-'));
  const captureDir = path.join(tmp, 'captures');
  fs.mkdirSync(captureDir);
  const fake = path.join(tmp, 'fake-sendmail.sh');
  // Capture each invocation to a per-recipient file (By To: header).
  // Tests read the specific recipient's .eml rather than a single
  // shared file that gets overwritten.
  fs.writeFileSync(fake,
    `#!/bin/sh
body=$(mktemp "${captureDir}/body.XXXXXX")
args=$(mktemp "${captureDir}/args.XXXXXX")
echo "$@" > "$args"
cat > "$body"
to=$(grep -m1 -i '^To:' "$body" | sed 's/^[Tt]o:[[:space:]]*//' | tr -d '\\r')
safe=$(printf '%s' "$to" | sed 's/@/_at_/g' | tr -c 'a-zA-Z0-9._-' '_')
mv "$body" "${captureDir}/$safe.eml"
mv "$args" "${captureDir}/$safe.args"
exit 0
`, { mode: 0o755 });
  process.env.GITDONE_DATA_DIR = tmp;
  process.env.GITDONE_SENDMAIL_BIN = fake;
  process.env.GITDONE_PUBLIC_URL = 'http://localhost:3001';
  for (const m of [
    '../../src/config',
    '../../src/event-store',
    '../../src/magic-token',
    '../../src/outbound',
    '../../bin/server',
  ]) {
    delete require.cache[require.resolve(m)];
  }
  const { handle } = require('../../bin/server');
  await new Promise((resolve) => {
    server = http.createServer(handle);
    server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
  });
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
  delete process.env.GITDONE_SENDMAIL_BIN;
  delete process.env.GITDONE_PUBLIC_URL;
});

function post(p, form) {
  const data = querystring.stringify(form);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: p, method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(data),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'),
      }));
    }).on('error', reject);
  });
}

test('POST /events mints a magic token and sends management email', async () => {
  // Wait a tick so the "before" hook's fake-sendmail is ready; required
  // because sendmail is spawned asynchronously from the POST handler.
  const r = await post('/events', {
    title: 'Manage me', initiator: 'boss@example.com',
    step_name: 'Step 1', step_participant: 'one@example.com',
  });
  assert.equal(r.status, 200);
  assert.match(r.body, /Management link sent to boss@example\.com/);

  // A token file should exist on disk
  const tokensDir = path.join(tmp, 'magic_tokens');
  const files = await fsp.readdir(tokensDir);
  const tokenFile = files.find((f) => /^[a-f0-9]{32}\.json$/.test(f));
  assert.ok(tokenFile, 'magic token file created');
  const rec = JSON.parse(await fsp.readFile(path.join(tokensDir, tokenFile), 'utf8'));
  assert.equal(rec.initiator, 'boss@example.com');

  // The fake sendmail should have received the management email for the
  // initiator specifically. A step-1 notification also fires in parallel
  // to one@example.com; that's the 1.I participant email.
  const captureDir = path.join(tmp, 'captures');
  const bossCapture = path.join(captureDir, 'boss_at_example.com.eml');
  const bossArgs = path.join(captureDir, 'boss_at_example.com.args');
  const submitted = fs.readFileSync(bossCapture, 'utf8');
  assert.match(submitted, /^From: gitdone@/m);
  assert.match(submitted, /^To: boss@example\.com/m);
  assert.match(submitted, /^Subject: \[gitdone\] "Manage me"/m);
  assert.match(submitted, /http:\/\/localhost:3001\/manage\/[a-f0-9]{32}/);
  const argv = fs.readFileSync(bossArgs, 'utf8').trim().split(/\s+/);
  assert.ok(argv.includes('boss@example.com'), 'envelope RCPT is the initiator');
});

test('GET /manage/:token renders a valid management page', async () => {
  const r = await post('/events', {
    title: 'Link check', initiator: 'owner@example.com',
    step_name: 'A', step_participant: 'a@x.com',
  });
  assert.equal(r.status, 200);
  // Extract the token the handler minted by reading disk
  const tokensDir = path.join(tmp, 'magic_tokens');
  const files = await fsp.readdir(tokensDir);
  // There will be >1 token in the dir by now; pick the one for this event
  let token = null;
  for (const f of files) {
    const rec = JSON.parse(await fsp.readFile(path.join(tokensDir, f), 'utf8'));
    if (rec.initiator === 'owner@example.com') { token = rec.token; break; }
  }
  assert.ok(token, 'token for this event');
  const view = await get(`/manage/${token}`);
  assert.equal(view.status, 200);
  assert.match(view.body, /Link check/);
  assert.match(view.body, /Management link valid/);
  assert.match(view.body, /owner@example\.com/);
});

test('GET /manage/:token returns 404 for unknown / malformed token', async () => {
  const unknown = await get('/manage/' + 'f'.repeat(32));
  assert.equal(unknown.status, 404);
  assert.match(unknown.body, /Link invalid or expired/);

  const malformed = await get('/manage/not-a-token');
  assert.equal(malformed.status, 404);
});
