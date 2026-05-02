'use strict';

// Integration tests for session-gated management (Surface C).
// Session cookies are minted directly into the knowless DB using the
// same HMAC formulas knowless uses internally — no mock, no API reach-in.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const querystring = require('node:querystring');
const { mintSessionCookie, TEST_SECRET } = require('../helpers/mint-session');

let tmp, server, port;
const mintCookie = (email) => mintSessionCookie({ email, dataDir: tmp });

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitdone-web-manage-'));
  const captureDir = path.join(tmp, 'captures');
  fs.mkdirSync(captureDir);
  const fake = path.join(tmp, 'fake-sendmail.sh');
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
  process.env.GITDONE_SESSION_SECRET = TEST_SECRET;
  process.env.GITDONE_COOKIE_SECURE = '0';
  for (const m of [
    '../../src/config',
    '../../src/event-store',
    '../../src/auth',
    '../../src/outbound',
    '../../bin/server',
  ]) { delete require.cache[require.resolve(m)]; }
  const { handle } = require('../../bin/server');
  await new Promise((resolve) => {
    server = http.createServer(handle);
    server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
  });
  // Trigger getAuth() so the knowless DB is initialised before mintCookie().
  await get('/manage');
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
  delete process.env.GITDONE_SENDMAIL_BIN;
  delete process.env.GITDONE_PUBLIC_URL;
  delete process.env.GITDONE_SESSION_SECRET;
  delete process.env.GITDONE_COOKIE_SECURE;
});

function get(p, cookie) {
  return new Promise((resolve, reject) => {
    const opts = { host: '127.0.0.1', port, path: p };
    if (cookie) opts.headers = { cookie };
    http.get(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

function post(p, form, cookie) {
  if (p === '/events' && !form._action) form = { ...form, _action: 'confirm' };
  const data = querystring.stringify(form);
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(data) };
    if (cookie) headers.cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function postEmpty(p, cookie) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '0' };
    if (cookie) headers.cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers }, (res) => {
      resolve({ status: res.statusCode, headers: res.headers });
    });
    req.on('error', reject);
    req.end();
  });
}

async function latestEventFor(initiator) {
  const eventsDir = path.join(tmp, 'events');
  const files = await fsp.readdir(eventsDir);
  for (const f of files.slice().reverse()) {
    if (!f.endsWith('.json')) continue;
    try {
      const ev = JSON.parse(await fsp.readFile(path.join(eventsDir, f), 'utf8'));
      if (ev.initiator === initiator) return ev;
    } catch { /* skip */ }
  }
  return null;
}

test('POST /events sends a knowless magic link to the initiator', async () => {
  const r = await post('/events', {
    title: 'Manage me', initiator: 'boss@example.com',
    step_name: 'Step 1', step_participant: 'one@example.com',
  });
  assert.equal(r.status, 200);
  assert.match(r.body, /Check boss@example\.com/);

  const bossCapture = path.join(tmp, 'captures', 'boss_at_example.com.eml');
  const submitted = fs.readFileSync(bossCapture, 'utf8');
  // knowless owns the subject prefix; gitdone supplies "activate <title>"
  assert.match(submitted, /^Subject: \[gitdone\] activate "Manage me"/m);
  // Magic link is on /manage/callback, not on a gitdone-internal /activate path.
  assert.doesNotMatch(submitted, /\/activate\//);
  assert.match(submitted, /\/manage\/callback\?t=/);
});

test('GET /manage/:token redirects to /manage (backward compat for old bookmarked links)', async () => {
  const r = await get('/manage/' + 'a'.repeat(32));
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, '/manage');
});

test('GET /manage/event/:id redirects to /manage when not signed in', async () => {
  await post('/events', {
    title: 'Auth gate', initiator: 'authtest@example.com',
    step_name: 'A', step_participant: 'a@x.com',
  });
  const ev = await latestEventFor('authtest@example.com');
  assert.ok(ev);
  const r = await get(`/manage/event/${ev.id}`);
  assert.equal(r.status, 303);
  assert.match(r.headers.location, /\/manage/);
});

test('GET /manage/event/:id renders dashboard for signed-in owner', async () => {
  await post('/events', {
    title: 'Dashboard check', initiator: 'owner@example.com',
    step_name: ['legal', 'design'],
    step_participant: ['l@x.com', 'd@x.com'],
    step_deadline: ['', ''],
    step_depends_on: ['', '1'],
  });
  const ev = await latestEventFor('owner@example.com');
  assert.ok(ev);
  const cookie = mintCookie('owner@example.com');
  const view = await get(`/manage/event/${ev.id}`, cookie);
  assert.equal(view.status, 200);
  assert.match(view.body, /Dashboard check/);
  assert.match(view.body, /Signed in as/);
  assert.match(view.body, /owner@example\.com/);
  assert.match(view.body, /<table class="mg-steps">/);
  assert.match(view.body, /after #1/);
  assert.match(view.body, /⏸ waiting/);
  assert.match(view.body, /0 of 2 complete/);
});

test('GET /manage/event/:id returns 403 for wrong owner', async () => {
  const ev = await latestEventFor('owner@example.com');
  assert.ok(ev);
  const cookie = mintCookie('intruder@example.com');
  const r = await get(`/manage/event/${ev.id}`, cookie);
  assert.equal(r.status, 403);
});

test('POST /manage/event/:id/close flips state and redirects with flash', async () => {
  await post('/events', {
    title: 'close via dash', initiator: 'closer@example.com',
    step_name: 'a', step_participant: 'a@x.com',
  });
  const ev = await latestEventFor('closer@example.com');
  assert.ok(ev);
  const cookie = mintCookie('closer@example.com');
  const closeRes = await postEmpty(`/manage/event/${ev.id}/close`, cookie);
  assert.equal(closeRes.status, 303);
  assert.match(closeRes.headers.location, /\/manage\/event\/.+\?closed=1$/);

  const after = JSON.parse(await fsp.readFile(path.join(tmp, 'events', `${ev.id}.json`), 'utf8'));
  assert.equal(after.completion.status, 'complete');
  assert.equal(after.completion.closed_by, 'initiator');

  const view = await get(`/manage/event/${ev.id}?closed=1`, cookie);
  assert.match(view.body, /Event closed\./);
  assert.match(view.body, /class="mg-pill complete"/);
});
