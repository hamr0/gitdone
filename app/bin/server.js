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
