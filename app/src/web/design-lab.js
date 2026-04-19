// Dev-only Design Lab loader. Serves /__design_lab when .claude-design/lab/
// exists. Loads variant-*.js modules on every request (no caching — the lab
// is for iteration). Feedback POSTs are appended to .claude-design/feedback.jsonl.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Resolve lab root regardless of where the server is launched from.
// Check cwd first (running from repo root), then one level up (running from app/).
function resolveLabRoot() {
  const candidates = [
    path.join(process.cwd(), '.claude-design', 'lab'),
    path.join(process.cwd(), '..', '.claude-design', 'lab'),
    path.join(__dirname, '..', '..', '..', '.claude-design', 'lab'),
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isDirectory()) return c; } catch {}
  }
  return candidates[0];
}

const LAB_ROOT = resolveLabRoot();
const VARIANTS_DIR = path.join(LAB_ROOT, 'variants');
const OVERLAY_PATH = path.join(LAB_ROOT, 'overlay.js');
const FEEDBACK_PATH = path.join(LAB_ROOT, '..', 'feedback.jsonl');

function labExists() {
  try { return fs.statSync(VARIANTS_DIR).isDirectory(); } catch { return false; }
}

function loadVariants() {
  const files = fs.readdirSync(VARIANTS_DIR)
    .filter((f) => /^variant-.+\.js$/.test(f))
    .sort();
  const variants = [];
  for (const f of files) {
    const full = path.join(VARIANTS_DIR, f);
    delete require.cache[require.resolve(full)];
    try {
      const v = require(full);
      if (v && typeof v.render === 'function') variants.push(v);
    } catch (err) {
      variants.push({ id: f, rationale: `load error: ${err.message}`, render: () => `<pre style="color:#c00;background:#fee;padding:1rem;border:1px solid #c99">${escapeHtml(err.stack || err.message)}</pre>` });
    }
  }
  return variants;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderLabPage() {
  if (!labExists()) {
    return `<!doctype html><meta charset="utf-8"><title>Design Lab</title>
      <body style="font-family:system-ui;padding:2rem;color:#555"><h1>No lab</h1>
      <p>Create <code>.claude-design/lab/variants/variant-*.js</code> to populate.</p></body>`;
  }
  const variants = loadVariants();
  const blocks = variants.map((v) => `
    <section class="lab-variant">
      <header class="lab-vhd">
        <h2>Variant ${escapeHtml(v.id)}</h2>
        <p class="lab-rationale">${escapeHtml(v.rationale || '')}</p>
      </header>
      <div class="lab-frame">${v.render()}</div>
    </section>
  `).join('\n');

  return `<!doctype html>
<html><head>
  <meta charset="utf-8">
  <title>Design Lab — landing</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { margin: 0; font-family: -apple-system, 'Inter', system-ui, sans-serif; background: #f7f7f9; color: #222; }
    .lab-top { background: #1c1c1c; color: #eee; padding: 1rem 1.4rem; display: flex; align-items: baseline; gap: 1rem; flex-wrap: wrap; }
    .lab-top h1 { font-size: 1rem; margin: 0; font-weight: 600; }
    .lab-top .hint { color: #aaa; font-size: 0.85em; }
    .lab-top .hint code { background: #333; padding: 0.1em 0.35em; border-radius: 3px; }
    .lab-grid { max-width: 900px; margin: 0 auto; padding: 1.4rem 1.2rem 4rem; }
    .lab-variant { margin-bottom: 2.2rem; background: #fff; border: 1px solid #e3e6ee; border-radius: 6px; overflow: hidden; }
    .lab-vhd { padding: 0.7rem 1rem; background: #fafafd; border-bottom: 1px solid #eef1f5; }
    .lab-vhd h2 { margin: 0 0 0.15rem; font-size: 0.82em; text-transform: uppercase; letter-spacing: 0.1em; color: #0645ad; }
    .lab-rationale { margin: 0; font-size: 0.85em; color: #555; line-height: 1.45; }
    .lab-frame { padding: 1rem 1.2rem; }
  </style>
</head>
<body>
  <div class="lab-top">
    <h1>Design Lab · landing page</h1>
    <span class="hint">Click "Add Feedback" (bottom-right) → click any element → comment → Save. All feedback streams to <code>.claude-design/feedback.jsonl</code>.</span>
  </div>
  <div class="lab-grid">
    ${blocks}
  </div>
  <script src="/__design_lab/overlay.js"></script>
  <script>
    LiveCanvas.init({
      target: 'landing',
      batchEndpoint: '/__design_lab/feedback',
    });
  </script>
</body></html>`;
}

function handle(req, res, u) {
  // overlay script
  if (u.pathname === '/__design_lab/overlay.js' && req.method === 'GET') {
    try {
      const js = fs.readFileSync(OVERLAY_PATH);
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(js);
    } catch {
      res.writeHead(404); return res.end('overlay missing');
    }
  }
  // feedback append
  if (u.pathname === '/__design_lab/feedback' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const line = JSON.stringify({ received_at: new Date().toISOString(), ...parsed }) + '\n';
        fs.mkdirSync(path.dirname(FEEDBACK_PATH), { recursive: true });
        fs.appendFileSync(FEEDBACK_PATH, line);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }
  // lab page
  if ((u.pathname === '/__design_lab' || u.pathname === '/__design_lab/') && req.method === 'GET') {
    const html = renderLabPage();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(html);
  }
  res.writeHead(404); res.end('not found');
}

module.exports = { handle, labExists };
