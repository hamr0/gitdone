'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseAddress, parseEventTag, parseReverifyTag, parseInitiatorCommand } = require('../../src/router');

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

// reverify+{eventId}-{commitSeq}@ tests (1.L.3)

test('parseReverifyTag: extracts eventId and commitSequence', () => {
  assert.deepEqual(parseReverifyTag('reverify+demo123-3@git-done.com'), {
    eventId: 'demo123',
    commitSequence: 3,
  });
});

test('parseReverifyTag: multi-digit commit sequences', () => {
  assert.deepEqual(parseReverifyTag('reverify+demo-42@git-done.com'), {
    eventId: 'demo',
    commitSequence: 42,
  });
});

test('parseReverifyTag: rejects non-reverify kinds', () => {
  assert.equal(parseReverifyTag('verify+demo123@git-done.com'), null);
  assert.equal(parseReverifyTag('event+demo123-3@git-done.com'), null);
});

test('parseReverifyTag: rejects when commit sequence missing', () => {
  assert.equal(parseReverifyTag('reverify+demo123@git-done.com'), null);
});

test('parseReverifyTag: rejects non-numeric commit sequence', () => {
  assert.equal(parseReverifyTag('reverify+demo123-abc@git-done.com'), null);
  assert.equal(parseReverifyTag('reverify+demo123-3a@git-done.com'), null);
});

test('parseReverifyTag: rejects zero and out-of-range sequences', () => {
  assert.equal(parseReverifyTag('reverify+demo123-0@git-done.com'), null);
  assert.equal(parseReverifyTag('reverify+demo123-100000@git-done.com'), null);
});

test('parseReverifyTag: rejects traversal in eventId', () => {
  assert.equal(parseReverifyTag('reverify+..-3@git-done.com'), null);
  assert.equal(parseReverifyTag('reverify+a.b-3@git-done.com'), null);
});

test('parseReverifyTag: accepts last-dash split (eventId can have preceding characters but not dashes)', () => {
  // eventId is alphanumeric only (same rule as event+), so dashes in the
  // "eventId" portion of the extension are actually illegal — commit
  // sequence is always after the last (and only) dash.
  const r = parseReverifyTag('reverify+abc-5@git-done.com');
  assert.equal(r.eventId, 'abc');
  assert.equal(r.commitSequence, 5);
});

test('parseReverifyTag: rejects dashes in eventId', () => {
  assert.equal(parseReverifyTag('reverify+abc-def-5@git-done.com'), null);
});

// §6.4 initiator commands

test('parseInitiatorCommand: stats / remind / close on an alphanumeric id', () => {
  assert.deepEqual(parseInitiatorCommand('stats+abc123@git-done.com'),  { command: 'stats',  eventId: 'abc123' });
  assert.deepEqual(parseInitiatorCommand('remind+abc123@git-done.com'), { command: 'remind', eventId: 'abc123' });
  assert.deepEqual(parseInitiatorCommand('close+abc123@git-done.com'),  { command: 'close',  eventId: 'abc123' });
});

test('parseInitiatorCommand: non-command kinds return null', () => {
  assert.equal(parseInitiatorCommand('event+abc-step@git-done.com'), null);
  assert.equal(parseInitiatorCommand('verify+abc@git-done.com'), null);
  assert.equal(parseInitiatorCommand('reverify+abc-3@git-done.com'), null);
  assert.equal(parseInitiatorCommand('unknown+abc@git-done.com'), null);
});

test('parseInitiatorCommand: rejects non-alphanumeric event ids', () => {
  assert.equal(parseInitiatorCommand('stats+abc-def@git-done.com'), null);
  assert.equal(parseInitiatorCommand('close+..@git-done.com'), null);
  assert.equal(parseInitiatorCommand('remind+@git-done.com'), null);
});
