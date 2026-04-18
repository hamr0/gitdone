'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const { parseBody, readBody } = require('../../src/web/body');

function fakeReq({ body = '', contentType = 'application/x-www-form-urlencoded' } = {}) {
  const stream = Readable.from(body ? [Buffer.from(body)] : []);
  stream.headers = { 'content-type': contentType };
  return stream;
}

test('readBody: returns buffer of request body', async () => {
  const req = fakeReq({ body: 'hello', contentType: 'text/plain' });
  const buf = await readBody(req);
  assert.equal(buf.toString(), 'hello');
});

test('readBody: rejects when body exceeds maxBytes', async () => {
  const req = fakeReq({ body: 'x'.repeat(100), contentType: 'text/plain' });
  await assert.rejects(readBody(req, 10), /too large/);
});

test('parseBody: parses application/x-www-form-urlencoded', async () => {
  const req = fakeReq({ body: 'title=Hello&email=a%40b.com&flow=sequential' });
  const obj = await parseBody(req);
  assert.equal(obj.title, 'Hello');
  assert.equal(obj.email, 'a@b.com');
  assert.equal(obj.flow, 'sequential');
});

test('parseBody: parses application/json', async () => {
  const req = fakeReq({ body: '{"a":1,"b":"two"}', contentType: 'application/json' });
  const obj = await parseBody(req);
  assert.deepEqual(obj, { a: 1, b: 'two' });
});

test('parseBody: invalid JSON throws', async () => {
  const req = fakeReq({ body: '{not json', contentType: 'application/json' });
  await assert.rejects(parseBody(req), /invalid JSON/);
});

test('parseBody: empty body returns empty object', async () => {
  const req = fakeReq({ body: '' });
  const obj = await parseBody(req);
  assert.deepEqual(obj, {});
});

test('parseBody: array values (repeated fields)', async () => {
  const req = fakeReq({ body: 'step=a&step=b&step=c' });
  const obj = await parseBody(req);
  assert.deepEqual(obj.step, ['a', 'b', 'c']);
});
