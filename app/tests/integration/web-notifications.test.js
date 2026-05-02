'use strict';

// 1.I integration — creating an event triggers participant notifications
// per flow/mode rules. Fake sendmail captures every message so we can
// assert per-recipient behaviour.
//
// Activation now happens on first dashboard visit by the initiator (Mode A
// magic-link flow); tests simulate that by minting a session cookie for
// the initiator's email and GETing /manage/event/:id. See activateAll().

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const querystring = require('node:querystring');
const { mintSessionCookie, TEST_SECRET } = require('../helpers/mint-session');

let tmp;
let server;
let port;
let capturesDir;

const mintCookie = (email) => mintSessionCookie({ email, dataDir: tmp });

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitdone-notify-'));
  capturesDir = path.join(tmp, 'captures');
  fs.mkdirSync(capturesDir);
  // Capture each sendmail invocation into its own file so we can inspect
  // what was sent to whom. The script greps the first To: header from
  // stdin and names the capture file after it.
  const fake = path.join(tmp, 'fake-sendmail.sh');
  fs.writeFileSync(fake,
    `#!/bin/sh
body=$(mktemp "${capturesDir}/msg.XXXXXX")
cat > "$body"
to=$(grep -m1 -i '^To:' "$body" | sed 's/^[Tt]o:[[:space:]]*//' | tr -d '\\r')
safe=$(printf '%s' "$to" | sed 's/@/_at_/g' | tr -c 'a-zA-Z0-9._-' '_')
# Each sendmail invocation gets its own file via mktemp on the dest path
# so concurrent sends to the same recipient don't overwrite each other.
out=$(mktemp "${capturesDir}/$safe.XXXXXX.eml")
mv "$body" "$out"
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
    '../../src/notifications',
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

function post(p, form) {
  if (p === '/events' && !form._action) form = { ...form, _action: 'confirm' };
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

async function clearCaptures() {
  const files = await fsp.readdir(capturesDir);
  await Promise.all(files.map((f) => fsp.unlink(path.join(capturesDir, f))));
}

// Events are created in pending-activation state; the initiator activates
// by visiting /manage/event/:id while signed in (Mode A flow — the magic
// link establishes the session, the dashboard visit fires the
// participant notifications). Tests simulate this by minting the cookie
// directly and GETing the dashboard.
function get(p, cookie) {
  return new Promise((resolve, reject) => {
    const opts = { host: '127.0.0.1', port, path: p };
    if (cookie) opts.headers = { cookie };
    http.get(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

async function activateAll() {
  const dir = path.join(tmp, 'events');
  let files = [];
  try { files = await fsp.readdir(dir); } catch { return; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const ev = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
    if (ev.activated_at) continue;
    await get(`/manage/event/${ev.id}`, mintCookie(ev.initiator));
  }
}

// Capture filenames are now <safe>.<random>.eml so concurrent sends to
// the same recipient each get their own file. Helpers prefix-match.
async function readCapture(toAddress) {
  const safe = toAddress.replace('@', '_at_').replace(/[^a-zA-Z0-9._-]/g, '_');
  const files = await fsp.readdir(capturesDir);
  const match = files.find((f) => f.startsWith(`${safe}.`) && f.endsWith('.eml'));
  if (!match) return null;
  try { return await fsp.readFile(path.join(capturesDir, match), 'utf8'); }
  catch { return null; }
}

async function capturedRecipients() {
  const files = await fsp.readdir(capturesDir);
  const set = new Set();
  for (const f of files) {
    if (!f.endsWith('.eml')) continue;
    // Strip ".XXXXXX.eml" suffix from the recipient stem.
    const stem = f.replace(/\.[a-zA-Z0-9]+\.eml$/, '');
    set.add(stem.replace('_at_', '@'));
  }
  return [...set];
}

test('chain of dependencies notifies only the root (step 1)', async () => {
  await clearCaptures();
  const r = await post('/events', {
    title: 'Chain',
    initiator: 'organiser@ex.com',
    step_name: ['one', 'two', 'three'],
    step_participant: ['one@ex.com', 'two@ex.com', 'three@ex.com'],
    // step 2 depends on 1, step 3 depends on 2 → chain
    step_depends_on: ['', '1', '2'],
  });
  assert.equal(r.status, 200);
  await activateAll();
  const recipients = await capturedRecipients();
  assert.ok(recipients.includes('organiser@ex.com'));
  assert.ok(recipients.includes('one@ex.com'));
  assert.ok(!recipients.includes('two@ex.com'));
  assert.ok(!recipients.includes('three@ex.com'));

  const step1 = await readCapture('one@ex.com');
  assert.match(step1, /Your step: one \(step 1 of 3\)/);
  assert.match(step1, /event\+[a-z0-9]{12}-one@/);
});

test('no-dependency (all root) workflow notifies every step', async () => {
  await clearCaptures();
  const r = await post('/events', {
    title: 'Parallel',
    initiator: 'nonseq@ex.com',
    step_name: ['a', 'b'],
    step_participant: ['a@ex.com', 'b@ex.com'],
    step_depends_on: ['', ''],
  });
  assert.equal(r.status, 200);
  await activateAll();
  const recipients = await capturedRecipients();
  assert.ok(recipients.includes('a@ex.com'));
  assert.ok(recipients.includes('b@ex.com'));
});

test('declaration notifies the designated signer', async () => {
  await clearCaptures();
  const r = await post('/crypto', {
    mode: 'declaration',
    title: 'Witness',
    initiator: 'me@ex.com',
    signer: 'witness@ex.com',
  });
  assert.equal(r.status, 200);
  await activateAll();
  const recipients = await capturedRecipients();
  assert.ok(recipients.includes('witness@ex.com'));
  const msg = await readCapture('witness@ex.com');
  assert.match(msg, /me@ex\.com asked you to sign/);
  // reply-to is the crypto (no step suffix) address
  assert.match(msg, /event\+[a-z0-9]{12}@/);
  assert.doesNotMatch(msg, /event\+[a-z0-9]{12}-/);
});

test('attestation does NOT notify anyone besides the initiator', async () => {
  await clearCaptures();
  const r = await post('/crypto', {
    mode: 'attestation',
    title: 'Peer review',
    initiator: 'chair@ex.com',
    threshold: '5',
    dedup: 'unique',
  });
  assert.equal(r.status, 200);
  const recipients = await capturedRecipients();
  // Only the management email to the initiator; attestation has no
  // pre-known signer list, so nobody else gets notified.
  assert.deepEqual(recipients, ['chair@ex.com']);
});

// Regression: two concurrent dashboard visits to a pending event must
// activate it once and notify each step participant exactly once.
// Without the per-event mutex in event-store.activateEvent, both
// requests would observe `!activated_at` and both would fire.
test('concurrent first-visit dashboard requests activate exactly once', async () => {
  await clearCaptures();
  const r = await post('/events', {
    title: 'Race',
    initiator: 'race@ex.com',
    step_name: ['onlystep'],
    step_participant: ['race-participant@ex.com'],
    step_depends_on: [''],
  });
  assert.equal(r.status, 200);
  // Find the event we just created (filter by initiator — readdir order
  // isn't guaranteed and earlier tests left events in the dir).
  const eventFiles = await fsp.readdir(path.join(tmp, 'events'));
  let ev;
  for (const f of eventFiles) {
    const candidate = JSON.parse(await fsp.readFile(path.join(tmp, 'events', f), 'utf8'));
    if (candidate.initiator === 'race@ex.com') { ev = candidate; break; }
  }
  assert.ok(ev, 'event was created');
  // Drop the magic-link capture so we only count post-activation sends.
  await clearCaptures();
  const cookie = mintCookie('race@ex.com');
  // Fire ten concurrent dashboard GETs for the same pending event.
  await Promise.all(Array.from({ length: 10 }, () => get(`/manage/event/${ev.id}`, cookie)));
  const captures = await fsp.readdir(capturesDir);
  const stepCaptures = captures.filter((f) => f.startsWith('race-participant_at_ex.com.') && f.endsWith('.eml'));
  assert.equal(stepCaptures.length, 1, `expected exactly one notification, got ${stepCaptures.length} (all: ${captures.join(', ')})`);
});
