#!/usr/bin/env node
// 1.H — HTTP server for the initiator web UI.
//
// Lives in the same process as receive.js? No — receive.js is invoked
// per-message by Postfix pipe transport. This server is long-lived and
// listens on a local port. nginx proxies :443 -> this port.
//
// Routes:
//   GET  /                        — landing page (2 buttons: Create Event / Create Crypto)
//   GET  /health                  — JSON health check (for monitoring)
//   GET  /events/new              — event creation form (Phase 1.H.2)
//   POST /events                  — create event (Phase 1.H.2)
//   GET  /crypto/new              — crypto event creation form (Phase 1.H.3)
//   POST /crypto                  — create crypto event (Phase 1.H.3)
//   GET  /manage                  — session dashboard / sign-in form (knowless)
//   POST /manage                  — knowless login (magic link)
//   GET  /manage/callback         — knowless callback: set 30-day cookie
//   GET  /manage/verify           — knowless forward-auth
//   POST /manage/logout           — clear session cookie
//   GET  /manage/event/:id        — per-event management dashboard (session-gated)
//   POST /manage/event/:id/remind — send reminders (session-gated)
//   POST /manage/event/:id/unarchive — un-archive (session-gated)
//   POST /manage/event/:id/close  — close event (session-gated)
//
// Non-goals: no REST API (§0.1.6), no accounts (§0.1.1), no telemetry
// (§0.1.5). The git repo IS the API for third parties; gitdone-verify
// is the canonical offline tool.

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

// Dev-mode detection FIRST — we may need to set GITDONE_DATA_DIR before
// requiring config/event-store (which cache the value at load time).
const IS_DEV = process.argv.includes('--dev') || process.env.GITDONE_DEV === '1';
if (IS_DEV) process.env.GITDONE_DEV_MAGIC_LINKS = '1';
if (IS_DEV && !process.env.GITDONE_DATA_DIR) {
  const devDataDir = path.join(process.cwd(), 'data-dev');
  try { fs.mkdirSync(devDataDir, { recursive: true }); } catch {}
  process.env.GITDONE_DATA_DIR = devDataDir;
  process.stderr.write(`dev: using GITDONE_DATA_DIR=${devDataDir}\n`);
}

const config = require('../src/config');
const { createRouter } = require('../src/web/router');
const { layout: rawLayout, html, raw, truncateText } = require('../src/web/templates');
const { parseBody } = require('../src/web/body');
const { validateWorkflowEvent, validateCryptoEvent, VALID_TRUST_LEVELS, VALID_CRYPTO_MODES, VALID_DEDUP_RULES } = require('../src/web/validation');
const { createEvent } = require('../src/event-store');
const { isClosedByInitiator, revokedHashSet } = require('../src/completion');
const { getAuth } = require('../src/auth');
const { createEventFinder } = require('../src/web/handle-events');
const { sendmail, buildRawMessage, withSignature } = require('../src/outbound');
const { notifyWorkflowParticipants, notifyDeclarationSigner } = require('../src/notifications');
const {
  renderTrustLadder,
  renderTrustPill,
  renderProofReceipt,
  renderAttachmentPill,
  truncHash,
  formatBytes,
  aggregateTrust,
  TRUST_COLOR,
  TRUST_LABEL,
} = require('../src/web/proof-render');
const devChannel = IS_DEV ? require('../src/web/dev-channel') : null;
const designLab = IS_DEV ? require('../src/web/design-lab') : null;

// Scheme/host used to build management URLs in outbound emails. Overrideable
// for local dev (http://localhost:3001) and tests. Defaults to production.
function publicBaseUrl() {
  return process.env.GITDONE_PUBLIC_URL || `https://${config.domain}`;
}

// Wrap layout() so every route automatically gets the dev HUD in dev mode.
function layout(opts) {
  if (!IS_DEV) return rawLayout(opts);
  return rawLayout({ ...opts, dev: true, devHUD: devChannel.devHUD() });
}

const LISTEN_HOST = process.env.GITDONE_WEB_HOST || '127.0.0.1';
const LISTEN_PORT = parseInt(process.env.GITDONE_WEB_PORT || '3001', 10);

const router = createRouter();

// Favicon served from disk (one route, cached by the browser). Both
// /favicon.svg (the canonical SVG) and /favicon.ico (the default path
// browsers probe) resolve to the same SVG bytes.
const FAVICON_PATH = path.join(__dirname, '..', 'src', 'web', 'favicon.svg');
let FAVICON_BODY = null;
try { FAVICON_BODY = fs.readFileSync(FAVICON_PATH); } catch {}
function serveFavicon(res) {
  if (!FAVICON_BODY) { res.writeHead(404); return res.end(); }
  res.writeHead(200, {
    'content-type': 'image/svg+xml',
    'cache-control': 'public, max-age=86400',
  });
  res.end(FAVICON_BODY);
}
router.get('/favicon.svg', async (req, res) => serveFavicon(res));
router.get('/favicon.ico', async (req, res) => serveFavicon(res));

// OG card — 1200×630 PNG referenced by og:image / twitter:image. Read once
// at boot, served with a long cache header (scrapers cache aggressively
// anyway: ~7d on WhatsApp, indefinite on Facebook until busted via the
// debugger, ~24h on Twitter).
const OG_PATH = path.join(__dirname, '..', 'src', 'web', 'og.png');
let OG_BODY = null;
try { OG_BODY = fs.readFileSync(OG_PATH); } catch {}
router.get('/og.png', async (req, res) => {
  if (!OG_BODY) { res.writeHead(404); return res.end(); }
  res.writeHead(200, {
    'content-type': 'image/png',
    'content-length': OG_BODY.length,
    'cache-control': 'public, max-age=86400',
  });
  res.end(OG_BODY);
});

// Design Lab winner — landing page (variant F: retro-terminal hybrid).
// CRT-green + amber phosphor, monospace, oversized wordmark with slash,
// two heavy cells (second inverted green → amber on hover).
// Reference: docs/01-product/design/landing-and-crypto-v1.md
const LANDING_CSS = `
.vF { font-family: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
      background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 0;
      margin: 1rem 0 1.5rem; overflow: hidden; position: relative; }
.vF::before { content: ''; position: absolute; top: 0; right: 0; width: 82px; height: 82px;
              background: repeating-linear-gradient(45deg, #ffb000 0 9px, #0d1117 9px 11px);
              opacity: 0.85; pointer-events: none; }
.vF .top { padding: 1.3rem 1.4rem 1rem; border-bottom: 1px solid #30363d; position: relative; z-index: 1; }
.vF .kicker { font-size: 0.7em; letter-spacing: 0.22em; color: #8b949e; margin: 0 0 0.4rem; text-transform: uppercase; }
.vF .kicker .dot { color: #3fb950; margin: 0 0.3em; }
.vF h1 { font-family: inherit; font-size: clamp(2.4rem, 8vw, 4.4rem); line-height: 0.88;
         font-weight: 700; letter-spacing: -0.04em; margin: 0 0 1.1rem; color: #c9d1d9; }
.vF h1 .slash { color: #ffb000; text-shadow: 0 0 18px rgba(255,176,0,.35); }
.vF h1 .cursor { display: inline-block; width: 0.4em; height: 0.9em; background: #3fb950;
                 vertical-align: baseline; margin-left: 0.1em;
                 animation: vF-blink 1.1s steps(1) infinite;
                 box-shadow: 0 0 10px rgba(63,185,80,.6); }
@keyframes vF-blink { 50% { opacity: 0; } }
.vF .tag { font-size: 0.95em; color: #8b949e; margin: 0; max-width: 44ch; line-height: 1.5; }
.vF .tag em { color: #3fb950; font-style: normal; }
.vF .grid { display: grid; grid-template-columns: 1fr 1fr; border-bottom: 1px solid #30363d; }
.vF .cell { display: block; padding: 1.5rem 1.4rem; text-decoration: none; color: inherit;
            border-right: 1px solid #30363d; transition: background 0.12s; position: relative; }
.vF .cell:last-child { border-right: 0; background: #3fb950; color: #0d1117; }
.vF .cell:hover { background: #161b22; }
.vF .cell:last-child:hover { background: #ffb000; color: #0d1117; }
.vF .cell .num { font-size: 0.72em; letter-spacing: 0.2em; color: #8b949e; margin: 0 0 0.4rem;
                 text-transform: uppercase; font-weight: 600; }
.vF .cell:last-child .num { color: #0d1117; opacity: 0.7; }
.vF .cell .title { font-size: 2.2rem; font-weight: 700; line-height: 1; margin: 0 0 0.5rem;
                   letter-spacing: -0.03em; }
.vF .cell .title .k { display: inline-block; background: #0d1117; color: #3fb950;
                      border: 1px solid #30363d; padding: 0.05em 0.4em; border-radius: 3px;
                      font-size: 0.42em; vertical-align: middle; margin-right: 0.5em;
                      letter-spacing: 0.05em; font-weight: 500; }
.vF .cell:last-child .title .k { background: #0d1117; color: #3fb950; border-color: #0d1117; }
.vF .cell .arr { float: right; font-size: 1.5rem; font-weight: 400; line-height: 1; color: #3fb950; }
.vF .cell:last-child .arr { color: #0d1117; }
.vF .cell .lede { font-size: 1em; line-height: 1.35; margin: 0 0 0.45rem; color: #c9d1d9; font-weight: 500; max-width: 30ch; }
.vF .cell:last-child .lede { color: #0d1117; }
.vF .cell .desc { font-size: 0.85em; line-height: 1.5; margin: 0; color: #8b949e; max-width: 34ch; }
.vF .cell:last-child .desc { color: rgba(13,17,23,.75); }
.vF .cell code { background: #0d1117; color: #ffb000; padding: 0.05em 0.35em; border-radius: 2px;
                 font-family: inherit; font-size: 0.95em; }
.vF .cell:last-child code { background: #0d1117; color: #ffb000; }
.vF .foot { padding: 0.8rem 1.4rem; display: flex; justify-content: space-between; gap: 0.9rem;
            font-size: 0.78em; color: #8b949e; flex-wrap: wrap; letter-spacing: 0.04em; }
.vF .foot .chip { color: #3fb950; }
.vF .foot a { color: #58a6ff; text-decoration: none; }
.vF .foot a:hover { color: #ffb000; }
.vF .foot code { background: #161b22; color: #3fb950; padding: 0.08em 0.4em; border-radius: 2px;
                 font-size: 0.94em; }
.vF .manage-strip { padding: 0.75rem 1.4rem; border-bottom: 1px solid #30363d;
                    font-size: 0.85em; color: #8b949e; display: flex; justify-content: space-between;
                    align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.vF .manage-strip a { color: #58a6ff; white-space: nowrap; }
.vF .manage-strip a:hover { color: #ffb000; }
@media (max-width: 640px) { .vF .grid { grid-template-columns: 1fr; }
  .vF .cell { border-right: 0; border-bottom: 1px solid #30363d; }
  .vF .cell:last-child { border-bottom: 0; }
  /* Decorative corner badge clipped the kicker + wordmark on narrow
     viewports — purely chrome, hide it below tablet width. */
  .vF::before { display: none; } }
`;
router.get('/', async (req, res) => {
  const body = html`
    <style>${raw(LANDING_CSS)}</style>
    <div class="vF" data-variant-root="F">
      <div class="top">
        <p class="kicker">email-native <span class="dot">●</span> git-proved <span class="dot">●</span> offline-verifiable</p>
        <h1>git<span class="slash">/</span>done<span class="cursor"></span></h1>
        <p class="tag">Multi-party actions coordinated by email. Every reply <em>DKIM-verified</em>, <em>OpenTimestamped</em>, and committed to a per-event git repository.</p>
      </div>
      <div class="manage-strip">
        <span>Already have events? <a href="/manage">Manage your events &amp; crypto ▸</a></span>
        <span>Sign-in by email · no password</span>
      </div>
      <div class="grid">
        <a href="/events/new" class="cell">
          <p class="num">◢ option 01</p>
          <p class="title"><span class="k">E</span>event<span class="arr">▸</span></p>
          <p class="lede">An auditable multi-party workflow.</p>
          <p class="desc">Ordered, parallel, or a DAG of steps. Each step has a <code>participant</code>, a <code>deadline</code>, and <code>depends_on</code>.</p>
        </a>
        <a href="/crypto/new" class="cell">
          <p class="num">◢ option 02</p>
          <p class="title"><span class="k">C</span>crypto<span class="arr">▸</span></p>
          <p class="lede">A cryptographically timestamped signature.</p>
          <p class="desc">One <code>declaration</code> (single signer) or an <code>attestation</code> (N distinct signers). DKIM + OTS on every reply.</p>
        </a>
      </div>
      <div class="foot">
        <span><span class="chip">●</span> no accounts</span>
        <span><span class="chip">●</span> no api</span>
        <span><span class="chip">●</span> no telemetry</span>
        <span>verify offline → <a href="https://github.com/hamr0/gitdone/tree/main/tools/gitdone-verify"><code>gitdone-verify</code></a></span>
      </div>
    </div>
  `;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(layout({
    title: 'gitdone — multi-party workflows over email, with cryptographic proof',
    description: 'Email-native multi-party workflow coordination with cryptographic proof of the reply sequence. No accounts, no API, no telemetry, open source.',
    canonical: `${publicBaseUrl()}/`,
    body,
  }));
});

// Tier-2 discoverability: robots.txt + sitemap.xml. Only the public
// marketing/utility surfaces are indexable; per-event audit pages and
// the session-gated dashboard sit behind Disallow.
router.get('/robots.txt', async (req, res) => {
  const base = publicBaseUrl();
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=86400' });
  res.end([
    'User-agent: *',
    'Allow: /',
    'Disallow: /manage/event/',
    'Disallow: /manage/callback',
    'Disallow: /manage/verify',
    'Disallow: /events/',
    'Allow: /events/new',
    `Sitemap: ${base}/sitemap.xml`,
    '',
  ].join('\n'));
});
router.get('/sitemap.xml', async (req, res) => {
  const base = publicBaseUrl();
  const urls = ['/', '/events/new', '/crypto/new', '/manage'];
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) => `  <url><loc>${base}${u}</loc><changefreq>weekly</changefreq></url>`),
    '</urlset>',
    '',
  ].join('\n');
  res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=86400' });
  res.end(body);
});

// -------- event creation (workflow) --------

// Design Lab variant F (synthesis winner, iteration 2): What+Who on one
// row, How on a second row, compact step table with datetime-local
// deadlines, explained dropdowns, numbered section headers.
// Reference: docs/01-product/design/event-form-v1.md
const WORKFLOW_FORM_CSS = `
.vf-form h2 { font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.12em; color: #8b949e; margin: 1.2rem 0 0.45rem; font-weight: 600; }
.vf-form h2 .num { display: inline-block; width: 1.4em; height: 1.4em; background: #0d1117; color: #3fb950; border: 1px solid #3fb950; border-radius: 0; text-align: center; font-weight: 600; margin-right: 0.5rem; font-size: 0.8em; line-height: 1.35em; }
.vf-form h2 .hint { font-size: 0.88em; color: #6e7681; text-transform: none; letter-spacing: 0; font-weight: 400; margin-left: 0.4rem; }
.vf-section { padding-left: 1.55rem; border-left: 2px solid #30363d; margin-bottom: 0.5rem; padding-bottom: 0.35rem; }
.vf-row { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
.vf-row label { margin: 0; }
.vf-row label span { font-size: 0.76em; color: #8b949e; text-transform: uppercase; letter-spacing: 0.08em; }
.vf-row input, .vf-row select { padding: 0.45rem 0.55rem; font-size: 0.93em; }
.vf-steps-table { width: 100%; border-collapse: collapse; font-size: 0.88em; margin-bottom: 0.35rem; table-layout: fixed; border: 1px solid #30363d; }
.vf-steps-table th { text-align: left; font-weight: 500; color: #8b949e; padding: 0.35rem 0.5rem; border-bottom: 1px solid #30363d; background: #161b22; font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.08em; }
.vf-steps-table td { padding: 0.28rem 0.35rem; border-bottom: 1px solid #21262d; vertical-align: middle; }
.vf-steps-table tr:last-child td { border-bottom: 0; }
.vf-steps-table input[type=text], .vf-steps-table input[type=email], .vf-steps-table input[type=date] { width: 100%; padding: 0.3rem 0.45rem; border: 1px solid transparent; background: transparent; color: #c9d1d9; font-size: 0.9em; border-radius: 0; font-family: inherit; }
.vf-steps-table input:focus { border-color: #3fb950; background: #0d1117; outline: 0; box-shadow: 0 0 0 1px rgba(63,185,80,.2); }
.vf-steps-table tr:hover input:not(:focus) { background: #161b22; }
.vf-steps-table .col-num { width: 28px; color: #6e7681; font-variant-numeric: tabular-nums; text-align: right; padding-right: 0.4rem; font-size: 0.82em; }
.vf-steps-table .col-name { width: 20%; }
.vf-steps-table .col-email { width: 22%; }
.vf-steps-table .col-dl { width: 24%; }
.vf-steps-table .col-deps { width: 12%; }
.vf-steps-table .col-att { width: 40px; text-align: center; }
.vf-errors { background:#0d1117; border:1px solid #f85149; border-left-width:3px; color:#f0b8b8; padding:0.7rem 0.95rem; margin-bottom:1rem; font-size:0.92em; }
.vf-errors strong { color:#f85149; text-transform:uppercase; letter-spacing:0.08em; font-size:0.8em; display:block; margin-bottom:0.35rem; }
.vf-errors ul { margin:0; padding-left:1.2rem; color:#c9d1d9; }
.vf-errors li { margin:0.12rem 0; }
.vf-steps-table .col-remove { width: 28px; text-align: center; padding: 0; }
.vf-remove-step { background: transparent; border: 0; color: #6e7681; font-size: 1.2em; line-height: 1; padding: 0.15rem 0.45rem; cursor: pointer; font-family: inherit; }
.vf-remove-step:hover { color: #f85149; }
.vf-remove-step:focus { outline: 1px solid #f85149; color: #f85149; }
.vf-details-toggle { background: none; border: 0; color: #58a6ff; cursor: pointer; font: inherit; font-size: 0.8em; padding: 0.1em 0.3em; letter-spacing: 0.02em; }
.vf-details-toggle:hover { color: #ffb000; }
.vf-details-toggle::before { content: "+ details"; }
.vf-details-row.open .vf-details-toggle::before { content: "\u2212 details"; }
.vf-details-row td { padding: 0 0.4rem 0.6rem 28px; border-bottom: 1px solid #21262d; }
.vf-details-row .vf-details-wrap { display: none; }
.vf-details-row.open .vf-details-wrap,
.vf-details-row.has-content .vf-details-wrap { display: block; margin-top: 0.25rem; }
.vf-details-row textarea { width: 100%; min-height: 4.5em; padding: 0.4rem 0.55rem; background: #161b22; color: #c9d1d9; border: 1px solid #30363d; border-radius: 0; font: inherit; font-size: 0.88em; resize: vertical; box-sizing: border-box; }
.vf-details-row textarea:focus { border-color: #3fb950; outline: 0; box-shadow: 0 0 0 1px rgba(63,185,80,.2); }
.vf-details-row .vf-details-count { font-size: 0.72em; color: #6e7681; text-align: right; margin-top: 0.15em; }
.vf-details-row .vf-details-count.over { color: #f85149; }
.vf-add-row { margin: 0.5rem 0 0; font-size: 0.85em; }
.vf-add-row button { background: none; border: 0; color: #58a6ff; cursor: pointer; padding: 0; font: inherit; text-decoration: none; }
.vf-add-row button:hover { color: #ffb000; text-decoration: underline; }
.vf-submit { display: block; margin: 1.1rem auto 0; background: #3fb950; color: #0d1117; padding: 0.65rem 1.8rem; border: 0; border-radius: 0; cursor: pointer; font-weight: 600; font-size: 0.95em; letter-spacing: 0.05em; text-transform: uppercase; }
.vf-submit:hover { background: #ffb000; }
@media (max-width: 540px) {
  .vf-row { grid-template-columns: 1fr; }
  .vf-steps-table { font-size: 0.85em; border: 0; }
  .vf-steps-table thead { display: none; }
  .vf-steps-table, .vf-steps-table tbody { display: block; }
  /* Each step becomes a 2-row grid card: name + email on top, the rest
     on a second line. col-num spans both rows as a left-edge label. */
  /* Row 1: name (narrower) + email (wider, full address visible).
     Row 2: date matches name's width, deps + checkbox share email's width.
     Remove × stays as a corner-right control on row 1. */
  .vf-steps-table tr:not(.vf-details-row) {
    display: grid;
    grid-template-columns: 28px 2fr 2fr 1fr 28px;
    grid-template-areas:
      "num name email email remove"
      "num dl   deps att   .";
    column-gap: 0.4rem;
    row-gap: 0.35rem;
    padding: 0.55rem 0.35rem;
    border-bottom: 1px solid #30363d;
    align-items: center;
  }
  .vf-steps-table tr:not(.vf-details-row) > td {
    display: block;
    width: auto;
    padding: 0;
    border-bottom: 0;
  }
  .vf-steps-table tr.vf-details-row { display: block; }
  .vf-steps-table tr.vf-details-row > td { display: block; padding: 0.25rem 0.35rem 0.4rem; border-bottom: 0; }
  .vf-steps-table .col-num    { grid-area: num; align-self: start; padding-top: 0.35rem; }
  .vf-steps-table .col-name   { grid-area: name; }
  .vf-steps-table .col-email  { grid-area: email; }
  .vf-steps-table .col-dl     { grid-area: dl; }
  .vf-steps-table .col-deps   { grid-area: deps; }
  .vf-steps-table .col-att    { grid-area: att; }
  .vf-steps-table .col-remove { grid-area: remove; }
  /* Inputs lose their transparent-by-default look on mobile so the
     controls read as discrete fields rather than blending into the row. */
  .vf-steps-table input[type=text], .vf-steps-table input[type=email], .vf-steps-table input[type=date] {
    border: 1px solid #30363d; background: #161b22;
  }
}
`;

const TRUST_LABELS = {
  verified: 'verified — cryptographic proof the sender wrote it (DKIM + DMARC both pass)',
  forwarded: 'forwarded — OK through trusted mail relays (e.g. Gmail forwarding)',
  authorized: 'authorized — OK from the sender\u2019s domain mail servers (SPF only)',
  unverified: 'unverified — accept any reply, no proof required',
};

