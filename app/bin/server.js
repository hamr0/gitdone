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
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

// Dev-mode detection FIRST — we may need to set GITDONE_DATA_DIR before
// requiring config/event-store (which cache the value at load time).
const IS_DEV = process.argv.includes('--dev') || process.env.GITDONE_DEV === '1';
if (IS_DEV && !process.env.GITDONE_DATA_DIR) {
  const devDataDir = path.join(process.cwd(), 'data-dev');
  try { fs.mkdirSync(devDataDir, { recursive: true }); } catch {}
  process.env.GITDONE_DATA_DIR = devDataDir;
  process.stderr.write(`dev: using GITDONE_DATA_DIR=${devDataDir}\n`);
}

const config = require('../src/config');
const { createRouter } = require('../src/web/router');
const { layout: rawLayout, html, raw } = require('../src/web/templates');
const { parseBody } = require('../src/web/body');
const { validateWorkflowEvent, validateCryptoEvent, VALID_TRUST_LEVELS, VALID_CRYPTO_MODES, VALID_DEDUP_RULES } = require('../src/web/validation');
const { createEvent } = require('../src/event-store');
const { createToken, loadToken } = require('../src/magic-token');
const { sendmail, buildRawMessage } = require('../src/outbound');
const { notifyWorkflowParticipants, notifyDeclarationSigner } = require('../src/notifications');
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
.vF .manage-strip a { color: #58a6ff; }
.vF .manage-strip a:hover { color: #ffb000; }
@media (max-width: 640px) { .vF .grid { grid-template-columns: 1fr; }
  .vF .cell { border-right: 0; border-bottom: 1px solid #30363d; }
  .vF .cell:last-child { border-bottom: 0; } }
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
  res.end(layout({ title: 'gitdone', body }));
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
.vf-submit { background: #3fb950; color: #0d1117; padding: 0.65rem 1.8rem; border: 0; border-radius: 0; cursor: pointer; font-weight: 600; margin-top: 1.1rem; font-size: 0.95em; letter-spacing: 0.05em; text-transform: uppercase; }
.vf-submit:hover { background: #ffb000; }
@media (max-width: 540px) { .vf-row { grid-template-columns: 1fr; } .vf-steps-table { font-size: 0.83em; } }
`;

const TRUST_LABELS = {
  verified: 'verified — cryptographic proof the sender wrote it (DKIM + DMARC both pass)',
  forwarded: 'forwarded — OK through trusted mail relays (e.g. Gmail forwarding)',
  authorized: 'authorized — OK from the sender\u2019s domain mail servers (SPF only)',
  unverified: 'unverified — accept any reply, no proof required',
};

function renderWorkflowForm({ values = {}, errors = [] } = {}) {
  const names = values.step_name || [];
  const participants = values.step_participant || [];
  const deadlines = values.step_deadline || [];
  const atts = values.step_requires_attachment || [];
  const depsArr = values.step_depends_on || [];
  const detailsArr = values.step_details || [];
  const stepRows = Math.max(2, names.length || 2);
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
    rows.push(html`
      <tr>
        <td class="col-num">${i + 1}</td>
        <td class="col-name">
          <input type="text" name="step_name" value="${n}" maxlength="200" placeholder="step name">
        </td>
        <td class="col-email"><input type="email" name="step_participant" value="${p}" placeholder="email@…"></td>
        <td class="col-dl"><input type="date" name="step_deadline" value="${d ? d.slice(0, 10) : ''}"></td>
        <td class="col-deps"><input type="text" name="step_depends_on" value="${dep}" placeholder="e.g. 1" title="step numbers this step waits for, comma-separated"></td>
        <td class="col-att"><input type="checkbox" name="step_requires_attachment" value="on" ${a ? raw('checked') : ''} title="requires attachment"></td>
        <td class="col-remove">${stepRows > 1 ? html`<button type="submit" class="vf-remove-step" formaction="/events/new" formmethod="GET" name="_remove_step" value="${String(i)}" title="remove this step" aria-label="remove step ${String(i + 1)}">×</button>` : raw('')}</td>
      </tr>
      <tr class="vf-details-row ${detOpen ? raw('has-content open') : ''}">
        <td colspan="7">
          <button type="button" class="vf-details-toggle" data-toggle-details title="long-form instructions for the participant (optional, up to 4096 chars)"></button>
          <div class="vf-details-wrap">
            <textarea name="step_details" maxlength="4096" placeholder="Optional plain-text details for the participant. Example: 'Please review section 3.2 of the contract, focus on indemnification language. Reply with signed PDF or inline notes.' Shown in the invite email.">${det}</textarea>
            <div class="vf-details-count" data-details-count>0 / 4096</div>
          </div>
        </td>
      </tr>
    `);
  }
  const errBlock = errors.length
    ? html`<div style="background:#fee;border:1px solid #c99;padding:0.75rem;margin-bottom:1rem">
        <strong>Please fix:</strong>
        <ul style="margin:0.3rem 0 0 1rem">${errors.map((e) => html`<li>${e}</li>`)}</ul>
      </div>`
    : raw('');
  return html`
    <h1>Create Event</h1>
    <p><a href="/">← back</a></p>
    ${errBlock}
    <style>${raw(WORKFLOW_FORM_CSS)}</style>
    <form class="vf-form" method="POST" action="/events" data-variant-root="F">

      <h2><span class="num">1</span>What + Who <span class="hint">event title and who runs it</span></h2>
      <div class="vf-section">
        <div class="vf-row">
          <label>
            <span>Title</span>
            <input type="text" name="title" value="${values.title || ''}" required maxlength="200" placeholder="e.g. Q2 sign-off">
          </label>
          <label>
            <span>Your email</span>
            <input type="email" name="initiator" value="${values.initiator || ''}" required placeholder="you@example.com">
          </label>
        </div>
      </div>

      <h2><span class="num">2</span>Trust <span class="hint">how strict should reply verification be — higher = more proof, fewer accepted replies</span></h2>
      <div class="vf-section">
        <label style="max-width:520px">
          <span>Minimum trust</span>
          <select name="min_trust_level">${trustOpts}</select>
        </label>
      </div>

      <h2><span class="num">3</span>Steps <span class="hint">${String(stepRows)} · each gets a unique reply-to · <em>Depends on</em>: step numbers, comma-separated; empty = runs immediately</span></h2>
      <div class="vf-section">
        <table class="vf-steps-table">
          <thead>
            <tr>
              <th class="col-num">#</th>
              <th class="col-name">Step</th>
              <th class="col-email">Participant</th>
              <th class="col-dl">Deadline</th>
              <th class="col-deps" title="step numbers this step waits for">Depends on</th>
              <th class="col-att" title="requires attachment">att</th>
              <th class="col-remove"></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p class="vf-add-row">
          <button type="submit" formaction="/events/new" formmethod="GET" name="_add_step" value="1">+ add step</button>
        </p>
      </div>

      <button type="submit" class="vf-submit">Create event</button>
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
          dl.style.opacity = hasDep ? '0.55' : '1';
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
  res.end(layout({ title: 'create event — gitdone', body: renderWorkflowForm({ values }) }));
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
`;

const TRUST_LABEL_SHORT = {
  verified: 'verified (strict DKIM + DMARC)',
  forwarded: 'forwarded (trusted mail relays OK)',
  authorized: 'authorized (SPF-only OK)',
  unverified: 'unverified (any reply)',
};

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
        <dt>Organizer</dt><dd><code>${initiator}</code></dd>
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

  // Confirmed — actually create.
  const event = await createEvent({
    type: 'event',
    ...v.value,
  });
  const token = await createToken({ eventId: event.id, initiator: event.initiator });
  const manageUrl = `${publicBaseUrl()}/manage/${token.token}`;
  const [emailResult, notifyResults] = await Promise.all([
    sendManagementEmail({ event, manageUrl }),
    notifyWorkflowParticipants(event),
  ]);
  for (const r of notifyResults) {
    if (!r.ok) process.stderr.write(`notify: failed ${r.to}: ${r.reason || r.code}\n`);
  }
  const flow = renderFlowProse(event.steps);
  const msg = html`
    <style>${raw(PREVIEW_CSS)}</style>
    <div class="pv">
      <h1>Event created</h1>
      <p class="lede"><strong>${event.title}</strong> — organized by <code>${event.initiator}</code> · ID: <code>${event.id}</code></p>

      <h2>Flow</h2>
      <p class="flow">${flow}</p>

      <h2>Participant reply addresses</h2>
      <p style="color:#8b949e;font-size:0.88em;margin:0 0 0.6rem">Each step has a unique reply-to. Replies are DKIM-verified, timestamped, and committed to the event's git repo.</p>
      <ol class="steps">
        ${event.steps.map((s, i) => html`
          <li>
            <span class="n">${i + 1}</span>
            <div>
              <span class="name">${s.name}</span> → <code>${s.participant}</code>
              <div class="sub">reply-to: <code>event+${event.id}-${s.id}@${config.domain}</code>
                ${s.deadline ? html` · deadline <code>${s.deadline.slice(0, 10)}</code>` : raw('')}
              </div>
              ${s.details ? html`<div class="details">${s.details}</div>` : raw('')}
            </div>
          </li>
        `)}
      </ol>

      ${emailResult.ok
        ? html`<div class="mg-flash" style="background:rgba(63,185,80,.08);border:1px solid #3fb950;color:#3fb950;padding:0.6rem 0.85rem;margin-top:1rem;font-size:0.9em">
            <strong>Management link sent to ${event.initiator}.</strong>
            Valid 30 days — use it to see progress, resend reminders, or close the event.
          </div>`
        : html`<div style="background:rgba(255,176,0,.08);border:1px solid #ffb000;color:#ffb000;padding:0.65rem 0.9rem;margin-top:1rem;font-size:0.9em;line-height:1.5">
            <strong>Management link could not be emailed</strong> (${emailResult.reason || 'send failed'}).
            Save this URL: <code style="color:#ffb000;background:#0d1117;word-break:break-all">${manageUrl}</code>
          </div>`}
      <p style="margin-top:1.2rem"><a href="/">← home</a> · <a href="/manage">your events</a></p>
    </div>
  `;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(layout({ title: 'event created — gitdone', body: msg }));
});

// Compose + submit the management-link email. Plain text; outbound DKIM
// signing is handled by the opendkim milter at the MTA (see outbound.js).
async function sendManagementEmail({ event, manageUrl }) {
  const from = `gitdone@${config.domain}`;
  const stepsList = event.steps
    .map((s, i) => `  ${i + 1}. ${s.name} — ${s.participant}`)
    .join('\n');
  const body = [
    `You created the event "${event.title}" on gitdone.`,
    ``,
    `Event ID: ${event.id}`,
    `Minimum trust: ${event.min_trust_level}`,
    ``,
    `Steps:`,
    stepsList,
    ``,
    `Management link (valid 30 days — bookmark it):`,
    `  ${manageUrl}`,
    ``,
    `Day-to-day commands happen by email. From the address you created`,
    `the event with (${event.initiator}), reply from your own mail client to:`,
    `  stats+${event.id}@${config.domain}    see current progress`,
    `  remind+${event.id}@${config.domain}   nudge pending participants`,
    `  close+${event.id}@${config.domain}    close the event early`,
    ``,
    `Anyone can verify a proof offline with the gitdone-verify CLI.`,
    `See https://github.com/hamr0/gitdone`,
  ].join('\n');
  const rawMessage = buildRawMessage({
    from,
    to: event.initiator,
    subject: `[gitdone] "${event.title}" — your management link`,
    body,
    autoSubmitted: 'auto-generated',
    domain: config.domain,
    extraHeaders: { 'X-GitDone-Event': event.id },
  });
  return sendmail({ from, rawMessage, to: [event.initiator] });
}

// -------- crypto event creation (1.H.3) --------
// Design Lab variant F: dense one-page grid, no numbered sections. Mode
// picker (declaration | attestation) is a segmented row; fields that don't
// apply to the picked mode stay on screen but dim. Reference:
// docs/01-product/design/landing-and-crypto-v1.md
const CRYPTO_FORM_CSS = `
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
.cf .grid input, .cf .grid select { width: 100%; padding: 0.4rem 0.5rem; font: inherit; background: #161b22; color: #c9d1d9; border: 1px solid #30363d; border-radius: 0; box-sizing: border-box; }
.cf .grid input:focus, .cf .grid select:focus { border-color: #3fb950; outline: 0; box-shadow: 0 0 0 1px rgba(63,185,80,.2); }
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
  const mode = values.mode === 'declaration' ? 'declaration' : 'attestation';
  const dedup = values.dedup || 'unique';
  const allowAnon = values.allow_anonymous === 'on' || values.allow_anonymous === true;
  const dedupOpts = VALID_DEDUP_RULES.map((d) => html`
    <option value="${d}" ${dedup === d ? raw('selected') : ''}>${d === 'unique'
      ? 'unique — one per sender'
      : d === 'latest'
        ? 'latest — most-recent counts'
        : 'accumulating — every email counts'}</option>
  `);
  const errBlock = errors.length
    ? html`<div style="background:#fee;border:1px solid #c99;padding:0.75rem;margin-bottom:1rem">
        <strong>Please fix:</strong>
        <ul style="margin:0.3rem 0 0 1rem">${errors.map((e) => html`<li>${e}</li>`)}</ul>
      </div>`
    : raw('');
  const signerDim = mode === 'attestation' ? raw('dim') : raw('');
  const attDim = mode === 'declaration' ? raw('dim') : raw('');
  const noteText = mode === 'declaration'
    ? 'declaration · one signer replies, one permanent record'
    : 'attestation · anyone you share the reply address with can sign';
  return html`
    <h1 style="margin:1rem 0 0.35rem">Create a signed record</h1>
    <p style="margin:0 0 1rem;color:#8b949e;font-size:0.9em">A cryptographically timestamped signature — sign something yourself, or gather signatures from a group. <a href="/">← back</a></p>
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

        <label>
          <span>Your email</span>
          <input type="email" name="initiator" required value="${values.initiator || ''}" placeholder="you@example.com">
        </label>
        <label class="${signerDim}">
          <span>Signer's email</span>
          <input type="email" name="signer" value="${values.signer || ''}" placeholder="witness@example.com">
        </label>

        <label class="${attDim}">
          <span>Threshold (N distinct signers)</span>
          <input type="number" name="threshold" min="1" value="${values.threshold || '10'}">
        </label>
        <label class="${attDim}">
          <span>Dedup rule</span>
          <select name="dedup">${dedupOpts}</select>
        </label>

        <label class="checkbox ${attDim}">
          <input type="checkbox" name="allow_anonymous" value="on" ${allowAnon ? raw('checked') : ''}>
          <span>Allow anonymous replies<br><small style="color:#6e7681">count replies from anyone, not just pre-specified signers</small></span>
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
        var anonLabel   = form.querySelector('input[name="allow_anonymous"]').closest('label');
        var note = document.querySelector('.cf .head .mode-note');
        var hint = document.querySelector('.cf .mode-row .hint');
        function setMode(m){
          var isDec = m === 'declaration';
          signerLabel.classList.toggle('dim', !isDec);
          [threshLabel, dedupLabel, anonLabel].forEach(function(el){
            el.classList.toggle('dim', isDec);
            el.classList.toggle('att', isDec);
          });
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
      })();
    `)}</script>
  `;
}

router.get('/crypto/new', async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const sp = u.searchParams;
  const values = {
    mode: sp.get('mode') || 'attestation',
    title: sp.get('title') || '',
    initiator: sp.get('initiator') || '',
    signer: sp.get('signer') || '',
    threshold: sp.get('threshold') || '',
    dedup: sp.get('dedup') || 'unique',
    allow_anonymous: sp.get('allow_anonymous') || '',
  };
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(layout({ title: 'create crypto — gitdone', body: renderCryptoForm({ values }) }));
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
  const event = await createEvent(v.value);
  const token = await createToken({ eventId: event.id, initiator: event.initiator });
  const manageUrl = `${publicBaseUrl()}/manage/${token.token}`;
  const [emailResult, notifyResults] = await Promise.all([
    sendCryptoManagementEmail({ event, manageUrl }),
    notifyDeclarationSigner(event),
  ]);
  for (const r of notifyResults) {
    if (!r.ok) process.stderr.write(`notify: failed ${r.to}: ${r.reason || r.code}\n`);
  }
  const replyAddr = event.mode === 'declaration'
    ? `event+${event.id}@${config.domain}`
    : `event+${event.id}@${config.domain}`;
  const msg = event.mode === 'declaration'
    ? html`
      <h1>Declaration created</h1>
      <p class="lede"><strong>${event.title}</strong> — organized by <code>${event.initiator}</code> · ID: <code>${event.id}</code></p>
      <p>The signer you named will get a reply address. When they reply from <code>${event.signer}</code>
      with a DKIM-verified email, it's committed to the event repo as a permanent record.</p>
      <p>Signer: <code>${event.signer}</code><br>Reply-to: <code>${replyAddr}</code></p>
    `
    : html`
      <h1>Attestation created</h1>
      <p class="lede"><strong>${event.title}</strong> — organized by <code>${event.initiator}</code> · ID: <code>${event.id}</code></p>
      <p>Share this reply address with potential signers (social media, mass email, QR code — up to you).
      Every DKIM-verified reply counts; completion is <strong>${String(event.threshold)} distinct signers</strong> with
      <code>${event.dedup}</code> dedup.</p>
      <p>Reply-to: <code>${replyAddr}</code><br>
      Share as: <code>mailto:${replyAddr}?subject=${encodeURIComponent('re: ' + event.title)}</code></p>
    `;
  const full = html`
    <style>${raw(PREVIEW_CSS)}</style>
    <div class="pv">
      ${msg}
      ${emailResult.ok
        ? html`<div style="background:rgba(63,185,80,.08);border:1px solid #3fb950;color:#3fb950;padding:0.6rem 0.85rem;margin-top:1rem;font-size:0.9em">
            <strong>Management link sent to ${event.initiator}.</strong>
            Valid 30 days; lets you track progress and close the event.
          </div>`
        : html`<div style="background:rgba(255,176,0,.08);border:1px solid #ffb000;color:#ffb000;padding:0.65rem 0.9rem;margin-top:1rem;font-size:0.9em;line-height:1.5">
            <strong>Management link could not be emailed</strong> (${emailResult.reason || 'send failed'}).
            Save this URL: <code style="color:#ffb000;background:#0d1117;word-break:break-all">${manageUrl}</code>
          </div>`}
      <p style="margin-top:1.2rem"><a href="/">← home</a> · <a href="/manage">your events</a></p>
    </div>
  `;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(layout({ title: 'crypto event created — gitdone', body: full }));
});

