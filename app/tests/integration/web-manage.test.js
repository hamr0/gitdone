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
  process.env.GITDONE_SKIP_MX_CHECK = '1';
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
  // Subject matches the unified [gitdone] "<title>" - <verb> shape every
  // other outbound message uses, so mail clients group all gitdone mail
  // under a single sender alias. The verb states the deadline so the
  // organiser sees "act within 72h" without opening the email.
  assert.match(submitted, /^Subject: \[gitdone\] "Manage me" - activate within \d+h$/m);
  // Magic link is on /manage/callback, not on a gitdone-internal /activate path.
  assert.doesNotMatch(submitted, /\/activate\//);
  assert.match(submitted, /\/manage\/callback\?t=/);
});

test('POST /events activation email shows two-stage wording and rich step snippets', async () => {
  await post('/events', {
    title: 'Two-stage preview', initiator: 'preview@example.com',
    step_name: ['Legal review', 'Sign'],
    step_participant: ['legal@x.com', 'ceo@x.com'],
    step_deadline: ['2026-06-01', ''],
    step_depends_on: ['', '1'],
    step_details: ['Review section 3.2 of the contract focusing on indemnification.', ''],
  });
  const cap = path.join(tmp, 'captures', 'preview_at_example.com.eml');
  const body = fs.readFileSync(cap, 'utf8');
  // Two-stage wording: clicking signs in, Activate is a separate press.
  assert.match(body, /press Activate/);
  assert.match(body, /Nothing leaves the server/);
  // Rich step metadata.
  assert.match(body, /Legal review - legal@x\.com/);
  assert.match(body, /deadline 2026-06-01/);
  assert.match(body, /after #1/);
  assert.match(body, /brief: Review section 3\.2/);
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
  // Activate so the dashboard renders the live steps table (pending
  // events render the read-only create form instead).
  await fsp.writeFile(
    path.join(tmp, 'events', `${ev.id}.json`),
    JSON.stringify({ ...ev, activated_at: '2026-01-01T00:00:00Z' }),
  );
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

test('GET /manage/event/:id (pending, link clicked) renders the read-only create form', async () => {
  await post('/events', {
    title: 'pending preview', initiator: 'pendingowner@example.com',
    step_name: ['legal', 'design'],
    step_participant: ['l@x.com', 'd@x.com'],
    step_depends_on: ['', '1'],
  });
  const ev = await latestEventFor('pendingowner@example.com');
  assert.ok(ev);
  const cookie = mintCookie('pendingowner@example.com');
  // Magic-link click first, otherwise GET /manage/event/:id renders
  // check-your-inbox instead of the dashboard.
  await get(`/manage/event/${ev.id}/confirmed?t=${ev.activation_ack_token}`, cookie);
  const view = await get(`/manage/event/${ev.id}`, cookie);
  assert.equal(view.status, 200);
  // Read-only form, not the live steps table.
  assert.doesNotMatch(view.body, /<table class="mg-steps">/);
  assert.match(view.body, /<table class="vf-steps-table">/);
  // Action row carries Activate (pending only) plus Edit + Close event.
  assert.match(view.body, />Activate</);
  assert.match(view.body, />Edit</);
  assert.match(view.body, />Close event</);
  // Submit button hidden in viewOnly mode.
  assert.doesNotMatch(view.body, /class="vf-submit"/);
});

test('GET /manage/event/:id (pending, link not clicked) still renders the dashboard for the signed-in initiator', async () => {
  await post('/events', {
    title: 'inbox-gated', initiator: 'inboxgate@example.com',
    step_name: ['a'],
    step_participant: ['a@x.com'],
    step_depends_on: [''],
  });
  const ev = await latestEventFor('inboxgate@example.com');
  assert.ok(ev);
  const cookie = mintCookie('inboxgate@example.com');
  // No /confirmed click. The Mode-B session itself proves email
  // ownership (knowless requires a magic-link click to mint it), so the
  // dashboard renders with Activate / Edit / Close available — no
  // separate per-event email round-trip required.
  const view = await get(`/manage/event/${ev.id}`, cookie);
  assert.equal(view.status, 200);
  assert.doesNotMatch(view.body, /Confirm via email/);
  assert.match(view.body, />Activate</);
  assert.match(view.body, />Edit</);
  assert.match(view.body, />Close event</);
});

test('POST /manage/event/:id/activate works for a signed-in initiator without the magic-link click', async () => {
  await post('/events', {
    title: 'unclicked-activate', initiator: 'unclicked@example.com',
    step_name: ['a'],
    step_participant: ['a@x.com'],
    step_depends_on: [''],
  });
  const ev = await latestEventFor('unclicked@example.com');
  assert.ok(ev);
  assert.ok(!ev.activation_link_clicked_at);
  const cookie = mintCookie('unclicked@example.com');
  const r = await post(`/manage/event/${ev.id}/activate`, {}, cookie);
  assert.equal(r.status, 303);
  const after = await latestEventFor('unclicked@example.com');
  assert.ok(after.activated_at, 'activated despite no /confirmed click');
});

test('POST /events: organiser email with no MX is rejected with form error', async () => {
  // The rest of this file runs with GITDONE_SKIP_MX_CHECK=1 to keep
  // tests offline; flip it off here so the actual MX path runs.
  // .invalid is an RFC 2606 reserved TLD that never resolves in DNS.
  delete process.env.GITDONE_SKIP_MX_CHECK;
  try {
    const r = await post('/events', {
      title: 'mxcheck', initiator: 'someone@gmaicom.invalid',
      step_name: 'a', step_participant: 'a@x.com',
    });
    assert.equal(r.status, 422);
    assert.match(r.body, /organiser email/);
    assert.match(r.body, /domain does not resolve|no MX record/);
    // No event got created.
    const ev = await latestEventFor('someone@gmaicom.invalid');
    assert.equal(ev, null);
  } finally {
    process.env.GITDONE_SKIP_MX_CHECK = '1';
  }
});

test('POST /events: participant email with no MX is rejected with form error', async () => {
  delete process.env.GITDONE_SKIP_MX_CHECK;
  try {
    const r = await post('/events', {
      title: 'p-mxcheck', initiator: 'org@example.com',
      step_name: 'a', step_participant: 'someone@gmaicom.invalid',
    });
    assert.equal(r.status, 422);
    assert.match(r.body, /participant email &quot;someone@gmaicom\.invalid&quot;/);
    assert.match(r.body, /domain does not resolve|no MX record/);
    const ev = await latestEventFor('org@example.com');
    assert.equal(ev, null);
  } finally {
    process.env.GITDONE_SKIP_MX_CHECK = '1';
  }
});

test('POST /crypto: declaration signer with no MX is rejected with form error', async () => {
  // Same recipient-MX gate as workflow participants — the signer is a
  // recipient and a typoed domain would silently bounce on activation.
  delete process.env.GITDONE_SKIP_MX_CHECK;
  try {
    const r = await post('/crypto', {
      mode: 'declaration', title: 'sig-mxcheck',
      initiator: 'org@example.com',
      signer: 'someone@gmaicom.invalid',
    });
    assert.equal(r.status, 422);
    assert.match(r.body, /signer email &quot;someone@gmaicom\.invalid&quot;/);
    assert.match(r.body, /domain does not resolve|no MX record/);
    const ev = await latestEventFor('org@example.com');
    assert.equal(ev, null);
  } finally {
    process.env.GITDONE_SKIP_MX_CHECK = '1';
  }
});

test('POST /events: participant email at a null-MX domain is rejected', async () => {
  // RFC 7505 null MX (priority 0, exchange "."): the domain explicitly
  // refuses mail. invmail.com publishes one in real DNS.
  delete process.env.GITDONE_SKIP_MX_CHECK;
  try {
    const r = await post('/events', {
      title: 'nullmx', initiator: 'org-nullmx@example.com',
      step_name: 'a', step_participant: 'nobody@invmail.com',
    });
    assert.equal(r.status, 422);
    assert.match(r.body, /participant email &quot;nobody@invmail\.com&quot;/);
    assert.match(r.body, /refuses mail|null MX/);
    const ev = await latestEventFor('org-nullmx@example.com');
    assert.equal(ev, null);
  } finally {
    process.env.GITDONE_SKIP_MX_CHECK = '1';
  }
});

test('POST /events: per-participant errors list every bad participant', async () => {
  delete process.env.GITDONE_SKIP_MX_CHECK;
  try {
    const r = await post('/events', {
      title: 'multi-bad', initiator: 'org2@example.com',
      step_name: ['a', 'b'],
      step_participant: ['x@bad1.invalid', 'y@bad2.invalid'],
    });
    assert.equal(r.status, 422);
    assert.match(r.body, /participant email &quot;x@bad1\.invalid&quot;/);
    assert.match(r.body, /participant email &quot;y@bad2\.invalid&quot;/);
    const ev = await latestEventFor('org2@example.com');
    assert.equal(ev, null);
  } finally {
    process.env.GITDONE_SKIP_MX_CHECK = '1';
  }
});

test('GET /events preview boldens the organiser email', async () => {
  // First POST without _action=confirm renders the preview.
  const data = querystring.stringify({
    title: 'preview-bolden', initiator: 'pv@example.com',
    step_name: 'a', step_participant: 'a@x.com',
  });
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    'content-length': Buffer.byteLength(data),
  };
  const r = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/events', method: 'POST', headers,
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
  assert.equal(r.status, 200);
  // Email rendered with emphasis + the "double-check" hint.
  assert.match(r.body, /pv@example\.com/);
  assert.match(r.body, /double-check this/);
});

test('GET /manage/event/:id surfaces last_send_error as a delivery-failed row', async () => {
  await post('/events', {
    title: 'send-fail surfaced', initiator: 'send-fail@example.com',
    step_name: ['legal'],
    step_participant: ['l@x.com'],
    step_depends_on: [''],
  });
  const ev = await latestEventFor('send-fail@example.com');
  assert.ok(ev);
  // Activate first — delivery-failed row renders on the live steps
  // table, not on the pending-mode form.
  await fsp.writeFile(
    path.join(tmp, 'events', `${ev.id}.json`),
    JSON.stringify({ ...ev, activated_at: '2026-01-01T00:00:00Z' }),
  );
  const { recordStepSendErrors } = require('../../src/event-store');
  await recordStepSendErrors(ev.id, {
    [ev.steps[0].id]: { reason: 'no such address', code: 67, at: '2026-05-03T10:00:00Z' },
  });
  const cookie = mintCookie('send-fail@example.com');
  const view = await get(`/manage/event/${ev.id}`, cookie);
  assert.equal(view.status, 200);
  assert.match(view.body, /delivery failed/);
  assert.match(view.body, /no such address/);
  assert.match(view.body, /invitation never sent/);
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
  // Activate first — close on a pending event deletes it (no audit
  // trail to commit against). This test exercises the close-with-
  // completion-commit path, so make the event activated.
  await fsp.writeFile(
    path.join(tmp, 'events', `${ev.id}.json`),
    JSON.stringify({ ...ev, activated_at: '2026-01-01T00:00:00Z' }),
  );
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

test('POST /manage/event/:id/close on a pending event deletes it', async () => {
  await post('/events', {
    title: 'pendingclose', initiator: 'pclose@example.com',
    step_name: 'x', step_participant: 'x@x.com',
  });
  const ev = await latestEventFor('pclose@example.com');
  assert.ok(ev);
  assert.equal(ev.activated_at, null);
  const cookie = mintCookie('pclose@example.com');
  const r = await postEmpty(`/manage/event/${ev.id}/close`, cookie);
  assert.equal(r.status, 303);
  assert.match(r.headers.location, /^\/manage\?cancelled=/);
  // JSON gone.
  const exists = await fsp.access(path.join(tmp, 'events', `${ev.id}.json`)).then(() => true, () => false);
  assert.equal(exists, false);
});

// ---------------------------------------------------------------------
// Proof-surfacing dashboard tests (PRD §7.5).
// ---------------------------------------------------------------------

test('GET /manage/event/:id (complete declaration) renders the trust ladder + DKIM-VERIFIED headline + receipt details', async () => {
  // Build a minimal completed declaration with a single counting commit
  // in the per-event git repo (synthetic — we don't need to run the full
  // receive pipeline; the dashboard render just reads commit JSON).
  const eventId = 'protestc1';
  const event = {
    id: eventId, type: 'crypto', mode: 'declaration',
    title: 'declaration-proof-render',
    initiator: 'declowner@example.com', signer: 'sign@example.com',
    salt: 'salt-pc1',
    activated_at: '2026-01-01T00:00:00Z',
    completion: { status: 'complete', completed_at: '2026-04-15T10:00:00Z', commit_sequence: 1 },
  };
  await fsp.mkdir(path.join(tmp, 'events'), { recursive: true });
  await fsp.writeFile(path.join(tmp, 'events', `${eventId}.json`), JSON.stringify(event));
  const repoCommitsDir = path.join(tmp, 'repos', eventId, 'commits');
  await fsp.mkdir(repoCommitsDir, { recursive: true });
  await fsp.writeFile(path.join(repoCommitsDir, 'commit-001.json'), JSON.stringify({
    schema_version: 2, event_id: eventId, sequence: 1,
    received_at: '2026-04-15T10:00:00Z',
    sender_domain: 'example.com',
    trust_level: 'verified',
    dkim: { signatures: [{ result: 'pass', domain: 'example.com', selector: 'gd1', algorithm: 'rsa-sha256', aligned: true }] },
    spf: { result: 'pass' },
    dmarc: { result: 'pass' },
    arc: { result: 'none', chain_length: 0 },
    raw_sha256: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    ots_proof_file: 'ots_proofs/commit-001.ots',
  }));

  const cookie = mintCookie('declowner@example.com');
  const view = await get(`/manage/event/${eventId}`, cookie);
  assert.equal(view.status, 200);
  // Trust ladder is rendered, with the verified rung filled.
  assert.match(view.body, /class="trust-ladder"/);
  assert.match(view.body, /data-level="verified"[^>]*background:#3fb950/);
  // Headline contains DKIM-VERIFIED + the sender domain.
  assert.match(view.body, /DKIM-VERIFIED/);
  assert.match(view.body, /@example\.com/);
  // Receipt details are present and collapsed (a <details> element).
  assert.match(view.body, /<details class="proof-details">/);
  assert.match(view.body, /Cryptographic proof/);
  assert.match(view.body, /gitdone-verify protestc1/);
});

test('GET /manage/event/:id (complete workflow) renders the trust strip + ladder + per-step trust pills', async () => {
  const eventId = 'protestw1';
  const event = {
    id: eventId, type: 'event',
    title: 'workflow-proof-render',
    initiator: 'wfowner@example.com',
    salt: 'salt-pw1',
    activated_at: '2026-01-01T00:00:00Z',
    steps: [
      { id: 's1', name: 'First', participant: 's1@example.com', status: 'complete', commit_sequence: 1, completed_at: '2026-04-15T10:00:00Z', depends_on: [] },
      { id: 's2', name: 'Second', participant: 's2@example.com', status: 'complete', commit_sequence: 2, completed_at: '2026-04-15T11:00:00Z', depends_on: [] },
    ],
    completion: { status: 'complete', completed_at: '2026-04-15T11:00:00Z', commit_sequence: 2 },
  };
  await fsp.mkdir(path.join(tmp, 'events'), { recursive: true });
  await fsp.writeFile(path.join(tmp, 'events', `${eventId}.json`), JSON.stringify(event));
  const repoCommitsDir = path.join(tmp, 'repos', eventId, 'commits');
  await fsp.mkdir(repoCommitsDir, { recursive: true });
  // Two completed-step commits with mixed trust: one verified, one forwarded.
  await fsp.writeFile(path.join(repoCommitsDir, 'commit-001.json'), JSON.stringify({
    schema_version: 2, event_id: eventId, step_id: 's1', sequence: 1,
    received_at: '2026-04-15T10:00:00Z', sender_domain: 'a.example.com',
    trust_level: 'verified',
    dkim: { signatures: [{ result: 'pass', domain: 'a.example.com', selector: 'g1', algorithm: 'rsa-sha256', aligned: true }] },
    spf: { result: 'pass' }, dmarc: { result: 'pass' }, arc: { result: 'none', chain_length: 0 },
    raw_sha256: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    ots_proof_file: 'ots_proofs/commit-001.ots',
  }));
  await fsp.writeFile(path.join(repoCommitsDir, 'commit-002.json'), JSON.stringify({
    schema_version: 2, event_id: eventId, step_id: 's2', sequence: 2,
    received_at: '2026-04-15T11:00:00Z', sender_domain: 'b.example.com',
    trust_level: 'forwarded',
    dkim: { signatures: [{ result: 'pass', domain: 'forwarder.example.org', selector: 'fw', algorithm: 'rsa-sha256', aligned: false }] },
    spf: { result: 'pass' }, dmarc: { result: 'pass' }, arc: { result: 'pass', chain_length: 1 },
    raw_sha256: 'sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
    ots_proof_file: 'ots_proofs/commit-002.ots',
  }));

  const cookie = mintCookie('wfowner@example.com');
  const view = await get(`/manage/event/${eventId}`, cookie);
  assert.equal(view.status, 200);
  // Trust strip + ladder render above the steps table.
  assert.match(view.body, /class="proof-strip"/);
  assert.match(view.body, /class="trust-ladder"/);
  // Aggregate counts in the strip.
  assert.match(view.body, /1 verified/);
  assert.match(view.body, /1 forwarded/);
  // Inline trust pills appear next to step status cells.
  assert.match(view.body, /trust-pill trust-verified/);
  assert.match(view.body, /trust-pill trust-forwarded/);
  // Per-step proof drawer rows are present (initially hidden).
  assert.match(view.body, /<tr class="mg-proof-row" data-step="s1"/);
  assert.match(view.body, /<tr class="mg-proof-row" data-step="s2"/);
  // Weakest-link ladder caps at "forwarded" — the verified rung above
  // is dimmed grey.
  assert.match(view.body, /data-level="forwarded"[^>]*background:#58a6ff/);
});

test('GET /manage/event/:id (workflow with attachments) renders the green attach pill + filenames in the receipt drawer', async () => {
  const eventId = 'proattw1';
  const event = {
    id: eventId, type: 'event',
    title: 'workflow-attach-render',
    initiator: 'attowner@example.com',
    salt: 'salt-paw',
    activated_at: '2026-01-01T00:00:00Z',
    steps: [
      { id: 's1', name: 'Sign', participant: 's1@example.com', status: 'complete', commit_sequence: 1, completed_at: '2026-04-15T10:00:00Z', depends_on: [] },
    ],
    completion: { status: 'complete', completed_at: '2026-04-15T10:00:00Z', commit_sequence: 1 },
  };
  await fsp.mkdir(path.join(tmp, 'events'), { recursive: true });
  await fsp.writeFile(path.join(tmp, 'events', `${eventId}.json`), JSON.stringify(event));
  const repoCommitsDir = path.join(tmp, 'repos', eventId, 'commits');
  await fsp.mkdir(repoCommitsDir, { recursive: true });
  await fsp.writeFile(path.join(repoCommitsDir, 'commit-001.json'), JSON.stringify({
    schema_version: 2, event_id: eventId, step_id: 's1', sequence: 1,
    received_at: '2026-04-15T10:00:00Z', sender_domain: 'example.com',
    trust_level: 'verified',
    dkim: { signatures: [{ result: 'pass', domain: 'example.com', selector: 'g1', algorithm: 'rsa-sha256', aligned: true }] },
    spf: { result: 'pass' }, dmarc: { result: 'pass' }, arc: { result: 'none', chain_length: 0 },
    raw_sha256: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    ots_proof_file: 'ots_proofs/commit-001.ots',
    attachments: [
      { filename: 'contract.pdf', sha256: 'sha256:aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff66667777888899990000', size: 102400 },
    ],
  }));

  const cookie = mintCookie('attowner@example.com');
  const view = await get(`/manage/event/${eventId}`, cookie);
  assert.equal(view.status, 200);
  // Green attach pill rides next to the trust pill on the row.
  assert.match(view.body, /trust-pill attach-pill/);
  assert.match(view.body, /📎 1/);
  // Filename + truncated hash + size land in the receipt drawer.
  assert.match(view.body, /contract\.pdf/);
  assert.match(view.body, /sha256:aaaa…0000/);
  assert.match(view.body, /100\.0 KB/);
});

test('GET /manage hub renders the unified filter row with non-zero buckets and lifecycle-coloured CSS', async () => {
  // Three events under one owner with three different statuses.
  // Confirms the filter-row pill shape (M-3 from review: no prior
  // coverage of the unified filter row added in commit 1611ad7).
  const owner = 'huber@example.com';
  const eventsDir = path.join(tmp, 'events');
  await fsp.mkdir(eventsDir, { recursive: true });
  await fsp.writeFile(path.join(eventsDir, 'hubactive.json'), JSON.stringify({
    id: 'hubactive', type: 'event', title: 'Active', initiator: owner,
    created_at: '2026-04-15T10:00:00Z', activated_at: '2026-04-15T10:00:00Z',
    steps: [{ id: 's1', name: 'A', participant: 'p@example.com', status: 'pending', depends_on: [] }],
  }));
  await fsp.writeFile(path.join(eventsDir, 'hubcomplete.json'), JSON.stringify({
    id: 'hubcomplete', type: 'event', title: 'Done', initiator: owner,
    created_at: '2026-04-14T10:00:00Z', activated_at: '2026-04-14T10:00:00Z',
    steps: [{ id: 's1', name: 'A', participant: 'p@example.com', status: 'complete', depends_on: [] }],
    completion: { status: 'complete', completed_at: '2026-04-14T11:00:00Z' },
  }));
  await fsp.writeFile(path.join(eventsDir, 'hubpending.json'), JSON.stringify({
    id: 'hubpending', type: 'event', title: 'Wait', initiator: owner,
    created_at: '2026-04-16T10:00:00Z',
    steps: [{ id: 's1', name: 'A', participant: 'p@example.com', status: 'pending', depends_on: [] }],
  }));
  const view = await get('/manage', mintCookie(owner));
  assert.equal(view.status, 200);
  // Filter row renders one pill per non-zero bucket.
  assert.match(view.body, /<div class="mh-filter-row">/);
  assert.match(view.body, /class="mh-filter-pill[^"]*"[^>]*>active <span class="n">1<\/span>/);
  assert.match(view.body, /class="mh-filter-pill[^"]*"[^>]*>completed <span class="n">1<\/span>/);
  assert.match(view.body, /class="mh-filter-pill[^"]*"[^>]*>pending <span class="n">1<\/span>/);
  // Zero-count buckets stay out of the row.
  assert.doesNotMatch(view.body, />closed <span class="n">/);
  assert.doesNotMatch(view.body, />archived <span class="n">/);
  // Lifecycle colours are wired so the active filter doubles as a legend.
  assert.match(view.body, /\.mh-filter-pill\.active\.active\s*\{\s*background:\s*#58a6ff/);
  assert.match(view.body, /\.mh-filter-pill\.active\.completed\s*\{\s*background:\s*#3fb950/);
  assert.match(view.body, /\.mh-filter-pill\.active\.pending\s*\{\s*background:\s*#ffb000/);
  // Cleanup so neighbouring tests don't see these fixtures.
  for (const f of ['hubactive.json', 'hubcomplete.json', 'hubpending.json']) {
    await fsp.unlink(path.join(eventsDir, f));
  }
});

test('GET /manage?status=completed activates the matching pill and filters the list', async () => {
  const owner = 'huber2@example.com';
  const eventsDir = path.join(tmp, 'events');
  await fsp.mkdir(eventsDir, { recursive: true });
  await fsp.writeFile(path.join(eventsDir, 'hubfact1.json'), JSON.stringify({
    id: 'hubfact1', type: 'event', title: 'Active1', initiator: owner,
    created_at: '2026-04-15T10:00:00Z', activated_at: '2026-04-15T10:00:00Z',
    steps: [{ id: 's1', name: 'A', participant: 'p@example.com', status: 'pending', depends_on: [] }],
  }));
  await fsp.writeFile(path.join(eventsDir, 'hubfdone1.json'), JSON.stringify({
    id: 'hubfdone1', type: 'event', title: 'Done1', initiator: owner,
    created_at: '2026-04-14T10:00:00Z', activated_at: '2026-04-14T10:00:00Z',
    steps: [{ id: 's1', name: 'A', participant: 'p@example.com', status: 'complete', depends_on: [] }],
    completion: { status: 'complete', completed_at: '2026-04-14T11:00:00Z' },
  }));
  const view = await get('/manage?status=completed', mintCookie(owner));
  assert.equal(view.status, 200);
  // The completed pill is in its `active completed` state — fills with green.
  assert.match(view.body, /class="mh-filter-pill active completed"/);
  // Only the matching event title is in the list.
  assert.match(view.body, /Done1/);
  assert.doesNotMatch(view.body, />Active1</);
  for (const f of ['hubfact1.json', 'hubfdone1.json']) {
    await fsp.unlink(path.join(eventsDir, f));
  }
});
