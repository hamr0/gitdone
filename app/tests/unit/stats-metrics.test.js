'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { flatMetrics } = require('../../src/stats');

// A representative collect() snapshot (nested shape).
const snap = {
  snapshot_at: '2026-06-01T06:00:00.000Z',
  unique_organisers: 7,
  unique_recipients_named: 12,
  events_total: 20,
  by_type: { event: 15, declaration: 2, attestation: 3 },
  by_status: { pending_activation: 3, open: 8, completed: 5, closed_early: 1, archived: 3 },
  completed_vs_incomplete: { completed: 5, incomplete: 15 },
  workflow_step_count_total: 60,
  workflow_step_completed_total: 40,
  attestation_replies_total: 9,
  parse_errors: 0,
};

test('flatMetrics: flattens the nested snapshot to named integers', () => {
  const m = flatMetrics(snap);
  assert.deepEqual(m, {
    orgs: 7, rcpts: 12, events: 20,
    type_workflow: 15, type_declaration: 2, type_attestation: 3,
    pending: 3, open: 8, completed: 5, closed_early: 1, archived: 3,
    steps_done: 40, steps_total: 60, attest_replies: 9,
  });
});

test('flatMetrics: every value is a whole-number integer (pulselog gate)', () => {
  // pulselog records a metric only if Number.isInteger(value); a float/NaN/
  // undefined records null. Guarantee none of ours ever degrade to null.
  for (const [k, v] of Object.entries(flatMetrics(snap))) {
    assert.ok(Number.isInteger(v), `${k} must be an integer, got ${v}`);
  }
});

test('flatMetrics: missing/partial snapshot fields coerce to 0, never null/NaN', () => {
  const m = flatMetrics({}); // nothing present
  for (const [k, v] of Object.entries(m)) {
    assert.equal(v, 0, `${k} should be 0 on an empty snapshot`);
    assert.ok(Number.isInteger(v), `${k} stays an integer`);
  }
});

test('flatMetrics: declared digest names are all present (config contract)', () => {
  // The names pulselog's digest config declares must exist as keys here, or
  // they'd silently record null. Keep this list in sync with
  // ops/pulselog/pulselog.config.json digest.metrics[].
  const declared = ['orgs', 'rcpts', 'events', 'pending', 'open', 'completed', 'steps_done', 'attest_replies'];
  const keys = new Set(Object.keys(flatMetrics(snap)));
  for (const name of declared) assert.ok(keys.has(name), `missing declared metric: ${name}`);
});
