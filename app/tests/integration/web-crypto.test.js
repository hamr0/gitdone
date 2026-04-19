'use strict';

// 1.H.3 integration — GET /crypto/new, POST /crypto for declaration and
// attestation modes. Uses a fake sendmail (same pattern as web-manage).

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
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitdone-web-crypto-'));
  const fake = path.join(tmp, 'fake-sendmail.sh');
  fs.writeFileSync(fake, `#!/bin/sh\ncat > /dev/null\nexit 0\n`, { mode: 0o755 });
  process.env.GITDONE_DATA_DIR = tmp;
  process.env.GITDONE_SENDMAIL_BIN = fake;
  process.env.GITDONE_PUBLIC_URL = 'http://localhost:3001';
  for (const m of [
    '../../src/config',
    '../../src/event-store',
    '../../src/magic-token',
    '../../src/outbound',
    '../../src/web/validation',
    '../../bin/server',
  ]) { delete require.cache[require.resolve(m)]; }
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
        status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'),
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

test('GET / renders the landing with two CTAs', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.body, /data-variant-root="F"/);
  assert.match(r.body, /href="\/events\/new"[^>]*class="cell"/);
  assert.match(r.body, /href="\/crypto\/new"[^>]*class="cell"/);
});

test('GET /crypto/new renders the crypto form', async () => {
  const r = await get('/crypto/new');
  assert.equal(r.status, 200);
  assert.match(r.body, /Create a signed record/);
  assert.match(r.body, /name="mode"/);
  assert.match(r.body, /name="title"/);
  assert.match(r.body, /name="initiator"/);
  assert.match(r.body, /name="signer"/);
  assert.match(r.body, /name="threshold"/);
  assert.match(r.body, /name="dedup"/);
  assert.match(r.body, /name="allow_anonymous"/);
});

test('POST /crypto declaration mode creates an event with signer', async () => {
  const r = await post('/crypto', {
    mode: 'declaration',
    title: 'Witness statement',
    initiator: 'me@example.com',
    signer: 'witness@example.com',
  });
  assert.equal(r.status, 200);
  assert.match(r.body, /Declaration created/);
  const m = r.body.match(/ID: <code>([a-z0-9]{12})<\/code>/);
  assert.ok(m, 'event id rendered');
  const ev = JSON.parse(await fsp.readFile(path.join(tmp, 'events', `${m[1]}.json`), 'utf8'));
  assert.equal(ev.type, 'crypto');
  assert.equal(ev.mode, 'declaration');
  assert.equal(ev.signer, 'witness@example.com');
  assert.equal(ev.title, 'Witness statement');
  // signer must not pollute attestation fields
  assert.equal(ev.threshold, undefined);
  assert.equal(ev.dedup, undefined);
});

test('POST /crypto attestation mode creates event with threshold + dedup', async () => {
  const r = await post('/crypto', {
    mode: 'attestation',
    title: 'Peer review quorum',
    initiator: 'chair@example.com',
    threshold: '7',
    dedup: 'latest',
    allow_anonymous: 'on',
  });
  assert.equal(r.status, 200);
  assert.match(r.body, /Attestation created/);
  const m = r.body.match(/ID: <code>([a-z0-9]{12})<\/code>/);
  const ev = JSON.parse(await fsp.readFile(path.join(tmp, 'events', `${m[1]}.json`), 'utf8'));
  assert.equal(ev.type, 'crypto');
  assert.equal(ev.mode, 'attestation');
  assert.equal(ev.threshold, 7);
  assert.equal(ev.dedup, 'latest');
  assert.equal(ev.allow_anonymous, true);
  assert.deepEqual(ev.replies, []);
  // attestation must not leak a signer field
  assert.equal(ev.signer, undefined);
});

test('POST /crypto declaration without signer returns 422', async () => {
  const r = await post('/crypto', {
    mode: 'declaration',
    title: 't', initiator: 'a@b.com',
    // no signer
  });
  assert.equal(r.status, 422);
  assert.match(r.body, /signer/i);
});

test('POST /crypto attestation with bogus threshold or dedup returns 422', async () => {
  const r1 = await post('/crypto', {
    mode: 'attestation', title: 't', initiator: 'a@b.com',
    threshold: '-3', dedup: 'unique',
  });
  assert.equal(r1.status, 422);
  assert.match(r1.body, /threshold/);

  const r2 = await post('/crypto', {
    mode: 'attestation', title: 't', initiator: 'a@b.com',
    threshold: '5', dedup: 'bogus',
  });
  assert.equal(r2.status, 422);
  assert.match(r2.body, /dedup/);
});

test('POST /crypto unknown mode returns 422', async () => {
  const r = await post('/crypto', {
    mode: 'workflow', title: 't', initiator: 'a@b.com',
  });
  assert.equal(r.status, 422);
  assert.match(r.body, /mode/);
});

test('POST /crypto generates a magic token the same way as events', async () => {
  const r = await post('/crypto', {
    mode: 'attestation', title: 'with link', initiator: 'owner@example.com',
    threshold: '3', dedup: 'unique',
  });
  assert.equal(r.status, 200);
  assert.match(r.body, /Management link sent to owner@example\.com/);
  const tokens = await fsp.readdir(path.join(tmp, 'magic_tokens'));
  assert.ok(tokens.some((f) => /^[a-f0-9]{32}\.json$/.test(f)));
});