function renderWorkflowForm({ values = {}, errors = [], event = null, viewOnly = false } = {}) {
  // Three modes share this template:
  //   - create  (event=null)               — fully editable; submit creates.
  //   - edit    (event set, viewOnly=false) — locks per status; submit saves.
  //   - view    (event set, viewOnly=true)  — everything disabled; no submit.
  // The view mode lets us reuse the familiar create layout as the
  // pending-activation dashboard so the organiser sees what they
  // typed, in the same shape they typed it.
  const isEdit = !!event;
  const isActivated = isEdit && !!event.activated_at;
  if (isEdit) {
    values = {
      title: event.title,
      initiator: event.initiator,
      min_trust_level: event.min_trust_level,
      step_name: (event.steps || []).map((s) => s.name || ''),
      step_participant: (event.steps || []).map((s) => s.participant || ''),
      step_deadline: (event.steps || []).map((s) => s.deadline || ''),
      step_requires_attachment: (event.steps || []).map((s) => (s.requires_attachment ? 'on' : '')),
      step_depends_on: (event.steps || []).map((s) => {
        const ids = s.depends_on || [];
        return ids.map((d) => {
          const idx = (event.steps || []).findIndex((x) => x.id === d);
          return idx >= 0 ? String(idx + 1) : d;
        }).join(', ');
      }),
      step_details: (event.steps || []).map((s) => s.details || ''),
      _step_id: (event.steps || []).map((s) => s.id),
      _step_status: (event.steps || []).map((s) => s.status || 'pending'),
    };
  }
  const names = values.step_name || [];
  const participants = values.step_participant || [];
  const deadlines = values.step_deadline || [];
  const atts = values.step_requires_attachment || [];
  const depsArr = values.step_depends_on || [];
  const detailsArr = values.step_details || [];
  const stepIds = values._step_id || [];
  const stepStatuses = values._step_status || [];
  const stepRows = isEdit ? names.length : Math.max(2, names.length || 2);
  const selectedTrust = values.min_trust_level || 'verified';
  const trustOpts = VALID_TRUST_LEVELS.map((t) => html`
    <option value="${t}" ${selectedTrust === t ? raw('selected') : ''}>${TRUST_LABELS[t] || t}</option>
  `);
  const rows = [];
  for (let i = 0; i < stepRows; i++) {
    const n = names[i] || '';
    const p = participants[i] || '';
    const d = deadlines[i] || '';
    const a = atts[i] === 'on' || atts[i] === true;
    const dep = depsArr[i] || '';
    const det = detailsArr[i] || '';
    const detOpen = det.length > 0;
    // Edit-mode locks: step name and depends_on always locked (changing
    // them rewrites the meaning of recorded commits); completed steps
    // freeze every field. Open steps stay editable: participant,
    // aspirational date, requires_attachment, details.
    const stepStatus = stepStatuses[i] || 'pending';
    const stepFrozen = isEdit && stepStatus === 'complete';
    const lockStructural = isEdit || viewOnly; // name + depends_on
    const lockEditableFields = stepFrozen || viewOnly;
    const dis = (cond) => (cond ? raw('disabled') : raw(''));
    const rowOpacity = stepFrozen ? 'opacity:0.55;' : '';
    rows.push(html`
      <tr style="${raw(rowOpacity)}">
        <td class="col-num">${i + 1}${stepFrozen ? html` <span title="completed — frozen" style="color:#3fb950">✓</span>` : raw('')}</td>
        <td class="col-name">
          <input type="text" name="step_name" value="${n}" maxlength="200" placeholder="step name" ${dis(lockStructural)}>
          ${isEdit && stepIds[i] && !stepFrozen ? html`<input type="hidden" name="step_id" value="${stepIds[i]}">` : raw('')}
        </td>
        <td class="col-email"><input type="email" name="step_participant" value="${p}" placeholder="email@…" ${dis(lockEditableFields)}></td>
        <td class="col-dl"><input type="date" name="step_deadline" value="${d ? d.slice(0, 10) : ''}" ${dis(lockEditableFields)}></td>
        <td class="col-deps"><input type="text" name="step_depends_on" value="${dep}" placeholder="e.g. 1" title="${lockStructural ? raw('Locked in edit mode — changing dependencies mid-flight rewrites the meaning of recorded replies.') : raw('step numbers this step waits for, comma-separated')}" ${dis(lockStructural)}></td>
        <td class="col-att"><input type="checkbox" name="step_requires_attachment" value="${isEdit ? stepIds[i] || 'on' : 'on'}" ${a ? raw('checked') : ''} title="requires attachment" ${dis(lockEditableFields)}></td>
        <td class="col-remove">${(!isEdit && stepRows > 1) ? html`<button type="submit" class="vf-remove-step" formaction="/events/new" formmethod="GET" name="_remove_step" value="${String(i)}" title="remove this step" aria-label="remove step ${String(i + 1)}">×</button>` : raw('')}</td>
      </tr>
      <tr class="vf-details-row ${detOpen ? raw('has-content open') : ''}">
        <td colspan="7">
          <button type="button" class="vf-details-toggle" data-toggle-details title="long-form instructions for the participant (optional, up to 4096 chars)"></button>
          <div class="vf-details-wrap">
            <textarea name="step_details" maxlength="4096" placeholder="Optional plain-text details for the participant. Example: 'Please review section 3.2 of the contract, focus on indemnification language. Reply with signed PDF or inline notes.' Shown in the invite email." ${dis(lockEditableFields)}>${det}</textarea>
            <div class="vf-details-count" data-details-count>0 / 4096</div>
          </div>
        </td>
      </tr>
    `);
  }
  const errBlock = errors.length
    ? html`<div class="vf-errors">
        <strong>Please fix:</strong>
        <ul>${errors.map((e) => html`<li>${e}</li>`)}</ul>
      </div>`
    : raw('');
  // Header copy + form action differ between create and edit, but the
  // form structure is identical so the organiser sees the same layout
  // they used to create the event, with the locked rows visibly greyed.
  const formAction = isEdit ? `/manage/event/${event.id}/edit` : '/events';
  const backHref = isEdit ? `/manage/event/${event.id}` : '/';
  const backLabel = isEdit ? '← back to dashboard' : '← back';
  const lede = viewOnly
    ? 'Pending — review the details you entered. Press Activate above to send invitations, Edit to fix anything, or Cancel to delete.'
    : (isEdit
      ? `Edit open steps. Completed steps are frozen — their entry in the audit trail is permanent. Step name and dependencies are locked: changing them mid-flight would rewrite the meaning of replies already recorded.`
      : 'An auditable multi-party workflow — ordered steps, parallel steps, or a DAG with explicit dependencies.');
  const submitLabel = isEdit ? 'Save changes' : 'Create event';
  const titleLocked = (isEdit && isActivated) || viewOnly;
  return html`
    ${viewOnly ? raw('') : html`<p style="margin:0 0 0.4rem"><a href="${backHref}" style="color:#8b949e;font-size:0.88em">${backLabel}</a></p>`}
    <p style="margin:0 0 1rem;color:#8b949e;font-size:0.9em">${lede}</p>
    ${errBlock}
    <style>${raw(WORKFLOW_FORM_CSS)}</style>
    <form class="vf-form" method="${viewOnly ? raw('GET') : raw('POST')}" action="${formAction}" data-variant-root="F">

      <h2><span class="num">1</span>What + Who <span class="hint">${isEdit ? raw('event title and organiser (locked)') : raw('event title and who runs it')}</span></h2>
      <div class="vf-section">
        <div class="vf-row">
          <label>
            <span>Title${titleLocked ? raw(' <em style="color:#6e7681;text-transform:none;letter-spacing:0;font-size:0.85em">— locked, already in subjects</em>') : raw('')}</span>
            <input type="text" name="title" value="${values.title || ''}" required maxlength="200" placeholder="e.g. Q2 sign-off" ${titleLocked ? raw('disabled') : raw('')}>
          </label>
          <label>
            <span>${isEdit ? raw('Organiser') : raw('Your email')}</span>
            <input type="email" name="initiator" value="${values.initiator || ''}" required placeholder="you@example.com" ${isEdit ? raw('disabled') : raw('')}>
          </label>
        </div>
      </div>

      <h2><span class="num">2</span>Trust <span class="hint">${isEdit ? raw('locked — changing this would rewrite the gating policy on existing replies') : raw('how strict should reply verification be — higher = more proof, fewer accepted replies')}</span></h2>
      <div class="vf-section">
        <label style="max-width:520px">
          <span>Minimum trust</span>
          <select name="min_trust_level" ${isEdit ? raw('disabled') : raw('')}>${trustOpts}</select>
        </label>
      </div>

      <h2><span class="num">3</span>Steps <span class="hint">${String(stepRows)} · each gets a unique reply-to · <em>Depends on</em>: step numbers, comma-separated; empty = runs immediately · <em>Deadline</em>: soft — later replies still count, you're notified if overdue</span></h2>
      <div class="vf-section">
        <table class="vf-steps-table">
          <thead>
            <tr>
              <th class="col-num">#</th>
              <th class="col-name">Step</th>
              <th class="col-email">Participant</th>
              <th class="col-dl" title="Soft deadline — later replies still count, but you'll be notified if a step is overdue">Deadline</th>
              <th class="col-deps" title="step numbers this step waits for">Depends on</th>
              <th class="col-att" title="requires attachment">att</th>
              <th class="col-remove"></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        ${(isEdit || viewOnly) ? raw('') : html`<p class="vf-add-row">
          <button type="submit" formaction="/events/new" formmethod="GET" name="_add_step" value="1">+ add step</button>
        </p>`}
      </div>

      ${viewOnly ? raw('') : html`<button type="submit" class="vf-submit">${submitLabel}</button>`}
    </form>
    <script>${raw(`
      (function(){
        var tbody = document.querySelector('.vf-steps-table tbody');
        if (!tbody) return;

        // Deadline hint: when a step has a depends_on, the deadline becomes
        // a hard-cap SLA on top of the implicit "wait for deps" rule.
        function syncDeadline(row){
          if (!row.matches('tr:not(.vf-details-row)')) return;
          var dep = row.querySelector('input[name="step_depends_on"]');
          var dl  = row.querySelector('input[name="step_deadline"]');
          if (!dep || !dl) return;
          var hasDep = dep.value.trim().length > 0;
          // Tooltip-only hint. We used to dim the field to opacity 0.55,
          // but that read as "disabled" — confusing when the field is
          // very much editable. The tooltip alone carries the meaning.
          dl.title = hasDep
            ? 'Optional — step already waits for its dependencies. Set only if you need a wall-clock cap.'
            : '';
        }

        // Details toggle: "+ details" / "- details" opens the textarea row.
        // If the textarea has content on load, the row is pre-opened (via
        // the server-rendered .open class) so edits don't hide content.
        tbody.addEventListener('click', function(e){
          var btn = e.target.closest('[data-toggle-details]');
          if (!btn) return;
          btn.closest('tr.vf-details-row').classList.toggle('open');
        });

        // Details char counter.
        function syncCount(ta){
          var box = ta.closest('.vf-details-row').querySelector('[data-details-count]');
          if (!box) return;
          var len = ta.value.length;
          box.textContent = len + ' / 4096';
          box.classList.toggle('over', len > 4096);
        }

        tbody.addEventListener('input', function(e){
          var t = e.target;
          if (t.name === 'step_depends_on' || t.name === 'step_deadline') syncDeadline(t.closest('tr'));
          if (t.name === 'step_details') syncCount(t);
        });

        // initial sync
        Array.prototype.forEach.call(tbody.querySelectorAll('tr:not(.vf-details-row)'), syncDeadline);
        Array.prototype.forEach.call(tbody.querySelectorAll('textarea[name="step_details"]'), syncCount);
      })();
    `)}</script>
  `;
}

router.get('/events/new', async (req, res) => {
  // Support "+ Add another step" by carrying over query-string values.
  const u = new URL(req.url, `http://${req.headers.host}`);
  const sp = u.searchParams;
  const values = {
    title: sp.get('title') || '',
    initiator: sp.get('initiator') || '',
    min_trust_level: sp.get('min_trust_level') || 'verified',
    step_name: sp.getAll('step_name'),
    step_participant: sp.getAll('step_participant'),
    step_deadline: sp.getAll('step_deadline'),
    step_depends_on: sp.getAll('step_depends_on'),
    step_details: sp.getAll('step_details'),
  };
  // If _add_step is set, add an empty step slot
  if (sp.get('_add_step')) {
    values.step_name.push('');
    values.step_participant.push('');
    values.step_deadline.push('');
    values.step_depends_on.push('');
    values.step_details.push('');
  }
  // If _remove_step=<index> is set, splice that row from every parallel
  // array. Never remove the last remaining step — validation requires ≥1.
  const removeIdx = parseInt(sp.get('_remove_step') || '', 10);
  if (Number.isInteger(removeIdx) && removeIdx >= 0
      && removeIdx < values.step_name.length && values.step_name.length > 1) {
    values.step_name.splice(removeIdx, 1);
    values.step_participant.splice(removeIdx, 1);
    values.step_deadline.splice(removeIdx, 1);
    values.step_depends_on.splice(removeIdx, 1);
    values.step_details.splice(removeIdx, 1);
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(layout({
    title: 'create event — gitdone',
    description: 'Create a multi-party workflow that runs over email. DKIM-verified replies, OpenTimestamped, committed to a per-event git repository. No accounts, no API.',
    canonical: `${publicBaseUrl()}/events/new`,
    body: renderWorkflowForm({ values }),
  }));
});

const { renderFlowProse, levelsByStep } = require('../src/web/flow-prose');

// Reusable preview/confirmation page. Called on first POST to /events;
// users can then confirm to create, or go back to edit the form.
const PREVIEW_CSS = `
.pv { margin: 1rem 0 1.5rem; }
.pv h1 { font-size: 1.4rem; margin: 0 0 0.4rem; letter-spacing: -0.02em; }
.pv .lede { color: #8b949e; font-size: 0.92em; margin: 0 0 1.2rem; }
.pv h2 { font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.12em; color: #8b949e; margin: 1.1rem 0 0.4rem; }
.pv .kv { display: grid; grid-template-columns: auto 1fr; gap: 0.35rem 1rem; font-size: 0.93em; }
.pv .kv dt { color: #8b949e; }
.pv .kv dd { margin: 0; }
.pv .kv dd code { background: #161b22; color: #ffb000; }
.pv .flow { background: #161b22; border: 1px solid #30363d; padding: 0.7rem 0.9rem; font-size: 0.95em; color: #3fb950; }
.pv ol.steps { margin: 0; padding: 0; list-style: none; border: 1px solid #30363d; }
.pv ol.steps li { padding: 0.55rem 0.85rem; border-bottom: 1px solid #21262d; display: grid; grid-template-columns: 2.2rem 1fr; gap: 0.7rem; align-items: baseline; }
.pv ol.steps li:last-child { border-bottom: 0; }
.pv ol.steps .n { color: #3fb950; font-weight: 700; text-align: right; font-variant-numeric: tabular-nums; }
.pv ol.steps .name { font-weight: 600; color: #c9d1d9; margin-right: 0.5em; }
.pv ol.steps .sub { color: #8b949e; font-size: 0.88em; margin-top: 0.2em; }
.pv ol.steps .sub code { background: #161b22; }
.pv ol.steps .chip { display: inline-block; font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.1em;
                     color: #58a6ff; border: 1px solid #58a6ff; padding: 0.1em 0.45em; margin-right: 0.4em; }
.pv ol.steps .chip.att { color: #ffb000; border-color: #ffb000; }
.pv ol.steps .chip.dep { color: #3fb950; border-color: #3fb950; }
.pv ol.steps .details { margin-top: 0.35rem; padding: 0.45rem 0.7rem; background: #161b22; border-left: 2px solid #3fb950; font-size: 0.88em; color: #c9d1d9; white-space: pre-wrap; line-height: 1.5; }
.pv .actions { display: flex; gap: 0.7rem; margin-top: 1.3rem; flex-wrap: wrap; }
.pv .actions button { font-family: inherit; font-size: 0.9em; padding: 0.65rem 1.4rem; border-radius: 0;
                      cursor: pointer; letter-spacing: 0.05em; text-transform: uppercase; font-weight: 600; }
.pv .actions .confirm { background: #3fb950; color: #0d1117; border: 0; }
.pv .actions .confirm:hover { background: #ffb000; }
.pv .actions .edit { background: transparent; color: #8b949e; border: 1px solid #30363d; }
.pv .actions .edit:hover { background: #161b22; color: #c9d1d9; }
@media (max-width: 540px) {
  /* Share the row 50/50 instead of wrapping; shrink padding + font so
     "Confirm & send invites ▸" still fits. */
  .pv .actions { flex-wrap: nowrap; gap: 0.5rem; }
  .pv .actions button { flex: 1 1 0; min-width: 0; padding: 0.65rem 0.6rem;
                        font-size: 0.82em; letter-spacing: 0.04em; }
}
`;

const TRUST_LABEL_SHORT = {
  verified: 'verified (strict DKIM + DMARC)',
  forwarded: 'forwarded (trusted mail relays OK)',
  authorized: 'authorized (SPF-only OK)',
  unverified: 'unverified (any reply)',
};

// Pre-flight MX-record lookup on the initiator. Catches the
// no-such-domain case ("avoidaccess@gmaicom") that EMAIL_RE accepts —
// silently letting it through means the activation magic-link bounces
// hours later, the user never gets it, and there's no recovery channel
// since Mode A has no session yet.
//
// Misses the within-real-domain typo case ("avoidaccess@gmaiil.com" —
// real MX); the Phase D DSN handler picks that up by deleting the
// pending event when the bounce arrives. Both layers together close
// the silent-failure gap.
//
// Fail-soft on non-typo DNS errors: if the resolver itself blows up
// (timeout, SERVFAIL), accept the address and let the bounce path do
// its work. Better to occasionally over-accept than to block a
// legitimate user because a recursive resolver hiccuped.
async function checkInitiatorMx(email) {
  // Tests shouldn't depend on the network or on external DNS reality.
  // The opt-out env var lets the integration suite skip MX while still
  // exercising it in the dedicated MX-check test.
  if (process.env.GITDONE_SKIP_MX_CHECK === '1') return { ok: true, soft: true };
  const at = String(email || '').lastIndexOf('@');
  if (at < 0) return { ok: false, reason: 'invalid' };
  const domain = email.slice(at + 1).toLowerCase();
  const dns = require('node:dns').promises;
  try {
    const records = await dns.resolveMx(domain);
    // RFC 7505 — a "null MX" record (priority 0, exchange "." or empty)
    // means the domain explicitly refuses mail. No A-record fallback;
    // delivery would silently black-hole. Catch it as a typo signal.
    const nullMx = Array.isArray(records) && records.length > 0 && records.every(r => {
      const ex = String(r && r.exchange || '').replace(/\.$/, '');
      return ex === '' && (r.priority === 0 || r.priority == null);
    });
    if (nullMx) return { ok: false, reason: 'domain refuses mail (null MX)' };
    const real = Array.isArray(records) ? records.filter(r => String(r && r.exchange || '').replace(/\.$/, '') !== '') : [];
    if (real.length === 0) {
      // RFC 5321 §5.1 — when no MX exists, the A/AAAA record of the
      // domain is the implicit MX. Check that fallback so domains
      // hosted directly off A records (rare but valid) still pass.
      try {
        const a = await dns.resolve(domain);
        if (a && a.length) return { ok: true };
      } catch { /* fall through to invalid */ }
      return { ok: false, reason: 'no MX record' };
    }
    return { ok: true };
  } catch (err) {
    const code = err && err.code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      // Try A/AAAA fallback before giving up.
      try {
        const a = await require('node:dns').promises.resolve(domain);
        if (a && a.length) return { ok: true };
      } catch { /* genuine no-such-domain */ }
      return { ok: false, reason: 'domain does not resolve' };
    }
    // Soft-fail on transient DNS issues so we don't block legitimate
    // users when the resolver is grumpy.
    return { ok: true, soft: true };
  }
}

// Catches typos at preview time instead of waiting for a DSN bounce
// that may never arrive when the receiving MTA black-holes the address.
async function checkParticipantsMx(steps) {
  const failures = [];
  // De-dupe by lowercased address so multi-step participants get one lookup.
  const seen = new Map();
  for (let i = 0; i < steps.length; i++) {
    const addr = String(steps[i].participant || '').trim();
    if (!addr) continue;
    const key = addr.toLowerCase();
    if (!seen.has(key)) seen.set(key, addr);
  }
  for (const addr of seen.values()) {
    const r = await checkInitiatorMx(addr);
    if (!r.ok) failures.push({ email: addr, reason: r.reason });
  }
  return failures;
}

function renderPreview({ validated, rawBody }) {
  const { title, initiator, min_trust_level, steps } = validated;
  // Order steps by execution level so the list reads top-down in run order.
  const levels = levelsByStep(steps);
  const ordered = steps.map((s, i) => ({ s, i, level: levels[i] }))
    .sort((a, b) => a.level - b.level || a.i - b.i);
  const flow = renderFlowProse(steps);

  // Hidden fields to carry the form state across the confirm/edit POST.
  const hidden = [];
  function hid(name, value) {
    hidden.push(html`<input type="hidden" name="${name}" value="${value == null ? '' : String(value)}">`);
  }
  hid('title', rawBody.title);
  hid('initiator', rawBody.initiator);
  hid('min_trust_level', rawBody.min_trust_level);
  const rowArr = (k) => Array.isArray(rawBody[k]) ? rawBody[k] : (rawBody[k] != null ? [rawBody[k]] : []);
  const names = rowArr('step_name');
  const parts = rowArr('step_participant');
  const dls = rowArr('step_deadline');
  const atts = rowArr('step_requires_attachment');
  const deps = rowArr('step_depends_on');
  const details = rowArr('step_details');
  for (let i = 0; i < names.length; i++) {
    hid('step_name', names[i]);
    hid('step_participant', parts[i]);
    hid('step_deadline', dls[i]);
    hid('step_depends_on', deps[i]);
    hid('step_details', details[i]);
    // Checkbox semantics: only include the hidden when it was on.
    if (atts[i] === 'on' || atts[i] === true) hid('step_requires_attachment', 'on');
    else hid('step_requires_attachment', '');
  }

  return html`
    <style>${raw(PREVIEW_CSS)}</style>
    <div class="pv">
      <h1>Preview — confirm to create</h1>
      <p class="lede">Review below. When you confirm, each participant receives an email invite.</p>

      <h2>Event</h2>
      <dl class="kv">
        <dt>Title</dt><dd><strong>${title}</strong></dd>
        <dt>Organizer</dt><dd><code style="background:#161b22;color:#ffb000;padding:0.15em 0.45em;font-size:1.05em;font-weight:600">${initiator}</code> <span style="color:#8b949e;font-size:0.86em">— double-check this; the activation link goes here</span></dd>
        <dt>Min trust</dt><dd>${TRUST_LABEL_SHORT[min_trust_level] || min_trust_level}</dd>
      </dl>

      <h2>Flow</h2>
      <p class="flow">${flow}</p>

      <h2>Steps, in execution order</h2>
      <ol class="steps">
        ${ordered.map(({ s, i }) => {
          const depLabels = (s.depends_on || []).map((depId) => {
            const idx = steps.findIndex((x) => x.id === depId);
            return idx >= 0 ? `step ${idx + 1}` : depId;
          });
          return html`
            <li>
              <span class="n">${i + 1}</span>
              <div>
                <span class="name">${s.name}</span> → <code>${s.participant}</code>
                <div class="sub">
                  ${depLabels.length ? html`<span class="chip dep">after ${depLabels.join(', ')}</span>` : raw('')}
                  ${s.requires_attachment ? html`<span class="chip att">attachment required</span>` : raw('')}
                  ${s.deadline ? html`deadline: <code>${s.deadline.slice(0, 10)}</code>` : html`<span style="color:#6e7681">no deadline</span>`}
                </div>
                ${s.details ? html`<div class="details">${s.details}</div>` : raw('')}
              </div>
            </li>
          `;
        })}
      </ol>

      <form method="POST" action="/events">
        ${hidden}
        <div class="actions">
          <button name="_action" value="confirm" class="confirm">Confirm &amp; send invites ▸</button>
          <button name="_action" value="edit" class="edit" formnovalidate>← Go back to edit</button>
        </div>
      </form>
    </div>
  `;
}

