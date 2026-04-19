'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderFlowProse } = require('../../src/web/flow-prose');

function mk(id, deps = []) { return { id, name: id, depends_on: deps }; }

test('empty → empty string', () => {
  assert.equal(renderFlowProse([]), '');
});

test('single step → "Step 1 runs alone"', () => {
  assert.equal(renderFlowProse([mk('a')]), 'Step 1 runs alone.');
});

test('all parallel (no deps) → "All N steps run in parallel"', () => {
  const s = [mk('a'), mk('b'), mk('c')];
  assert.equal(renderFlowProse(s), 'All 3 steps run in parallel (any order).');
});

test('linear chain → "Step 1, then Step 2, then Step 3"', () => {
  const s = [mk('a'), mk('b', ['a']), mk('c', ['b'])];
  assert.equal(renderFlowProse(s), 'Step 1, then Step 2, then Step 3.');
});

test('fan-out → "Step 1, then Steps 2 and 3"', () => {
  const s = [mk('a'), mk('b', ['a']), mk('c', ['a'])];
  assert.equal(renderFlowProse(s), 'Step 1, then Steps 2 and 3.');
});

test('merge → "Steps 1 and 2, then Step 3"', () => {
  const s = [mk('a'), mk('b'), mk('c', ['a', 'b'])];
  assert.equal(renderFlowProse(s), 'Steps 1 and 2, then Step 3.');
});

test('three-parallel merge → "Steps 1, 2, and 3, then Step 4"', () => {
  const s = [mk('a'), mk('b'), mk('c'), mk('d', ['a', 'b', 'c'])];
  assert.equal(renderFlowProse(s), 'Steps 1, 2, and 3, then Step 4.');
});

test('mixed: independent root joins lower level', () => {
  // 1 → 3, 2 → 3, 4 is independent (no deps) — all at level 0 or 1
  const s = [mk('a'), mk('b'), mk('c', ['a', 'b']), mk('d')];
  assert.equal(renderFlowProse(s), 'Steps 1, 2, and 4, then Step 3.');
});
