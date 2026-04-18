#!/usr/bin/env node
// 1.H — HTTP server for the initiator web UI.
//
// Lives in the same process as receive.js? No — receive.js is invoked
// per-message by Postfix pipe transport. This server is long-lived and
// listens on a local port. nginx proxies :443 -> this port.
//
// Routes:
//   GET  /                — landing page (2 buttons: Create Event / Create Crypto)
//   GET  /health          — JSON health check (for monitoring)
//   GET  /events/new      — event creation form (Phase 1.H.2)
//   POST /events          — create event, generate magic link (Phase 1.H.2, 1.H.4)
//   GET  /crypto/new      — crypto event creation form (Phase 1.H.3)
//   POST /crypto          — create crypto event (Phase 1.H.3)
//   GET  /manage/:token   — initiator dashboard (Phase 1.H.5)
//
// Non-goals: no REST API (§0.1.6), no accounts (§0.1.1), no telemetry
// (§0.1.5). The git repo IS the API for third parties; gitdone-verify
// is the canonical offline tool.

'use strict';

const http = require('node:http');
const { URL } = require('node:url');

const config = require('../src/config');
const { createRouter } = require('../src/web/router');
const { layout, html, raw } = require('../src/web/templates');
const { parseBody } = require('../src/web/body');
const { validateWorkflowEvent, VALID_FLOWS, VALID_TRUST_LEVELS } = require('../src/web/validation');
const { createEvent } = require('../src/event-store');

const LISTEN_HOST = process.env.GITDONE_WEB_HOST || '127.0.0.1';
const LISTEN_PORT = parseInt(process.env.GITDONE_WEB_PORT || '3001', 10);

const router = createRouter();

router.get('/', async (req, res) => {
  const body = html`
    <h1>gitdone</h1>
    <p>Coordinate multi-party actions. Email is the interface. Git is the permanent record.</p>

    <h2>Create</h2>
    <a href="/events/new" class="btn-big">Create Event</a>
    <a href="/crypto/new" class="btn-big">Create Crypto</a>

    <h2>How it works</h2>
    <p>An event (workflow with steps) or a crypto event (one or many
    cryptographically-verifiable emails). Participants reply to a
    unique email address; replies are DKIM-verified, OpenTimestamped,
    and committed to a per-event git repository. Attachments are
    forwarded to you directly and never stored on gitdone.</p>

    <p>Every proof verifies independently on any machine — without
    gitdone the service — using the open-source
    <a href="https://github.com/hamr0/gitdone/tree/main/tools/gitdone-verify"><code>gitdone-verify</code></a>
    tool. If gitdone disappears tomorrow, every proof still works.</p>
  `;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(layout({ title: 'gitdone', body }));
});

// -------- event creation (workflow) --------

function renderWorkflowForm({ values = {}, errors = [] } = {}) {
  const stepRows = Math.max(2, (values.step_name || []).length || 2);
  const flows = VALID_FLOWS.map((f) => html`
    <option value="${f}" ${values.flow === f ? raw('selected') : ''}>${f}</option>
  `);
  const trusts = VALID_TRUST_LEVELS.map((t) => html`
    <option value="${t}" ${values.min_trust_level === t ? raw('selected') : (!values.min_trust_level && t === 'verified' ? raw('selected') : '')}>${t}</option>
  `);
  const stepsHtml = [];
  for (let i = 0; i < stepRows; i++) {
    const n = (values.step_name && values.step_name[i]) || '';
    const p = (values.step_participant && values.step_participant[i]) || '';
    const d = (values.step_deadline && values.step_deadline[i]) || '';
    stepsHtml.push(html`
      <fieldset style="border:1px solid #eee;padding:0.75rem 1rem;margin-top:0.75rem">
        <legend style="font-size:0.85em;color:#555">Step ${i + 1}</legend>
        <label>Name
          <input type="text" name="step_name" value="${n}" maxlength="200">
        </label>
        <label>Participant email
          <input type="email" name="step_participant" value="${p}">
        </label>
        <label>Deadline <span>(optional, YYYY-MM-DD)</span>
          <input type="date" name="step_deadline" value="${d}">
        </label>
        <label style="margin-top:0.5rem">
          <input type="checkbox" name="step_requires_attachment" value="on"> requires attachment
        </label>
      </fieldset>
    `);
  }
  const errBlock = errors.length
    ? html`<div style="background:#fee;border:1px solid #c99;padding:0.75rem;margin-bottom:1rem">
        <strong>Please fix:</strong>
        <ul style="margin:0.3rem 0 0 1rem">${errors.map((e) => html`<li>${e}</li>`)}</ul>
      </div>`
    : raw('');
  return html`
    <h1>Create Event (workflow)</h1>
    <p><a href="/">← back</a></p>
    ${errBlock}
    <form method="POST" action="/events">
      <label>Title
        <input type="text" name="title" value="${values.title || ''}" required maxlength="200">
      </label>
      <label>Your email <span>(you'll get a management link)</span>
        <input type="email" name="initiator" value="${values.initiator || ''}" required>
      </label>
      <label>Flow
        <select name="flow" required>${flows}</select>
        <span>sequential: steps run in order. non-sequential: any order (use deadlines). hybrid: tree-like (coming later).</span>
      </label>
      <label>Minimum trust level for completion
        <select name="min_trust_level">${trusts}</select>
        <span>verified = strict DKIM+DMARC pass. authorized = SPF pass, DKIM may have broken in transit.</span>
      </label>
      <h2 style="margin-top:1.5rem">Steps</h2>
      ${stepsHtml}
      <p style="margin-top:0.75rem">
        <button type="submit" formaction="/events/new" formmethod="GET" name="_add_step" value="1">
          + Add another step
        </button>
      </p>
      <p style="margin-top:1.5rem">
        <input type="submit" value="Create event">
      </p>
    </form>
  `;
}

