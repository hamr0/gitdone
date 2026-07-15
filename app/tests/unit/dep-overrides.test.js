'use strict';

// Smoke test for the npm `overrides` block in app/package.json.
// We pin floor versions of fast-xml-parser, nodemailer, and undici to
// clear advisories that mailauth's transitive deps drag in. If npm
// resolves a lower version (e.g. someone removes the override before
// upstream catches up), this test fails LOUDLY.
//
// Pure version comparison — no behaviour assertions. The override is
// a security gate, not a feature. When mailauth eventually ships
// dependencies that meet or exceed these versions and the overrides
// block can be removed, this test still passes (versions only go up).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Read the package's package.json directly because some packages
// (e.g. fast-xml-parser) restrict subpath exports and disallow
// `require('<pkg>/package.json')`. Walks up from the resolved main
// entry until it finds a package.json with a matching name field.
function resolvedVersion(name) {
  const main = require.resolve(name);
  let dir = path.dirname(main);
  while (dir !== path.dirname(dir)) {
    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj)) {
      const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
      if (j.name === name) return j.version;
    }
    dir = path.dirname(dir);
  }
  throw new Error(`could not locate package.json for ${name}`);
}

// Compare two semver-ish dotted numbers. Pre-release tags are ignored
// (the floors here are stable versions). Returns true iff actual >= floor.
function gte(actual, floor) {
  const a = String(actual).split('-')[0].split('.').map(Number);
  const f = String(floor).split('-')[0].split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, f.length); i++) {
    const av = a[i] || 0;
    const fv = f[i] || 0;
    if (av !== fv) return av > fv;
  }
  return true;
}

test('npm overrides: fast-xml-parser >= 5.7.3', () => {
  const v = resolvedVersion('fast-xml-parser');
  assert.ok(gte(v, '5.7.3'),
    `fast-xml-parser ${v} < 5.7.3 — security override leaked, restore overrides in app/package.json`);
});

// Floor raised 8.0.7 -> 9.0.3: the nodemailer advisories widened to cover
// <=9.0.0, so the old floor stopped clearing them. The override is repo-global,
// so it also caps knowless (which declares ^9.0.3) — leaving it at ^8.0.7 would
// silently hold knowless's own security bump down.
test('npm overrides: nodemailer >= 9.0.3', () => {
  const v = resolvedVersion('nodemailer');
  assert.ok(gte(v, '9.0.3'),
    `nodemailer ${v} < 9.0.3 — security override leaked, restore overrides in app/package.json`);
});

// Floor raised 7.23.0 -> 7.28.0: mailauth 4.13.3 pins undici 7.25.0, which is
// still in the advisory range (<=7.27.2); 7.28.0 is the same-major patched
// release that clears it. Bumping mailauth alone doesn't reach it.
test('npm overrides: undici >= 7.28.0', () => {
  const v = resolvedVersion('undici');
  assert.ok(gte(v, '7.28.0'),
    `undici ${v} < 7.28.0 — security override leaked, restore overrides in app/package.json`);
});
