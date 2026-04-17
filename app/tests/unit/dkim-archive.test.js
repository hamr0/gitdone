'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  fetchDkimKey,
  extractPublicKey,
  toPem,
  pickSignatureToArchive,
} = require('../../src/dkim-archive');

test('extractPublicKey: returns base64 from typical DKIM record', () => {
  const rec = ['v=DKIM1; k=rsa; p=MIIBIjANBgkqh/abc=='];
  assert.equal(extractPublicKey(rec), 'MIIBIjANBgkqh/abc==');
});

test('extractPublicKey: handles multiple TXT chunks joined', () => {
  const rec = ['v=DKIM1; k=rsa; p=MIIBI', 'jANBgkqh/abc=='];
  assert.equal(extractPublicKey(rec), 'MIIBIjANBgkqh/abc==');
});

test('extractPublicKey: strips whitespace inside p=', () => {
  const rec = ['v=DKIM1; p= M I I B I jAN Bg ==  '];
  assert.equal(extractPublicKey(rec), 'MIIBIjANBg==');
});

test('extractPublicKey: returns null when p= missing', () => {
  assert.equal(extractPublicKey(['v=DKIM1; k=rsa']), null);
  assert.equal(extractPublicKey([]), null);
  assert.equal(extractPublicKey(null), null);
});

test('toPem: wraps base64 in PEM headers with 64-char lines', () => {
  const b64 = 'A'.repeat(150);
  const pem = toPem(b64);
  assert.match(pem, /^-----BEGIN PUBLIC KEY-----\n/);
  assert.match(pem, /\n-----END PUBLIC KEY-----\n$/);
  const body = pem.split('\n').slice(1, -2);
  assert.equal(body[0].length, 64);
  assert.equal(body[1].length, 64);
  assert.equal(body[2].length, 22); // 150 - 128
});

test('toPem: returns null on empty input', () => {
  assert.equal(toPem(null), null);
  assert.equal(toPem(''), null);
});

test('fetchDkimKey: resolves TXT, extracts PEM, records lookup metadata', async () => {
  const fakeResolver = async (name) => {
    assert.equal(name, 'sel1._domainkey.example.com');
    return [['v=DKIM1; k=rsa; p=TESTBASE64VALUE=']];
  };
  const r = await fetchDkimKey('example.com', 'sel1', { resolver: fakeResolver });
  assert.equal(r.error, undefined);
  assert.match(r.pem, /TESTBASE64VALUE/);
  assert.equal(r.base64, 'TESTBASE64VALUE=');
  assert.equal(r.lookup, 'sel1._domainkey.example.com');
  assert.match(r.fetched_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('fetchDkimKey: records error when DNS throws', async () => {
  const r = await fetchDkimKey('example.com', 'sel1', {
    resolver: async () => { throw new Error('NXDOMAIN'); },
  });
  assert.equal(r.pem, null);
  assert.match(r.error, /NXDOMAIN/);
});

test('fetchDkimKey: records error when record has no p= tag', async () => {
  const r = await fetchDkimKey('example.com', 'sel1', {
    resolver: async () => [['v=DKIM1; k=rsa']],
  });
  assert.equal(r.pem, null);
  assert.match(r.error, /no p=/);
});

test('fetchDkimKey: rejects invalid domain/selector (injection guard)', async () => {
  const r1 = await fetchDkimKey('ex\nample.com', 'sel1');
  assert.equal(r1.pem, null);
  assert.match(r1.error, /invalid/);
  const r2 = await fetchDkimKey('example.com', '../evil');
  assert.equal(r2.pem, null);
  assert.match(r2.error, /invalid/);
});

test('fetchDkimKey: returns error on empty inputs', async () => {
  const r = await fetchDkimKey('', '');
  assert.match(r.error, /missing/);
});

test('pickSignatureToArchive: prefers pass + aligned', () => {
  const auth = {
    dkim: {
      results: [
        { status: { result: 'fail', aligned: null }, signingDomain: 'fail.com' },
        { status: { result: 'pass', aligned: null }, signingDomain: 'unaligned.com' },
        { status: { result: 'pass', aligned: 'good.com' }, signingDomain: 'good.com' },
      ],
    },
  };
  const s = pickSignatureToArchive(auth);
  assert.equal(s.signingDomain, 'good.com');
});

test('pickSignatureToArchive: falls back to first passing when none aligned', () => {
  const auth = {
    dkim: {
      results: [
        { status: { result: 'pass', aligned: null }, signingDomain: 'first.com' },
        { status: { result: 'pass', aligned: null }, signingDomain: 'second.com' },
      ],
    },
  };
  assert.equal(pickSignatureToArchive(auth).signingDomain, 'first.com');
});

test('pickSignatureToArchive: falls back to first when none pass', () => {
  const auth = {
    dkim: { results: [{ status: { result: 'fail' }, signingDomain: 'only.com' }] },
  };
  assert.equal(pickSignatureToArchive(auth).signingDomain, 'only.com');
});

test('pickSignatureToArchive: returns null when no signatures', () => {
  assert.equal(pickSignatureToArchive({ dkim: { results: [] } }), null);
  assert.equal(pickSignatureToArchive({}), null);
  assert.equal(pickSignatureToArchive(null), null);
});