async function sendCryptoManagementEmail({ event, manageUrl }) {
  const from = `gitdone@${config.domain}`;
  const replyAddr = `event+${event.id}@${config.domain}`;
  const modeDetails = event.mode === 'declaration'
    ? [
        `Mode: declaration — one DKIM-verified reply from the designated signer.`,
        `Signer: ${event.signer}`,
      ]
    : [
        `Mode: attestation — ${event.threshold} distinct signers needed (${event.dedup} dedup).`,
        `Anonymous replies: ${event.allow_anonymous ? 'allowed' : 'not allowed'}`,
        `Share the reply address below however you like — social, email, QR.`,
      ];
  const body = [
    `You created the crypto event "${event.title}" on gitdone.`,
    ``,
    `Event ID: ${event.id}`,
    ...modeDetails,
    ``,
    `Reply address (this is the one signers reply to):`,
    `  ${replyAddr}`,
    ``,
    `Management link (valid 30 days):`,
    `  ${manageUrl}`,
    ``,
    `Day-to-day commands by email from ${event.initiator}:`,
    `  stats+${event.id}@${config.domain}    current state`,
    `  close+${event.id}@${config.domain}    close early`,
    ``,
    `Proofs verify offline via gitdone-verify.`,
    `See https://github.com/hamr0/gitdone`,
  ].join('\n');
  const rawMessage = buildRawMessage({
    from,
    to: event.initiator,
    subject: `[gitdone] "${event.title}" — your management link`,
    body,
    autoSubmitted: 'auto-generated',
    domain: config.domain,
    extraHeaders: { 'X-GitDone-Event': event.id },
  });
  return sendmail({ from, rawMessage, to: [event.initiator] });
}