router.get('/events/new', async (req, res) => {
  // Support "+ Add another step" by carrying over query-string values.
  const u = new URL(req.url, `http://${req.headers.host}`);
  const sp = u.searchParams;
  const values = {
    title: sp.get('title') || '',
    initiator: sp.get('initiator') || '',
    flow: sp.get('flow') || 'sequential',
    min_trust_level: sp.get('min_trust_level') || 'verified',
    step_name: sp.getAll('step_name'),
    step_participant: sp.getAll('step_participant'),
    step_deadline: sp.getAll('step_deadline'),
  };
  // If _add_step is set, add an empty step slot
  if (sp.get('_add_step')) {
    values.step_name.push('');
    values.step_participant.push('');
    values.step_deadline.push('');
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(layout({ title: 'create event — gitdone', body: renderWorkflowForm({ values }) }));
});

router.post('/events', async (req, res) => {
  let body;
  try { body = await parseBody(req); }
  catch (err) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    return res.end(`bad request: ${err.message}`);
  }
  const v = validateWorkflowEvent(body);
  if (!v.ok) {
    res.writeHead(422, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(layout({
      title: 'fix errors — gitdone',
      body: renderWorkflowForm({ values: body, errors: v.errors }),
    }));
  }
  const event = await createEvent({
    type: 'event',
    ...v.value,
  });
  const msg = html`
    <h1>Event created</h1>
    <p><strong>${event.title}</strong> — ID: <code>${event.id}</code></p>
    <p>Flow: <code>${event.flow}</code> | Min trust: <code>${event.min_trust_level}</code> | ${event.steps.length} step(s)</p>
    <h2>Participant reply addresses</h2>
    <p>Each step has a unique reply-to address. Participants reply to these; every reply is DKIM-verified, timestamped, and committed to the event's git repository.</p>
    <ul>
      ${event.steps.map((s) => html`
        <li>
          <strong>${s.name}</strong> → ${s.participant}<br>
          reply-to: <code>event+${event.id}-${s.id}@${config.domain}</code>
          ${s.deadline ? html`<br>deadline: <code>${s.deadline}</code>` : raw('')}
        </li>
      `)}
    </ul>
    <p style="background:#ffc;padding:0.75rem;border:1px solid #cc9">
      <strong>Next:</strong> management link (email notification) will be added in 1.H.4.
      For now, you can verify the event exists:
      <a href="/events/${event.id}">${event.id}</a>
    </p>
    <p><a href="/">home</a></p>
  `;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(layout({ title: 'event created — gitdone', body: msg }));
});

// Debug/read-only event view — helpful during dev; will be locked down
// or removed when 1.H.5 (magic-link management) lands.
router.get('/events/:id', async (req, res, params) => {
  const { loadEvent } = require('../src/event-store');
  const event = await loadEvent(params.id);
  if (!event) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(layout({
      title: 'not found',
      body: html`<h1>Event not found</h1><p><a href="/">home</a></p>`,
    }));
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(layout({
    title: `${event.title} — gitdone`,
    body: html`
      <h1>${event.title}</h1>
      <p>ID: <code>${event.id}</code></p>
      <p>Type: <code>${event.type}</code> | Flow: <code>${event.flow || '—'}</code> | Min trust: <code>${event.min_trust_level || '—'}</code></p>
      <p>Created: <code>${event.created_at}</code></p>
      ${event.steps ? html`
        <h2>Steps</h2>
        <ul>
          ${event.steps.map((s) => html`
            <li><strong>${s.name}</strong> → ${s.participant}
              ${s.deadline ? html` · deadline ${s.deadline}` : raw('')}
              ${s.requires_attachment ? html` · <em>attachment required</em>` : raw('')}
            </li>
          `)}
        </ul>
      ` : raw('')}
      <p><a href="/">home</a></p>
    `,
  }));
});

router.get('/health', async (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    service: 'gitdone-web',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  }));
});

// 405 fallback for known paths with wrong method (useful for forms)
// handled inline in the server; router.match already encodes it.

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
  res.end(layout({
    title: 'not found',
    body: html`<h1>404</h1><p>Page not found. <a href="/">home</a></p>`,
  }));
}

function serverError(res, err) {
  process.stderr.write(`server: ${err && err.stack || err}\n`);
  res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
  res.end(layout({
    title: 'error',
    body: html`<h1>500</h1><p>Something went wrong. <a href="/">home</a></p>`,
  }));
}

async function handle(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const m = router.match(req.method, u.pathname);
  if (!m) return notFound(res);
  try {
    await m.handler(req, res, m.params);
  } catch (err) {
    if (!res.headersSent) serverError(res, err);
  }
}

if (require.main === module) {
  const server = http.createServer(handle);
  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    process.stdout.write(JSON.stringify({
      kind: 'web_started',
      host: LISTEN_HOST,
      port: LISTEN_PORT,
      domain: config.domain,
      started_at: new Date().toISOString(),
    }) + '\n');
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      process.stdout.write(JSON.stringify({ kind: 'web_stop', signal: sig }) + '\n');
      server.close(() => process.exit(0));
    });
  }
}

module.exports = { handle, router };
