// Request body parsing. stdlib only; supports application/x-www-form-urlencoded
// and application/json. Caps at 256KB by default — event-creation forms
// are small; anything bigger is suspect.

'use strict';

const querystring = require('node:querystring');

const DEFAULT_MAX_BYTES = 256 * 1024;

function readBody(req, maxBytes = DEFAULT_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        req.destroy();
        return reject(new Error('body too large'));
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function parseBody(req, maxBytes = DEFAULT_MAX_BYTES) {
  const ctype = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const raw = await readBody(req, maxBytes);
  if (!raw.length) return {};
  if (ctype === 'application/x-www-form-urlencoded') {
    return querystring.parse(raw.toString('utf8'));
  }
  if (ctype === 'application/json') {
    try { return JSON.parse(raw.toString('utf8')); }
    catch { throw new Error('invalid JSON body'); }
  }
  // Unknown content type — hand back raw
  return { __raw: raw, __contentType: ctype };
}

module.exports = { readBody, parseBody, DEFAULT_MAX_BYTES };
