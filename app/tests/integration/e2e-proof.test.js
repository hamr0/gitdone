'use strict';

// End-to-end proof flow: create -> activate -> reply -> complete ->
// bundle download -> offline-verify. Exercises the full chain that
// produces a downloadable proof tarball and confirms gitdone-verify
// (with --no-ots so it stays offline) accepts the result.
//
// This is the "would have caught the accumulating-attestation OTS bug"
// regression: it walks the same code path a real user does, end to end,
// with no internal mocking past the sendmail capture and the receive.js
// envelope shim used by every other integration test.
//
// Notes on trust:
//   We pipe an UNSIGNED reply (no DKIM signature). That's why the event
//   is created with min_trust_level: 'unverified' and the verifier is
//   spawned with --min-trust unverified — the completion check needs
//   to accept a trust-level=unverified reply. The verifier's archived-
//   DKIM-keys check returns WARN (not PASS) under those conditions
//   because no commit carries an archived key; overall stays non-fail
//   (exit 0) because WARN is acceptable. If/when a DKIM-signed test
//   fixture is wired up, switch min_trust to 'verified' and the
//   archived-keys check will flip to PASS.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const querystring = require('node:querystring');
const { spawn, spawnSync } = require('node:child_process');
const { mintSessionCookie, TEST_SECRET } = require('../helpers/mint-session');

const RECEIVE = path.join(__dirname, '..', '..', 'bin', 'receive.js');
const VERIFY = path.join(__dirname, '..', '..', '..', 'tools', 'gitdone-verify', 'gitdone-verify.js');

// Strip ANSI color escapes so verifier output can be regex-matched.
const stripAnsi = (s) => s.replace(/\x1B\[[0-9;]*m/g, '');

let tmp, server, port, captureDir, fakeSendmail;
const mintCookie = (email) => mintSessionCookie({ email, dataDir: tmp });

function makeFakeSendmail(rootTmp) {
  const dir = path.join(rootTmp, 'captures');
  fs.mkdirSync(dir, { recursive: true });
  const fake = path.join(rootTmp, 'fake-sendmail.sh');
  // Counter prefix preserves arrival order so we can locate the proof
  // email even when several sends land in one HTTP request.
  fs.writeFileSync(fake,
    `#!/bin/sh
counter_file="${dir}/.counter"
n=$(cat "$counter_file" 2>/dev/null || echo 0)
n=$((n+1))
echo "$n" > "$counter_file"
body=$(mktemp "${dir}/${'$'}{n}_msg.XXXXXX")
cat > "$body"
to=$(grep -m1 -i '^To:' "$body" | sed 's/^[Tt]o:[[:space:]]*//' | tr -d '\\r')
safe=$(printf '%s' "$to" | sed 's/@/_at_/g' | tr -c 'a-zA-Z0-9._-' '_')
mv "$body" "${dir}/${'$'}{n}_${'$'}safe.eml"
exit 0
`, { mode: 0o755 });
  return { fake, dir };
}

function rawGet(p, cookie) {
  return new Promise((resolve, reject) => {
    const opts = { host: '127.0.0.1', port, path: p };
    if (cookie) opts.headers = { cookie };
    http.get(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    }).on('error', reject);
  });
}
const get = (p, cookie) => rawGet(p, cookie).then((r) => ({ ...r, body: r.body.toString('utf8') }));

function post(p, form, cookie) {
  if (p === '/events' && !form._action) form = { ...form, _action: 'confirm' };
  const data = querystring.stringify(form);
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    'content-length': Buffer.byteLength(data),
  };
  if (cookie) headers.cookie = cookie;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: p, method: 'POST', headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function pipeReply(emlBuffer, envelopeArgs) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      GITDONE_DATA_DIR: tmp,
      GITDONE_SENDMAIL_BIN: fakeSendmail,
      GITDONE_OTS_BIN: '/nonexistent/ots',
      GITDONE_LOG_FILE: '',
      GITDONE_LOG_STDOUT: 'true',
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

