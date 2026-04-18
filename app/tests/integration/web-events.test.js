'use strict';

// End-to-end test of the event-creation HTTP flow:
//   GET /events/new       returns a form
//   POST /events (good)   creates event, redirects / responds 200
//   POST /events (bad)    responds 422 with errors
//
// Uses a throwaway GITDONE_DATA_DIR so it doesn't pollute anything.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const querystring = require('node:querystring');

let tmp;
let server;
let port;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdone-web-events-'));
  process.env.GITDONE_DATA_DIR = tmp;
  // flush any already-cached instances bound to the old dataDir
  for (const m of ['../../src/config', '../../src/event-store', '../../bin/server']) {
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
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

function post(path, form) {
  const data = querystring.stringify(form);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(data),
      },
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

function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'),
      }));
    }).on('error', reject);
  });
}

test('GET /events/new renders the workflow form', async () => {
  const r = await get('/events/new');
  assert.equal(r.status, 200);
  assert.match(r.body, /<h1>Create Event/);
  assert.match(r.body, /name="title"/);
  assert.match(r.body, /name="initiator"/);
  assert.match(r.body, /name="flow"/);
  assert.match(r.body, /name="step_name"/);
  assert.match(r.body, /name="step_participant"/);
  assert.match(r.body, /name="step_deadline"/);
  assert.match(r.body, /name="min_trust_level"/);
});

test('GET /events/new?_add_step=1 adds a step slot', async () => {
  const r1 = await get('/events/new');
  const r2 = await get('/events/new?_add_step=1&step_name=A&step_name=B');
  const stepCount = (r2.body.match(/<legend[^>]*>Step \d+<\/legend>/g) || []).length;
  // With two step_name params + _add_step, we should have at least 3 slots
  assert.ok(stepCount >= 3, `got ${stepCount} steps`);
});

test('POST /events creates a valid event and shows confirmation', async () => {
  const r = await post('/events', {
    title: 'Integration test event',
    initiator: 'dev@example.com',
    flow: 'sequential',
    min_trust_level: 'verified',
    step_name: 'Legal review',
    step_participant: 'legal@example.com',
    step_deadline: '',
  });
  assert.equal(r.status, 200);
  assert.match(r.body, /Event created/);
  assert.match(r.body, /Integration test event/);
  // Extract the event ID from the rendered page
  const m = r.body.match(/ID: <code>([a-z0-9]{12})<\/code>/);
  assert.ok(m, 'event id should be rendered');
  const eventId = m[1];

  // File should exist on disk
  const file = path.join(tmp, 'events', `${eventId}.json`);
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(parsed.id, eventId);
  assert.equal(parsed.type, 'event');
  assert.equal(parsed.title, 'Integration test event');
  assert.equal(parsed.initiator, 'dev@example.com');
  assert.equal(parsed.flow, 'sequential');
  assert.equal(parsed.min_trust_level, 'verified');
  assert.match(parsed.salt, /^[0-9a-f]{64}$/);
  assert.equal(parsed.steps.length, 1);
  assert.equal(parsed.steps[0].id, 'legal-review');
  assert.equal(parsed.steps[0].participant, 'legal@example.com');
});

test('POST /events (invalid) returns 422 with errors', async () => {
  const r = await post('/events', {
    title: '', initiator: 'bogus',
    flow: 'parallel',
    step_name: '', step_participant: '',
  });
  assert.equal(r.status, 422);
  assert.match(r.body, /Please fix/);
  assert.match(r.body, /title/i);
  assert.match(r.body, /initiator/i);
  assert.match(r.body, /flow/i);
});

test('GET /events/:id shows the event read-only', async () => {
  // Create one
  const r = await post('/events', {
    title: 'read-back', initiator: 'a@b.com', flow: 'non-sequential',
    step_name: ['one', 'two'],
    step_participant: ['x@y.com', 'z@y.com'],
    step_deadline: ['2026-06-01', ''],
  });
  const m = r.body.match(/ID: <code>([a-z0-9]{12})<\/code>/);
  const id = m[1];
  const view = await get(`/events/${id}`);
  assert.equal(view.status, 200);
  assert.match(view.body, /read-back/);
  assert.match(view.body, /non-sequential/);
  assert.match(view.body, /x@y\.com/);
  assert.match(view.body, /z@y\.com/);
  assert.match(view.body, /deadline 2026-06-01/);
});

test('GET /events/bogus-id returns 404 (traversal guard)', async () => {
  const r = await get('/events/..slash..slash..etc');
  assert.equal(r.status, 404);
});

test('POST /events with multi-step deadlines is persisted correctly', async () => {
  const r = await post('/events', {
    title: 'multi', initiator: 'a@b.com', flow: 'non-sequential',
    min_trust_level: 'authorized',
    step_name: ['A', 'B', 'C'],
    step_participant: ['a@x.com', 'b@x.com', 'c@x.com'],
    step_deadline: ['2026-05-01', '', '2026-05-15'],
    step_requires_attachment: ['on', '', 'on'],
  });
  assert.equal(r.status, 200);
  const id = r.body.match(/ID: <code>([a-z0-9]{12})<\/code>/)[1];
  const ev = JSON.parse(await fs.readFile(path.join(tmp, 'events', `${id}.json`), 'utf8'));
  assert.equal(ev.steps.length, 3);
  assert.match(ev.steps[0].deadline, /^2026-05-01/);
  assert.equal(ev.steps[1].deadline, null);
  assert.match(ev.steps[2].deadline, /^2026-05-15/);
  assert.equal(ev.steps[0].requires_attachment, true);
  assert.equal(ev.steps[1].requires_attachment, false);
  assert.equal(ev.steps[2].requires_attachment, true);
  assert.equal(ev.min_trust_level, 'authorized');
});
