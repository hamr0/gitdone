'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createRouter, compilePattern } = require('../../src/web/router');

test('compilePattern: literal path', () => {
  const p = compilePattern('/health');
  assert.deepEqual(p.names, []);
  assert.ok(p.re.test('/health'));
  assert.ok(p.re.test('/health/'));
  assert.ok(!p.re.test('/health/x'));
});

test('compilePattern: single param', () => {
  const p = compilePattern('/manage/:token');
  assert.deepEqual(p.names, ['token']);
  const m = '/manage/abc123'.match(p.re);
  assert.ok(m);
  assert.equal(m[1], 'abc123');
});

test('compilePattern: multiple params', () => {
  const p = compilePattern('/events/:id/steps/:stepId');
  assert.deepEqual(p.names, ['id', 'stepId']);
  const m = '/events/evt-abc/steps/step-1'.match(p.re);
  assert.ok(m);
  assert.equal(m[1], 'evt-abc');
  assert.equal(m[2], 'step-1');
});

test('router: match method + literal path', () => {
  const r = createRouter();
  const handler = () => {};
  r.get('/health', handler);
  const m = r.match('GET', '/health');
  assert.ok(m);
  assert.equal(m.handler, handler);
  assert.deepEqual(m.params, {});
});

test('router: match is method-sensitive', () => {
  const r = createRouter();
  r.get('/events', () => {});
  assert.equal(r.match('POST', '/events'), null);
});

test('router: POST matches POST handler', () => {
  const r = createRouter();
  r.post('/events', () => {});
  assert.ok(r.match('POST', '/events'));
});

test('router: param handling', () => {
  const r = createRouter();
  r.get('/manage/:token', () => {});
  const m = r.match('GET', '/manage/abc-123');
  assert.ok(m);
  assert.equal(m.params.token, 'abc-123');
});

test('router: url-decodes path params', () => {
  const r = createRouter();
  r.get('/search/:q', () => {});
  const m = r.match('GET', '/search/hello%20world');
  assert.ok(m);
  assert.equal(m.params.q, 'hello world');
});

test('router: trailing slash tolerated', () => {
  const r = createRouter();
  r.get('/health', () => {});
  assert.ok(r.match('GET', '/health'));
  assert.ok(r.match('GET', '/health/'));
});

test('router: non-matching path returns null', () => {
  const r = createRouter();
  r.get('/events', () => {});
  assert.equal(r.match('GET', '/nope'), null);
  assert.equal(r.match('GET', '/events/x/y'), null);
});

test('router: first registered handler wins on match', () => {
  const r = createRouter();
  const h1 = () => 'first';
  const h2 = () => 'second';
  r.get('/x', h1);
  r.get('/x', h2);
  const m = r.match('GET', '/x');
  assert.equal(m.handler, h1);
});

test('router: regex meta-chars in literal path are escaped', () => {
  const r = createRouter();
  r.get('/events.json', () => {});
  // Must match literally, not treat . as regex dot
  assert.ok(r.match('GET', '/events.json'));
  assert.equal(r.match('GET', '/eventsxjson'), null);
});