const buildEml = (headers, body = 'reply body\r\n') =>
  Buffer.from(headers.join('\r\n') + '\r\n\r\n' + body);

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitdone-e2e-'));
  const sm = makeFakeSendmail(tmp);
  fakeSendmail = sm.fake;
  captureDir = sm.dir;
  process.env.GITDONE_DATA_DIR = tmp;
  process.env.GITDONE_SENDMAIL_BIN = fakeSendmail;
  process.env.GITDONE_PUBLIC_URL = 'http://localhost:3001';
  process.env.GITDONE_SKIP_MX_CHECK = '1';
  process.env.GITDONE_SESSION_SECRET = TEST_SECRET;
  process.env.GITDONE_COOKIE_SECURE = '0';
  process.env.GITDONE_OTS_BIN = '/nonexistent/ots';
  for (const m of [
    '../../src/config',
    '../../src/event-store',
    '../../src/auth',
    '../../src/outbound',
    '../../src/notifications',
    '../../src/bundle',
    '../../src/gitrepo',
    '../../bin/server',
  ]) { delete require.cache[require.resolve(m)]; }
  const { handle } = require('../../bin/server');
  await new Promise((resolve) => {
    server = http.createServer(handle);
    server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
  });
  // Bootstrap knowless DB so mintCookie has a sessions table to insert into.
  await get('/manage');
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
  delete process.env.GITDONE_DATA_DIR;
  delete process.env.GITDONE_SENDMAIL_BIN;
  delete process.env.GITDONE_PUBLIC_URL;
  delete process.env.GITDONE_SKIP_MX_CHECK;
  delete process.env.GITDONE_SESSION_SECRET;
  delete process.env.GITDONE_COOKIE_SECURE;
  delete process.env.GITDONE_OTS_BIN;
});

