// TEST-ONLY DKIM signer. Wraps mailauth's own dkimSign so tests can
// produce a valid DKIM-Signature header on a synthesized .eml without
// shelling out to opendkim or hand-rolling RFC 6376.
//
// Lives under tests/helpers/ — never imported from src/ or bin/.
//
// Usage:
//   const { signDkim } = require('../helpers/dkim-sign');
//   const signed = await signDkim(rawEml, {
//     domain: 'test.example.com',
//     selector: 'test1',
//     privateKeyPem: fs.readFileSync('.../test.example.com.private.pem', 'utf8'),
//     // headers list is optional; default mirrors common opendkim defaults
//   });
//
// Returns: Buffer with `DKIM-Signature: ...\r\n` prepended to the input.
// Canonicalization: relaxed/relaxed. Algorithm: rsa-sha256.

'use strict';

const { dkimSign } = require('mailauth');

const DEFAULT_HEADERS = ['from', 'to', 'subject', 'date', 'message-id'];

async function signDkim(rawEml, opts) {
  if (!opts || !opts.domain || !opts.selector || !opts.privateKeyPem) {
    throw new Error('signDkim: domain, selector, privateKeyPem are required');
  }
  const input = Buffer.isBuffer(rawEml) ? rawEml : Buffer.from(String(rawEml));
  const headerList = (opts.headers && opts.headers.length ? opts.headers : DEFAULT_HEADERS).join(':');
  const result = await dkimSign(input, {
    canonicalization: 'relaxed/relaxed',
    algorithm: 'rsa-sha256',
    signTime: opts.signTime || new Date(),
    signatureData: [{
      signingDomain: opts.domain,
      selector: opts.selector,
      privateKey: opts.privateKeyPem,
      headerList,
    }],
  });
  if (result.errors && result.errors.length) {
    const err = new Error('signDkim: mailauth reported signing errors');
    err.errors = result.errors;
    throw err;
  }
  // result.signatures already ends with \r\n. Prepend to the original eml
  // so the DKIM-Signature header lands at the very top.
  const sigBuf = Buffer.from(result.signatures, 'utf8');
  return Buffer.concat([sigBuf, input]);
}

module.exports = { signDkim };