router.post('/events', async (req, res) => {
  let body;
  try { body = await parseBody(req); }
  catch (err) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    return res.end(`bad request: ${err.message}`);
  }

  // Two-step flow:
  //   first POST (no _action)           → validate + show preview
  //   POST with _action=edit            → re-render form with values
  //   POST with _action=confirm         → re-validate + createEvent + emails
  const action = String(body._action || '').toLowerCase();

  if (action === 'edit') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(layout({ title: 'edit event — gitdone', body: renderWorkflowForm({ values: body }) }));
  }

  const v = validateWorkflowEvent(body);
  if (!v.ok) {
    res.writeHead(422, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(layout({
      title: 'fix errors — gitdone',
      body: renderWorkflowForm({ values: body, errors: v.errors }),
    }));
  }

  if (action !== 'confirm') {
    // First POST — show preview.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(layout({
      title: 'preview — gitdone',
      body: renderPreview({ validated: v.value, rawBody: body }),
    }));
  }

  // Pre-flight MX check on the organiser email. EMAIL_RE accepts
  // syntax-only typos like "you@gmaicom"; sending an activation link
  // there bounces silently and the user has no recovery path. If the
  // domain has no MX (or A/AAAA fallback) we re-render the form with
  // an inline error.
  const mxCheck = await checkInitiatorMx(v.value.initiator);
  const participantFailures = await checkParticipantsMx(v.value.steps || []);
  if (!mxCheck.ok || participantFailures.length) {
    const errors = [];
    if (!mxCheck.ok) {
      errors.push(`organiser email "${v.value.initiator}" — ${mxCheck.reason}. Did you mean a different domain?`);
    }
    for (const f of participantFailures) {
      errors.push(`participant email "${f.email}" — ${f.reason}. Did you mean a different domain?`);
    }
    res.writeHead(422, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(layout({
      title: 'fix errors — gitdone',
      body: renderWorkflowForm({ values: body, errors }),
    }));
  }
  // Confirmed — persist event in pending-activation state, then trigger
  // knowless Mode A. The magic link both verifies email ownership AND
  // opens a session whose nextUrl lands on the event dashboard.
  const event = await createEvent({
    type: 'event',
    ...v.value,
  });
  const confirmPath = `/manage/event/${event.id}/confirmed?t=${event.activation_ack_token}`;
  const auth = await getAuth();
  // Always send the magic-link round-trip, even when the requester is
  // already signed in as the initiator. The email artifact is part of
  // the activation gate per PRD §6.1: every event creation produces
  // its own email-ownership receipt before participants can be
  // notified. Skipping it for "same session" turned the activation
  // gate into something the same-tab dashboard could bypass. nextUrl
  // routes through /confirmed so the click flips
  // event.activation_link_clicked_at — without that flip the
  // dashboard hides the Activate button.
  await auth.startLogin({
    email: event.initiator,
    nextUrl: confirmPath,
    sourceIp: req.socket.remoteAddress || '',
    subjectOverride: activationSubject(event.title),
    bodyOverride: buildEventActivationBody(event),
    // gitdone is the trusted server-side caller (AF-10). The per-IP
    // new-handle limit is meant for self-serve login forms; here the
    // rate-limiting concern is event creation itself, which lives at
    // gitdone's layer, not at knowless's.
    bypassRateLimit: true,
  });
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(layout({
    title: 'event created — gitdone',
    body: renderCheckYourInboxPage({ event, kind: 'event' }),
  }));
});

// Build the magic-link email body for a workflow event. knowless calls
// this with the magic-link URL it composes; we surround it with the
// event-specific context (steps list, command tags, manage link).
// Constraints from validateBodyOverride: ASCII only, no CR, ≤2048 chars,
// URL on its own line and present exactly once.
function buildEventActivationBody(event) {
  const safeTitle = asciiSafe(event.title);
  const safeInitiator = asciiSafe(event.initiator);
  // Map step ids to their 1-based index so depends_on can be rendered
  // as "after #2" instead of an opaque internal id.
  const indexById = new Map(event.steps.map((s, i) => [s.id, i + 1]));
  // Per-step block: name + email on the first line, an inline tag list
  // (deadline / attachment / depends-on) on the second, and a one-line
  // truncated details preview on the third when present. Line two and
  // three are skipped if they would be empty so steps with no metadata
  // stay tight.
  const stepBlocks = event.steps.map((s, i) => {
    const tags = [];
    if (s.deadline) tags.push(`deadline ${asciiSafe(String(s.deadline).slice(0, 10))}`);
    if (s.requires_attachment) tags.push('attachment required');
    const deps = (s.depends_on || [])
      .map((d) => indexById.get(d))
      .filter(Boolean)
      .map((n) => `#${n}`);
    if (deps.length) tags.push(`after ${deps.join(', ')}`);
    const lines = [`  ${i + 1}. ${asciiSafe(s.name)} - ${asciiSafe(s.participant)}`];
    if (tags.length) lines.push(`     ${tags.join(' . ')}`);
    if (s.details) {
      const oneLine = asciiSafe(String(s.details)).replace(/\s+/g, ' ').trim();
      if (oneLine) lines.push(`     brief: ${oneLine.length > 80 ? oneLine.slice(0, 77) + '...' : oneLine}`);
    }
    return lines.join('\n');
  });
  // knowless caps the body at 2048 chars. Truncate the steps section if
  // a 50-step event with rich details would otherwise blow the budget.
  // Keep the first N steps that fit under ~1200 chars and summarise the
  // rest; the dashboard has the full list anyway.
  const STEPS_BUDGET = 1200;
  const kept = [];
  let used = 0;
  for (const block of stepBlocks) {
    if (used + block.length + 1 > STEPS_BUDGET && kept.length > 0) break;
    kept.push(block);
    used += block.length + 1;
  }
  const omitted = stepBlocks.length - kept.length;
  if (omitted > 0) {
    kept.push(`  ... and ${omitted} more step${omitted === 1 ? '' : 's'} (open the dashboard for the full list)`);
  }
  const stepsList = kept.join('\n');

  // knowless appends bodyFooter after the override returns (with the
  // -- signature delimiter), so we must NOT also call withSignature
  // here — that double-signs the body.
  return ({ url }) => ([
    `You created the event "${safeTitle}" on gitdone.`,
    ``,
    `Clicking the link below signs you in and opens the event dashboard.`,
    `Review the steps below, then press Activate on the dashboard to send`,
    `invitations. Nothing leaves the server until you press Activate; if`,
    `you decide not to go ahead, just ignore this email.`,
    `Sign-in link is valid for 15 minutes; request a new one at`,
    `${publicBaseUrl()}/manage if it expires.`,
    ``,
    url,
    ``,
    `Event ID: ${event.id}`,
    `Minimum trust: ${event.min_trust_level}`,
    ``,
    `Steps that will be notified on Activate:`,
    stepsList,
    ``,
    `Day-to-day commands by email from ${safeInitiator}:`,
    `  stats+${event.id}@${config.domain}    see current progress`,
    `  remind+${event.id}@${config.domain}   nudge pending participants`,
    `  close+${event.id}@${config.domain}    close the event early`,
    `  bundle+${event.id}@${config.domain}   get the full audit-trail repo as .tar.gz`,
    ``,
    `Manage your events at: ${publicBaseUrl()}/manage`,
  ].join('\n'));
}

// Plain-English one-liner per dedup rule. Used in the activation email
// and on the manage dashboard so the organiser sees what the rule does
// in their own words, not just the rule name.
function dedupDescription(rule) {
  if (rule === 'unique') return 'one DKIM-verified reply per sender counts';
  if (rule === 'latest') return 'latest DKIM-verified reply per sender counts';
  if (rule === 'accumulating') return 'every reply counts, DKIM-verified or not';
  return '';
}

// Build the magic-link email body for a crypto event (declaration or
// attestation). Same validation constraints as buildEventActivationBody.
function buildCryptoActivationBody(event) {
  const safeTitle = asciiSafe(event.title);
  const safeInitiator = asciiSafe(event.initiator);
  const safeSigner = asciiSafe(event.signer);
  const safeDetails = event.details ? asciiSafe(event.details) : null;
  const replyAddr = `event+${event.id}@${config.domain}`;
  const attachAddr = `attach+${event.id}@${config.domain}`;
  const strictMode = !!event.reference_url;
  const modeDetails = event.mode === 'declaration'
    ? [
        `Mode: declaration - one DKIM-verified reply from the designated signer.`,
        `Signer: ${safeSigner}`,
      ]
    : [
        `Mode: attestation - ${event.threshold} distinct signers needed (${event.dedup} dedup).`,
        `Dedup rule: ${event.dedup} - ${dedupDescription(event.dedup)}`,
        `Share the reply address below however you like - social, email, QR.`,
      ];
  return ({ url }) => {
    const lines = [
      `You created the crypto event "${safeTitle}" on gitdone.`,
      ``,
      `Clicking the link below signs you in and opens the event dashboard.`,
      `Review the details below, then press Activate on the dashboard to make`,
      `the reply address live${event.mode === 'declaration' && !strictMode ? ' and notify the signer' : ''}. Nothing leaves the server until you press`,
      `Activate; if you decide not to go ahead, just ignore this email.`,
      `Sign-in link is valid for 15 minutes; request a new one at`,
      `${publicBaseUrl()}/manage if it expires.`,
      ``,
      url,
      ``,
      `Event ID: ${event.id}`,
      ...modeDetails,
    ];
    if (safeDetails) {
      lines.push(``, `The ask:`, ...safeDetails.split('\n').map((l) => `  ${l}`));
    }
    if (event.reference_url) {
      lines.push(``, `Reference URL:`, `  ${event.reference_url}`);
    }
    if (strictMode) {
      lines.push(
        ``,
        `IMPORTANT - reference documents required before signing:`,
        `  After you press Activate, gitdone will email you back asking`,
        `  you to attach the reference document${event.mode === 'declaration' ? '' : 's'} in ONE reply (one-shot`,
        `  freeze) to:`,
        `    ${attachAddr}`,
        `  Once we receive your docs, we will${event.mode === 'declaration' ? ' invite the signer' : ' open the reply address'} with the`,
        `  file list and sha256 hashes. Until then, signing is held.`,
      );
    }
    lines.push(
      ``,
      `Reply address (goes live on activation):`,
      `  ${replyAddr}`,
      ``,
      `Day-to-day commands by email from ${safeInitiator}:`,
      `  stats+${event.id}@${config.domain}    current state`,
      `  close+${event.id}@${config.domain}    close early`,
      `  bundle+${event.id}@${config.domain}   get the full audit-trail repo as .tar.gz`,
      ``,
      `Manage your events at: ${publicBaseUrl()}/manage`,
    );
    return lines.join('\n');
  };
}

// knowless caps subjects at 60 strictly-ASCII chars (no CR/LF). Strip
// non-ASCII so a non-Latin event title doesn't 500 the create-event
// response, then truncate to fit alongside the bracketed prefix.
function activationSubject(title) {
  // Match the [gitdone] "<title>" - <verb> shape used by every other
  // outbound subject (completion, bounce, please-sign, etc.) so the
  // sender alias every mail client groups by stays just "gitdone"
  // instead of fragmenting into "gitdone activate <title>" etc.
  // ASCII-only because knowless's validateSubject (60-char cap, no
  // CR/LF, ASCII-only) gates this string before sending.
  const prefix = '[gitdone] "';
  const suffix = `" - activate within ${config.activationTtlHours}h`;
  const room = 60 - prefix.length - suffix.length;
  const ascii = String(title).replace(/[\r\n]/g, ' ').replace(/[^\x20-\x7e]/g, '');
  const safe = ascii.trim() || 'event';
  const trimmed = safe.length > room ? safe.slice(0, room - 3) + '...' : safe;
  return prefix + trimmed + suffix;
}

// Strip CR/LF and non-ASCII so user-supplied strings can't break
// knowless's body validator (ASCII-only, URL on its own line). Returns
// the original string if already safe.
function asciiSafe(s) {
  return String(s == null ? '' : s).replace(/[\r\n]/g, ' ').replace(/[^\x20-\x7e]/g, '');
}

