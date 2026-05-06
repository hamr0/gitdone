// Plain-HTML templating via tagged template literal. Enough for forms +
// read-only pages; nothing client-side-heavy. Renders server-side, no
// JS framework, no bundler. If a page needs a pinch of JS, inline it.
//
// escapeHTML is the only safety primitive — all interpolated values
// are escaped by default. Use `raw()` to opt out (e.g. inline SVG).

'use strict';

function escapeHTML(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const RAW_MARK = Symbol('raw-html');

function raw(html) {
  return { [RAW_MARK]: true, html: String(html) };
}

function html(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) {
      const v = values[i];
      if (v && v[RAW_MARK]) out += v.html;
      else if (Array.isArray(v)) out += v.map((x) => (x && x[RAW_MARK]) ? x.html : escapeHTML(x)).join('');
      else out += escapeHTML(v);
    }
  });
  return { [RAW_MARK]: true, html: out };
}

// Shared page chrome. Keep it minimal per §0.1.4 ("invisible beats
// correct") — whitespace, no branding chrome, no JS in production.
// In dev mode (layout called with { dev: true, devHUD: "..." }),
// injects the feedback/reload HUD.
// Discoverability tier 1 (declarative head tags only — no scripts, no
// trackers). description + canonical are passed by routes that should
// be indexed; transactional routes pass nothing and rely on robots.txt
// to keep them out of search.
const DEFAULT_DESCRIPTION = 'Email-native multi-party workflow coordination with cryptographic proof of the reply sequence. No accounts, no API, no telemetry, open source.';
const SITE_NAME = 'gitdone';
const THEME_COLOR = '#0d1117';

