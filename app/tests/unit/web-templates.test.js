'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { html, raw, escapeHTML, layout, truncateText } = require('../../src/web/templates');

test('truncateText: short strings pass through unchanged', () => {
  assert.equal(truncateText('https://x.io/a', 30), 'https://x.io/a');
  assert.equal(truncateText('', 30), '');
});

test('truncateText: long URL is shortened with ellipsis', () => {
  const url = 'https://drive.google.com/file/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ123456/view';
  const out = truncateText(url, 30);
  assert.equal(out.length, 30);
  assert.ok(out.endsWith('…'));
  assert.ok(url.startsWith(out.slice(0, -1)));
});

test('truncateText: handles non-string input', () => {
  assert.equal(truncateText(null, 30), '');
  assert.equal(truncateText(undefined, 30), '');
});

test('escapeHTML: escapes all five dangerous chars', () => {
  assert.equal(escapeHTML('<>&"\''), '&lt;&gt;&amp;&quot;&#39;');
});

test('escapeHTML: null/undefined -> empty string', () => {
  assert.equal(escapeHTML(null), '');
  assert.equal(escapeHTML(undefined), '');
});

test('escapeHTML: numbers become strings', () => {
  assert.equal(escapeHTML(42), '42');
});

test('html: interpolated values are escaped by default (XSS guard)', () => {
  const name = '<script>alert(1)</script>';
  const out = html`<p>Hello ${name}</p>`;
  assert.match(out.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(out.html, /<script>/);
});

test('html: raw() opts out of escaping', () => {
  const trustedSnippet = raw('<strong>bold</strong>');
  const out = html`<p>${trustedSnippet}</p>`;
  assert.equal(out.html, '<p><strong>bold</strong></p>');
});

test('html: nested html() templates render as raw', () => {
  const inner = html`<b>x</b>`;
  const outer = html`<p>${inner}</p>`;
  assert.equal(outer.html, '<p><b>x</b></p>');
});

test('html: arrays render per-element with escaping', () => {
  const items = ['<a>', '<b>'];
  const out = html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`;
  assert.equal(out.html, '<ul><li>&lt;a&gt;</li><li>&lt;b&gt;</li></ul>');
});

test('layout: includes title (escaped) and body', () => {
  const body = html`<h1>x</h1>`;
  const page = layout({ title: 'Hello <world>', body });
  assert.match(page, /<title>Hello &lt;world&gt;<\/title>/);
  assert.match(page, /<h1>x<\/h1>/);
});

test('layout: includes viewport meta + footer home link', () => {
  const page = layout({ title: 't', body: 'x' });
  assert.match(page, /name="viewport"/);
  assert.match(page, /href="\/"/);
  assert.match(page, /href="https:\/\/github\.com\/hamr0\/gitdone"/);
});

test('layout: plain string body is escaped', () => {
  const page = layout({ title: 't', body: '<script>' });
  assert.match(page, /&lt;script&gt;/);
  assert.doesNotMatch(page, /<body>\s*<script>/);
});
