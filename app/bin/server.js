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
const { validateWorkflowEvent, validateCryptoEvent, VALID_FLOWS, VALID_TRUST_LEVELS, VALID_CRYPTO_MODES, VALID_DEDUP_RULES } = require('../src/web/validation');
const { createEvent } = require('../src/event-store');
const { createToken, loadToken } = require('../src/magic-token');
const { sendmail, buildRawMessage } = require('../src/outbound');
const { notifyWorkflowParticipants, notifyDeclarationSigner } = require('../src/notifications');
const devChannel = IS_DEV ? require('../src/web/dev-channel') : null;

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

// 1.H.3 Design Lab winner — landing page (variant F style).
// Reference: docs/01-product/design/landing-and-crypto-v1.md
const LANDING_CSS = `
.f-landing { padding: 1.25rem 1.5rem; background: #fff; border: 1px solid #e3e6ee; border-radius: 5px; margin: 1rem 0 1.5rem; }
.f-landing h1 { font-size: 1.4rem; font-weight: 500; margin: 0 0 0.25rem; }
.f-landing .tag { color: #666; font-size: 0.95em; margin: 0 0 1rem; }
.f-landing .cta-row { display: flex; gap: 0.6rem; margin-bottom: 1rem; flex-wrap: wrap; }
.f-landing .cta { padding: 0.6rem 1.2rem; border: 1px solid #0645ad; color: #0645ad; text-decoration: none; border-radius: 4px; font-weight: 500; font-size: 0.95em; background: #fff; display: inline-block; }
.f-landing .cta.primary { background: #0645ad; color: #fff; }
.f-landing .cta:hover { background: #053590; color: #fff; }
.f-landing .cta.primary:hover { background: #053590; }
.f-landing .how { font-size: 0.88em; color: #555; line-height: 1.55; margin: 0; padding-top: 0.75rem; border-top: 1px dashed #e3e6ee; }
.f-landing .how strong { color: #222; }
.f-landing .how code { background: #f3f3f3; padding: 0.05em 0.3em; border-radius: 2px; font-size: 0.92em; }
`;
router.get('/', async (req, res) => {
  const body = html`
    <style>${raw(LANDING_CSS)}</style>
    <div class="f-landing">
      <h1>gitdone</h1>
      <p class="tag">Multi-party actions coordinated by email, proved by git.</p>
      <div class="cta-row">
        <a href="/events/new" class="cta primary">Create Event</a>
        <a href="/crypto/new" class="cta">Create Crypto</a>
      </div>
      <p class="how">
        <strong>Event</strong> — a workflow with ordered or parallel steps.
        <strong>Crypto</strong> — one <em>declaration</em> (one signer) or an <em>attestation</em> (N distinct signers).
        Participants reply to email; every reply is DKIM-verified, OpenTimestamped,
        and committed to a per-event git repository. Proofs verify offline via
        <a href="https://github.com/hamr0/gitdone/tree/main/tools/gitdone-verify"><code>gitdone-verify</code></a> —
        if gitdone disappears tomorrow, every proof still works.
      </p>
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
.vf-form h2 { font-size: 0.82em; text-transform: uppercase; letter-spacing: 0.06em; color: #555; margin: 1rem 0 0.35rem; font-weight: 600; }
.vf-form h2 .num { display: inline-block; width: 1.15em; height: 1.15em; background: #0645ad; color: #fff; border-radius: 50%; text-align: center; font-weight: 500; margin-right: 0.4rem; font-size: 0.78em; line-height: 1.15em; }
.vf-form h2 .hint { font-size: 0.88em; color: #888; text-transform: none; letter-spacing: 0; font-weight: 400; margin-left: 0.3rem; }
.vf-section { padding-left: 1.55rem; border-left: 2px solid #eef; margin-bottom: 0.35rem; padding-bottom: 0.35rem; }
.vf-row { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; }
.vf-row label { margin: 0; }
.vf-row label span { font-size: 0.8em; color: #888; }
.vf-row input, .vf-row select { padding: 0.35rem 0.45rem; font-size: 0.93em; }
.vf-steps-table { width: 100%; border-collapse: collapse; font-size: 0.9em; margin-bottom: 0.35rem; table-layout: fixed; }
.vf-steps-table th { text-align: left; font-weight: 500; color: #666; padding: 0.25rem 0.4rem; border-bottom: 1px solid #ddd; font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.04em; }
.vf-steps-table td { padding: 0.22rem 0.28rem; border-bottom: 1px solid #f2f2f5; vertical-align: middle; }
.vf-steps-table input[type=text], .vf-steps-table input[type=email], .vf-steps-table input[type=datetime-local] { width: 100%; padding: 0.28rem 0.4rem; border: 1px solid transparent; background: transparent; font-size: 0.9em; border-radius: 3px; }
.vf-steps-table input:focus { border-color: #0645ad; background: #fff; outline: 0; box-shadow: 0 0 0 2px rgba(6,69,173,.12); }
.vf-steps-table tr:hover input:not(:focus) { background: #fafafa; }
.vf-steps-table .col-num { width: 28px; color: #999; font-variant-numeric: tabular-nums; text-align: right; padding-right: 0.35rem; font-size: 0.82em; }
.vf-steps-table .col-name { width: 24%; }
.vf-steps-table .col-email { width: 28%; }
.vf-steps-table .col-dl { width: 30%; }
.vf-steps-table .col-att { width: 40px; text-align: center; }
.vf-add-row { margin: 0.3rem 0 0; font-size: 0.85em; }
.vf-add-row button { background: none; border: 0; color: #0645ad; cursor: pointer; padding: 0; font: inherit; text-decoration: none; }
.vf-add-row button:hover { text-decoration: underline; }
.vf-submit { background: #0645ad; color: #fff; padding: 0.55rem 1.5rem; border: 0; border-radius: 4px; cursor: pointer; font-weight: 500; margin-top: 0.9rem; font-size: 0.95em; }
.vf-submit:hover { background: #053590; }
@media (max-width: 540px) { .vf-row { grid-template-columns: 1fr; } .vf-steps-table { font-size: 0.83em; } }
`;

const FLOW_LABELS = {
  'sequential': 'sequential — one after another',
  'non-sequential': 'non-sequential — any order',
  'hybrid': 'hybrid — tree of parallel branches',
};
const TRUST_LABELS = {
  verified: 'verified — strict DKIM + DMARC',
  forwarded: 'forwarded — OK via trusted relay',
  authorized: 'authorized — SPF-only OK',
  unverified: 'unverified — accept anything',
};

function renderWorkflowForm({ values = {}, errors = [] } = {}) {
  const names = values.step_name || [];
  const participants = values.step_participant || [];
  const deadlines = values.step_deadline || [];
  const atts = values.step_requires_attachment || [];
  const stepRows = Math.max(2, names.length || 2);
  const selectedFlow = values.flow || 'sequential';
  const selectedTrust = values.min_trust_level || 'verified';
  const flowOpts = VALID_FLOWS.map((f) => html`
    <option value="${f}" ${selectedFlow === f ? raw('selected') : ''}>${FLOW_LABELS[f] || f}</option>
  `);
  const trustOpts = VALID_TRUST_LEVELS.map((t) => html`
    <option value="${t}" ${selectedTrust === t ? raw('selected') : ''}>${TRUST_LABELS[t] || t}</option>
  `);
  const rows = [];
  for (let i = 0; i < stepRows; i++) {
    const n = names[i] || '';
    const p = participants[i] || '';
    const d = deadlines[i] || '';
    const a = atts[i] === 'on' || atts[i] === true;
    rows.push(html`
      <tr>
        <td class="col-num">${i + 1}</td>
        <td class="col-name"><input type="text" name="step_name" value="${n}" maxlength="200" placeholder="step name"></td>
        <td class="col-email"><input type="email" name="step_participant" value="${p}" placeholder="email@…"></td>
        <td class="col-dl"><input type="datetime-local" name="step_deadline" value="${d}"></td>
        <td class="col-att"><input type="checkbox" name="step_requires_attachment" value="on" ${a ? raw('checked') : ''} title="requires attachment"></td>
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

      <h2><span class="num">2</span>How <span class="hint">how it runs, what counts</span></h2>
      <div class="vf-section">
        <div class="vf-row">
          <label>
            <span>Flow</span>
            <select name="flow" required>${flowOpts}</select>
          </label>
          <label>
            <span>Minimum trust</span>
            <select name="min_trust_level">${trustOpts}</select>
          </label>
        </div>
      </div>

      <h2><span class="num">3</span>Steps <span class="hint">${String(stepRows)} · each gets a unique reply-to</span></h2>
      <div class="vf-section">
        <table class="vf-steps-table">
          <thead>
            <tr>
              <th class="col-num">#</th>
              <th class="col-name">Step</th>
              <th class="col-email">Participant</th>
              <th class="col-dl">Deadline (date + time)</th>
              <th class="col-att" title="requires attachment">att</th>
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
  const token = await createToken({ eventId: event.id, initiator: event.initiator });
  const manageUrl = `${publicBaseUrl()}/manage/${token.token}`;
  const [emailResult, notifyResults] = await Promise.all([
    sendManagementEmail({ event, manageUrl }),
    notifyWorkflowParticipants(event),
  ]);
  for (const r of notifyResults) {
    if (!r.ok) process.stderr.write(`notify: failed ${r.to}: ${r.reason || r.code}\n`);
  }
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
    ${emailResult.ok
      ? html`<p style="background:#efe;padding:0.75rem;border:1px solid #9c9">
          <strong>Management link sent to ${event.initiator}.</strong>
          Check your inbox — the link is valid for 30 days and lets you see progress,
          resend reminders, or close the event early.
        </p>`
      : html`<p style="background:#fee;padding:0.75rem;border:1px solid #c99">
          <strong>Management link could not be emailed</strong> (${emailResult.reason || 'send failed'}).
          Save this URL: <code>${manageUrl}</code>
        </p>`}
    <p><a href="/">home</a></p>
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
    `Flow: ${event.flow}   Minimum trust: ${event.min_trust_level}`,
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
.cf { color: #222; }
.cf .head { display: flex; justify-content: space-between; align-items: baseline; margin: 0 0 0.5rem; }
.cf .head h1 { font-size: 1.15rem; font-weight: 500; color: #222; margin: 0; }
.cf .head .mode-note { font-size: 0.82em; color: #888; }
.cf .mode-row { display: flex; gap: 0.75rem; align-items: center; padding: 0.5rem 0.75rem; background: #f3f6fb; border-radius: 4px; margin-bottom: 0.75rem; font-size: 0.9em; }
.cf .mode-row label { display: flex; align-items: center; gap: 0.3rem; cursor: pointer; margin: 0; }
.cf .mode-row label input { accent-color: #0645ad; width: auto; }
.cf .mode-row .hint { color: #666; margin-left: auto; font-size: 0.9em; }
.cf .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.45rem 0.7rem; }
.cf .grid label { display: block; margin: 0; font-size: 0.9em; }
.cf .grid label > span { display: block; font-size: 0.72em; color: #888; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.1rem; }
.cf .grid input, .cf .grid select { width: 100%; padding: 0.32rem 0.45rem; font: inherit; border: 1px solid #ccc; border-radius: 3px; box-sizing: border-box; }
.cf .grid input:focus, .cf .grid select:focus { border-color: #0645ad; outline: 0; box-shadow: 0 0 0 2px rgba(6,69,173,.12); }
.cf .grid .full { grid-column: 1 / -1; }
.cf .grid .dim { opacity: 0.42; pointer-events: none; }
.cf .grid .dim > span::after { content: ' · declaration only'; color: #bbb; font-size: 0.9em; text-transform: none; letter-spacing: 0; }
.cf .grid .att > span::after { content: ' · attestation only'; color: #bbb; font-size: 0.9em; text-transform: none; letter-spacing: 0; }
.cf .checkbox { display: flex; align-items: center; gap: 0.35rem; font-size: 0.85em; grid-column: 1 / -1; color: #444; }
.cf .checkbox input { width: auto; margin: 0; }
.cf .actions { display: flex; justify-content: flex-end; margin-top: 0.9rem; }
.cf .submit { background: #0645ad; color: #fff; padding: 0.5rem 1.3rem; border: 0; border-radius: 4px; cursor: pointer; font: inherit; font-weight: 500; }
.cf .submit:hover { background: #053590; }
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
    <h1 style="margin:1rem 0 0.5rem">Create Crypto Event</h1>
    <p style="margin:0 0 1rem"><a href="/">← back</a></p>
    ${errBlock}
    <style>${raw(CRYPTO_FORM_CSS)}</style>
    <form class="cf" method="POST" action="/crypto" data-variant-root="F">
      <div class="head">
        <h1>New crypto event</h1>
        <span class="mode-note">${noteText}</span>
      </div>

      <div class="mode-row" role="radiogroup" aria-label="Crypto event mode">
        <strong>Mode:</strong>
        <label><input type="radio" name="mode" value="declaration" ${mode === 'declaration' ? raw('checked') : ''}> declaration</label>
        <label><input type="radio" name="mode" value="attestation" ${mode === 'attestation' ? raw('checked') : ''}> attestation</label>
        <span class="hint">${mode === 'declaration'
          ? 'one signer · one permanent record'
          : 'N distinct signers reach a threshold'}</span>
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
          Allow anonymous replies
        </label>
      </div>

      <div class="actions">
        <button type="submit" class="submit">Create →</button>
      </div>
    </form>
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
      <p><strong>${event.title}</strong> — ID: <code>${event.id}</code></p>
      <p>The signer you named will get a reply address. When they reply from <code>${event.signer}</code>
      with a DKIM-verified email, it's committed to the event repo as a permanent record.</p>
      <p>Signer: <code>${event.signer}</code><br>Reply-to: <code>${replyAddr}</code></p>
    `
    : html`
      <h1>Attestation created</h1>
      <p><strong>${event.title}</strong> — ID: <code>${event.id}</code></p>
      <p>Share this reply address with potential signers (social media, mass email, QR code — up to you).
      Every DKIM-verified reply counts; completion is <strong>${String(event.threshold)} distinct signers</strong> with
      <code>${event.dedup}</code> dedup.</p>
      <p>Reply-to: <code>${replyAddr}</code><br>
      Share as: <code>mailto:${replyAddr}?subject=${encodeURIComponent('re: ' + event.title)}</code></p>
    `;
  const full = html`
    ${msg}
    ${emailResult.ok
      ? html`<p style="background:#efe;padding:0.75rem;border:1px solid #9c9;margin-top:1rem">
          <strong>Management link sent to ${event.initiator}.</strong>
          Valid 30 days; lets you track progress and close the event.
        </p>`
      : html`<p style="background:#fee;padding:0.75rem;border:1px solid #c99;margin-top:1rem">
          <strong>Management link could not be emailed</strong> (${emailResult.reason || 'send failed'}).
          Save this URL: <code>${manageUrl}</code>
        </p>`}
    <p><a href="/">home</a></p>
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
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(layout({
    title: `manage — ${event.title}`,
    body: html`
      <h1>${event.title}</h1>
      <p>Management link valid. Signed in as <code>${rec.initiator}</code>.</p>
      <p>Event ID: <code>${event.id}</code> · Flow: <code>${event.flow}</code> · ${event.steps.length} step(s)</p>
      <p style="background:#ffc;padding:0.75rem;border:1px solid #cc9">
        Full dashboard (progress, reminders, close) lands in 1.H.5.
        For now: day-to-day commands happen by email —
        <code>stats+${event.id}@${config.domain}</code>,
        <code>remind+${event.id}@${config.domain}</code>,
        <code>close+${event.id}@${config.domain}</code>.
      </p>
      <p><a href="/events/${event.id}">read-only view</a> · <a href="/">home</a></p>
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
