'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseEnvelope } = require('../../src/envelope');

test('parseEnvelope: full argv from postfix', () => {
  const argv = ['node', 'receive.js', '52.103.33.36', 'mail.example.com', 'a@b.com', 'c+tag@git-done.com'];
  assert.deepEqual(parseEnvelope(argv), {
    clientIp: '52.103.33.36',
    clientHelo: 'mail.example.com',
    sender: 'a@b.com',
    recipient: 'c+tag@git-done.com',
  });
});

test('parseEnvelope: "unknown" placeholders normalised to null', () => {
  const argv = ['node', 'receive.js', 'unknown', 'unknown', 'a@b.com', 'r@git-done.com'];
  const e = parseEnvelope(argv);
  assert.equal(e.clientIp, null);
  assert.equal(e.clientHelo, null);
  assert.equal(e.sender, 'a@b.com');
});

test('parseEnvelope: missing args produce nulls', () => {
  const argv = ['node', 'receive.js'];
  assert.deepEqual(parseEnvelope(argv), {
    clientIp: null, clientHelo: null, sender: null, recipient: null,
  });
});