function renderCheckYourInboxPage({ event, kind }) {
  const noun = kind === 'crypto'
    ? (event.mode === 'declaration' ? 'declaration' : 'attestation')
    : 'event';
  // Module 4d#4 — for crypto events with a reference_url set, the
  // expected flow has TWO extra steps: initiator attaches docs after
  // activation, THEN the signer/attestor invite goes out. Surface
  // those expectations + the ask + the URL up front.
  const strictMode = kind === 'crypto' && !!event.reference_url;
  const detailsBlock = (kind === 'crypto' && event.details)
    ? html`<div style="margin:1.2rem 0 0;padding:0.7rem 0.95rem;background:#0d1117;border-left:3px solid #3fb950;color:#c9d1d9;white-space:pre-wrap;font-size:0.92em;line-height:1.5"><strong style="display:block;color:#8b949e;font-size:0.78em;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:0.25rem">The ask</strong>${event.details}</div>`
    : raw('');
  const refUrlBlock = (kind === 'crypto' && event.reference_url)
    ? html`<p style="margin:0.8rem 0 0;font-size:0.92em"><strong style="color:#8b949e;font-size:0.78em;letter-spacing:0.08em;text-transform:uppercase;display:block;margin-bottom:0.2rem">Reference</strong><a href="${event.reference_url}" rel="noopener noreferrer" target="_blank" title="${event.reference_url}">${truncateText(event.reference_url, 30)}</a></p>`
    : raw('');
  const indexById = event.steps
    ? new Map(event.steps.map((s, i) => [s.id, i + 1]))
    : new Map();
  const stepsBlock = (kind === 'event' && Array.isArray(event.steps) && event.steps.length)
    ? html`
        <h3 style="margin:1.2rem 0 0.4rem;font-size:0.95em;letter-spacing:0.06em;text-transform:uppercase;color:#8b949e">
          ${String(event.steps.length)} step${event.steps.length === 1 ? '' : 's'} queued — will be invited on Activate
        </h3>
        <ol style="margin:0;padding-left:1.4rem;color:#c9d1d9;font-size:0.92em;line-height:1.55">
          ${event.steps.map((s, i) => {
            const tags = [];
            if (s.deadline) tags.push(`deadline ${String(s.deadline).slice(0, 10)}`);
            if (s.requires_attachment) tags.push('attachment required');
            const deps = (s.depends_on || []).map((d) => indexById.get(d)).filter(Boolean).map((n) => `#${n}`);
            if (deps.length) tags.push(`after ${deps.join(', ')}`);
            return html`<li style="margin:0.18rem 0">
              <strong>${s.name}</strong> · <code>${s.participant}</code>${tags.length
                ? html` <span style="color:#6e7681;font-size:0.88em">· ${tags.join(' · ')}</span>`
                : raw('')}
            </li>`;
          })}
        </ol>`
    : raw('');
  return html`
    <style>${raw(PREVIEW_CSS)}</style>
    <div class="pv">
      <p class="lede"><strong>${event.title}</strong> &middot; ID: <code>${event.id}</code></p>
      <div class="mg-flash" style="background:rgba(255,176,0,.08);border:1px solid #ffb000;color:#ffb000;padding:0.7rem 0.95rem;margin-top:1rem;font-size:0.95em;line-height:1.5">
        <strong>Check ${event.initiator}.</strong>
        We sent a sign-in link. Confirm via email — clicking the link is what
        unlocks the Activate button. Until you click it, this page is all you'll see;
        ${kind === 'event'
          ? 'no participants are notified and no replies count.'
          : (event.mode === 'declaration'
              ? 'the signer has not been notified and the reply address is not live.'
              : 'the reply address is not live.')}
      </div>
      ${detailsBlock}
      ${refUrlBlock}
      <ol style="margin:1rem 0 0;padding-left:1.4rem;color:#c9d1d9;font-size:0.92em;line-height:1.6">
        <li>Open your inbox at <code>${event.initiator}</code>.</li>
        <li>Click the gitdone sign-in link (valid 15 minutes).</li>
        <li>You'll land back here on the dashboard for this ${noun}.</li>
        <li>Press <strong>Activate</strong> to ${kind === 'event'
          ? 'send invitations to all named participants'
          : (strictMode
              ? html`turn the reply address live. Right after, we'll email you
              with instructions to <strong>attach the reference document${event.mode === 'declaration' ? '' : 's'}</strong> in
              ONE email to <code>attach+${event.id}@${config.domain}</code> — that's a one-shot freeze.`
              : (event.mode === 'declaration'
                  ? 'invite the signer'
                  : 'make the reply address live'))}.</li>
        ${strictMode ? html`<li>After we receive your docs, gitdone ${event.mode === 'declaration'
              ? html`invites the signer (<code>${event.signer || 'configured signer'}</code>) with the file list + sha256 hashes they must match`
              : html`makes the reply address live; you share it with attestors. Each must attach the same files to count`}.</li>` : raw('')}
      </ol>
      ${stepsBlock}
      ${(() => {
        const expiresAtMs = new Date(event.created_at).getTime() + 72 * 3600 * 1000;
        const expiresLabel = new Date(expiresAtMs).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
        return html`<p style="margin-top:1.2rem;color:#8b949e;font-size:0.88em">
          If you don't sign in by <strong>${expiresLabel}</strong> (72h from creation), the ${noun} is auto-deleted — no record kept.
        </p>`;
      })()}
      <p style="margin-top:1rem"><a href="/">← home</a> &middot; <a href="/manage">your events</a></p>
    </div>
  `;
}

// -------- crypto event creation (1.H.3) --------
// Design Lab variant F: dense one-page grid, no numbered sections. Mode
// picker (declaration | attestation) is a segmented row; fields that don't
// apply to the picked mode stay on screen but dim. Reference:
// docs/01-product/design/landing-and-crypto-v1.md
const CRYPTO_FORM_CSS = `
.vf-errors { background:#0d1117; border:1px solid #f85149; border-left-width:3px; color:#f0b8b8; padding:0.7rem 0.95rem; margin-bottom:1rem; font-size:0.92em; }
.vf-errors strong { color:#f85149; text-transform:uppercase; letter-spacing:0.08em; font-size:0.8em; display:block; margin-bottom:0.35rem; }
.vf-errors ul { margin:0; padding-left:1.2rem; color:#c9d1d9; }
.vf-errors li { margin:0.12rem 0; }
.cf { color: #c9d1d9; }
.cf .head { display: flex; justify-content: space-between; align-items: baseline; margin: 0 0 0.6rem; }
.cf .head h1 { font-size: 1.1rem; font-weight: 600; color: #c9d1d9; margin: 0; letter-spacing: 0.02em; }
.cf .head .mode-note { font-size: 0.82em; color: #8b949e; }
.cf .mode-row { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; padding: 0.7rem; background: #161b22; border: 1px solid #30363d; margin-bottom: 0.9rem; font-size: 0.9em; }
.cf .mode-row label { display: flex; align-items: flex-start; gap: 0.5rem; cursor: pointer; margin: 0; padding: 0.5rem 0.7rem; border: 1px solid transparent; color: #c9d1d9; transition: border-color 0.12s, background 0.12s; }
.cf .mode-row label:hover { background: #0d1117; }
.cf .mode-row label:has(input:checked) { border-color: #3fb950; background: #0d1117; }
.cf .mode-row label input { accent-color: #3fb950; width: auto; margin-top: 0.15em; }
.cf .mode-row label strong { color: #c9d1d9; font-weight: 600; }
.cf .mode-row label small { color: #8b949e; font-size: 0.85em; }
.cf .checkbox small { font-size: 0.85em; }
.cf .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.55rem 0.8rem; }
.cf .grid label { display: block; margin: 0; font-size: 0.9em; color: #c9d1d9; }
.cf .grid label > span { display: block; font-size: 0.72em; color: #8b949e; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 0.2rem; }
.cf .grid input, .cf .grid select, .cf .grid textarea { width: 100%; padding: 0.4rem 0.5rem; font: inherit; background: #161b22; color: #c9d1d9; border: 1px solid #30363d; border-radius: 0; box-sizing: border-box; }
.cf .grid textarea { resize: vertical; min-height: 4em; }
.cf .grid input:focus, .cf .grid select:focus, .cf .grid textarea:focus { border-color: #3fb950; outline: 0; box-shadow: 0 0 0 1px rgba(63,185,80,.2); }
.cf .grid .full { grid-column: 1 / -1; }
.cf .grid .dim { opacity: 0.38; pointer-events: none; }
.cf .grid .dim > span::after { content: ' · declaration only'; color: #6e7681; font-size: 0.9em; text-transform: none; letter-spacing: 0; }
.cf .grid .att > span::after { content: ' · attestation only'; color: #6e7681; font-size: 0.9em; text-transform: none; letter-spacing: 0; }
.cf .checkbox { display: flex; align-items: center; gap: 0.4rem; font-size: 0.85em; grid-column: 1 / -1; color: #c9d1d9; }
.cf .checkbox input { width: auto; margin: 0; }
.cf .actions { display: flex; justify-content: flex-end; margin-top: 1rem; }
.cf .submit { background: #3fb950; color: #0d1117; padding: 0.6rem 1.5rem; border: 0; border-radius: 0; cursor: pointer; font: inherit; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; }
.cf .submit:hover { background: #ffb000; }
@media (max-width: 540px) { .cf .grid { grid-template-columns: 1fr; } }
`;

function renderCryptoForm({ values = {}, errors = [] } = {}) {
  // Default to declaration — the one-signer flow is the more common entry
  // point per user feedback. Attestation is selected explicitly.
  const mode = values.mode === 'attestation' ? 'attestation' : 'declaration';
  const dedup = values.dedup || 'unique';
  const dedupOpts = VALID_DEDUP_RULES.map((d) => html`
    <option value="${d}" ${dedup === d ? raw('selected') : ''}>${d === 'unique'
      ? 'unique — one per sender'
      : d === 'latest'
        ? 'latest — most-recent counts'
        : 'accumulating — every email counts'}</option>
  `);
  const errBlock = errors.length
    ? html`<div class="vf-errors">
        <strong>Please fix:</strong>
        <ul>${errors.map((e) => html`<li>${e}</li>`)}</ul>
      </div>`
    : raw('');
  const signerDim = mode === 'attestation' ? raw('dim') : raw('');
  const attDim = mode === 'declaration' ? raw('dim') : raw('');
  const noteText = mode === 'declaration'
    ? 'declaration · one signer replies, one permanent record'
    : 'attestation · anyone you share the reply address with can sign';
  return html`
    <p style="margin:0 0 0.4rem"><a href="/" style="color:#8b949e;font-size:0.88em">← back</a></p>
    <p style="margin:0 0 1rem;color:#8b949e;font-size:0.9em">A cryptographically timestamped signature — sign something yourself, or gather signatures from a group.</p>
    ${errBlock}
    <style>${raw(CRYPTO_FORM_CSS)}</style>
    <form class="cf" method="POST" action="/crypto" data-variant-root="F">
      <div class="head">
        <h1>Mode</h1>
        <span class="mode-note">${noteText}</span>
      </div>

      <div class="mode-row" role="radiogroup" aria-label="Crypto event mode">
        <label><input type="radio" name="mode" value="declaration" ${mode === 'declaration' ? raw('checked') : ''}>
          <span><strong>declaration</strong><br><small>one signer, one record</small></span></label>
        <label><input type="radio" name="mode" value="attestation" ${mode === 'attestation' ? raw('checked') : ''}>
          <span><strong>attestation</strong><br><small>gather signatures from a group</small></span></label>
      </div>

      <div class="grid">
        <label class="full">
          <span>Title</span>
          <input type="text" name="title" required maxlength="200" value="${values.title || ''}" placeholder="e.g. Proof of being known">
        </label>

        <label class="full">
          <span>Details — the ask <small style="color:#8b949e;font-weight:normal">(what is the signer attesting to or declaring? required)</small></span>
          <textarea name="details" required maxlength="4096" rows="4" placeholder="e.g. I attest that I have read and agree to the terms at https://example.com/terms-2026-05.pdf">${values.details || ''}</textarea>
        </label>

        <label class="full">
          <span>Reference URL <small style="color:#8b949e;font-weight:normal">(optional · https:// link to the document, post, or contract being attested to)</small></span>
          <input type="url" name="reference_url" maxlength="2048" value="${values.reference_url || ''}" placeholder="https://example.com/terms-2026-05.pdf" pattern="https://.*">
        </label>

        <label>
          <span>Your email</span>
          <input type="email" name="initiator" required value="${values.initiator || ''}" placeholder="you@example.com">
        </label>
        <label class="${signerDim}">
          <span>Signer's email</span>
          <input type="email" name="signer" value="${values.signer || ''}" placeholder="witness@example.com">
        </label>

        <label class="${attDim}">
          <span>Threshold (N distinct signers, max 50)</span>
          <input type="number" name="threshold" min="1" max="50" value="${values.threshold || '10'}">
        </label>
        <label class="${attDim}">
          <span>Dedup rule</span>
          <select name="dedup">${dedupOpts}</select>
        </label>
      </div>

      <div class="actions">
        <button type="submit" class="submit">Create →</button>
      </div>
    </form>
    <script>${raw(`
      (function(){
        var form = document.querySelector('form.cf');
        if (!form) return;
        var signerLabel = form.querySelector('input[name="signer"]').closest('label');
        var threshLabel = form.querySelector('input[name="threshold"]').closest('label');
        var dedupLabel  = form.querySelector('select[name="dedup"]').closest('label');
        var note = document.querySelector('.cf .head .mode-note');
        var hint = document.querySelector('.cf .mode-row .hint');
        function setMode(m){
          var isDec = m === 'declaration';
          signerLabel.classList.toggle('dim', !isDec);
          [threshLabel, dedupLabel].forEach(function(el){
            el.classList.toggle('dim', isDec);
            el.classList.toggle('att', isDec);
          });
          // pointer-events: none stops mouse but keyboard tab still
          // focuses the dimmed input — so flag the actual control as
          // disabled. Also clears the value so a stray pre-toggle entry
          // doesn't ride the submission ("signer's email" lingering
          // into an attestation POST and triggering MX-check noise).
          signerLabel.querySelector('input').disabled = !isDec;
          if (!isDec) signerLabel.querySelector('input').value = '';
          [threshLabel.querySelector('input'), dedupLabel.querySelector('select')].forEach(function(c){ c.disabled = isDec; });
          if (note) note.textContent = isDec
            ? 'declaration · one signer replies, one permanent record'
            : 'attestation · anyone you share the reply address with can sign';
          if (hint) hint.textContent = isDec
            ? 'one signer · one permanent record'
            : 'N distinct signers reach a threshold';
        }
        form.addEventListener('change', function(e){
          if (e.target && e.target.name === 'mode') setMode(e.target.value);
        });
        // Apply the disabled state on first render so the dimmed
        // fields don't accept input before the user touches the radio.
        var checked = form.querySelector('input[name="mode"]:checked');
        if (checked) setMode(checked.value);
      })();
    `)}</script>
  `;
}

router.get('/crypto/new', async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const sp = u.searchParams;
  const values = {
    mode: sp.get('mode') || 'declaration',
    title: sp.get('title') || '',
    initiator: sp.get('initiator') || '',
    signer: sp.get('signer') || '',
    threshold: sp.get('threshold') || '',
    dedup: sp.get('dedup') || 'unique',
    details: sp.get('details') || '',
    reference_url: sp.get('reference_url') || '',
  };
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(layout({
    title: 'create crypto — gitdone',
    description: 'Cryptographically timestamped declarations and N-of-M attestations over email. DKIM + OpenTimestamps on every reply. No accounts, no API.',
    canonical: `${publicBaseUrl()}/crypto/new`,
    body: renderCryptoForm({ values }),
  }));
});

router.post('/crypto', async (req, res) => {
  let body;
  try { body = await parseBody(req); }
  catch (err) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    return res.end(`bad request: ${err.message}`);
  }
  const v = validateCryptoEvent(body);
  if (!v.ok) {
    res.writeHead(422, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(layout({
      title: 'fix errors — gitdone',
      body: renderCryptoForm({ values: body, errors: v.errors }),
    }));
  }
  // Pre-flight MX check on the organiser email — see POST /events. For
  // declaration mode, also MX-check the signer; an unreachable signer
  // address is the same typo class as an unreachable workflow
  // participant and we reject both at create time.
  const mxCheck = await checkInitiatorMx(v.value.initiator);
  const signerMxCheck = (v.value.mode === 'declaration')
    ? await checkInitiatorMx(v.value.signer)
    : { ok: true };
  if (!mxCheck.ok || !signerMxCheck.ok) {
    const errors = [];
    if (!mxCheck.ok) {
      errors.push(`organiser email "${v.value.initiator}" — ${mxCheck.reason}. Did you mean a different domain?`);
    }
    if (!signerMxCheck.ok) {
      errors.push(`signer email "${v.value.signer}" — ${signerMxCheck.reason}. Did you mean a different domain?`);
    }
    res.writeHead(422, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(layout({
      title: 'fix errors — gitdone',
      body: renderCryptoForm({ values: body, errors }),
    }));
  }
  // Same pending-activation gate as workflow events: no signer invite
  // (declaration), no reply-address goes live, until the magic link
  // is clicked. See POST /events for details on the knowless Mode A
  // pattern.
  const event = await createEvent(v.value);
  const confirmPath = `/manage/event/${event.id}/confirmed?t=${event.activation_ack_token}`;
  const auth = await getAuth();
  // No same-session shortcut — see POST /events for the rationale.
  await auth.startLogin({
    email: event.initiator,
    nextUrl: confirmPath,
    sourceIp: req.socket.remoteAddress || '',
    subjectOverride: activationSubject(event.title),
    bodyOverride: buildCryptoActivationBody(event),
    bypassRateLimit: true, // see AF-10 note in POST /events
  });
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(layout({
    title: 'crypto event created — gitdone',
    body: renderCheckYourInboxPage({ event, kind: 'crypto' }),
  }));
});


// Debug/read-only event view — helpful during dev; will be locked down
// or removed when 1.H.5 (magic-link management) lands.
// Requires a valid session whose handle matches event.initiator — keeps
// participant emails out of reach for anyone who knows/guesses an event
// ID (PRD §0.1.10). Linked from the /manage/:token dashboard.
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
  const handle = await currentHandle(req);
  let isOwner = false;
  if (handle && event.initiator) {
    try { isOwner = (await getAuth()).deriveHandle(event.initiator) === handle; } catch {}
  }
  if (!isOwner) {
    res.writeHead(303, { location: `/manage?next=${encodeURIComponent('/events/' + event.id)}` });
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(layout({
    title: `${event.title} — gitdone`,
    body: html`
      <h1>${event.title}</h1>
      <p>ID: <code>${event.id}</code></p>
      <p>Type: <code>${event.type}</code>${event.mode ? html` · Mode: <code>${event.mode}</code>` : raw('')} | Min trust: <code>${event.min_trust_level || '—'}</code></p>
      <p>Created: <code>${event.created_at}</code></p>
      ${event.steps ? html`
        <h2>Steps</h2>
        <ul>
          ${event.steps.map((s) => html`
            <li>
              <strong>${s.name}</strong> → <code>${s.participant}</code>
              ${s.deadline ? html` · deadline <code>${s.deadline.slice(0, 10)}</code>` : raw('')}
              ${s.requires_attachment ? html` · <em>attachment required</em>` : raw('')}
              ${s.details ? html`<div style="margin:0.4rem 0 0.6rem;padding:0.45rem 0.7rem;background:#161b22;border-left:2px solid #3fb950;white-space:pre-wrap;font-size:0.9em">${s.details}</div>` : raw('')}
            </li>
          `)}
        </ul>
      ` : raw('')}
      <p><a href="/">home</a></p>
    `,
  }));
});

// ---- Session flow (knowless-backed) -----------------------------------
// GET  /manage                     → if session valid: list of your events,
//                                    else: email form (gitdone-themed)
// POST /manage                     → knowless login: sham-safe magic link
// GET  /manage/callback            → knowless callback: set 30-day cookie
// GET  /manage/verify              → knowless forward-auth check
// POST /manage/logout              → knowless logout: clear cookie

async function currentHandle(req) {
  try {
    const auth = await getAuth();
    return auth.handleFromRequest(req);
  } catch {
    return null;
  }
}

const MANAGE_HUB_CSS = `
.mh { margin: 1rem 0 1.5rem; }
.mh h1 { font-size: 1.6rem; margin: 0 0 0.25rem; letter-spacing: -0.02em; }
.mh .lede { color: #8b949e; margin: 0 0 1.4rem; font-size: 0.95em; }
.mh form { display: flex; gap: 0.6rem; max-width: 420px; margin: 0 0 1rem; align-items: stretch; }
.mh form input[type=email] { flex: 1; padding: 0.55rem 0.7rem; }
.mh form button { padding: 0.55rem 1.2rem; white-space: nowrap; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
.mh .hint { font-size: 0.82em; color: #6e7681; margin-top: -0.3rem; }
.mh .list { border: 1px solid #30363d; margin: 0.8rem 0 1rem; }
.mh .list .row { display: grid; grid-template-columns: auto 1fr auto; gap: 0.9rem; padding: 0.8rem 1rem;
                 border-bottom: 1px solid #21262d; align-items: center; }
.mh .list .row:last-child { border-bottom: 0; }
.mh .list .row .meta { min-width: 0; }
.mh .list .row .title { color: #c9d1d9; font-weight: 600; font-size: 1em; margin: 0 0 0.2rem;
                        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mh .list .row .sub { color: #8b949e; font-size: 0.82em; }
.mh .list .row .sub code { background: #161b22; }
.mh .list .row .kind { font-size: 0.7em; letter-spacing: 0.14em; text-transform: uppercase;
                       color: #8b949e; border: 1px solid #30363d; padding: 0.2em 0.55em; }
.mh .list .row .kind.event { color: #58a6ff; border-color: #58a6ff; }
.mh .list .row .kind.crypto { color: #ffb000; border-color: #ffb000; }
.mh .list .row a.open { font-weight: 600; color: #3fb950; text-decoration: none; letter-spacing: 0.04em;
                        text-transform: uppercase; font-size: 0.85em; }
.mh .list .row a.open:hover { color: #ffb000; }
.mh .empty { color: #8b949e; padding: 1.2rem; border: 1px dashed #30363d; text-align: center; }
.mh .logout { margin-top: 1rem; font-size: 0.85em; }
.mh .logout form { display: inline; }
.mh .logout button { background: none; border: 0; padding: 0; color: #8b949e; font-size: inherit;
                     text-decoration: underline; cursor: pointer; letter-spacing: 0; text-transform: none; font-weight: 400; }
.mh .logout button:hover { color: #ffb000; background: none; }
.mh .flash { background: rgba(63,185,80,.08); border: 1px solid #3fb950; color: #3fb950;
             padding: 0.55rem 0.85rem; margin: 0 0 1rem; font-size: 0.9em; }
.mh .devlink { background: rgba(255,176,0,.08); border: 1px solid #ffb000; color: #ffb000;
               padding: 0.55rem 0.85rem; margin: 0 0 1rem; font-size: 0.85em; word-break: break-all; }
.mh .devlink code { background: #0d1117; color: #ffb000; }
.mh-pill { display:inline-block; padding:0.1em 0.45em; border-radius:0; font-size:0.65em; font-weight:600;
           text-transform:uppercase; letter-spacing:0.1em; border:1px solid; vertical-align:0.15em; margin-left:0.3em; }
.mh-pill.open { background:#0d1117; color:#58a6ff; border-color:#58a6ff; }
.mh-pill.complete { background:#0d1117; color:#3fb950; border-color:#3fb950; }
.mh-pill.closed { background:#0d1117; color:#d29922; border-color:#d29922; }
.mh-pill.pending-activation { background:#0d1117; color:#ffb000; border-color:#ffb000; }
.mh-pill.archived { background:#0d1117; color:#6e7681; border-color:#6e7681; }
.mh .list .row .sub .muted { color: #6e7681; }
.mh-filter-row { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0 0 0.9rem; align-items: center; }
.mh-filter-sep { width: 1px; height: 1.4em; background: #30363d; margin: 0 0.25rem; }
.mh-filter-pill { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.25rem 0.7rem;
                  border: 1px solid #30363d; color: #8b949e; font-size: 0.78em; text-decoration: none;
                  text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; border-radius: 999px;
                  background: #0d1117; transition: color .12s, border-color .12s, background .12s; }
.mh-filter-pill:hover { color: #c9d1d9; border-color: #8b949e; }
.mh-filter-pill .n { color: #6e7681; font-weight: 700; font-size: 0.92em; }
.mh-filter-pill.active { color: #0d1117; background: #3fb950; border-color: #3fb950; }
.mh-filter-pill.active .n { color: #0d1117; }
/* Active state takes the lifecycle colour so it doubles as a legend
   when filtered, matching the row pills (.mh-pill.*). */
.mh-filter-pill.active.active   { background: #58a6ff; border-color: #58a6ff; }
.mh-filter-pill.active.completed { background: #3fb950; border-color: #3fb950; }
.mh-filter-pill.active.closed    { background: #d29922; border-color: #d29922; }
.mh-filter-pill.active.pending   { background: #ffb000; border-color: #ffb000; }
.mh-filter-pill.active.archived  { background: #6e7681; border-color: #6e7681; color: #0d1117; }
.mh-filter-pill:focus-visible { outline: 2px solid #3fb950; outline-offset: 2px; }
@media (max-width: 480px) {
  .mh-filter-pill { padding: 0.2rem 0.55rem; font-size: 0.72em; }
  .mh-filter-sep { display: none; }
}
`;

// Derive a single display status for the /manage hub rows so the
// dashboard mirrors the per-event page. Priority mirrors
// renderManagementDashboard: complete > archived > pending_activation
// > open. The returned `pillClass` is the same CSS class used in
// renderManagementDashboard so styling stays consistent.
// Split the terminal "complete" bucket into two. A workflow that ran
// its full course (every step.status === 'complete') is "completed";
// one that was ended early via close-command/dashboard while steps
// were still pending is "closed". Both are terminal; naming them
// differently matches how organisers actually think about outcomes.
function summariseEvent(ev) {
  const terminal = ev.completion && ev.completion.status === 'complete';
  const allStepsDone = ev.type === 'event' && Array.isArray(ev.steps) && ev.steps.length > 0
    && ev.steps.every((s) => s.status === 'complete');
  // Canonical closed-early signal — see completion.isClosedByInitiator.
  const closedByInitiator = terminal && isClosedByInitiator(ev);
  const completed = terminal && !closedByInitiator && (ev.type !== 'event' || allStepsDone);
  const closed = terminal && (
    (ev.type === 'event' && !allStepsDone) ||
    (ev.type !== 'event' && closedByInitiator)
  );
  const archived = !terminal && !!ev.archived_at;
  const pending = !terminal && !archived && !ev.activated_at;
  let status, pillClass;
  if (completed) { status = 'completed'; pillClass = 'complete'; }
  else if (closed) { status = 'closed early'; pillClass = 'closed'; }
  else if (archived) { status = 'archived'; pillClass = 'archived'; }
  else if (pending) { status = 'pending activation'; pillClass = 'pending-activation'; }
  else { status = 'active'; pillClass = 'open'; }
  let progress = null;
  if (ev.type === 'event' && Array.isArray(ev.steps) && ev.steps.length) {
    const done = ev.steps.filter((s) => s.status === 'complete').length;
    progress = `${done} of ${ev.steps.length} complete`;
  } else if (ev.type === 'crypto' && ev.mode === 'declaration') {
    progress = terminal ? 'signed' : 'awaiting signature';
  } else if (ev.type === 'crypto' && ev.mode === 'attestation') {
    // Module 6 — dual count. "Counted" reflects the dedup rule
    // (unique = distinct senders, latest/accumulating = replies[]).
    // "Verified" is the DKIM-verified subset. Surface both when they
    // diverge so the organiser sees the trust shape of their
    // signatures at a glance, not just the bare count.
    //
    // Module 6.5 — strict mode overrides dedup: counted = distinct
    // attestors with complete buckets (re-signing the same manifest
    // doesn't tick the count). Verified is the subset of those whose
    // most-recent completing reply was DKIM-verified.
    const replies = ev.replies || [];
    const dedup = ev.dedup || 'unique';
    const strict = !!ev.reference_url
      && Array.isArray(ev.reference_docs)
      && ev.reference_docs.length > 0;
    // Module 8 — revoked sender_hashes drop from counted + verified;
    // the audit trail (replies[]) is unchanged.
    const revokedSet = revokedHashSet(ev);
    let counted;
    let verified;
    if (strict) {
      const progressMap = ev.attestor_progress || {};
      const completeKeys = Object.keys(progressMap).filter((k) => progressMap[k] && progressMap[k].complete && !revokedSet.has(k));
      counted = completeKeys.length;
      // Per-attestor: did any of their counted replies come in
      // DKIM-verified? (replies[] only carries counted ones post-6.5,
      // and the strict branch under unique/latest already requires
      // trust_level=verified; this catches accumulating.)
      const verifiedHashes = new Set(
        replies.filter((r) => r.trust_level === 'verified' && r.sender_hash).map((r) => r.sender_hash)
      );
      verified = completeKeys.filter((k) => verifiedHashes.has(k)).length;
    } else if (dedup === 'unique') {
      const seenAll = new Set();
      const seenVerified = new Set();
      for (const r of replies) {
        if (!r.sender_hash || revokedSet.has(r.sender_hash)) continue;
        seenAll.add(r.sender_hash);
        if (r.trust_level === 'verified') seenVerified.add(r.sender_hash);
      }
      counted = seenAll.size;
      verified = seenVerified.size;
    } else {
      const live = replies.filter((r) => !revokedSet.has(r.sender_hash));
      counted = live.length;
      verified = live.filter((r) => r.trust_level === 'verified').length;
    }
    // Module 9 — when any senders are revoked, surface the breakdown
    // here too so the dashboard list matches the manage hero's triple
    // count and an organiser scanning the list sees revocation without
    // clicking in.
    const revokedN = revokedSet.size;
    if (revokedN > 0) {
      progress = `${counted + revokedN} attested · ${revokedN} revoked · ${counted} of ${ev.threshold || '?'} effective`;
    } else {
      progress = verified === counted
        ? `${counted} of ${ev.threshold || '?'} signers`
        : `${counted} of ${ev.threshold || '?'} signers · ${verified} verified`;
    }
  }
  return { status, pillClass, progress, terminal, completed, closed, archived, pending };
}

async function renderSessionHub({ handle, auth, flash, showArchived = false, typeFilter = null, statusFilter = null }) {
  // Clicking the archived pill implicitly shows archived events,
  // even if ?show=archived isn't in the URL. Keeps the pill row the
  // single source of truth.
  if (statusFilter === 'archived') showArchived = true;
  const findEventsByHandle = createEventFinder((email) => auth.deriveHandle(email));
  const all = await findEventsByHandle(handle);
  // Summarise once so both the top strip and row rendering see the
  // same derived status. Stash it on the event for simplicity.
  for (const ev of all) ev._summary = summariseEvent(ev);
  const counts = { active: 0, completed: 0, closed: 0, archived: 0, pending: 0 };
  const typeCounts = { event: 0, crypto: 0 };
  for (const ev of all) {
    const s = ev._summary;
    if (s.completed) counts.completed++;
    else if (s.closed) counts.closed++;
    else if (s.archived) counts.archived++;
    else if (s.pending) counts.pending++;
    else counts.active++;
    if (ev.type === 'crypto') typeCounts.crypto++;
    else typeCounts.event++;
  }
  const active = all.filter((ev) => !ev._summary.archived);
  const archived = all.filter((ev) => ev._summary.archived);
  let events = showArchived ? all : active;
  // Type filter — narrows the row list to one event type. Pill counts
  // stay over the whole portfolio (so the user sees what the other
  // filter would yield).
  if (typeFilter === 'event' || typeFilter === 'crypto') {
    events = events.filter((ev) => (ev.type === 'crypto' ? 'crypto' : 'event') === typeFilter);
  }
  // Status filter — narrows by lifecycle status (active/completed/
  // closed/pending/archived). Same key set as summariseEvent's pill.
  if (statusFilter) {
    events = events.filter((ev) => {
      const s = ev._summary;
      if (statusFilter === 'active') return !s.completed && !s.closed && !s.archived && !s.pending;
      if (statusFilter === 'completed') return !!s.completed;
      if (statusFilter === 'closed') return !!s.closed;
      if (statusFilter === 'pending') return !!s.pending;
      if (statusFilter === 'archived') return !!s.archived;
      return true;
    });
  }
  const renderRow = (ev) => {
    const kind = ev.type === 'crypto' ? 'crypto' : 'event';
    const s = ev._summary;
    const pill = html`<span class="mh-pill ${s.pillClass}">${s.status}</span>`;
    const created = (ev.created_at || '').slice(0, 10);
    // Status-specific one-liner: show the organiser what matters for
    // THIS event right now, not a fixed field grid.
    //   pending_activation → "waiting on your confirmation email"
    //   open (workflow)    → "2 of 3 · next: video (alice@…)"
    //   open (declaration) → "awaiting signature from alice@…"
    //   open (attestation) → "3 of 10 signers"
    //   complete           → "2 of 2 · completed 2026-04-20"
    //   archived           → "2 of 3 · archived 2026-04-20"
    let line;
    if (s.pending) {
      line = 'check your inbox — click the activation link to send invites';
    } else if (s.completed || s.closed) {
      const date = ev.completion && ev.completion.completed_at
        ? String(ev.completion.completed_at).slice(0, 10) : '';
      const label = s.closed ? 'closed early' : 'completed';
      const when = date ? ` · ${label} ${date}` : '';
      line = `${s.progress || 'done'}${when}`;
    } else if (s.archived) {
      line = `${s.progress || ''} · archived ${String(ev.archived_at).slice(0, 10)}`;
    } else {
      // open
      if (ev.type === 'event' && Array.isArray(ev.steps)) {
        const next = ev.steps.find((st) => st.status !== 'complete');
        const nextLabel = next
          ? ` · next: ${next.name}${next.participant ? ` (${next.participant})` : ''}`
          : '';
        line = `${s.progress || ''}${nextLabel}`;
      } else {
        line = s.progress || 'open';
      }
    }
    const sub = html`<span>${line}</span><span class="muted"> · created ${created}</span>`;
    const manageHref = `/manage/event/${ev.id}`;
    return html`
      <div class="row">
        <span class="kind ${kind}">${kind}</span>
        <div class="meta">
          <p class="title">${ev.title || ev.id} ${pill}</p>
          <p class="sub">${sub}</p>
        </div>
        <a class="open" href="${manageHref}">open ▸</a>
      </div>
    `;
  };
  // Unified filter row: type pills (events/crypto) + status pills
  // (active/completed/closed/pending/archived). Same pill shape, all
  // clickable. Each pill's href toggles its own dimension (clicking
  // the active one clears it). Independent dimensions: a status
  // filter coexists with a type filter via separate query params.
  const buildHref = ({ type, status }) => {
    const params = [];
    if (type) params.push(`type=${type}`);
    if (status) params.push(`status=${status}`);
    // Preserve ?show=archived only when no status filter is active —
    // a status filter sets its own visibility.
    if (showArchived && status !== 'archived' && !statusFilter) params.push('show=archived');
    return params.length ? `/manage?${params.join('&')}` : '/manage';
  };
  const typePill = (key, label, count) => count === 0 ? raw('') : html`
    <a class="mh-filter-pill ${typeFilter === key ? `active ${key}` : ''}"
       href="${typeFilter === key ? buildHref({ status: statusFilter }) : buildHref({ type: key, status: statusFilter })}">${label} <span class="n">${String(count)}</span></a>`;
  const statusPill = (key, label, count) => count === 0 ? raw('') : html`
    <a class="mh-filter-pill ${statusFilter === key ? `active ${key}` : ''}"
       href="${statusFilter === key ? buildHref({ type: typeFilter }) : buildHref({ type: typeFilter, status: key })}">${label} <span class="n">${String(count)}</span></a>`;
  const showTypePills = typeCounts.event > 0 && typeCounts.crypto > 0;
  const filterRow = all.length === 0 ? raw('') : html`
    <div class="mh-filter-row">
      ${showTypePills ? typePill('event', 'events', typeCounts.event) : raw('')}
      ${showTypePills ? typePill('crypto', 'crypto', typeCounts.crypto) : raw('')}
      ${showTypePills ? html`<span class="mh-filter-sep" aria-hidden="true"></span>` : raw('')}
      ${statusPill('active', 'active', counts.active)}
      ${statusPill('completed', 'completed', counts.completed)}
      ${statusPill('closed', 'closed', counts.closed)}
      ${statusPill('pending', 'pending', counts.pending)}
      ${statusPill('archived', 'archived', counts.archived)}
    </div>`;
  const rows = events.length === 0
    ? (showArchived
        ? html`<div class="empty">No events (including archived). <a href="/events/new">Create one</a>.</div>`
        : html`<div class="empty">No active events. <a href="/events/new">Create one</a>${archived.length ? html` or <a href="/manage?show=archived">view ${String(archived.length)} archived</a>` : raw('')}.</div>`)
    : html`<div class="list">${events.map(renderRow)}</div>`;
  const toggle = archived.length === 0
    ? raw('')
    : (showArchived
        ? html`<p class="hint" style="margin:0.4rem 0 1rem"><a href="/manage" style="color:#8b949e">← hide archived</a></p>`
        : html`<p class="hint" style="margin:0.4rem 0 1rem"><a href="/manage?show=archived" style="color:#8b949e">show ${String(archived.length)} archived</a></p>`);
  return html`
    <style>${raw(MANAGE_HUB_CSS)}</style>
    <div class="mh">
      <p style="margin:0 0 0.4rem"><a href="/" style="color:#8b949e;font-size:0.88em">← back</a></p>
      <p style="margin:0 0 1rem;color:#8b949e;font-size:0.9em">Every event and crypto you've organised. Open one to send reminders, view replies, or close it.</p>
      ${flash ? html`<div class="flash">${flash}</div>` : raw('')}
      ${filterRow}
      ${rows}
      ${toggle}
      <p class="logout">
        <form method="POST" action="/manage/logout"><button type="submit">sign out</button></form>
      </p>
    </div>
  `;
}

function renderSignInForm({ flash, devLink, email, next }) {
  return html`
    <style>${raw(MANAGE_HUB_CSS)}</style>
    <p style="margin:0 0 0.4rem"><a href="/" style="color:#8b949e;font-size:0.88em">← back</a></p>
    <div class="mh">
      <h1>Open your events</h1>
      <p class="lede">Enter the email you used to create events. We'll send a one-time link (valid 15 minutes). You'll stay signed in for 30 days.</p>
      ${flash ? html`<div class="flash">${flash}</div>` : raw('')}
      ${devLink ? html`<div class="devlink"><strong>DEV:</strong> sendmail unavailable — magic link: <code>${devLink}</code></div>` : raw('')}
      <form method="POST" action="/manage">
        ${next ? html`<input type="hidden" name="next" value="${next}">` : raw('')}
        <input type="email" name="email" placeholder="you@example.com" required autofocus value="${email || ''}">
        <button type="submit">send link</button>
      </form>
      <p class="hint">No password needed. No account to create. The link opens a dashboard listing every event and crypto record you've initiated.</p>
    </div>
  `;
}

router.get('/manage', async (req, res) => {
  const handle = await currentHandle(req);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (handle) {
    const auth = await getAuth();
    const u = new URL(req.url || '/', 'http://localhost');
    const cancelled = u.searchParams.get('cancelled');
    const flash = cancelled
      ? `Cancelled "${cancelled}". The event was deleted; nothing was sent.`
      : null;
    res.end(layout({
      title: 'your events — gitdone',
      body: await renderSessionHub({
        handle, auth, flash,
        showArchived: /[?&]show=archived\b/.test(req.url || ''),
        typeFilter: (() => {
          const t = u.searchParams.get('type');
          return t === 'event' || t === 'crypto' ? t : null;
        })(),
        statusFilter: (() => {
          const s = u.searchParams.get('status');
          return ['active', 'completed', 'closed', 'pending', 'archived'].includes(s) ? s : null;
        })(),
      }),
    }));
  } else {
    const u = new URL(req.url || '/', 'http://localhost');
    const next = u.searchParams.get('next') || '';
    const sent = u.searchParams.get('sent');
    const flash = sent
      ? "Check your inbox. If your email has events on gitdone, a sign-in link is on its way."
      : null;
    res.end(layout({
      title: 'sign in — gitdone',
      description: 'Sign in by email — no passwords. gitdone organisers manage their events here.',
      canonical: `${publicBaseUrl()}/manage`,
      body: renderSignInForm({ next, flash }),
    }));
  }
});

// Mode B sign-in: parse the email out of the form, send the magic link
// via auth.startLogin, then 303 back to /manage?sent=1 with a flash —
// no dead-end confirmation page. nextUrl defaults to /manage so the
// callback after clicking the link lands the user on their dashboard.
// Calling startLogin directly (vs auth.login(req, res)) means knowless
// still rate-limits but we control the response shape.
router.post('/manage', async (req, res) => {
  let body;
  try { body = await parseBody(req); }
  catch { res.writeHead(400); return res.end('bad request'); }
  const email = (body.email || '').toString().trim();
  if (!email) { res.writeHead(303, { location: '/manage' }); return res.end(); }
  const next = (body.next || '/manage').toString();
  const auth = await getAuth();
  try {
    await auth.startLogin({ email, nextUrl: next });
  } catch (err) {
    process.stderr.write(`manage-login: ${err.message || err}\n`);
    // Don't leak whether the email matched — the flash is intentionally
    // shaped the same on success and failure (per knowless's
    // confirmationMessage policy).
  }
  res.writeHead(303, { location: '/manage?sent=1' });
  res.end();
});

router.get('/manage/callback', async (req, res) => {
  const auth = await getAuth();
  return auth.callback(req, res);
});

router.get('/manage/verify', async (req, res) => {
  const auth = await getAuth();
  return auth.verify(req, res);
});

router.post('/manage/logout', async (req, res) => {
  const auth = await getAuth();
  // knowless.logout clears the cookie but returns 200 with empty body.
  // Hook res.end so we upgrade to a 303 home, preserving the Set-Cookie.
  const origEnd = res.end.bind(res);
  res.end = (...args) => {
    if (res.statusCode === 200 && !res.headersSent) {
      res.statusCode = 303;
      res.setHeader('Location', '/');
    }
    return origEnd(...args);
  };
  return auth.logout(req, res);
});

// Session-gated per-event management dashboard. First arrival by the
// initiator activates a pending event (idempotent via activateEvent) and
// fires the deferred participant notifications. The signed-in session is
// proof of email ownership — established via knowless's magic-link
// callback (Mode A: "do the thing, confirm by email").
router.get('/manage/event/:id', async (req, res, params) => {
  const handle = await currentHandle(req);
  if (!handle) {
    const u = new URL(req.url || '/', 'http://localhost');
    const target = `/manage/event/${params.id}${u.search}`;
    res.writeHead(303, { location: `/manage?next=${encodeURIComponent(target)}` });
    return res.end();
  }
  const auth = await getAuth();
  const { loadEvent } = require('../src/event-store');
  let event = await loadEvent(params.id);
  if (!event) { res.writeHead(404); return res.end('event not found'); }
  if (auth.deriveHandle(event.initiator) !== handle) {
    res.writeHead(403); return res.end('forbidden');
  }

  // A signed-in session whose handle matches the initiator (verified
  // above) is itself proof of email ownership — knowless requires a
  // magic-link click to mint that session. So we render the live
  // dashboard for pending events too: the user can Activate / Edit /
  // Close without re-clicking the per-event activation link.

  // Activation is opt-in: the dashboard renders a 'pending' state with a
  // confirm button, and POST /manage/event/:id/activate fires the
  // notifications. Visiting alone does nothing, so reviewing a pending
  // event before committing to it is safe.
  const flash = (req.url.includes('?activated=1'))
    ? (event.type === 'event'
        ? 'Event activated — invitations have been sent to all participants.'
        : (event.mode === 'declaration'
            ? 'Activated — the signer has been invited.'
            : 'Activated — your reply address is now live.'))
    : (req.url.includes('?reminded=1'))
      ? 'Reminders sent.'
      : (req.url.includes('?closed=1'))
        ? 'Event closed.'
        : (req.url.includes('?unarchived=1'))
          ? 'Event un-archived — replies will count again.'
          : (req.url.includes('?edited=1'))
            ? 'Changes saved. Any participants whose email changed received a fresh invitation.'
            : null;
  let stepAttempts = {};
  // Per-step commit (latest attempt) for the workflow trust pills, and
  // ALL commits for the crypto receipt + attestation per-reply ledger.
  // listCommits returns [] if the repo doesn't exist yet (pending events).
  const { listCommits } = require('../src/gitrepo');
  const allCommits = await listCommits(event.id).catch(() => []);
  if (event.type === 'event') {
    for (const c of allCommits) {
      if (!c.step_id) continue;
      const prev = stepAttempts[c.step_id];
      if (!prev || (c.sequence || 0) > (prev.sequence || 0)) {
        stepAttempts[c.step_id] = c;
      }
    }
  }
  const stepCommits = stepAttempts; // alias kept for clarity below
  const eventCommits = allCommits;
  // Page title differentiates by type so the browser tab + the
  // page-header line (auto-derived from title) read clearly when the
  // organiser has multiple events open.
  const kindWord = event.type === 'event'
    ? 'event'
    : (event.mode === 'declaration' ? 'declaration' : 'attestation');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(layout({
    title: `manage ${kindWord} — ${event.title}`,
    body: renderManagementDashboard({ eventId: params.id, initiatorEmail: event.initiator, event, flash, stepAttempts, eventCommits }),
  }));
});

// Edit form for a workflow event. Steps with status='complete' are
// rendered read-only — the audit trail records what their participant
// was at the time they replied; rewriting that post-hoc would lie.
// Pending events allow editing the title; activated events keep the
// title locked (it's been emailed to participants and would silently
// rewrite the subject of future inbound notifications). Crypto events
// are not editable today (declaration's signer change and attestation's
// threshold change are both rare; covered by close + recreate).
router.get('/manage/event/:id/edit', async (req, res, params) => {
  const handle = await currentHandle(req);
  if (!handle) {
    res.writeHead(303, { location: `/manage?next=${encodeURIComponent('/manage/event/' + params.id + '/edit')}` });
    return res.end();
  }
  const auth = await getAuth();
  const { loadEvent } = require('../src/event-store');
  const event = await loadEvent(params.id);
  if (!event) { res.writeHead(404); return res.end('event not found'); }
  if (auth.deriveHandle(event.initiator) !== handle) { res.writeHead(403); return res.end('forbidden'); }
  if (event.type !== 'event') {
    res.writeHead(303, { location: `/manage/event/${params.id}` });
    return res.end();
  }
  const finalised = (event.completion && event.completion.status === 'complete') || !!event.archived_at;
  if (finalised) {
    res.writeHead(303, { location: `/manage/event/${params.id}` });
    return res.end();
  }
  const errors = [];
  const search = new URL(req.url || '/', 'http://localhost').searchParams;
  if (search.get('err') === 'bad_email') errors.push('A participant email is invalid.');
  if (search.get('err') === 'bad_deadline') errors.push('A deadline must be YYYY-MM-DD or empty.');
  if (search.get('err') === 'frozen') errors.push('Cannot edit a step that is already complete.');
  if (search.get('err') === 'bad_title') errors.push('Title cannot be empty.');
  if (search.get('err') === 'unknown') errors.push('Could not save changes — try again or close and recreate.');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(layout({
    title: `edit — ${event.title}`,
    body: renderWorkflowForm({ event, errors }),
  }));
});

router.post('/manage/event/:id/edit', async (req, res, params) => {
  const handle = await currentHandle(req);
  if (!handle) { res.writeHead(303, { location: '/manage' }); return res.end(); }
  const auth = await getAuth();
  const { loadEvent, editEvent } = require('../src/event-store');
  const event = await loadEvent(params.id);
  if (!event) { res.writeHead(404); return res.end('event not found'); }
  if (auth.deriveHandle(event.initiator) !== handle) { res.writeHead(403); return res.end('forbidden'); }
  if (event.type !== 'event') { res.writeHead(400); return res.end('only workflow events are editable'); }

  let body;
  try { body = await parseBody(req); }
  catch { res.writeHead(400); return res.end('bad request'); }

  // Form arrays line up by index. Build the patch by zipping.
  const ids = [].concat(body.step_id || []);
  const participants = [].concat(body.step_participant || []);
  const deadlines = [].concat(body.step_deadline || []);
  const reqAtts = new Set(body._attached_step_ids ? [].concat(body._attached_step_ids) : []);
  const detailsArr = [].concat(body.step_details || []);
  // requires_attachment checkboxes only POST when checked, and they POST
  // their step id as the value — collected as `step_requires_attachment`.
  const checkedAtt = new Set([].concat(body.step_requires_attachment || []));
  const stepsPatch = ids.map((id, i) => ({
    id: String(id || ''),
    participant: participants[i] != null ? String(participants[i]) : undefined,
    deadline: deadlines[i] != null ? String(deadlines[i]) : undefined,
    details: detailsArr[i] != null ? String(detailsArr[i]) : undefined,
    requires_attachment: checkedAtt.has(String(id)),
  })).filter((s) => s.id);

  const patch = { steps: stepsPatch };
  if (!event.activated_at && body.title != null) patch.title = String(body.title);

  try {
    const result = await editEvent(params.id, patch, { organiserHandle: handle });
    // Re-notify any step whose participant changed. New address only —
    // old address gets nothing (their reply will fail sender_match now).
    const participantChanges = (result.changes || []).filter((c) => c.field === 'participant');
    if (participantChanges.length && event.activated_at) {
      const { notifyWorkflowParticipants } = require('../src/notifications');
      const reNotifySteps = participantChanges
        .map((c) => result.event.steps.find((s) => s.id === c.step_id))
        .filter((s) => s && s.status !== 'complete');
      if (reNotifySteps.length) {
        try {
          const sendResults = await notifyWorkflowParticipants(result.event, { stepsOverride: reNotifySteps });
          for (const r of sendResults) {
            if (!r.ok) process.stderr.write(`edit-renotify: failed ${r.to}: ${r.reason || r.code}\n`);
          }
        } catch (err) {
          process.stderr.write(`edit-renotify: ${err.message || err}\n`);
        }
      }
    }
    res.writeHead(303, { location: `/manage/event/${params.id}?edited=1` });
    return res.end();
  } catch (err) {
    const code = err && err.code ? err.code : 'unknown';
    const errParam = code === 'BAD_EMAIL' ? 'bad_email'
      : code === 'BAD_DEADLINE' ? 'bad_deadline'
      : code === 'EVENT_STEP_FROZEN' ? 'frozen'
      : code === 'BAD_TITLE' ? 'bad_title'
      : 'unknown';
    res.writeHead(303, { location: `/manage/event/${params.id}/edit?err=${errParam}` });
    return res.end();
  }
});

// Magic-link landing for activation: knowless 303s here after the
// initiator clicks the sign-in link. We validate the per-event ack
// token against event.activation_ack_token, flip
// event.activation_link_clicked_at, and 303 the user onward to the
// real dashboard. Without this flip, the dashboard hides the
// Activate button — that's the gate that stops a pre-signed-in
// initiator from skipping the email round-trip.
router.get('/manage/event/:id/confirmed', async (req, res, params) => {
  const handle = await currentHandle(req);
  if (!handle) { res.writeHead(303, { location: '/manage' }); return res.end(); }
  const auth = await getAuth();
  const { loadEvent, confirmActivationLink } = require('../src/event-store');
  const event = await loadEvent(params.id);
  if (!event) { res.writeHead(404); return res.end('event not found'); }
  if (auth.deriveHandle(event.initiator) !== handle) { res.writeHead(403); return res.end('forbidden'); }
  const u = new URL(req.url || '/', 'http://localhost');
  const token = u.searchParams.get('t') || '';
  const result = await confirmActivationLink(params.id, token);
  if (!result.ok) {
    // Stale link / wrong token — bounce to the dashboard with a flash.
    res.writeHead(303, { location: `/manage/event/${params.id}?confirm_error=${result.reason || 'unknown'}` });
    return res.end();
  }
  res.writeHead(303, { location: `/manage/event/${params.id}` });
  res.end();
});

// Confirm-and-activate a pending event. Mutex-guarded so concurrent
// double-clicks (or two tabs) only activate once and notify each
// participant exactly once. No-op (303 with neutral flash) if the event
// is already active, finalised, or archived.
router.post('/manage/event/:id/activate', async (req, res, params) => {
  const handle = await currentHandle(req);
  if (!handle) { res.writeHead(303, { location: '/manage' }); return res.end(); }
  const auth = await getAuth();
  const { loadEvent, activateEvent } = require('../src/event-store');
  let event = await loadEvent(params.id);
  if (!event) { res.writeHead(404); return res.end('event not found'); }
  if (auth.deriveHandle(event.initiator) !== handle) { res.writeHead(403); return res.end('forbidden'); }
  const finalised = (event.completion && event.completion.status === 'complete') || !!event.archived_at;
  if (finalised || event.activated_at) {
    res.writeHead(303, { location: `/manage/event/${params.id}` });
    return res.end();
  }
  const { event: activated, alreadyActive } = await activateEvent(params.id);
  event = activated;
  if (!alreadyActive) {
    const { notifyWorkflowParticipants, notifyDeclarationSigner, notifyOrganiserOfActivation } = require('../src/notifications');
    try {
      if (event.type === 'event') {
        const results = await notifyWorkflowParticipants(event);
        for (const r of results) {
          if (!r.ok) process.stderr.write(`activate-notify: failed ${r.to}: ${r.reason || r.code}\n`);
        }
        // Confirm to the organiser what just went out. Awaited so the
        // 303 doesn't race the send (tests, and any caller checking the
        // outbox immediately after). Best-effort: a send failure logs
        // but doesn't undo the activation.
        try {
          await notifyOrganiserOfActivation(event, { sendResults: results });
        } catch (err) {
          process.stderr.write(`activate-organiser-notify: ${err.message || err}\n`);
        }
      } else if (event.type === 'crypto' && event.mode === 'declaration') {
        // Module 4c: when the event cites a reference_url, hold the
        // signer invite until reference docs land — the signer needs
        // the file list + hashes to know what to attach. First attach+
        // email triggers the invite (see receive.js attach+ branch).
        const holdForDocs = !!event.reference_url
          && !((event.reference_docs || []).length);
        if (!holdForDocs) {
          const results = await notifyDeclarationSigner(event);
          for (const r of results) {
            if (!r.ok) process.stderr.write(`activate-notify: failed ${r.to}: ${r.reason || r.code}\n`);
          }
        }
      }
      // Module 4d#3 — for any crypto event with reference_url set + no
      // docs (declaration or attestation), email the initiator with the
      // attach+ instructions so they know what to do next.
      if (event.type === 'crypto' && event.reference_url
          && !((event.reference_docs || []).length)) {
        const { notifyInitiatorAttachDocsNeeded } = require('../src/notifications');
        try {
          await notifyInitiatorAttachDocsNeeded(event);
        } catch (err) {
          process.stderr.write(`activate-attach-prompt: ${err.message || err}\n`);
        }
      }
      // Attestation: no per-recipient invite — organiser shares the
      // reply address themselves.
    } catch (err) {
      process.stderr.write(`activate-notify: ${err.message || err}\n`);
    }
  }
  res.writeHead(303, { location: `/manage/event/${params.id}?activated=1` });
  res.end();
});

router.post('/manage/event/:id/remind', async (req, res, params) => {
  const handle = await currentHandle(req);
  if (!handle) { res.writeHead(303, { location: '/manage' }); return res.end(); }
  const auth = await getAuth();
  const { loadEvent } = require('../src/event-store');
  const { executeRemind } = require('../src/email-commands');
  const event = await loadEvent(params.id);
  if (!event) { res.writeHead(404); return res.end('event not found'); }
  if (auth.deriveHandle(event.initiator) !== handle) { res.writeHead(403); return res.end('forbidden'); }
  await executeRemind(event);
  res.writeHead(303, { location: `/manage/event/${params.id}?reminded=1` });
  res.end();
});

router.post('/manage/event/:id/unarchive', async (req, res, params) => {
  const handle = await currentHandle(req);
  if (!handle) { res.writeHead(303, { location: '/manage' }); return res.end(); }
  const auth = await getAuth();
  const { loadEvent } = require('../src/event-store');
  const { unarchive } = require('../src/sweep');
  const event = await loadEvent(params.id);
  if (!event) { res.writeHead(404); return res.end('event not found'); }
  if (auth.deriveHandle(event.initiator) !== handle) { res.writeHead(403); return res.end('forbidden'); }
  await unarchive(params.id);
  res.writeHead(303, { location: `/manage/event/${params.id}?unarchived=1` });
  res.end();
});

router.post('/manage/event/:id/close', async (req, res, params) => {
  const handle = await currentHandle(req);
  if (!handle) { res.writeHead(303, { location: '/manage' }); return res.end(); }
  const auth = await getAuth();
  const { loadEvent } = require('../src/event-store');
  const { executeClose } = require('../src/email-commands');
  const { updateEventAtomic } = require('../src/completion');
  const { commitCompletion } = require('../src/gitrepo');
  const event = await loadEvent(params.id);
  if (!event) { res.writeHead(404); return res.end('event not found'); }
  if (auth.deriveHandle(event.initiator) !== handle) { res.writeHead(403); return res.end('forbidden'); }
  // Pending-activation events have no audit trail yet, so "close" here
  // just deletes the event JSON — it never lived past the create step.
  // No completion commit, no participant notifications (none were ever
  // contacted). Behaves like the email-driven cancel that the 72h
  // sweep would have done anyway.
  if (!event.activated_at) {
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const config = require('../src/config');
    try { await fs.unlink(path.join(config.dataDir, 'events', `${params.id}.json`)); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    await fs.rm(path.join(config.dataDir, 'repos', params.id), { recursive: true, force: true })
      .catch(() => {});
    res.writeHead(303, { location: `/manage?cancelled=${encodeURIComponent(event.title || params.id)}` });
    return res.end();
  }
  const r = executeClose(event, { receivedAt: new Date().toISOString() });
  if (!r.wasAlreadyComplete) {
    await updateEventAtomic(params.id, () => r.newEvent, { syncMessage: 'event closed from dashboard' });
    await commitCompletion(params.id, r.newEvent, {
      completedAt: r.newEvent.completion.completed_at,
      triggeringSequence: null,
      summary: { closed_by: 'initiator', reason: 'dashboard-close' },
    });
    try {
      const { notifyEventCompletion } = require('../src/notifications');
      const { listCommits } = require('../src/gitrepo');
      const { recordProofEmailMessageId } = require('../src/event-store');
      const allCommits = await listCommits(params.id).catch(() => []);
      const wantedSeqs = new Set();
      for (const s of (r.newEvent.steps || [])) {
        if (s && s.status === 'complete' && s.commit_sequence != null) wantedSeqs.add(s.commit_sequence);
      }
      const wantedHashes = new Set();
      for (const reply of (r.newEvent.replies || [])) {
        if (reply && reply.sender_hash) wantedHashes.add(reply.sender_hash);
      }
      const counting = allCommits.filter((c) => !c.kind && (
        wantedSeqs.has(c.sequence) || (c.sender_hash && wantedHashes.has(c.sender_hash))
      ));
      const results = await notifyEventCompletion(r.newEvent, { reason: 'closed_by_initiator', commits: counting });
      const firstOk = results.find((rr) => rr.ok && rr.message_id);
      if (firstOk) {
        try { await recordProofEmailMessageId(params.id, firstOk.message_id); } catch {}
      }
    } catch (err) {
      process.stderr.write(`dashboard-close notify: ${err.message || err}\n`);
    }
  }
  res.writeHead(303, { location: `/manage/event/${params.id}?closed=1` });
  res.end();
});

// Streaming proof-bundle download. Session-gated to the initiator —
// same auth shape as every other /manage/event/:id route. Spawns tar(1)
// and pipes its stdout straight to the response so the bundle never
// lands on disk and never hits Node's heap. PRD §0.1.4 / §7.5: this is
// the artifact handoff for offline verification.
router.get('/manage/event/:id/bundle', async (req, res, params) => {
  const handle = await currentHandle(req);
  if (!handle) {
    const target = `/manage/event/${params.id}/bundle`;
    res.writeHead(303, { location: `/manage?next=${encodeURIComponent(target)}` });
    return res.end();
  }
  const auth = await getAuth();
  const { loadEvent } = require('../src/event-store');
  const { streamBundle, bundleFilename, locateRepo, asciiFilename } = require('../src/bundle');
  const event = await loadEvent(params.id);
  if (!event) { res.writeHead(404); return res.end('event not found'); }
  if (auth.deriveHandle(event.initiator) !== handle) { res.writeHead(403); return res.end('forbidden'); }
  const loc = await locateRepo(params.id);
  if (!loc.ok) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('no proof bundle yet — event has no commits to verify');
  }
  const filename = asciiFilename(bundleFilename(params.id));
  res.writeHead(200, {
    'content-type': 'application/gzip',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
  });
  const r = await streamBundle(params.id, res);
  if (!r.ok) {
    // Headers are already sent; we can't switch to 500. Best we can do is
    // log and end the truncated response — the client gets a malformed
    // archive, which surfaces as a tar error on extraction.
    process.stderr.write(`bundle: tar failed for ${params.id}: ${r.reason || r.code || 'unknown'}\n`);
  }
  res.end();
});

// Old magic-link management URLs from pre-session emails. Redirect to the
// hub so the organiser can sign in and find their event there.
router.get('/manage/:token', async (req, res) => {
  res.writeHead(303, { location: '/manage' });
  res.end();
});

const MANAGE_CSS = `
.mg-meta { color:#8b949e; font-size:0.88em; margin:0 0 0.4rem; }
.mg-meta code { background:#161b22; color:#ffb000; padding:0.08em 0.35em; border-radius:2px; }
.mg-flash { background:rgba(63,185,80,.08); border:1px solid #3fb950; color:#3fb950; padding:0.7rem 0.95rem; border-radius:0; margin:0 0 1rem; font-size:1em; font-weight:500;
  /* Grab attention briefly — easy to miss otherwise. The pulse fades
     out so it doesn't keep blinking long after the user has read it. */
  animation: mgFlashAttn 1.6s ease-out 1 both;
}
@keyframes mgFlashAttn {
  0% { box-shadow: 0 0 0 0 rgba(63,185,80,.55); transform: translateY(-4px); }
  35% { box-shadow: 0 0 0 6px rgba(63,185,80,.18); transform: translateY(0); }
  100% { box-shadow: 0 0 0 0 rgba(63,185,80,0); transform: translateY(0); }
}
.mg-section { padding-left:1.55rem; border-left:2px solid #30363d; margin:0.3rem 0 1rem; padding-bottom:0.4rem; }
.mg-section h2 { font-size:0.78em; text-transform:uppercase; letter-spacing:0.12em; color:#8b949e; margin:0.9rem 0 0.45rem; font-weight:600; }
.mg-steps { width:100%; border-collapse:collapse; font-size:0.9em; border:1px solid #30363d; }
.mg-steps th { text-align:left; font-weight:500; color:#8b949e; padding:0.4rem 0.55rem; border-bottom:1px solid #30363d; background:#161b22; font-size:0.7em; text-transform:uppercase; letter-spacing:0.1em; }
.mg-steps td { padding:0.38rem 0.55rem; border-bottom:1px solid #21262d; }
.mg-steps tr:last-child td { border-bottom:0; }
.mg-steps .status-complete { color:#3fb950; }
.mg-steps .status-pending { color:#6e7681; }
.mg-steps .status-blocked { color:#ffb000; }
.mg-pill { display:inline-block; padding:0.15em 0.55em; border-radius:0; font-size:0.72em; font-weight:600; text-transform:uppercase; letter-spacing:0.1em; border:1px solid; }
.mg-pill.open { background:#0d1117; color:#58a6ff; border-color:#58a6ff; }
.mg-pill.complete { background:#0d1117; color:#3fb950; border-color:#3fb950; }
.mg-pill.pending-activation { background:#0d1117; color:#ffb000; border-color:#ffb000; }
.mg-pill.archived { background:#0d1117; color:#6e7681; border-color:#6e7681; }
.mg-archived-banner { background:rgba(110,118,129,0.06); border:1px solid #30363d; border-left:3px solid #6e7681; color:#8b949e; padding:0.7rem 0.95rem; margin:0 0 1rem; font-size:0.92em; line-height:1.5; }
.mg-archived-banner strong { color:#c9d1d9; display:block; margin-bottom:0.25rem; }
.mg-pending-activation { background:rgba(255,176,0,0.06); border:1px solid #ffb000; border-left-width:3px; color:#ffb000; padding:0.7rem 0.95rem; margin:0 0 1rem; font-size:0.92em; line-height:1.5; }
.mg-pending-activation strong { color:#ffb000; }
.mg-pending-activation .title { color:#ffb000; font-weight:700; display:block; margin-bottom:0.25rem; }
.mg-actions { display:flex; gap:0.7rem; margin:1rem 0; justify-content:center; flex-wrap:wrap; align-items:center; }
.mg-actions button, .mg-actions .mg-edit-btn { padding:0.55rem 1.2rem; border-radius:0; cursor:pointer; font:inherit; font-size:0.85em; font-weight:600; letter-spacing:0.05em; text-transform:uppercase; }
.mg-activate { background:#3fb950; color:#0d1117; border:0; }
.mg-activate:hover { background:#ffb000; }
.mg-edit-btn { display:inline-block; background:transparent; border:1px solid #58a6ff; color:#58a6ff; text-decoration:none; }
.mg-edit-btn.mg-disabled { opacity:0.4; pointer-events:none; }
/* Callout strip: full-width, sits directly below the buttons row, only
   one is visible at a time. The [hidden] selector wins over display:flex. */
.mg-confirm-callout { display:flex; gap:0.7rem; align-items:center; flex-wrap:wrap;
                      margin:0.4rem 0 1rem; padding:0.65rem 0.85rem;
                      background:#161b22; border:1px solid #30363d; border-left:3px solid #ffb000; }
.mg-confirm-callout[hidden] { display:none; }
.mg-confirm-msg { color:#c9d1d9; font-size:0.88em; flex:1 1 280px; }
.mg-confirm-actions { display:flex; gap:0.5rem; flex-wrap:wrap; }
.mg-cancel { background:transparent; color:#8b949e; border:1px solid #30363d; }
.mg-cancel:hover { background:#0d1117; color:#c9d1d9; }
@media (max-width:540px) {
  .mg-confirm-msg { flex:1 1 100%; }
  .mg-confirm-actions { width:100%; justify-content:flex-end; }
}
.mg-remind { background:#0d1117; color:#3fb950; border:1px solid #3fb950; }
.mg-remind:hover { background:#3fb950; color:#0d1117; }
.mg-close { background:#0d1117; color:#f85149; border:1px solid #f85149; }
.mg-close:hover { background:#f85149; color:#0d1117; }
.mg-actions button:disabled { opacity:0.4; cursor:not-allowed; }
.mg-bundle-btn { display:inline-block; padding:0.55rem 1.2rem; border-radius:0; cursor:pointer; font:inherit; font-size:0.85em; font-weight:600; letter-spacing:0.05em; text-transform:uppercase; background:#0d1117; color:#ffb000; border:1px solid #ffb000; text-decoration:none; }
.mg-bundle-btn:hover { background:#ffb000; color:#0d1117; }
.mg-email-cmds { font-size:0.85em; color:#8b949e; background:#161b22; border:1px solid #30363d; border-radius:0; padding:0.8rem 1rem; margin-top:1rem; }
.mg-email-cmds code { background:#0d1117; color:#ffb000; border:1px solid #30363d; padding:0.08em 0.35em; border-radius:2px; }
.mg-email-cmd-list { margin:0; display:grid; grid-template-columns:auto 1fr; gap:0.25rem 0.85rem; }
.mg-email-cmd-list dt { margin:0; }
.mg-email-cmd-list dd { margin:0; color:#c9d1d9; }
@media (max-width: 560px) { .mg-email-cmd-list { grid-template-columns:1fr; } .mg-email-cmd-list dd { margin:0 0 0.45rem 0.3rem; } }
.mg-details-toggle { background:none; border:0; color:#58a6ff; cursor:pointer; font:inherit; font-size:0.8em; padding:0 0.25em; letter-spacing:0.03em; vertical-align:baseline; }
.mg-details-toggle:hover { color:#ffb000; }
.mg-details-toggle::before { content:"+ details"; }
.mg-details-toggle[aria-expanded="true"]::before { content:"− details"; }
.mg-steps .mg-details-row td { background:#0d1117; padding:0.45rem 0.7rem 0.6rem; border-bottom:1px solid #30363d; }
.mg-steps .mg-details { background:#161b22; border-left:2px solid #3fb950; padding:0.5rem 0.75rem; font-size:0.88em; white-space:pre-wrap; line-height:1.5; color:#c9d1d9; }
.mg-steps .col-att-flag { text-align:center; width:28px; }
.mg-steps .mg-reject-row td { background:#0d1117; padding:0.35rem 0.7rem 0.5rem; border-bottom:1px solid #30363d; }
.mg-steps .mg-reject { font-size:0.85em; color:#ffb000; border-left:2px solid #ffb000; padding:0.3rem 0.65rem; background:rgba(255,176,0,0.05); }
.mg-steps .mg-reject code { background:#161b22; color:#c9d1d9; padding:0.05em 0.3em; }
.mg-steps .mg-reject-at { color:#6e7681; font-family:inherit; }
@media (max-width: 540px) {
  /* Stack each row as a card. Cells carry data-label so the column
     header reads as a key:value line (avoids the conditional-column
     positioning problem with nth-child). Auxiliary rows (details +
     rejection + delivery-failed callout) span the full card width. */
  .mg-steps { font-size:0.88em; border:0; }
  .mg-steps thead { display:none; }
  .mg-steps, .mg-steps tbody, .mg-steps tr, .mg-steps td { display:block; width:auto; }
  .mg-steps tbody > tr {
    border:1px solid #30363d; border-left:3px solid #30363d;
    margin-bottom:0.5rem; padding:0.55rem 0.7rem;
  }
  .mg-steps tbody > tr > td { padding:0.18rem 0; border-bottom:0; }
  .mg-steps tbody > tr > td[data-label]::before {
    content: attr(data-label) ': ';
    color:#8b949e; font-size:0.75em; text-transform:uppercase; letter-spacing:0.08em;
    margin-right:0.45rem; display:inline-block; min-width:5.5em;
  }
  .mg-steps tbody > tr > td:first-child { color:#6e7681; padding-bottom:0.3rem; font-size:0.85em; }
  .mg-steps tbody > tr.mg-details-row,
  .mg-steps tbody > tr.mg-reject-row {
    border:0; border-bottom:1px solid #21262d; padding:0.3rem 0 0.5rem;
    margin:-0.3rem 0 0.5rem;
  }
  .mg-steps tbody > tr.mg-details-row > td:first-child,
  .mg-steps tbody > tr.mg-reject-row > td:first-child { display:none; }
  .mg-steps .col-att-flag { text-align:left; width:auto; }
}

/* Proof surfacing — trust ladder + headline + receipt. Shared by the
   crypto C3 layout and the workflow W2 layout. */
.proof-hero { background:#0d1117; border:1px solid #30363d; padding:0.95rem 1.1rem; margin:0 0 1rem; }
.trust-ladder { display:grid; grid-template-columns:repeat(4,1fr); gap:0; margin:0 0 0.5rem; }
.trust-rung { padding:0.5rem 0.55rem; text-align:center; font-size:0.7rem;
              text-transform:uppercase; letter-spacing:0.08em; border:1px solid #30363d;
              background:transparent; }
.trust-rung + .trust-rung { border-left:none; }
.proof-headline { font-size:1.4rem; color:#c9d1d9; margin:0.7rem 0 0.25rem;
                  letter-spacing:0.02em; font-weight:500; }
.proof-headline.is-verified { color:#3fb950; }
.proof-headline.is-forwarded { color:#58a6ff; }
.proof-headline.is-authorized { color:#ffb000; }
.proof-headline.is-unverified { color:#6e7681; }
.proof-sub { font-size:0.82rem; color:#8b949e; margin:0 0 0.6rem; }
.proof-mode-badge { display:inline-block; padding:0.25rem 0.7rem; margin:0.3rem 0 0.6rem;
                    border:1px solid; font-size:0.78rem; font-weight:600;
                    letter-spacing:0.12em; text-transform:uppercase; }
.proof-mode-badge.decl { color:#3fb950; border-color:#3fb950; background:rgba(63,185,80,.08); }
.proof-mode-badge.attn { color:#ffb000; border-color:#ffb000; background:rgba(255,176,0,.08); }
.proof-mode-badge .sep { color:#6e7681; margin:0 0.5rem; }
.proof-mode-badge .dedup { color:#8b949e; font-weight:500; }
.proof-secondary { background:#161b22; border:1px solid #30363d; padding:0.7rem 0.9rem;
                   margin-top:0.5rem; }
.proof-secondary h4 { margin:0 0 0.4rem; font-size:0.7rem; text-transform:uppercase;
                      letter-spacing:0.07em; color:#8b949e; font-weight:500; }
.proof-row { display:flex; gap:0.6rem; padding:0.32rem 0; font-size:0.82rem;
             align-items:baseline; border-bottom:1px dotted #30363d; min-width:0; }
.proof-row:last-of-type { border-bottom:none; }
.proof-key { color:#8b949e; min-width:7rem; text-transform:uppercase;
             letter-spacing:0.04em; font-size:0.7rem; flex-shrink:0; }
/* Module 9 — narrow-viewport guard. The reference-URL anchor was
   spilling past the right edge on phones (~360px). flex children
   ignore their content's intrinsic width by default; min-width:0
   on the row + flex:1 with overflow-wrap on the value lets long
   links wrap inside the column instead of pushing the layout. */
.proof-value { color:#c9d1d9; flex:1; min-width:0; overflow-wrap:anywhere; word-break:break-word; }
.proof-value a { overflow-wrap:anywhere; word-break:break-word; }
.proof-tiles { display:grid; grid-template-columns:repeat(4,1fr); gap:0.5rem;
               margin:0.6rem 0 0.4rem; }
.proof-tile { border:1px solid currentColor; padding:0.55rem 0.4rem; text-align:center; }
.proof-tile .num { font-size:1.4rem; line-height:1; font-weight:600; }
.proof-tile .lbl { font-size:0.65rem; text-transform:uppercase; letter-spacing:0.06em;
                   color:#8b949e; margin-top:0.3rem; }
/* Unified stat band — two tiles (signers / verified) plus a meta line.
   Shared across declaration + attestation hero rendering. Tiles are
   wider than the per-trust tiles since there are only two; the meta
   strip slots in to the right (or wraps below on narrow viewports). */
.proof-stats { display:flex; align-items:stretch; gap:0.6rem;
               margin:0.6rem 0 0.7rem; flex-wrap:wrap; }
.proof-stat-tile { border:1px solid currentColor; padding:0.6rem 1.0rem;
                   text-align:center; min-width:7rem; }
.proof-stat-tile .num { font-size:1.6rem; line-height:1; font-weight:600; }
.proof-stat-tile .num .of { font-size:0.65em; color:#6e7681; font-weight:400; }
.proof-stat-tile .lbl { font-size:0.65rem; text-transform:uppercase; letter-spacing:0.06em;
                        color:#8b949e; margin-top:0.35rem; }
.proof-stats-meta { display:flex; align-items:center; color:#8b949e; font-size:0.88em; }
/* Module 7 — share buttons row, sits between the stat band and Event Details. */
.proof-share { display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center;
               margin:0.2rem 0 0.9rem; }
.proof-share .label { font-size:0.7rem; text-transform:uppercase; letter-spacing:0.07em;
                      color:#8b949e; margin-right:0.3rem; }
.proof-share button { background:#161b22; color:#3fb950; border:1px solid #3fb950;
                      padding:0.4rem 0.75rem; font:inherit; font-size:0.85em;
                      cursor:pointer; border-radius:0; letter-spacing:0.03em; }
.proof-share button:hover { background:#3fb950; color:#0d1117; }
.proof-share button:focus-visible { outline:2px solid #ffb000; outline-offset:1px; }
.proof-share button[hidden] { display:none; }
.proof-share a { text-decoration:none; }
.proof-share .toast { font-size:0.85em; color:#3fb950; opacity:0;
                      transition:opacity .15s ease-in; }
.proof-share .toast.show { opacity:1; }
details.proof-details { margin-top:0.7rem; border:1px solid #30363d; }
details.proof-details summary { cursor:pointer; padding:0.45rem 0.7rem; background:#161b22;
                                color:#ffb000; list-style:none; font-size:0.74rem;
                                text-transform:uppercase; letter-spacing:0.07em; }
details.proof-details summary::-webkit-details-marker { display:none; }
details.proof-details summary::after { content:' \\25be'; }
details.proof-details[open] summary::after { content:' \\25b4'; }
.mg-receipt { padding:0.6rem 0.8rem; background:#0d1117; border-top:1px solid #30363d; }
.mg-receipt-row { display:flex; gap:0.6rem; padding:0.3rem 0; font-size:0.82rem;
                  align-items:baseline; border-bottom:1px dotted #30363d; }
.mg-receipt-row:last-of-type { border-bottom:none; }
.mg-receipt-key { color:#8b949e; min-width:7rem; text-transform:uppercase;
                  letter-spacing:0.04em; font-size:0.7rem; }
.mg-receipt-mono { word-break:break-all; color:#c9d1d9; }
.mg-receipt-cmd { background:#0d1117; border:1px solid #30363d; padding:0.35rem 0.55rem;
                  margin-top:0.5rem; }
.mg-receipt-cmd code { background:transparent; color:#3fb950; font-size:0.78rem; }

/* Workflow trust strip + inline pills + per-step proof drawer. */
.proof-strip { background:#161b22; border:1px solid #30363d; padding:0.8rem 1rem;
               margin:0 0 0.9rem; }
.proof-strip-line { font-size:0.85rem; color:#c9d1d9; margin:0 0 0.55rem; }
.proof-strip-line strong { color:#3fb950; font-weight:600; }
.trust-pill { display:inline-block; padding:0.04em 0.45em; border:1px solid currentColor;
              font-size:0.62rem; letter-spacing:0.05em; text-transform:uppercase;
              vertical-align:middle; margin-left:0.4rem; cursor:pointer; }
.trust-pill[data-step] { user-select:none; }
.trust-pill[data-step]:focus-visible { outline:2px solid currentColor; outline-offset:2px; }
.trust-pill.attach-pill { letter-spacing:0; padding:0.04em 0.4em; }
.mg-steps tr.mg-proof-row td { background:#0d1117; padding:0.4rem 0.7rem 0.55rem;
                               border-bottom:1px solid #30363d; }
@media (max-width:540px) {
  .trust-ladder { grid-template-columns:repeat(2,1fr); }
  .trust-rung + .trust-rung { border-left:1px solid #30363d; }
  .trust-rung:nth-child(3) { border-top:none; }
  .trust-rung:nth-child(4) { border-top:none; }
  .proof-tiles { grid-template-columns:repeat(2,1fr); }
}
`;

// Module 7 — three share buttons (Email / Share / Copy) on every crypto
// manage hero. Email opens mailto: with prefilled subject + body;
// Share uses the Web Share API on mobile (button hidden when not
// supported); Copy puts the same plain-text pitch on the clipboard.
//
// The pitch text is computed server-side and embedded as data-* on the
// container so the JS can read it without re-doing the templating.
// Title + details + reply address + strict-mode attachment hint are
// the load-bearing pieces; an organiser pasting this into a Slack /
// Whatsapp / DM has the WHAT, the HOW (reply here), and a verify
// pointer in five lines.
function buildSharePitch(event) {
  const replyAddr = `event+${event.id}@${config.domain}`;
  const verbByMode = event.mode === 'declaration' ? 'declaration' : 'attestation';
  const verbAction = event.mode === 'declaration' ? 'Sign' : 'Sign the';
  const strict = !!event.reference_url
    && Array.isArray(event.reference_docs) && event.reference_docs.length > 0;
  const attachHint = strict
    ? ` with the registered file${event.reference_docs.length === 1 ? '' : 's'} attached`
    : '';
  const lines = [
    `${verbAction} ${verbByMode} "${event.title}":`,
  ];
  if (event.details) lines.push('', event.details);
  lines.push('', `Reply to: ${replyAddr}${attachHint}`);
  if (event.reference_url) lines.push('', `Reference: ${event.reference_url}`);
  lines.push('', 'Verifies offline via gitdone-verify after completion. No accounts, no app.');
  return lines.join('\n');
}

function renderShareButtons(event) {
  if (!event || event.type !== 'crypto') return raw('');
  const pitch = buildSharePitch(event);
  const subj = `Sign ${event.mode === 'declaration' ? 'declaration' : 'attestation'}: "${event.title}"`;
  // mailto: needs %0A linebreaks + percent-encoded subject/body.
  const mailto = `mailto:?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(pitch)}`;
  return html`
    <div class="proof-share" data-share-pitch="${pitch}" data-share-subject="${subj}">
      <span class="label">Share reply address</span>
      <a href="${mailto}" target="_blank" rel="noopener"><button type="button">Email</button></a>
      <button type="button" data-share-action="web" hidden>Share</button>
      <button type="button" data-share-action="copy">Copy</button>
      <span class="toast" aria-live="polite"></span>
    </div>
    <script>${raw(`
      (function(){
        var root = document.currentScript.previousElementSibling;
        if (!root) return;
        var pitch = root.getAttribute('data-share-pitch') || '';
        var subj  = root.getAttribute('data-share-subject') || '';
        var toast = root.querySelector('.toast');
        var flash = function(msg){
          if (!toast) return;
          toast.textContent = msg;
          toast.classList.add('show');
          setTimeout(function(){ toast.classList.remove('show'); }, 1800);
        };
        // Feature-detect Web Share API. Most desktop browsers don't
        // ship it; mobile + some desktop Safari do. Hidden until proven.
        if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
          var btn = root.querySelector('[data-share-action="web"]');
          if (btn) {
            btn.hidden = false;
            btn.addEventListener('click', function(){
              navigator.share({ title: subj, text: pitch }).catch(function(){ /* user cancelled */ });
            });
          }
        }
        var copyBtn = root.querySelector('[data-share-action="copy"]');
        if (copyBtn) copyBtn.addEventListener('click', function(){
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(pitch).then(
              function(){ flash('Copied to clipboard'); },
              function(){ flash('Copy failed — select + Ctrl-C'); }
            );
          } else {
            // Fallback for ancient browsers — focus a hidden textarea.
            var ta = document.createElement('textarea');
            ta.value = pitch;
            ta.style.position = 'fixed'; ta.style.left = '-9999px';
            document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); flash('Copied to clipboard'); }
            catch(_){ flash('Copy failed'); }
            document.body.removeChild(ta);
          }
        });
      })();
    `)}</script>
  `;
}

// Find the canonical "declaration" commit for a crypto declaration event:
// the first counting reply (whose sequence equals
// event.completion.commit_sequence). Returns null when the declaration
// hasn't been signed yet.
function findDeclarationCommit(event, commits) {
  if (!event || event.type !== 'crypto' || event.mode !== 'declaration') return null;
  if (!event.completion || event.completion.status !== 'complete') return null;
  const seq = event.completion.commit_sequence;
  if (seq == null) return commits.find((c) => !c.kind && c.sequence) || null;
  return commits.find((c) => c.sequence === seq && !c.kind) || null;
}

// For attestation: the ordered list of ledger commits to render — counted
// + audit-only reply commits (matched by sender_hash in event.replies[])
// AND every kind:'revoke' commit. The render loop branches on c.kind to
// pick the row template (signature row vs. revoke row). Latest first.
function findAttestationCommits(event, commits) {
  if (!event || event.type !== 'crypto' || event.mode !== 'attestation') return [];
  const wanted = new Set();
  for (const r of (event.replies || [])) if (r.sender_hash) wanted.add(r.sender_hash);
  const out = commits.filter((c) =>
    c.kind === 'revoke'
      ? true
      : (!c.kind && c.sender_hash && wanted.has(c.sender_hash))
  );
  out.sort((a, b) => (b.sequence || 0) - (a.sequence || 0));
  return out;
}

function fmtDate(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : String(iso).slice(0, 10);
}

// C3 hero strip for crypto declarations. Ladder + headline + secondary
// Module 4a: docs row + registration-address row. Each doc renders as
// "filename · sha256[12] · human-size". When the event hasn't received a
// counted reply yet, also surface the attach+<id>@ address so the
// initiator knows where to email more files; bytes are hashed and
// discarded.
function isReferenceDocSetFrozen(event) {
  if (!event || event.type !== 'crypto') return false;
  const hasDocs = Array.isArray(event.reference_docs) && event.reference_docs.length > 0;
  if (event.reference_url && hasDocs) return true;
  if (event.mode === 'attestation') return (event.replies || []).length > 0;
  if (event.mode === 'declaration') return !!(event.completion && event.completion.status === 'complete');
  return false;
}

function renderReferenceDocsRow(event) {
  if (!event || event.type !== 'crypto') return raw('');
  const docs = Array.isArray(event.reference_docs) ? event.reference_docs : [];
  const frozen = isReferenceDocSetFrozen(event);
  // For attestation, signing state lives in event.attestor_progress
  // (per-attestor sha256 sets); for declaration it's reference_docs[i].signed_at.
  // Precompute a per-doc count of attestors who signed this hash.
  const isAttestation = event.mode === 'attestation';
  const attestorProgress = event.attestor_progress || {};
  const perDocAttestorCount = isAttestation
    ? docs.map((d) => {
        if (!d || !d.sha256) return 0;
        let n = 0;
        for (const k of Object.keys(attestorProgress)) {
          const hashes = attestorProgress[k] && attestorProgress[k].signed_doc_hashes;
          if (Array.isArray(hashes) && hashes.includes(d.sha256)) n++;
        }
        return n;
      })
    : null;
  const docsBlock = docs.length
    ? html`<div class="proof-row">
        <div class="proof-key">Reference docs</div>
        <div class="proof-value" style="display:flex;flex-direction:column;gap:0.18rem">
          ${docs.map((d, i) => {
            const sz = formatBytes(d.size);
            let sig, sigColor, annot;
            if (isAttestation) {
              const n = perDocAttestorCount[i];
              if (n > 0) {
                sig = `[${n}x]`;
                sigColor = '#3fb950';
                annot = html` · <span style="color:#8b949e">${String(n)} attestor${n === 1 ? '' : 's'} signed</span>`;
              } else {
                sig = '[ ]';
                sigColor = '#6e7681';
                annot = raw('');
              }
            } else {
              sig = d.signed_at ? '[x]' : '[ ]';
              sigColor = d.signed_at ? '#3fb950' : '#6e7681';
              const trust = d.signed_trust_level;
              const trustLabel = trust ? (TRUST_LABEL[trust] || trust) : null;
              const trustColor = trust ? (TRUST_COLOR[trust] || '#c9d1d9') : '#8b949e';
              const dom = d.signed_sender_domain;
              const dateStr = d.signed_at ? String(d.signed_at).slice(0, 10) : null;
              annot = d.signed_at
                ? html` · <span style="color:${raw(trustColor)}">${trustLabel || 'signed'}</span>${dom ? html` · <span style="color:#8b949e">@${dom}</span>` : raw('')}${dateStr ? html` · <span style="color:#8b949e">${dateStr}</span>` : raw('')}`
                : raw('');
            }
            return html`<div><span style="color:${raw(sigColor)};font-family:JetBrains Mono,monospace">${sig}</span> <code>${d.filename || `doc-${String(i + 1)}`}</code> <span class="mg-receipt-mono" style="color:#6e7681">${truncHash(d.sha256)}</span>${sz ? html` <span style="color:#6e7681">· ${sz}</span>` : raw('')}${annot}</div>`;
          })}
          ${frozen ? html`<div style="color:#8b949e;font-size:0.85em">doc set frozen at first reply</div>` : raw('')}
        </div>
      </div>`
    : raw('');
  const addrBlock = !frozen
    ? html`<div class="proof-row">
        <div class="proof-key">Add docs</div>
        <div class="proof-value">
          <code class="copyable">attach+${event.id}@${config.domain}</code>
          <div style="color:#8b949e;font-size:0.85em;margin-top:0.15rem">email attachments here; we hash + discard the bytes</div>
        </div>
      </div>`
    : raw('');
  return html`${docsBlock}${addrBlock}`;
}

// details (signer/reply-addr/status) + collapsible full receipt.
//
// Under strict signing (Module 4c), an event has N reference docs each
// signed by a separate reply commit. We render per-doc summary rows
// (each independently expandable into the full DKIM/SPF/DMARC/ARC/OTS
// receipt), instead of one combined drawer (Module 4d#6).
function renderDeclarationHero(event, commit, allCommits = []) {
  const achieved = commit ? commit.trust_level : null;
  const headlineLabel = (achieved && TRUST_LABEL[achieved]) || 'PENDING SIGNATURE';
  const headlineCls = achieved ? `is-${achieved}` : 'is-unverified';
  const dateStr = commit && commit.received_at ? fmtDate(commit.received_at).slice(0, 10) : null;
  const domain = commit && commit.sender_domain ? commit.sender_domain : null;
  const headline = (achieved && domain && dateStr)
    ? html`${headlineLabel} · @${domain} · ${dateStr}`
    : html`${headlineLabel}`;
  const strictMode = !!event.reference_url
    && Array.isArray(event.reference_docs) && event.reference_docs.length > 0;
  const perDocReceipts = strictMode
    ? renderPerDocReceipts(event, allCommits)
    : (commit
        ? html`<details class="proof-details">
            <summary>Cryptographic proof</summary>
            ${renderProofReceipt(commit, event.id)}
          </details>`
        : raw(''));
  // Unified stat band — same shape as attestation (signers / verified
  // tiles + meta). For declaration the "signers" tile reads as
  // "signed" (0 or 1) and "verified" mirrors it iff the signer's
  // commit came in DKIM-verified. Audit-only count surfaces any
  // rejected reply (wrong attachment, self-reply, etc.) so the
  // organiser sees that an extra commit landed without counting.
  const signedN = commit ? 1 : 0;
  const verifiedN = (commit && commit.trust_level === 'verified') ? 1 : 0;
  const declMeta = [];
  // Audit-only = total commits minus the one counted commit (or 0
  // for a pending declaration).
  const declAudit = Math.max(0, (allCommits || []).length - signedN);
  if (declAudit > 0) declMeta.push(`${declAudit} audit-only`);
  if (commit && event.completion && event.completion.completed_at) {
    declMeta.push(`signed ${String(event.completion.completed_at).slice(0, 10)}`);
  }
  const statBand = html`<div class="proof-stats">
    <div class="proof-stat-tile" style="color:${raw(TRUST_COLOR.verified)}">
      <div class="num">${String(signedN)}<span class="of"> / 1</span></div>
      <div class="lbl">signed</div>
    </div>
    <div class="proof-stat-tile" style="color:${raw(TRUST_COLOR.verified)}">
      <div class="num">${String(verifiedN)}</div>
      <div class="lbl">verified</div>
    </div>
    ${declMeta.length ? html`<div class="proof-stats-meta">${declMeta.join(' · ')}</div>` : raw('')}
  </div>`;
  return html`
    <div class="proof-hero">
      ${renderShareButtons(event)}
      ${renderTrustLadder({ achieved })}
      <div class="proof-headline ${headlineCls}">${headline}</div>
      <div class="proof-sub">"${event.title}" · id <code>${event.id}</code></div>
      <div class="proof-mode-badge decl">Declaration <span class="sep">·</span> <span class="dedup">one signer, one record</span></div>
      ${statBand}
      <div class="proof-secondary">
        <h4>Event details</h4>
        <div class="proof-row"><div class="proof-key">Type</div><div class="proof-value">declaration</div></div>
        ${event.details ? html`<div class="proof-row"><div class="proof-key">Ask</div><div class="proof-value" style="white-space:pre-wrap">${event.details}</div></div>` : raw('')}
        ${event.reference_url ? html`<div class="proof-row"><div class="proof-key">Reference</div><div class="proof-value"><a href="${event.reference_url}" rel="noopener noreferrer" target="_blank" title="${event.reference_url}">${truncateText(event.reference_url, 30)}</a></div></div>` : raw('')}
        ${renderReferenceDocsRow(event)}
        <div class="proof-row"><div class="proof-key">Initiator</div><div class="proof-value"><code class="copyable">${event.initiator}</code></div></div>
        <div class="proof-row"><div class="proof-key">Signer</div><div class="proof-value"><code class="copyable">${event.signer}</code></div></div>
        <div class="proof-row"><div class="proof-key">Reply address</div><div class="proof-value"><code class="copyable">event+${event.id}@${config.domain}</code></div></div>
        <div class="proof-row"><div class="proof-key">Status</div><div class="proof-value">${commit ? html`signed on <code>${event.completion.completed_at.slice(0, 10)}</code>` : 'awaiting signature'}</div></div>
      </div>
      ${perDocReceipts}
    </div>
  `;
}

// Module 4d#6 — per-doc proof receipts. One row per registered doc:
// pending docs render a dim "[ ] filename · awaiting" line; signed docs
// render a clickable summary that expands into the full receipt for the
// commit that registered the signature.
function renderPerDocReceipts(event, allCommits) {
  const docs = Array.isArray(event.reference_docs) ? event.reference_docs : [];
  if (!docs.length) return raw('');
  const commitBySeq = new Map();
  for (const c of (allCommits || [])) {
    if (c && c.sequence != null) commitBySeq.set(c.sequence, c);
  }
  return html`
    <div class="proof-secondary" style="margin-top:0.6rem">
      <h4>Per-document proof</h4>
      ${docs.map((d, i) => {
        if (!d.signed_at) {
          return html`<details class="proof-details" style="opacity:0.7">
            <summary style="cursor:default;color:#8b949e">
              [ ] <code>${d.filename || `doc-${String(i + 1)}`}</code>
              <span style="margin-left:0.5rem;color:#6e7681;font-size:0.88em">awaiting signature</span>
            </summary>
          </details>`;
        }
        const seq = d.signed_commit_sequence;
        const docCommit = seq != null ? commitBySeq.get(seq) : null;
        const trust = d.signed_trust_level;
        const trustLabel = trust ? (TRUST_LABEL[trust] || trust) : 'signed';
        const trustColor = trust ? (TRUST_COLOR[trust] || '#c9d1d9') : '#3fb950';
        const dom = d.signed_sender_domain;
        const dateStr = String(d.signed_at).slice(0, 10);
        return html`<details class="proof-details">
          <summary>
            <span style="color:#3fb950">[x]</span>
            <code>${d.filename || `doc-${String(i + 1)}`}</code>
            <span style="margin-left:0.5rem;color:${raw(trustColor)}">${trustLabel}</span>${dom ? html` <span style="color:#8b949e">· @${dom}</span>` : raw('')}
            <span style="color:#8b949e"> · ${dateStr}</span>
          </summary>
          ${docCommit
            ? renderProofReceipt(docCommit, event.id)
            : html`<div style="padding:0.7rem;color:#8b949e;font-size:0.9em">commit data unavailable (sequence ${String(seq)})</div>`}
        </details>`;
      })}
    </div>
  `;
}

// C3 hero strip for crypto attestations. Ladder uses the modal trust
// across counted replies; headline summarises threshold progress;
// trust tiles show non-zero counts; collapsible per-reply ledger.
function renderAttestationHero(event, commits) {
  const replies = event.replies || [];
  const dedup = event.dedup || 'unique';
  const { counts, modal } = aggregateTrust(replies);
  // Module 6.5 — under strict mode the user-facing count is distinct
  // attestors whose buckets are complete, regardless of dedup. That
  // matches the "a signer is a signer" intuition: re-signing the same
  // manifest doesn't move the count even under accumulating dedup.
  // Loose attestation keeps the original dedup-based count.
  // Module 8 — every count surface drops sender_hashes the initiator
  // has revoked (audit trail kept; counter doesn't see them).
  const strict = !!event.reference_url
    && Array.isArray(event.reference_docs)
    && event.reference_docs.length > 0;
  const revokedSet = revokedHashSet(event);
  let count;
  if (strict) {
    const progress = event.attestor_progress || {};
    count = Object.entries(progress)
      .filter(([k, p]) => p && p.complete && !revokedSet.has(k)).length;
  } else if (dedup === 'unique') {
    const seen = new Set();
    for (const r of replies) {
      if (r.sender_hash && !revokedSet.has(r.sender_hash)) seen.add(r.sender_hash);
    }
    count = seen.size;
  } else {
    count = replies.reduce((n, r) => n + (revokedSet.has(r.sender_hash) ? 0 : 1), 0);
  }
  const complete = event.completion && event.completion.status === 'complete';
  const accumulating = dedup === 'accumulating';
  const thresholdReachedAt = event.threshold_reached_at;
  const thresholdReached = !!thresholdReachedAt || complete;
  const achieved = modal;
  const headlineCls = achieved ? `is-${achieved}` : 'is-unverified';
  const modalLabel = achieved ? TRUST_LABEL[achieved] : 'PENDING REPLIES';
  let headline;
  if (accumulating && thresholdReachedAt) {
    const dateStr = String(thresholdReachedAt).slice(0, 10);
    // Strict mode counts distinct signers (not raw replies) so the
    // headline noun changes to match.
    const noun = strict ? 'signers' : 'replies';
    headline = html`${modalLabel} · ${String(count)} ${noun} · threshold reached ${dateStr}`;
  } else if (complete) {
    const dateStr = String(event.completion.completed_at).slice(0, 10);
    const verb = isClosedByInitiator(event) ? 'closed early' : 'complete';
    headline = html`${modalLabel} · ${String(count)} of ${String(event.threshold)} · ${verb} ${dateStr}`;
  } else {
    headline = html`${modalLabel} · ${String(count)} of ${String(event.threshold)}`;
  }
  // Unified stat band — two prominent tiles (SIGNERS / VERIFIED) plus
  // a meta strip (audit-only count, threshold-reached date). Replaces
  // the prior per-reply trust tiles (3 verified) — the trust ladder
  // above already conveys the trust posture, and the user-facing
  // metric people actually want is "how many distinct signers" not
  // "how many DKIM-verified replies".
  //
  // verified-signer logic: under strict mode, a complete attestor is
  // verified iff any of their counted replies came in DKIM-verified.
  // Under loose mode we fall back to the dedup-aware verified count
  // (which is what the prior code surfaced).
  let signersN; let verifiedN;
  if (strict) {
    const progressMap = event.attestor_progress || {};
    const completeKeys = Object.keys(progressMap).filter((k) => progressMap[k] && progressMap[k].complete && !revokedSet.has(k));
    signersN = completeKeys.length;
    const verifiedHashes = new Set(
      replies.filter((r) => r.trust_level === 'verified' && r.sender_hash).map((r) => r.sender_hash)
    );
    verifiedN = completeKeys.filter((k) => verifiedHashes.has(k)).length;
  } else if (dedup === 'unique') {
    const seenAll = new Set();
    const seenVerified = new Set();
    for (const r of replies) {
      if (!r.sender_hash || revokedSet.has(r.sender_hash)) continue;
      seenAll.add(r.sender_hash);
      if (r.trust_level === 'verified') seenVerified.add(r.sender_hash);
    }
    signersN = seenAll.size;
    verifiedN = seenVerified.size;
  } else {
    const live = replies.filter((r) => !revokedSet.has(r.sender_hash));
    signersN = live.length;
    verifiedN = live.filter((r) => r.trust_level === 'verified').length;
  }
  // Module 9 — when any sender has been revoked, the audit count diverges
  // from the effective count. The stat band shows the breakdown: attested
  // (pre-revoke distinct signers) · revoked (R) · effective (= signersN,
  // already revocation-filtered). Below threshold + once-was-complete is
  // surfaced as a subtitle so the organiser can see "we made it, then it
  // dropped" at a glance instead of digging through the ledger.
  const revokedCount = revokedSet.size;
  // ledger commits are passed in already filtered to attestation rows +
  // kind:'revoke' commits (see findAttestationCommits). The audit-only
  // count is "non-revoke commits not in counted-reply set" — we have to
  // skip kind:'revoke' both numerator and denominator.
  const replyCommitsN = (commits || []).filter((c) => c && c.kind !== 'revoke').length;
  const auditOnlyN = Math.max(0, replyCommitsN - replies.length);
  const thresholdDateStr = thresholdReachedAt ? String(thresholdReachedAt).slice(0, 10) : null;
  const completedDateStr = (event.completion && event.completion.completed_at)
    ? String(event.completion.completed_at).slice(0, 10) : null;
  const reopenedAt = event.completion && event.completion.reopened_at;
  const reopenedDate = reopenedAt ? String(reopenedAt).slice(0, 10) : null;
  // Module 9 — "originally reached, since revoked" subtitle fires when:
  //   - the event historically reached threshold (threshold_reached_at
  //     is a durable anchor; executeClose does NOT wipe it)
  //   - revocation has happened (otherwise the subtitle is noise)
  //   - the effective count is now below threshold
  // Earlier draft gated on completion.reopened_at, but executeClose
  // overwrites the whole completion object — so a closed-early event
  // lost the subtitle even when the historical truth still held.
  const onceReachedNowBelow = !!(thresholdDateStr && revokedCount > 0 && count < (event.threshold || 0));
  const metaBits = [];
  if (auditOnlyN > 0) metaBits.push(`${auditOnlyN} audit-only`);
  if (complete && !accumulating && completedDateStr) {
    metaBits.push(`complete ${completedDateStr}`);
  } else if (thresholdReached && thresholdDateStr) {
    metaBits.push(`threshold reached ${thresholdDateStr}`);
  }
  const tilesHTML = revokedCount > 0
    ? html`<div class="proof-stats">
        <div class="proof-stat-tile" style="color:${raw(TRUST_COLOR.verified)}">
          <div class="num">${String(signersN + revokedCount)}</div>
          <div class="lbl">attested</div>
        </div>
        <div class="proof-stat-tile" style="color:#ffb000">
          <div class="num">${String(revokedCount)}</div>
          <div class="lbl">revoked</div>
        </div>
        <div class="proof-stat-tile" style="color:${raw(TRUST_COLOR.verified)}">
          <div class="num">${String(signersN)}${event.threshold ? html`<span class="of"> / ${String(event.threshold)}</span>` : raw('')}</div>
          <div class="lbl">effective</div>
        </div>
        ${metaBits.length ? html`<div class="proof-stats-meta">${metaBits.join(' · ')}</div>` : raw('')}
      </div>`
    : html`<div class="proof-stats">
        <div class="proof-stat-tile" style="color:${raw(TRUST_COLOR.verified)}">
          <div class="num">${String(signersN)}${event.threshold ? html`<span class="of"> / ${String(event.threshold)}</span>` : raw('')}</div>
          <div class="lbl">signers</div>
        </div>
        <div class="proof-stat-tile" style="color:${raw(TRUST_COLOR.verified)}">
          <div class="num">${String(verifiedN)}</div>
          <div class="lbl">verified</div>
        </div>
        ${metaBits.length ? html`<div class="proof-stats-meta">${metaBits.join(' · ')}</div>` : raw('')}
      </div>`;
  const dedupBlurb = dedup === 'unique'
    ? 'one count per sender'
    : (dedup === 'latest' ? 'latest counts per sender' : 'every reply counts');
  // Module 9 — "originally reached <date>, since revoked <date>" sits
  // directly under the headline when the count has dropped below
  // threshold via revoke. Single source of truth: completion.reopened_at
  // + threshold_reached_at. Above-threshold still-revoked is intentionally
  // silent (the triple-count tiles already say it).
  const revokeSubtitle = onceReachedNowBelow
    ? html`<div class="proof-revoke-sub" style="color:#ffb000;font-size:0.86em;margin-top:0.35rem;letter-spacing:0.02em">originally reached ${thresholdDateStr}, since revoked${reopenedDate ? html` ${reopenedDate}` : raw('')}</div>`
    : raw('');
  return html`
    <div class="proof-hero">
      ${renderShareButtons(event)}
      ${renderTrustLadder({ achieved })}
      <div class="proof-headline ${headlineCls}">${headline}</div>
      ${revokeSubtitle}
      <div class="proof-sub">"${event.title}" · id <code>${event.id}</code></div>
      <div class="proof-mode-badge attn">Attestation <span class="sep">·</span> <span class="dedup">${dedupBlurb}</span></div>
      ${tilesHTML}
      <div class="proof-secondary">
        <h4>Event details</h4>
        <div class="proof-row"><div class="proof-key">Type</div><div class="proof-value">attestation · ${dedup}</div></div>
        ${event.details ? html`<div class="proof-row"><div class="proof-key">Ask</div><div class="proof-value" style="white-space:pre-wrap">${event.details}</div></div>` : raw('')}
        ${event.reference_url ? html`<div class="proof-row"><div class="proof-key">Reference</div><div class="proof-value"><a href="${event.reference_url}" rel="noopener noreferrer" target="_blank" title="${event.reference_url}">${truncateText(event.reference_url, 30)}</a></div></div>` : raw('')}
        ${renderReferenceDocsRow(event)}
        <div class="proof-row"><div class="proof-key">Initiator</div><div class="proof-value"><code class="copyable">${event.initiator}</code></div></div>
        <div class="proof-row"><div class="proof-key">Reply address</div><div class="proof-value"><code class="copyable">event+${event.id}@${config.domain}</code></div></div>
        <div class="proof-row"><div class="proof-key">Revoke address</div><div class="proof-value"><code class="copyable">revoke+${event.id}@${config.domain}</code> <span style="color:#8b949e;font-size:0.86em">— initiator only; one email per line in the body, optional <code>reason:</code></span></div></div>
        <div class="proof-row"><div class="proof-key">Threshold</div><div class="proof-value">${String(event.threshold)}</div></div>
      </div>
      ${commits.length ? html`
        <details class="proof-details">
          <summary>Cryptographic proof — per-reply ledger</summary>
          <div class="mg-receipt">
            ${(() => {
              // Audit-trail policy commits every inbound reply, counted or
              // not (PRD §0.1.10 — "audit trail always wins"). Without a
              // visual cue the rejected ones (wrong-doc strict mismatch,
              // self-reply, etc.) read identical to counted attestations
              // and the organiser can't tell who counted. Compute the
              // counted-sequence set from event.replies and badge the rest.
              // Module 9 — additionally, replies from a revoked sender_hash
              // are struck through with an amber "revoked" badge, and
              // kind:'revoke' commits get their own row template showing
              // the initiator's reason inline.
              const countedSeqs = new Set();
              for (const r of (event.replies || [])) {
                if (typeof r.sequence === 'number') countedSeqs.add(r.sequence);
              }
              // Build a sender_hash → sender_domain lookup once, so each
              // revoke row can name the affected attestor(s) by domain
              // (we never store plaintext emails for loose attestation;
              // domain is the most-informative thing we have without
              // breaking the anonymity-friendly posture).
              const hashToDomain = new Map();
              for (const rc of commits) {
                if (rc && rc.kind !== 'revoke' && rc.sender_hash && rc.sender_domain && !hashToDomain.has(rc.sender_hash)) {
                  hashToDomain.set(rc.sender_hash, rc.sender_domain);
                }
              }
              return commits.map((c) => {
                if (c.kind === 'revoke') {
                  const revokedList = Array.isArray(c.revoked) ? c.revoked : [];
                  const nRev = revokedList.length;
                  const domains = revokedList
                    .map((r) => r && r.sender_hash ? (hashToDomain.get(r.sender_hash) || null) : null)
                    .filter(Boolean);
                  const domainStr = domains.length ? domains.join(', ') : 'unknown sender';
                  const reason = c.reason ? String(c.reason) : '';
                  return html`
              <div class="proof-row" style="border-left:2px solid #ffb000;padding-left:0.6rem">
                <div class="proof-key" style="color:#ffb000;letter-spacing:0.04em;text-transform:uppercase">revoke</div>
                <div class="proof-value">${fmtDate(c.received_at)} · ${domainStr}</div>
                <span class="trust-pill" style="color:#ffb000;border-color:#ffb000;margin-left:0.5rem;text-transform:uppercase;letter-spacing:0.04em">−${String(nRev)} attestor${nRev === 1 ? '' : 's'}</span>
                <div style="margin-left:0.8rem;color:#8b949e;font-size:0.85em;font-style:italic">${reason ? html`"${reason}"` : raw('no reason recorded')}</div>
              </div>
                  `;
                }
                const atts = Array.isArray(c.attachments) ? c.attachments : [];
                const counted = countedSeqs.has(c.sequence);
                const isRevoked = !!(c.sender_hash && revokedSet.has(c.sender_hash));
                const rowStyle = isRevoked
                  ? 'opacity:0.55;text-decoration:line-through'
                  : (counted ? '' : 'opacity:0.62');
                return html`
              <div class="proof-row"${rowStyle ? raw(` style="${rowStyle}"`) : raw('')}>
                <div class="proof-key">${c.sender_domain || '?'}</div>
                <div class="proof-value">${fmtDate(c.received_at)}</div>
                ${atts.length ? html`<span class="trust-pill attach-pill" style="color:${raw(TRUST_COLOR.verified)};border-color:${raw(TRUST_COLOR.verified)};margin-left:0.5rem">📎 ${String(atts.length)}</span>` : raw('')}
                ${isRevoked ? html`<span class="trust-pill" style="color:#ffb000;border-color:#ffb000;margin-left:0.5rem;text-transform:uppercase;letter-spacing:0.04em;text-decoration:none">revoked</span>` : (counted ? raw('') : html`<span class="trust-pill" style="color:#ffb000;border-color:#ffb000;margin-left:0.5rem;text-transform:uppercase;letter-spacing:0.04em">audit-only</span>`)}
                <div style="margin-left:auto;color:${raw(TRUST_COLOR[c.trust_level] || '#c9d1d9')}">${TRUST_LABEL[c.trust_level] || c.trust_level || '?'}</div>
              </div>
              ${atts.length ? html`
                <div class="proof-row" style="padding-left:1.2rem;color:#8b949e;font-size:0.85em${isRevoked ? ';opacity:0.55' : ''}">
                  <div style="display:flex;flex-direction:column;gap:0.15rem">
                    ${atts.map((a, i) => {
                      const sz = formatBytes(a.size);
                      return html`
                      <div><code>${a.filename || `attachment-${String(i + 1)}`}</code> <span class="mg-receipt-mono">${truncHash(a.sha256)}</span>${sz ? html` <span style="color:#6e7681">· ${sz}</span>` : raw('')}</div>
                    `;
                    })}
                  </div>
                </div>
              ` : raw('')}
              `;
              });
            })()}
            <div class="mg-receipt-cmd"><code class="copyable">$ gitdone-verify ${event.id}</code></div>
          </div>
        </details>
      ` : raw('')}
    </div>
  `;
}

// W2 trust strip for workflow events. Strip line + ladder above the
// steps table. Uses the WEAKEST trust level present across completed
// steps as the achieved rung (chain-of-trust: only as strong as the
// least-trusted commit).
function renderWorkflowTrustStrip(event, completedCommits) {
  const total = (event.steps || []).length;
  const k = completedCommits.length;
  const { counts, weakest } = aggregateTrust(completedCommits);
  const parts = [];
  if (counts.verified) parts.push(html`<span class="trust-pill" style="color:${raw(TRUST_COLOR.verified)};border-color:${raw(TRUST_COLOR.verified)}">${String(counts.verified)} verified</span>`);
  if (counts.forwarded) parts.push(html`<span class="trust-pill" style="color:${raw(TRUST_COLOR.forwarded)};border-color:${raw(TRUST_COLOR.forwarded)}">${String(counts.forwarded)} forwarded</span>`);
  if (counts.authorized) parts.push(html`<span class="trust-pill" style="color:${raw(TRUST_COLOR.authorized)};border-color:${raw(TRUST_COLOR.authorized)}">${String(counts.authorized)} authorized</span>`);
  if (counts.unverified) parts.push(html`<span class="trust-pill" style="color:${raw(TRUST_COLOR.unverified)};border-color:${raw(TRUST_COLOR.unverified)}">${String(counts.unverified)} unverified</span>`);
  return html`
    <div class="proof-strip">
      <div class="proof-strip-line">
        <strong>${String(k)} of ${String(total)}</strong> steps complete${parts.length ? raw(' · ') : raw('')}${parts}
      </div>
      ${renderTrustLadder({ achieved: weakest })}
      <div style="font-size:0.7rem;color:#8b949e;margin-top:0.5rem;letter-spacing:0.04em;text-transform:uppercase">Chain of trust — ladder caps at the weakest commit.</div>
    </div>
  `;
}

function renderManagementDashboard({ eventId, initiatorEmail, event, flash, stepAttempts = {}, eventCommits = [] }) {
  const complete = event.completion && event.completion.status === 'complete';
  const pendingActivation = !event.activated_at && !complete;
  const archived = !!event.archived_at && !complete;
  const pill = complete
    ? html`<span class="mg-pill complete">complete</span>`
    : (archived
      ? html`<span class="mg-pill archived">archived</span>`
      : (pendingActivation
        ? html`<span class="mg-pill pending-activation">pending activation</span>`
        : html`<span class="mg-pill open">active</span>`));
  let bodyMiddle;
  if (event.type === 'event' && pendingActivation) {
    // Pending workflow events have no live state (no replies, no
    // bounces, no completion). Render the same form layout the
    // organiser used to create the event, in read-only mode — they
    // recognise the shape, and the action row at the bottom carries
    // Activate / Edit / Close event.
    bodyMiddle = renderWorkflowForm({ event, viewOnly: true });
  } else if (event.type === 'event') {
    const allSteps = event.steps || [];
    const done = allSteps.filter((s) => s.status === 'complete').length;
    const total = allSteps.length;
    const anyDeadlines = allSteps.some((s) => s.deadline);
    const anyAtt = allSteps.some((s) => s.requires_attachment);
    const rows = allSteps.flatMap((s, i) => {
      const blocked = s.status !== 'complete' && (s.depends_on || []).some((dep) => {
        const d = allSteps.find((x) => x.id === dep);
        return !d || d.status !== 'complete';
      });
      const statusCls = s.status === 'complete' ? 'status-complete' : (blocked ? 'status-blocked' : 'status-pending');
      const latest = stepAttempts[s.id];
      const rejectedAttempt = s.status !== 'complete' && latest
        ? (s.requires_attachment && (!latest.attachments || latest.attachments.length === 0)
            ? { reason: 'missing attachment', at: latest.received_at, domain: latest.sender_domain }
            : (!latest.participant_match
                ? { reason: 'sender not a named participant', at: latest.received_at, domain: latest.sender_domain }
                : null))
        : null;
      const statusLabel = s.status === 'complete'
        ? '✓ complete'
        : (blocked ? '⏸ waiting' : (rejectedAttempt ? '⚠ reply rejected' : '○ pending'));
      const depsLabel = (s.depends_on || []).length
        ? (s.depends_on || []).map((dep) => {
            const idx = allSteps.findIndex((x) => x.id === dep);
            return idx >= 0 ? `#${idx + 1}` : dep;
          }).join(', ')
        : '—';
      // Inline trust pill on completed steps. The pill carries
      // data-step=<id> so the table click handler toggles the drawer.
      const completedCommit = s.status === 'complete' ? stepAttempts[s.id] : null;
      const attCount = completedCommit && Array.isArray(completedCommit.attachments) ? completedCommit.attachments.length : 0;
      const stepPill = completedCommit && completedCommit.trust_level
        ? html` <span class="trust-pill trust-${completedCommit.trust_level}" data-step="${s.id}" role="button" tabindex="0" aria-expanded="false" style="color:${raw(TRUST_COLOR[completedCommit.trust_level] || '#c9d1d9')};border-color:${raw(TRUST_COLOR[completedCommit.trust_level] || '#30363d')}">${TRUST_LABEL[completedCommit.trust_level] || completedCommit.trust_level}</span>${attCount ? html` ${renderAttachmentPill({ count: attCount, stepId: s.id })}` : raw('')}`
        : raw('');
      const out = [
        html`
          <tr>
            <td>${String(i + 1)}</td>
            <td data-label="Step"><strong>${s.name}</strong></td>
            <td data-label="Participant"><code class="copyable">${s.participant}</code></td>
            ${anyDeadlines ? html`<td data-label="Deadline">${s.deadline ? html`<code>${s.deadline.slice(0, 10)}</code>` : raw('—')}</td>` : raw('')}
            ${anyAtt ? html`<td class="col-att-flag" data-label="Attachment">${s.requires_attachment ? html`<span title="attachment required">📎</span>` : raw('—')}</td>` : raw('')}
            <td data-label="Depends on">${raw(depsLabel === '—' ? '—' : 'after ' + depsLabel)}</td>
            <td class="${statusCls}" data-label="Status">${statusLabel}${stepPill}</td>
          </tr>
        `,
      ];
      if (completedCommit) {
        const colspan = 4 + (anyDeadlines ? 1 : 0) + (anyAtt ? 1 : 0);
        out.push(html`
          <tr class="mg-proof-row" data-step="${s.id}" hidden>
            <td></td>
            <td colspan="${String(colspan)}">${renderProofReceipt(completedCommit, eventId)}</td>
          </tr>
        `);
      }
      if (s.details) {
        const colspan = 4 + (anyDeadlines ? 1 : 0) + (anyAtt ? 1 : 0);
        out.push(html`
          <tr class="mg-details-row" data-step="${s.id}">
            <td></td>
            <td colspan="${String(colspan)}"><div class="mg-details">${s.details}</div></td>
          </tr>
        `);
      }
      if (rejectedAttempt) {
        const colspan = 4 + (anyDeadlines ? 1 : 0) + (anyAtt ? 1 : 0);
        out.push(html`
          <tr class="mg-reject-row">
            <td></td>
            <td colspan="${String(colspan)}">
              <div class="mg-reject">
                ↳ reply received${rejectedAttempt.domain ? html` from <code>@${rejectedAttempt.domain}</code>` : raw('')} · <strong>${rejectedAttempt.reason}</strong> · not counted · <span class="mg-reject-at">${rejectedAttempt.at ? rejectedAttempt.at.slice(0, 16).replace('T', ' ') : ''}</span>
              </div>
            </td>
          </tr>
        `);
      }
      if (s.status !== 'complete' && s.last_send_error) {
        const colspan = 4 + (anyDeadlines ? 1 : 0) + (anyAtt ? 1 : 0);
        const err = s.last_send_error;
        const detail = err.reason || (err.code != null ? `sendmail exit ${err.code}` : 'unknown error');
        out.push(html`
          <tr class="mg-reject-row">
            <td></td>
            <td colspan="${String(colspan)}">
              <div class="mg-reject">
                ⚠ delivery failed · <strong>${detail}</strong> · invitation never sent · <span class="mg-reject-at">${err.at ? err.at.slice(0, 16).replace('T', ' ') : ''}</span>
              </div>
            </td>
          </tr>
        `);
      }
      return out;
    });
    // Completed-step commits feed the trust strip + ladder above the
    // table. Per-step pills + drawer rows use stepAttempts[id] inline.
    const completedCommits = allSteps
      .filter((s) => s.status === 'complete')
      .map((s) => stepAttempts[s.id])
      .filter(Boolean);
    bodyMiddle = html`
      ${completedCommits.length ? renderWorkflowTrustStrip(event, completedCommits) : raw('')}
      <h2>Steps
        <span class="hint" style="font-weight:400;color:#888;font-size:0.88em;text-transform:none;letter-spacing:0;margin-left:0.3rem">
          ${String(done)} of ${String(total)} complete
        </span>
      </h2>
      <div class="mg-section">
        <table class="mg-steps">
          <thead>
            <tr>
              <th>#</th><th>Step</th><th>Participant</th>
              ${anyDeadlines ? html`<th>Deadline</th>` : raw('')}
              ${anyAtt ? html`<th title="attachment required"></th>` : raw('')}
              <th>Depends on</th><th>Status</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <script>${raw(`
        (function(){
          var tbl = document.querySelector('.mg-steps');
          if (!tbl) return;
          // Single handler dispatched from both click + keydown so
          // keyboard users (Tab + Enter/Space) can toggle the same
          // drawers as mouse users.
          function handle(e){
            if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
            // Trust / attach pill → toggle the matching mg-proof-row.
            // Both pills on a step share data-step, so we sync
            // aria-expanded across all of them after toggling.
            var pill = e.target.closest('.trust-pill[data-step]');
            if (pill) {
              if (e.type === 'keydown') e.preventDefault();
              var pid = pill.dataset.step;
              var prow = tbl.querySelector('tr.mg-proof-row[data-step="' + pid + '"]');
              if (prow) {
                var pwasOpen = !prow.hasAttribute('hidden');
                if (pwasOpen) prow.setAttribute('hidden', '');
                else prow.removeAttribute('hidden');
                var nowOpen = !pwasOpen ? 'true' : 'false';
                var pills = tbl.querySelectorAll('.trust-pill[data-step="' + pid + '"]');
                for (var i = 0; i < pills.length; i++) pills[i].setAttribute('aria-expanded', nowOpen);
              }
              return;
            }
            // Pre-existing details-toggle button.
            var btn = e.target.closest('[data-step]');
            if (!btn || btn.tagName !== 'BUTTON') return;
            if (e.type === 'keydown') e.preventDefault();
            var id = btn.dataset.step;
            var row = tbl.querySelector('tr.mg-details-row[data-step="' + id + '"]');
            if (!row) return;
            var open = row.hasAttribute('hidden');
            if (open) row.removeAttribute('hidden');
            else row.setAttribute('hidden', '');
            btn.setAttribute('aria-expanded', open ? 'true' : 'false');
          }
          tbl.addEventListener('click', handle);
          tbl.addEventListener('keydown', handle);
        })();
      `)}</script>
    `;
  } else if (event.mode === 'declaration') {
    // C3 hero strip: ladder + DKIM-VERIFIED headline + secondary
    // details + collapsible receipt. Pre-completion (no commit yet),
    // the ladder is dim and the headline reads "PENDING SIGNATURE".
    const declCommit = findDeclarationCommit(event, eventCommits);
    bodyMiddle = renderDeclarationHero(event, declCommit, eventCommits);
  } else {
    // C3 attestation hero. Threshold/dedup details live inside the
    // hero's secondary block; the standing dedup-explainer line stays
    // below to keep the existing dedup terminology discoverable.
    const attCommits = findAttestationCommits(event, eventCommits);
    const dedup = event.dedup || 'unique';
    bodyMiddle = html`
      ${renderAttestationHero(event, attCommits)}
      <p class="mg-meta" style="margin-top:0.6rem">Dedup: <code>${dedup}</code> — ${dedupDescription(dedup)}</p>
    `;
  }

  return html`
    <style>${raw(MANAGE_CSS)}</style>
    <p style="margin:0 0 0.5rem"><a href="/manage" style="color:#8b949e;font-size:0.88em">← back</a></p>
    <p class="mg-meta">Signed in as <code class="copyable">${initiatorEmail}</code> · Event <code>${event.id}</code> · ${pill}</p>
    ${flash ? html`<div class="mg-flash" id="mg-flash-target">${flash}</div>
      <script>${raw(`
        // The flash sits below the header + back link, so on a fresh
        // navigation it can sit just-above-the-fold and read like part
        // of the metadata strip. Smooth-scroll it into view a few
        // pixels below the top so the eye lands on it directly.
        (function(){
          var el = document.getElementById('mg-flash-target');
          if (!el || typeof el.scrollIntoView !== 'function') return;
          requestAnimationFrame(function(){
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            // Nudge a touch further so the message clears any fixed
            // header chrome and sits in comfortable reading position.
            setTimeout(function(){ window.scrollBy({ top: -24, behavior: 'smooth' }); }, 250);
          });
        })();
      `)}</script>` : raw('')}
    ${pendingActivation ? (() => {
        // Auto-delete window: 72h from creation. Show the absolute
        // timestamp so the organiser knows exactly when it lapses, not
        // just "in 72h".
        const expiresAtMs = new Date(event.created_at).getTime() + 72 * 3600 * 1000;
        const expiresLabel = new Date(expiresAtMs).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
        return html`<div class="mg-pending-activation">
          <span class="title">Pending activation</span>
          Participants haven't been invited yet. Review the details below, then click <strong>Activate</strong>
          to send invitations${event.type === 'crypto' && event.mode === 'attestation' ? raw(' and make the reply address live') : raw('')}.
          Nothing leaves the server until you do. To delete this event without sending anything,
          click <strong>Close event</strong>; or just ignore — <strong>auto-deleted ${expiresLabel}</strong> if not activated.
        </div>`;
      })() : raw('')}
    ${archived ? html`<div class="mg-archived-banner">
        <strong>Archived${event.archive_reason === 'auto_stale' ? ' automatically' : ''} on <code>${String(event.archived_at).slice(0,10)}</code></strong>
        Replies to the reply addresses still land in the audit trail but don't count toward completion.
        <form method="POST" action="/manage/event/${eventId}/unarchive" style="display:inline;margin-left:0.4rem">
          <button type="submit" style="background:transparent;border:1px solid #3fb950;color:#3fb950;padding:0.2em 0.6em;cursor:pointer;font:inherit;font-size:0.85em">Un-archive</button>
        </form>
      </div>` : raw('')}

    ${bodyMiddle}

    <div class="mg-actions">
      ${pendingActivation
        ? html`<button type="button" class="mg-activate" data-confirm-trigger="activate">Activate</button>`
        : (event.type === 'crypto' && event.mode === 'attestation'
            ? raw('')
            : html`<form method="POST" action="/manage/event/${eventId}/remind" style="margin:0">
                <button type="submit" class="mg-remind" ${complete || archived ? raw('disabled') : ''}>Send reminders</button>
              </form>`)}
      ${event.type === 'event' ? html`<a href="/manage/event/${eventId}/edit" class="mg-edit-btn ${complete || archived ? raw('mg-disabled') : ''}">Edit</a>` : raw('')}
      <button type="button" class="mg-close" ${complete || archived ? raw('disabled') : ''} data-confirm-trigger="close">Close event</button>
    </div>
    ${(eventCommits && eventCommits.length)
      ? html`<div class="mg-actions" style="margin-top:0">
          <a href="/manage/event/${eventId}/bundle" class="mg-bundle-btn" download>Download proof bundle (.tar.gz)</a>
        </div>`
      : raw('')}
    ${pendingActivation ? html`<form method="POST" action="/manage/event/${eventId}/activate" class="mg-confirm-callout" data-confirm-panel="activate" hidden>
      <span class="mg-confirm-msg">${event.type === 'event' ? raw('Emails all named participants. Cannot be undone.') : (event.mode === 'declaration' ? raw('Emails the signer. Cannot be undone.') : raw('Brings the reply address live. Cannot be undone.'))}</span>
      <span class="mg-confirm-actions">
        <button type="submit" class="mg-activate">Yes, activate</button>
        <button type="button" class="mg-cancel" data-confirm-cancel>Cancel</button>
      </span>
    </form>` : raw('')}
    <form method="POST" action="/manage/event/${eventId}/close" class="mg-confirm-callout" data-confirm-panel="close" hidden>
      <span class="mg-confirm-msg">${pendingActivation ? raw("Hasn't been activated — deleting leaves no trace; participants are never contacted.") : raw('Writes a completion commit. Cannot be undone.')}</span>
      <span class="mg-confirm-actions">
        <button type="submit" class="mg-close">${pendingActivation ? raw('Yes, delete') : raw('Yes, close')}</button>
        <button type="button" class="mg-cancel" data-confirm-cancel>Cancel</button>
      </span>
    </form>
    <script>${raw(`
      (function(){
        document.querySelectorAll('[data-confirm-trigger]').forEach(function(t){
          t.addEventListener('click', function(){
            if (t.disabled) return;
            var key = t.getAttribute('data-confirm-trigger');
            document.querySelectorAll('[data-confirm-panel]').forEach(function(p){
              p.hidden = (p.getAttribute('data-confirm-panel') !== key);
            });
          });
        });
        document.querySelectorAll('[data-confirm-cancel]').forEach(function(c){
          c.addEventListener('click', function(){
            var panel = c.closest('[data-confirm-panel]');
            if (panel) panel.hidden = true;
          });
        });
      })();
    `)}</script>

    <div class="mg-email-cmds">
      <p style="margin:0 0 0.4rem">Prefer email? Send a short message from <code class="copyable">${initiatorEmail}</code> (DKIM-verified) to any of these:</p>
      <dl class="mg-email-cmd-list">
        <dt><code class="copyable">stats+${event.id}@${config.domain}</code></dt>
        <dd>get current progress back as a reply (which steps are done, pending, or waiting on deps)</dd>
        <dt><code class="copyable">remind+${event.id}@${config.domain}</code></dt>
        <dd>re-notify everyone whose step is still pending</dd>
        <dt><code class="copyable">close+${event.id}@${config.domain}</code></dt>
        <dd>close the event early — writes a completion commit to the repo, cannot be undone</dd>
        <dt><code class="copyable">bundle+${event.id}@${config.domain}</code></dt>
        <dd>get the full audit-trail repo back as a <code>.tar.gz</code> attachment — verify offline with <code>gitdone-verify</code></dd>
      </dl>
      <p style="margin:0.5rem 0 0;color:#6e7681;font-size:0.82em">The subject and body can be anything; the address tag is the command. Authentication is DKIM + envelope-sender == event organizer, so only you can trigger these from your own inbox.</p>
    </div>

    <p style="margin-top:1.5rem">
      <a href="/manage">← your events</a> ·
      <a href="/">home</a> ·
      <form method="POST" action="/manage/logout" style="display:inline;margin:0"><button type="submit" style="background:none;border:0;padding:0;color:#8b949e;font:inherit;font-size:inherit;cursor:pointer;text-decoration:underline">sign out</button></form>
    </p>
  `;
}

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
  // In dev mode, surface the real error so the feedback loop is fast.
  // In production, generic 500 page; logs are where errors belong.
  const body = IS_DEV
    ? html`<h1>500 (dev)</h1>
      <p>${err && err.message || String(err)}</p>
      <pre style="background:#f3f3f3;padding:0.75rem;overflow:auto;font-size:0.85em">${err && err.stack || ''}</pre>
      <p><a href="/">home</a></p>`
    : html`<h1>500</h1><p>Something went wrong. <a href="/">home</a></p>`;
  res.end(layout({ title: 'error', body }));
}

async function handle(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  // Dev-only endpoints before the main router
  if (IS_DEV && u.pathname === '/dev/feedback' && req.method === 'POST') {
    return devChannel.handleFeedback(req, res);
  }
  if (IS_DEV && u.pathname === '/dev/stream' && req.method === 'GET') {
    return devChannel.handleStream(req, res);
  }
  if (IS_DEV && u.pathname.startsWith('/__design_lab')) {
    return designLab.handle(req, res, u);
  }
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
  // Attach the error listener BEFORE listen() so we catch synchronous
  // EADDRINUSE — otherwise the throw from listen() would land on the
  // process default handler and exit with a Node stack trace that
  // buries the actionable bit (which port, what to kill).
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      process.stderr.write(
        `port ${LISTEN_PORT} is already in use — another gitdone-web is running. ` +
        `find it with: lsof -ti:${LISTEN_PORT}  or  ps aux | grep 'node bin/server.js'. ` +
        `kill it, then retry.\n`
      );
      process.exit(1);
    }
    process.stderr.write(`gitdone-web failed: ${err && err.stack || err}\n`);
    process.exit(1);
  });
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
      process.exit(0);
    });
  }
}

module.exports = { handle, router };
