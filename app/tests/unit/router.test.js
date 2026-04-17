'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseAddress, parseEventTag } = require('../../src/router');

test('parseAddress: standard event+tag form', () => {
  assert.deepEqual(parseAddress('event+abc123-step1@git-done.com'), {
    kind: 'event',
    extension: 'abc123-step1',
    domain: 'git-done.com',
  });
});

test('parseAddress: case-insensitive kind, lowered', () => {
  const a = parseAddress('Event+abc-step1@Git-Done.com');
  assert.equal(a.kind, 'event');
  assert.equal(a.domain, 'git-done.com');
});

test('parseAddress: returns null on plain (no plus) address', () => {
  assert.equal(parseAddress('test@git-done.com'), null);
});

test('parseAddress: returns null on garbage', () => {
  assert.equal(parseAddress('not an address'), null);
  assert.equal(parseAddress(''), null);
  assert.equal(parseAddress(null), null);
  assert.equal(parseAddress(undefined), null);
});

test('parseEventTag: extracts eventId and stepId', () => {
  assert.deepEqual(parseEventTag('event+abc123-step1@git-done.com'), {
    eventId: 'abc123',
    stepId: 'step1',
  });
});

test('parseEventTag: stepId may contain dashes (split on first dash only)', () => {
  assert.deepEqual(parseEventTag('event+abc-step-1-final@git-done.com'), {
    eventId: 'abc',
    stepId: 'step-1-final',
  });
});

test('parseEventTag: eventId without stepId is permitted', () => {
  assert.deepEqual(parseEventTag('event+abc123@git-done.com'), {
    eventId: 'abc123',
    stepId: null,
  });
});

test('parseEventTag: rejects non-event kinds', () => {
  assert.equal(parseEventTag('manage+abc@git-done.com'), null);
  assert.equal(parseEventTag('attest+abc@git-done.com'), null);
});

test('parseEventTag: rejects non-alphanumeric eventId (path traversal guard)', () => {
  assert.equal(parseEventTag('event+../etc/passwd-step1@git-done.com'), null);
  assert.equal(parseEventTag('event+abc.123-step1@git-done.com'), null);
  assert.equal(parseEventTag('event+abc 123-step1@git-done.com'), null);
});

test('parseEventTag: returns null when address fails parse', () => {
  assert.equal(parseEventTag('plain@git-done.com'), null);
  assert.equal(parseEventTag(null), null);
});