function layout({ title, body, dev, devHUD, pageName, pageTagline, description, canonical, noindex }) {
  // Auto-derive header from title when not explicitly given. Two title
  // shapes in the app:
  //   "<page> — gitdone"   → name = "<page>",   no tagline (sub-pages)
  //   "gitdone — <tag>"    → name = "gitdone",  tagline = "<tag>" (home)
  //   just "gitdone"       → no header
  if (pageName === undefined && title) {
    const t = String(title).trim();
    let m = t.match(/^(.*?)\s+—\s+gitdone\s*$/);
    if (m) {
      pageName = m[1].trim();
    } else if ((m = t.match(/^gitdone\s+—\s+(.*)$/))) {
      pageName = 'gitdone';
      if (pageTagline === undefined) pageTagline = m[1].trim();
    } else {
      pageName = (t === 'gitdone' ? '' : t);
    }
  }
  const desc = description || DEFAULT_DESCRIPTION;
  const seoTags = [];
  seoTags.push(`<meta name="description" content="${escapeHTML(desc)}">`);
  seoTags.push(`<meta name="theme-color" content="${THEME_COLOR}">`);
  if (canonical) seoTags.push(`<link rel="canonical" href="${escapeHTML(canonical)}">`);
  if (noindex) seoTags.push(`<meta name="robots" content="noindex,nofollow">`);
  // OpenGraph + twitter card — skip og:image (deferred design task per
  // privacy-seo.md tier 1; unfurl falls back to title+description).
  seoTags.push(`<meta property="og:type" content="website">`);
  seoTags.push(`<meta property="og:site_name" content="${SITE_NAME}">`);
  seoTags.push(`<meta property="og:title" content="${escapeHTML(title || SITE_NAME)}">`);
  seoTags.push(`<meta property="og:description" content="${escapeHTML(desc)}">`);
  if (canonical) seoTags.push(`<meta property="og:url" content="${escapeHTML(canonical)}">`);
  seoTags.push(`<meta name="twitter:card" content="summary">`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHTML(title || 'gitdone')}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
${seoTags.join('\n')}
<style>
/* Terminal theme — retro CRT (charcoal + phosphor green + amber). */
html, body { background: #0d1117; }
body { font: 15px/1.55 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
       max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #c9d1d9; }
h1, h2, h3, h4 { font-family: inherit; font-weight: 600; color: #c9d1d9; letter-spacing: -0.01em; }
h1 { font-weight: 700; }
p { margin: 0.6rem 0; }
a { color: #58a6ff; text-decoration: none; }
a:hover { color: #ffb000; text-decoration: underline; }
em { color: #3fb950; font-style: normal; }
strong { color: #c9d1d9; }
hr { border: 0; border-top: 1px solid #30363d; margin: 1.2rem 0; }
button, input[type=submit] {
  font: inherit; padding: 0.55rem 1.2rem; cursor: pointer; border: 1px solid #3fb950;
  background: #0d1117; color: #3fb950; border-radius: 0; letter-spacing: 0.03em;
  transition: background 0.12s, color 0.12s;
}
button:hover, input[type=submit]:hover { background: #3fb950; color: #0d1117; }
input[type=text], input[type=email], input[type=date], input[type=datetime-local],
input[type=number], input[type=password], select, textarea {
  font: inherit; padding: 0.45rem 0.55rem; width: 100%; box-sizing: border-box;
  background: #161b22; color: #c9d1d9; border: 1px solid #30363d; border-radius: 0;
}
input:focus, select:focus, textarea:focus { outline: 0; border-color: #3fb950;
  box-shadow: 0 0 0 2px rgba(63,185,80,.18); }
input[type=checkbox] { width: auto; accent-color: #3fb950; }
label { display: block; margin-top: 0.75rem; color: #c9d1d9; }
label span { display: block; font-size: 0.82em; color: #8b949e; margin-bottom: 0.2rem;
             text-transform: uppercase; letter-spacing: 0.08em; }
.btn-big { display: inline-block; margin: 0.5rem 0.5rem 0.5rem 0; padding: 0.8rem 1.4rem;
           border: 1px solid #3fb950; background: #0d1117; color: #3fb950;
           text-decoration: none; border-radius: 0; letter-spacing: 0.03em; font-weight: 500; }
.btn-big:hover { background: #3fb950; color: #0d1117; text-decoration: none; }
code { background: #161b22; color: #ffb000; padding: 0.08em 0.35em; border-radius: 2px;
       font-family: inherit; font-size: 0.95em; }
pre { background: #161b22; color: #c9d1d9; padding: 0.8rem 1rem; overflow-x: auto;
      border: 1px solid #30363d; }
table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid #30363d; padding: 0.4rem 0.5rem; text-align: left; }
th { color: #8b949e; font-weight: 500; text-transform: uppercase; font-size: 0.76em;
     letter-spacing: 0.1em; }
.footer { margin-top: 3rem; font-size: 0.82em; color: #6e7681; border-top: 1px solid #30363d;
          padding-top: 0.9rem; letter-spacing: 0.04em; }
.footer a { color: #8b949e; }
.footer a:hover { color: #3fb950; }
.page-header { margin: 0 0 1.5rem; padding: 0 0 0.6rem;
               border-bottom: 1px solid #30363d; letter-spacing: -0.01em; }
.page-header .line1 { font-size: 1.1rem; font-weight: 600; }
.page-header a { color: #c9d1d9; text-decoration: none; }
.page-header a:hover { color: #3fb950; text-decoration: none; }
.page-header .slash { color: #ffb000; margin: 0 0.2em; text-shadow: 0 0 12px rgba(255,176,0,.35); }
.page-header .name { color: #8b949e; font-weight: 400; font-size: 0.92em; letter-spacing: 0.04em; }
.page-header .tagline { display: block; margin-top: 0.25rem; font-size: 0.85em;
                        font-weight: 400; color: #8b949e; letter-spacing: 0; }
/* Home variant: tight wordmark (no slash spacing), bold, one size up. */
.page-header.home .line1 { font-size: 1.4rem; font-weight: 700; }
.page-header.home .slash { margin: 0; }
.page-header.home .name { font-size: 1em; font-weight: 700; color: #c9d1d9; letter-spacing: -0.01em; }
.page-header.home .tagline { font-size: 0.95em; }
::selection { background: rgba(63,185,80,.28); color: #c9d1d9; }
.copyable { cursor: pointer; position: relative; }
.copyable:hover { background: #1f2630; }
.copyable.copied::after { content: 'copied'; position: absolute; left: 100%; top: 50%;
  transform: translateY(-50%); margin-left: 0.4rem; padding: 0.1em 0.4em;
  background: #3fb950; color: #0d1117; font-size: 0.72em; letter-spacing: 0.06em;
  border-radius: 0; pointer-events: none; white-space: nowrap; }
</style>
</head>
<body>
${pageName ? `<header class="page-header${pageTagline ? ' home' : ''}"><div class="line1"><a href="/">g</a><span class="slash">/</span><span class="name">${escapeHTML(pageName)}</span></div>${pageTagline ? `<div class="tagline">${escapeHTML(pageTagline)}</div>` : ''}</header>` : ''}
${(body && body[RAW_MARK]) ? body.html : escapeHTML(body || '')}
<div class="footer">
  <a href="/">gitdone</a> &middot; proofs verify offline &middot;
  <a href="https://github.com/hamr0/gitdone">source</a>
${dev ? ' &middot; <strong style="color:#ffb000">DEV MODE</strong>' : ''}
</div>
${dev && devHUD ? devHUD : ''}
<script>
(function(){
  function copyText(el){
    var t = (el.textContent || '').trim();
    if (!t) return;
    function flash(){ el.classList.add('copied'); setTimeout(function(){ el.classList.remove('copied'); }, 1000); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(flash, function(){});
    } else {
      try {
        var ta = document.createElement('textarea');
        ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy');
        document.body.removeChild(ta); flash();
      } catch(e) {}
    }
  }
  document.addEventListener('click', function(e){
    var c = e.target.closest && e.target.closest('.copyable');
    if (c) copyText(c);
  });
})();
</script>
</body>
</html>
`;
}

module.exports = { html, raw, escapeHTML, layout };