// Debug/read-only event view — helpful during dev; will be locked down
// or removed when 1.H.5 (magic-link management) lands.
// Read-only detail view. Requires the signed-in session email to match
// event.initiator — keeps participant emails out of reach for anyone
// who happens to know or guess an event ID (PRD §0.1.10 plaintext
// discipline). Linked from the /manage/:token dashboard.
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
  const sessionEmail = currentSessionEmail(req);
  const isOwner = sessionEmail
    && String(sessionEmail).toLowerCase() === String(event.initiator || '').toLowerCase();
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

// ---- Magic-link session flow ------------------------------------------
// GET  /manage                     → if cookie valid: list of your events,
//                                    else: email form
// POST /manage                     → mint 15-min token, email magic link
// GET  /manage/session/:token      → consume token, set 30-day cookie,
//                                    redirect to /manage
// POST /manage/logout              → clear cookie, redirect to /

const session = require('../src/magic-session');

function currentSessionEmail(req) {
  const cookie = session.parseCookie(req.headers.cookie, session.COOKIE_NAME);
  return session.verifySessionCookie(cookie);
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
`;

async function renderSessionHub({ email, devLink, flash }) {
  const events = await session.findEventsByInitiator(email);
  const rows = events.length === 0
    ? html`<div class="empty">No events yet. <a href="/events/new">Create one</a>.</div>`
    : html`<div class="list">
        ${events.map((ev) => {
          const kind = ev.type === 'crypto' ? 'crypto' : 'event';
          const sub = ev.type === 'crypto'
            ? html`<span>mode <code>${ev.mode || '—'}</code> · created ${(ev.created_at || '').slice(0, 10)}</span>`
            : html`<span>${(ev.steps || []).length} step(s) · created ${(ev.created_at || '').slice(0, 10)}</span>`;
          const manageHref = ev.management_token
            ? `/manage/${ev.management_token}`
            : `/manage/event/${ev.id}`;
          return html`
            <div class="row">
              <span class="kind ${kind}">${kind}</span>
              <div class="meta">
                <p class="title">${ev.title || ev.id}</p>
                <p class="sub">${sub}</p>
              </div>
              <a class="open" href="${manageHref}">open ▸</a>
            </div>
          `;
        })}
      </div>`;
  return html`
    <style>${raw(MANAGE_HUB_CSS)}</style>
    <div class="mh">
      <h1>Your events</h1>
      <p class="lede">Signed in as <code>${email}</code>.</p>
      ${flash ? html`<div class="flash">${flash}</div>` : raw('')}
      ${devLink ? html`<div class="devlink"><strong>DEV:</strong> magic link (sendmail unavailable): <code>${devLink}</code></div>` : raw('')}
      ${rows}
      <p class="logout">
        <form method="POST" action="/manage/logout"><button type="submit">sign out</button></form>
      </p>
    </div>
  `;
}

function renderSignInForm({ flash, devLink, email }) {
  return html`
    <style>${raw(MANAGE_HUB_CSS)}</style>
    <div class="mh">
      <h1>Open your events</h1>
      <p class="lede">Enter the email you used to create events. We'll send a one-time link (valid 15 minutes). You'll stay signed in for 30 days.</p>
      ${flash ? html`<div class="flash">${flash}</div>` : raw('')}
      ${devLink ? html`<div class="devlink"><strong>DEV:</strong> sendmail unavailable — magic link: <code>${devLink}</code></div>` : raw('')}
      <form method="POST" action="/manage">
        <input type="email" name="email" placeholder="you@example.com" required autofocus value="${email || ''}">
        <button type="submit">send link</button>
      </form>
      <p class="hint">No password needed. No account to create. The link opens a dashboard listing every event and crypto record you've initiated.</p>
    </div>
  `;
}

router.get('/manage', async (req, res) => {
  const email = currentSessionEmail(req);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (email) {
    res.end(layout({
      title: 'your events — gitdone',
      body: await renderSessionHub({ email }),
    }));
  } else {
    res.end(layout({
      title: 'sign in — gitdone',
      body: renderSignInForm({}),
    }));
  }
});

router.post('/manage', async (req, res) => {
  let fields = {};
  try { fields = await parseBody(req); } catch {}
  const email = String(fields.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(layout({
      title: 'sign in — gitdone',
      body: renderSignInForm({ flash: 'Please enter a valid email address.', email: fields.email }),
    }));
  }
  // Always respond the same regardless of whether the email has events
  // (no "does X exist?" oracle). Mint the token only if we would actually
  // email it; if sendmail fails, surface the link in dev mode.
  const rec = await session.createMagicLink(email);
  const link = `${publicBaseUrl()}/manage/session/${rec.token}`;
  const body = `A one-time link to open your gitdone dashboard:

    ${link}

Valid for 15 minutes. Opens once.

If you didn't request this, ignore this email.

--
gitdone`;
  const rawMessage = buildRawMessage({
    from: `gitdone <noreply@${config.domain}>`,
    to: email,
    subject: 'Your gitdone sign-in link',
    body,
    domain: config.domain,
    autoSubmitted: 'auto-generated',
  });
  const result = await sendmail({ from: `noreply@${config.domain}`, rawMessage });
  let devLink = null;
  if (!result.ok) {
    process.stderr.write(`manage/signin: sendmail failed for ${email}: ${result.reason || result.stderr || '?'}\n  link: ${link}\n`);
    if (IS_DEV) devLink = link;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(layout({
    title: 'check your inbox — gitdone',
    body: html`
      <style>${raw(MANAGE_HUB_CSS)}</style>
      <div class="mh">
        <h1>Check your inbox</h1>
        <p class="lede">If <code>${email}</code> has any events on gitdone, we just emailed a one-time sign-in link. It's valid for 15 minutes.</p>
        ${devLink ? html`<div class="devlink"><strong>DEV:</strong> sendmail unavailable — magic link: <code>${devLink}</code></div>` : raw('')}
        <p><a href="/manage">← back</a></p>
      </div>
    `,
  }));
});

router.get('/manage/session/:token', async (req, res, params) => {
  const email = await session.consumeMagicLink(params.token);
  if (!email) {
    res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(layout({
      title: 'link expired — gitdone',
      body: html`
        <style>${raw(MANAGE_HUB_CSS)}</style>
        <div class="mh">
          <h1>Link expired or already used</h1>
          <p class="lede">Sign-in links are one-time and expire after 15 minutes.</p>
          <p><a href="/manage">Get a new link</a> · <a href="/">home</a></p>
        </div>
      `,
    }));
  }
  res.writeHead(303, { location: '/manage', 'set-cookie': session.buildSetCookie(email) });
  res.end();
});

router.post('/manage/logout', async (req, res) => {
  res.writeHead(303, { location: '/', 'set-cookie': session.buildClearCookie() });
  res.end();
});

// Session-authed jump to a specific event's management dashboard. Used by
// the hub's per-event "open" link — finds the event's per-event token and
// redirects to the canonical /manage/:token URL.
router.get('/manage/event/:id', async (req, res, params) => {
  const email = currentSessionEmail(req);
  if (!email) { res.writeHead(303, { location: '/manage' }); return res.end(); }
  const { loadEvent } = require('../src/event-store');
  const ev = await loadEvent(params.id);
  if (!ev) { res.writeHead(404); return res.end('event not found'); }
  if (String(ev.initiator || '').toLowerCase() !== email) {
    res.writeHead(403); return res.end('forbidden');
  }
  const token = await session.findTokenByEventId(params.id);
  if (!token) { res.writeHead(404); return res.end('management token for this event has expired; re-create is not supported yet'); }
  res.writeHead(303, { location: `/manage/${token}` });
  res.end();
});

// 1.H.4 — management link landing. Validates the token and shows a minimal
// confirmation page. Full dashboard is 1.H.5.
router.get('/manage/:token', async (req, res, params) => {
  const rec = await loadToken(params.token);
  if (!rec) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(layout({
      title: 'link invalid — gitdone',
      body: html`<h1>Link invalid or expired</h1>
        <p>This management link is no longer valid. Create a new event if you need one.</p>
        <p><a href="/">home</a></p>`,
    }));
  }
  const { loadEvent } = require('../src/event-store');
  const event = await loadEvent(rec.event_id);
  if (!event) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(layout({
      title: 'event missing — gitdone',
      body: html`<h1>Event not found</h1>
        <p>Token valid, but the underlying event is gone.</p>
        <p><a href="/">home</a></p>`,
    }));
  }
  const flash = (req.url.includes('?reminded=1'))
    ? 'Reminders sent.'
    : (req.url.includes('?closed=1'))
      ? 'Event closed.'
      : null;
  let stepAttempts = {};
  if (event.type === 'event') {
    const { listCommits } = require('../src/gitrepo');
    const commits = await listCommits(event.id).catch(() => []);
    for (const c of commits) {
      if (!c.step_id) continue;
      const prev = stepAttempts[c.step_id];
      if (!prev || (c.sequence || 0) > (prev.sequence || 0)) {
        stepAttempts[c.step_id] = c;
      }
    }
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(layout({
    title: `manage — ${event.title}`,
    body: renderManagementDashboard({ token: params.token, rec, event, flash, stepAttempts }),
  }));
});

router.post('/manage/:token/remind', async (req, res, params) => {
  const rec = await loadToken(params.token);
  if (!rec) { res.writeHead(404); return res.end('link invalid'); }
  const { loadEvent } = require('../src/event-store');
  const { executeRemind } = require('../src/email-commands');
  const event = await loadEvent(rec.event_id);
  if (!event) { res.writeHead(404); return res.end('event missing'); }
  await executeRemind(event);
  res.writeHead(303, { location: `/manage/${params.token}?reminded=1` });
  res.end();
});

router.post('/manage/:token/close', async (req, res, params) => {
  const rec = await loadToken(params.token);
  if (!rec) { res.writeHead(404); return res.end('link invalid'); }
  const { loadEvent } = require('../src/event-store');
  const { executeClose } = require('../src/email-commands');
  const { updateEventAtomic } = require('../src/completion');
  const { commitCompletion } = require('../src/gitrepo');
  const event = await loadEvent(rec.event_id);
  if (!event) { res.writeHead(404); return res.end('event missing'); }
  const r = executeClose(event, { receivedAt: new Date().toISOString() });
  if (!r.wasAlreadyComplete) {
    await updateEventAtomic(rec.event_id, () => r.newEvent);
    await commitCompletion(rec.event_id, r.newEvent, {
      completedAt: r.newEvent.completion.completed_at,
      triggeringSequence: null,
      summary: { closed_by: 'initiator', reason: 'dashboard-close' },
    });
  }
  res.writeHead(303, { location: `/manage/${params.token}?closed=1` });
  res.end();
});

const MANAGE_CSS = `
.mg-meta { color:#8b949e; font-size:0.88em; margin:0 0 0.4rem; }
.mg-meta code { background:#161b22; color:#ffb000; padding:0.08em 0.35em; border-radius:2px; }
.mg-flash { background:rgba(63,185,80,.08); border:1px solid #3fb950; color:#3fb950; padding:0.55rem 0.85rem; border-radius:0; margin:0 0 1rem; font-size:0.9em; }
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
.mg-actions { display:flex; gap:0.7rem; margin:1rem 0; }
.mg-actions button { padding:0.55rem 1.2rem; border-radius:0; cursor:pointer; font:inherit; font-size:0.85em; font-weight:600; letter-spacing:0.05em; text-transform:uppercase; }
.mg-remind { background:#0d1117; color:#3fb950; border:1px solid #3fb950; }
.mg-remind:hover { background:#3fb950; color:#0d1117; }
.mg-close { background:#0d1117; color:#f85149; border:1px solid #f85149; }
.mg-close:hover { background:#f85149; color:#0d1117; }
.mg-actions button:disabled { opacity:0.4; cursor:not-allowed; }
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
`;

function renderManagementDashboard({ token, rec, event, flash, stepAttempts = {} }) {
  const complete = event.completion && event.completion.status === 'complete';
  const pill = complete
    ? html`<span class="mg-pill complete">complete</span>`
    : html`<span class="mg-pill open">open</span>`;
  let bodyMiddle;
  if (event.type === 'event') {
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
      const out = [
        html`
          <tr>
            <td>${String(i + 1)}</td>
            <td>
              <strong>${s.name}</strong>
              ${s.details ? html` <button type="button" class="mg-details-toggle" data-step="${s.id}" aria-expanded="false" title="show details"></button>` : raw('')}
            </td>
            <td><code>${s.participant}</code></td>
            ${anyDeadlines ? html`<td>${s.deadline ? html`<code>${s.deadline.slice(0, 10)}</code>` : raw('—')}</td>` : raw('')}
            ${anyAtt ? html`<td class="col-att-flag">${s.requires_attachment ? html`<span title="attachment required">📎</span>` : raw('')}</td>` : raw('')}
            <td>${raw(depsLabel === '—' ? '—' : 'after ' + depsLabel)}</td>
            <td class="${statusCls}">${statusLabel}</td>
          </tr>
        `,
      ];
      if (s.details) {
        const colspan = 4 + (anyDeadlines ? 1 : 0) + (anyAtt ? 1 : 0);
        out.push(html`
          <tr class="mg-details-row" data-step="${s.id}" hidden>
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
      return out;
    });
    bodyMiddle = html`
      <h2><span class="num">1</span> Steps
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
          tbl.addEventListener('click', function(e){
            var btn = e.target.closest('[data-step]');
            if (!btn || btn.tagName !== 'BUTTON') return;
            var id = btn.dataset.step;
            var row = tbl.querySelector('tr.mg-details-row[data-step="' + id + '"]');
            if (!row) return;
            var open = row.hasAttribute('hidden');
            if (open) row.removeAttribute('hidden');
            else row.setAttribute('hidden', '');
            btn.setAttribute('aria-expanded', open ? 'true' : 'false');
          });
        })();
      `)}</script>
    `;
  } else if (event.mode === 'declaration') {
    bodyMiddle = html`
      <h2><span class="num">1</span> Declaration</h2>
      <div class="mg-section">
        <p class="mg-meta">Signer: <code>${event.signer}</code></p>
        <p class="mg-meta">Reply address: <code>event+${event.id}@${config.domain}</code></p>
        <p class="mg-meta">Status: ${complete ? html`signed on <code>${event.completion.completed_at}</code>` : html`awaiting signature`}</p>
      </div>
    `;
  } else {
    const counted = (event.replies || []).length;
    bodyMiddle = html`
      <h2><span class="num">1</span> Attestation</h2>
      <div class="mg-section">
        <p class="mg-meta">Reply address: <code>event+${event.id}@${config.domain}</code></p>
        <p class="mg-meta">Threshold: <strong>${String(event.threshold)}</strong> · Dedup: <code>${event.dedup}</code> · Anonymous: ${event.allow_anonymous ? 'allowed' : 'not allowed'}</p>
        <p class="mg-meta">Replies received: <strong>${String(counted)}</strong>${complete ? html` · completed <code>${event.completion.completed_at}</code>` : raw('')}</p>
      </div>
    `;
  }

  return html`
    <style>${raw(MANAGE_CSS)}</style>
    <h1 style="margin-bottom:0.25rem">${event.title}</h1>
    <p class="mg-meta">Signed in as <code>${rec.initiator}</code> · Event <code>${event.id}</code> · ${pill}</p>
    ${flash ? html`<div class="mg-flash">${flash}</div>` : raw('')}

    ${bodyMiddle}

    <div class="mg-actions">
      <form method="POST" action="/manage/${token}/remind" style="margin:0">
        <button type="submit" class="mg-remind" ${complete ? raw('disabled') : ''}>Send reminders</button>
      </form>
      <form method="POST" action="/manage/${token}/close" style="margin:0"
            onsubmit="return confirm('Close this event now? This writes a completion commit and cannot be undone.');">
        <button type="submit" class="mg-close" ${complete ? raw('disabled') : ''}>Close event</button>
      </form>
    </div>

    <div class="mg-email-cmds">
      <p style="margin:0 0 0.4rem">Prefer email? Send a short message from <code>${rec.initiator}</code> (DKIM-verified) to any of these:</p>
      <dl class="mg-email-cmd-list">
        <dt><code>stats+${event.id}@${config.domain}</code></dt>
        <dd>get current progress back as a reply (which steps are done, pending, or waiting on deps)</dd>
        <dt><code>remind+${event.id}@${config.domain}</code></dt>
        <dd>re-notify everyone whose step is still pending</dd>
        <dt><code>close+${event.id}@${config.domain}</code></dt>
        <dd>close the event early — writes a completion commit to the repo, cannot be undone</dd>
      </dl>
      <p style="margin:0.5rem 0 0;color:#6e7681;font-size:0.82em">The subject and body can be anything; the address tag is the command. Authentication is DKIM + envelope-sender == event organizer, so only you can trigger these from your own inbox.</p>
    </div>

    <p style="margin-top:1.5rem"><a href="/">home</a></p>
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
