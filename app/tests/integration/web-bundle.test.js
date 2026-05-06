'use strict';

// Integration: dashboard download of the proof bundle.
//   - 200 + .tar.gz body for the signed-in initiator on an event with
//     commits
//   - 404 + plain text for an event with no commits yet
//   - 403 for a signed-in non-initiator

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { mintSessionCookie, TEST_SECRET } = require('../helpers/mint-session');

let tmp, server, port;
const mintCookie = (email) => mintSessionCookie({ email, dataDir: tmp });

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitdone-web-bundle-'));
  process.env.GITDONE_DATA_DIR = tmp;
  process.env.GITDONE_SESSION_SECRET = TEST_SECRET;
  process.env.GITDONE_COOKIE_SECURE = '0';
  process.env.GITDONE_PUBLIC_URL = 'http://localhost:3001';
  for (const m of ['../../src/config', '../../src/event-store', '../../src/auth', '../../bin/server', '../../src/bundle', '../../src/gitrepo']) {
    delete require.cache[require.resolve(m)];
  }
  const { handle } = require('../../bin/server');
  await new Promise((resolve) => {
    server = http.createServer(handle);
    server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
  });
  // touch /manage to spin up knowless DB so mintCookie has a sessions table.
  await get('/manage');
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
  delete process.env.GITDONE_SESSION_SECRET;
  delete process.env.GITDONE_COOKIE_SECURE;
  delete process.env.GITDONE_PUBLIC_URL;
});

function rawGet(p, cookie) {
  return new Promise((resolve, reject) => {
    const opts = { host: '127.0.0.1', port, path: p };
    if (cookie) opts.headers = { cookie };
    http.get(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}
function get(p, cookie) { return rawGet(p, cookie).then((r) => ({ ...r, body: r.body.toString('utf8') })); }

async function writeEvent(id, ev) {
  const dir = path.join(tmp, 'events');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${id}.json`), JSON.stringify(ev, null, 2));
}

async function writeRepo(id) {
  const root = path.join(tmp, 'repos', id);
  await fsp.mkdir(path.join(root, '.git'), { recursive: true });
  await fsp.mkdir(path.join(root, 'commits'), { recursive: true });
  await fsp.writeFile(path.join(root, 'event.json'), JSON.stringify({ id, title: 'Bundle me' }) + '\n');
  await fsp.writeFile(path.join(root, 'commits', 'commit-001.json'), '{"sequence":1}\n');
}

test('GET /manage/event/:id/bundle returns a valid .tar.gz with event.json', async () => {
  const id = 'evbundle1';
  await writeEvent(id, {
    id, type: 'event', title: 'Bundle me', initiator: 'owner@example.com',
    activated_at: '2026-01-01T00:00:00Z', salt: 'salt-x',
    steps: [{ id: 'a', name: 'a', participant: 'a@x.com', status: 'pending', depends_on: [] }],
    min_trust_level: 'unverified',
  });
  await writeRepo(id);
  const cookie = mintCookie('owner@example.com');
  const r = await rawGet(`/manage/event/${id}/bundle`, cookie);
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/gzip');
  assert.match(r.headers['content-disposition'], /attachment; filename="gitdone-evbundle1-\d{8}\.tar\.gz"/);
  // gzip magic
  assert.equal(r.body[0], 0x1f);
  assert.equal(r.body[1], 0x8b);
  // List contents via system tar.
  const out = path.join(tmp, 'capture.tar.gz');
  await fsp.writeFile(out, r.body);
  const ls = spawnSync('tar', ['-tzf', out], { encoding: 'utf8' });
  assert.equal(ls.status, 0, `tar list failed: ${ls.stderr}`);
  const list = ls.stdout.split('\n').filter(Boolean);
  assert.ok(list.some((p) => p === 'evbundle1/event.json'),
    `expected evbundle1/event.json in list:\n${list.join('\n')}`);
  assert.ok(list.some((p) => p.startsWith('evbundle1/commits/')), 'expected commits/');
});

test('GET /manage/event/:id/bundle returns 404 + text for events with no repo', async () => {
  const id = 'evnobun1';
  await writeEvent(id, {
    id, type: 'event', title: 'No commits', initiator: 'owner2@example.com',
    activated_at: '2026-01-01T00:00:00Z', salt: 'salt-y',
    steps: [{ id: 'a', name: 'a', participant: 'a@x.com', status: 'pending', depends_on: [] }],
    min_trust_level: 'unverified',
  });
  // No writeRepo() — this event never received a reply, so no audit trail.
  const cookie = mintCookie('owner2@example.com');
  const r = await get(`/manage/event/${id}/bundle`, cookie);
  assert.equal(r.status, 404);
  assert.match(r.headers['content-type'], /text\/plain/);
  assert.match(r.body, /no proof bundle yet/);
});

test('GET /manage/event/:id/bundle returns 403 for non-initiator session', async () => {
  const id = 'evbun403';
  await writeEvent(id, {
    id, type: 'event', title: 'private', initiator: 'mine@example.com',
    activated_at: '2026-01-01T00:00:00Z', salt: 'salt-z',
    steps: [{ id: 'a', name: 'a', participant: 'a@x.com', status: 'pending', depends_on: [] }],
    min_trust_level: 'unverified',
  });
  await writeRepo(id);
  // signed in as a DIFFERENT user
  const cookie = mintCookie('snoop@example.com');
  const r = await get(`/manage/event/${id}/bundle`, cookie);
  assert.equal(r.status, 403);
});

test('GET /manage/event/:id/bundle without a session redirects to /manage', async () => {
  const r = await get('/manage/event/evNoSession/bundle');
  assert.equal(r.status, 303);
  assert.match(r.headers.location, /\/manage\?next=/);
});

test('GET /manage/event/:id renders a Download proof bundle button when the repo has commits', async () => {
  const id = 'evbtn001';
  await writeEvent(id, {
    id, type: 'event', title: 'showbtn', initiator: 'btnowner@example.com',
    activated_at: '2026-01-01T00:00:00Z', salt: 'salt-b',
    steps: [{ id: 'a', name: 'a', participant: 'a@x.com', status: 'pending', depends_on: [] }],
    min_trust_level: 'unverified',
  });
  await writeRepo(id);
  // Need a real-looking commit listed by listCommits — so dump a JSON
  // file that the gitrepo loader reads in.
  const root = path.join(tmp, 'repos', id);
  await fsp.writeFile(path.join(root, 'commits', 'commit-001.json'),
    JSON.stringify({ sequence: 1, event_id: id, step_id: 'a', received_at: '2026-04-01T00:00:00Z' }, null, 2));
  const cookie = mintCookie('btnowner@example.com');
  const view = await get(`/manage/event/${id}`, cookie);
  assert.equal(view.status, 200);
  assert.match(view.body, /Download proof bundle/);
  assert.match(view.body, new RegExp(`/manage/event/${id}/bundle`));
});

test('GET /manage/event/:id email-commands box lists bundle+', async () => {
  const id = 'evlist01';
  await writeEvent(id, {
    id, type: 'event', title: 'listcmd', initiator: 'cmd@example.com',
    activated_at: '2026-01-01T00:00:00Z', salt: 'salt-c',
    steps: [{ id: 'a', name: 'a', participant: 'a@x.com', status: 'pending', depends_on: [] }],
    min_trust_level: 'unverified',
  });
  const cookie = mintCookie('cmd@example.com');
  const view = await get(`/manage/event/${id}`, cookie);
  assert.equal(view.status, 200);
  assert.match(view.body, new RegExp(`bundle\\+${id}@`));
});
