// Minimal HTTP router. Matches (method, path) to a handler; supports
// path parameters like /manage/:token. No middleware chain, no
// heroics — just enough for a few event routes and some static pages.
//
// Handlers are async (req, res, params) => void. The server calls
// res.end() to finish; handlers can set status/headers before.

'use strict';

function compilePattern(pattern) {
  // /manage/:token -> regex + param names
  const names = [];
  const regexParts = pattern.split('/').map((seg) => {
    if (seg.startsWith(':')) {
      names.push(seg.slice(1));
      return '([^/]+)';
    }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  const re = new RegExp('^' + regexParts.join('/') + '/?$');
  return { re, names };
}

function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    routes.push({ method: method.toUpperCase(), pattern, ...compilePattern(pattern), handler });
  }

  function match(method, url) {
    for (const r of routes) {
      if (r.method !== method.toUpperCase()) continue;
      const m = url.match(r.re);
      if (!m) continue;
      const params = {};
      r.names.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return null;
  }

  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    match,
  };
}

module.exports = { createRouter, compilePattern };
