'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderFlowProse } = require('../../src/web/flow-prose');

function mk(id, name, deps = []) { return { id, name, depends_on: deps }; }

test('empty → empty string', () => {
  assert.equal(renderFlowProse([]), '');
});

test('single step → "#1 name runs alone"', () => {
  assert.equal(renderFlowProse([mk('a', 'audio')]), '#1 audio runs alone.');
});

test('all parallel (no deps) → names joined with "and", ends "in parallel"', () => {
  const s = [mk('a', 'audio'), mk('b', 'video'), mk('c', 'catering')];
  assert.equal(
    renderFlowProse(s),
    '#1 audio, #2 video, and #3 catering run in parallel (any order).',
  );
});

test('linear chain → "#1 a, then #2 b, then #3 c"', () => {
  const s = [mk('a', 'draft'), mk('b', 'review', ['a']), mk('c', 'sign', ['b'])];
  assert.equal(renderFlowProse(s), '#1 draft, then #2 review, then #3 sign.');
});

test('fan-out → "#1 a, then #2 b and #3 c"', () => {
  const s = [mk('a', 'root'), mk('b', 'left', ['a']), mk('c', 'right', ['a'])];
  assert.equal(renderFlowProse(s), '#1 root, then #2 left and #3 right.');
});

test('merge → "#1 a and #2 b, then #3 c"', () => {
  const s = [mk('a', 'legal'), mk('b', 'design'), mk('c', 'signoff', ['a', 'b'])];
  assert.equal(renderFlowProse(s), '#1 legal and #2 design, then #3 signoff.');
});

test('three-parallel merge → "#1 a, #2 b, and #3 c, then #4 d"', () => {
  const s = [mk('a', 'a'), mk('b', 'b'), mk('c', 'c'), mk('d', 'd', ['a', 'b', 'c'])];
  assert.equal(renderFlowProse(s), '#1 a, #2 b, and #3 c, then #4 d.');
});

test('mixed: independent root joins lower level', () => {
  const s = [mk('a', 'first'), mk('b', 'second'), mk('c', 'merge', ['a', 'b']), mk('d', 'orphan')];
  assert.equal(renderFlowProse(s), '#1 first, #2 second, and #4 orphan, then #3 merge.');
});

test('missing name → falls back to "#N" alone', () => {
  const s = [mk('a', ''), mk('b', 'named', ['a'])];
  assert.equal(renderFlowProse(s), '#1, then #2 named.');
});
