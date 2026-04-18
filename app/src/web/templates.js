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
function layout({ title, body, dev, devHUD }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHTML(title || 'gitdone')}</title>
<style>
body { font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; color: #222; }
h1, h2 { font-weight: 500; }
a { color: #0645ad; }
button, input[type=submit] { font-size: 1rem; padding: 0.5rem 1rem; cursor: pointer; }
input[type=text], input[type=email], input[type=date], select, textarea { font: inherit; padding: 0.4rem; width: 100%; box-sizing: border-box; }
label { display: block; margin-top: 0.75rem; }
label span { display: block; font-size: 0.9em; color: #555; }
.btn-big { display: inline-block; margin: 0.5rem; padding: 1rem 1.5rem; border: 1px solid #0645ad; background: white; color: #0645ad; text-decoration: none; border-radius: 4px; }
.btn-big:hover { background: #0645ad; color: white; }
code { background: #f3f3f3; padding: 0.1em 0.3em; border-radius: 2px; }
.footer { margin-top: 3rem; font-size: 0.85em; color: #666; border-top: 1px solid #eee; padding-top: 1rem; }
</style>
</head>
<body>
${(body && body[RAW_MARK]) ? body.html : escapeHTML(body || '')}
<div class="footer">
  <a href="/">gitdone</a> &middot; proofs verify offline &middot;
  <a href="https://github.com/hamr0/gitdone">source</a>
${dev ? ' &middot; <strong style="color:#0645ad">DEV MODE</strong>' : ''}
</div>
${dev && devHUD ? devHUD : ''}
</body>
</html>
`;
}

module.exports = { html, raw, escapeHTML, layout };
