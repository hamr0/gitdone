// TEST-ONLY DNS stub. Builds a resolver function compatible with both
//   - mailauth's resolver shape: (name, type) => [[txtChunk, ...], ...]
//   - dns.resolveTxt's shape:    (name)       => [[txtChunk, ...], ...]
//
// Loads a JSON map from a file. Keys are DNS names; values are the raw
// TXT-record strings (one record per name). Names not in the map raise
// ENOTFOUND so callers see the same shape they would for missing records.
//
// Used by the e2e DKIM-signed reply test to spoof DKIM (selector._domainkey
// .domain), DMARC (_dmarc.domain), and SPF (domain) lookups without
// touching the network.

'use strict';

const fs = require('node:fs');

function buildStubResolver(filePath) {
  const map = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return async function stubResolver(name, type) {
    const t = (type || 'TXT').toUpperCase();
    if (t !== 'TXT') {
      const e = new Error(`stub-dns: only TXT supported, got ${t} for ${name}`);
      e.code = 'ENOTFOUND';
      throw e;
    }
    const rec = map[name];
    if (rec === undefined) {
      const e = new Error(`stub-dns: no record for ${name}`);
      e.code = 'ENOTFOUND';
      throw e;
    }
    // Return shape: array of records, each an array of string chunks.
    return [[rec]];
  };
}

module.exports = { buildStubResolver };
