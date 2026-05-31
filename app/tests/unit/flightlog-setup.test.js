'use strict';

// Guards the only policy in the flightlog adopter glue (src/flightlog.js): the
// sink path. init() itself is exercised live in the entry points (it registers
// global handlers + writes a boot probe, so it's deliberately NOT called here).
const test = require('node:test');
const assert = require('node:assert/strict');
const { sinkFile } = require('../../src/flightlog');

test('sinkFile honors GITDONE_FLIGHTLOG_FILE override', () => {
  const prev = process.env.GITDONE_FLIGHTLOG_FILE;
  process.env.GITDONE_FLIGHTLOG_FILE = '/tmp/custom-flightlog.jsonl';
  try {
    assert.equal(sinkFile(), '/tmp/custom-flightlog.jsonl');
  } finally {
    if (prev === undefined) delete process.env.GITDONE_FLIGHTLOG_FILE;
    else process.env.GITDONE_FLIGHTLOG_FILE = prev;
  }
});

test('sinkFile defaults to <dataDir>/logs/errors.jsonl', () => {
  const prev = process.env.GITDONE_FLIGHTLOG_FILE;
  delete process.env.GITDONE_FLIGHTLOG_FILE;
  try {
    assert.match(sinkFile(), /[/\\]logs[/\\]errors\.jsonl$/);
  } finally {
    if (prev !== undefined) process.env.GITDONE_FLIGHTLOG_FILE = prev;
  }
});