test('end-to-end proof flow: create -> activate -> reply -> bundle -> offline verify', async (t) => {
  const initiator = 'owner@example.com';
  const participant = 'doer@example.com';

  await t.test('POST /events creates an unverified-trust workflow event', async () => {
    const r = await post('/events', {
      title: 'E2E proof',
      initiator,
      // Test reply is unsigned, so the event has to accept unverified
      // trust for completion. See the file header for context.
      min_trust_level: 'unverified',
      step_name: 'Sign off',
      step_participant: participant,
      step_deadline: '',
      step_depends_on: '',
    });
    assert.equal(r.status, 200);
    assert.match(r.body, /ID: <code>([a-z0-9]{12})<\/code>/);
  });

  // Locate the just-created event JSON. Only one event lives under
  // ${tmp}/events/ at this point, so a single readdir suffices.
  const eventsDir = path.join(tmp, 'events');
  const entries = (await fsp.readdir(eventsDir)).filter((f) => f.endsWith('.json'));
  assert.equal(entries.length, 1, `expected exactly one event JSON, got ${entries.join(', ')}`);
  const eventId = entries[0].replace(/\.json$/, '');
  const masterPath = path.join(eventsDir, `${eventId}.json`);
  const created = JSON.parse(await fsp.readFile(masterPath, 'utf8'));
  assert.equal(created.initiator, initiator);
  assert.equal(created.activated_at, null);
  assert.ok(created.activation_ack_token, 'event has an activation ack token');

  const cookie = mintCookie(initiator);

  await t.test('GET /manage/event/:id/confirmed flips activation_link_clicked_at', async () => {
    const r = await get(`/manage/event/${eventId}/confirmed?t=${created.activation_ack_token}`, cookie);
    assert.equal(r.status, 303);
    const after = JSON.parse(await fsp.readFile(masterPath, 'utf8'));
    assert.ok(after.activation_link_clicked_at, 'click timestamp recorded');
  });

  await t.test('POST /manage/event/:id/activate fires participant invites', async () => {
    const r = await post(`/manage/event/${eventId}/activate`, {}, cookie);
    // Activation either redirects (303) or renders (200) — both are
    // success; the real signal is activated_at on the event.
    assert.ok(r.status === 303 || r.status === 200, `unexpected status ${r.status}`);
    const after = JSON.parse(await fsp.readFile(masterPath, 'utf8'));
    assert.ok(after.activated_at, 'event activated_at set');
  });

  await t.test('participant reply via receive.js completes the event', async () => {
    const eml = buildEml([
      `From: ${participant}`,
      `To: event+${eventId}-sign-off@git-done.com`,
      'Subject: done',
    ]);
    const r = await pipeReply(eml, [
      '1.2.3.4', 'example.com', participant,
      `event+${eventId}-sign-off@git-done.com`,
    ]);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.completion.applied, true, JSON.stringify(out.completion));
    assert.equal(out.completion.completed_event, true);
  });

  await t.test('master event JSON shows complete and repo event.json mirrors it', async () => {
    const master = JSON.parse(await fsp.readFile(masterPath, 'utf8'));
    assert.equal(master.completion.status, 'complete');
    const repoEventPath = path.join(tmp, 'repos', eventId, 'event.json');
    const repoView = JSON.parse(await fsp.readFile(repoEventPath, 'utf8'));
    assert.equal(repoView.completion.status, 'complete');
    assert.equal(repoView.completion.completed_at, master.completion.completed_at);
    assert.equal(repoView.completion.commit_sequence, master.completion.commit_sequence);
  });

  await t.test('proof email composed to the initiator', async () => {
    const captures = await fsp.readdir(captureDir);
    const ownerStem = initiator.replace('@', '_at_');
    const ownerCaps = captures.filter((n) => n.endsWith(`_${ownerStem}.eml`));
    assert.ok(ownerCaps.length, `no captures to ${initiator}: ${captures.join(', ')}`);
    let proof = '';
    for (const f of ownerCaps) {
      const txt = await fsp.readFile(path.join(captureDir, f), 'utf8');
      if (/Subject: \[gitdone\] proof — /.test(txt)) { proof = txt; break; }
    }
    assert.ok(proof, 'proof-subject email captured for organiser');
    assert.match(proof, new RegExp(`gitdone-verify ${eventId}`));
  });

  let bundleBytes;
  await t.test('GET /manage/event/:id/bundle returns a .tar.gz attachment', async () => {
    const r = await rawGet(`/manage/event/${eventId}/bundle`, cookie);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'application/gzip');
    assert.match(r.headers['content-disposition'],
      new RegExp(`attachment; filename="gitdone-${eventId}-\\d{8}\\.tar\\.gz"`));
    assert.equal(r.body[0], 0x1f);
    assert.equal(r.body[1], 0x8b);
    bundleBytes = r.body;
  });

  await t.test('bundle tar contains event.json, commits, and dkim_keys entries', async () => {
    const out = path.join(tmp, 'bundle.tar.gz');
    await fsp.writeFile(out, bundleBytes);
    const ls = spawnSync('tar', ['-tzf', out], { encoding: 'utf8' });
    assert.equal(ls.status, 0, `tar list failed: ${ls.stderr}`);
    const list = ls.stdout.split('\n').filter(Boolean);
    assert.ok(list.includes(`${eventId}/event.json`),
      `expected ${eventId}/event.json in:\n${list.join('\n')}`);
    assert.ok(list.some((p) => p === `${eventId}/commits/commit-001.json`),
      `expected ${eventId}/commits/commit-001.json in:\n${list.join('\n')}`);
    // dkim_keys/ is part of the bundle layout even when no key was
    // archived (unsigned reply): the directory itself is preserved.
    assert.ok(list.some((p) => p.startsWith(`${eventId}/dkim_keys/`)),
      `expected a ${eventId}/dkim_keys/ entry in:\n${list.join('\n')}`);
  });

  await t.test('offline verifier accepts the per-event repo (--no-ots)', async () => {
    const repo = path.join(tmp, 'repos', eventId);
    const r = await new Promise((resolve, reject) => {
      const proc = spawn('node', [VERIFY, repo, '--no-ots', '--min-trust', 'unverified'], {
        env: { ...process.env },
      });
      let stdout = '', stderr = '';
      proc.stdout.on('data', (c) => { stdout += c.toString(); });
      proc.stderr.on('data', (c) => { stderr += c.toString(); });
      proc.on('error', reject);
      proc.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    const clean = stripAnsi(r.stdout);
    // Exit 0 is the load-bearing signal: the verifier exits non-zero
    // only on hard failures.
    assert.equal(r.code, 0, `verifier failed:\n${clean}\n${r.stderr}`);
    // Each named check must show PASS.
    assert.match(clean, /Structure\s+PASS/, clean);
    assert.match(clean, /Git integrity\s+PASS/, clean);
    assert.match(clean, /Schema \(v2\)\s+PASS/, clean);
    assert.match(clean, /Event completion\s+PASS/, clean);
    // Archived DKIM keys is WARN under unsigned mail (no archived
    // PEM to validate). When a DKIM-signed fixture lands, this and
    // the assertions above can flip to PASS overall.
    assert.match(clean, /Archived DKIM keys\s+(PASS|WARN)/, clean);
    // Overall is PASS when all checks pass; WARN is the accepted
    // fallback for unsigned-only repos. FAIL is forbidden.
    assert.match(clean, /Overall: (PASS|WARN)/, clean);
    assert.doesNotMatch(clean, /Overall: FAIL/, clean);
  });
});
