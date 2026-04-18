'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateWorkflowEvent,
  validateEmail,
  validateTitle,
  validateTrustLevel,
  validateFlow,
  validateDeadline,
  slugifyStepId,
} = require('../../src/web/validation');

// ---- small validators --------------------------------------------------

test('validateEmail: accepts common forms, lowercases', () => {
  const r = validateEmail('  Hamr@Example.Com  ');
  assert.equal(r.ok, true);
  assert.equal(r.value, 'hamr@example.com');
});

test('validateEmail: rejects empty, malformed', () => {
  assert.equal(validateEmail('').ok, false);
  assert.equal(validateEmail('no-at').ok, false);
  assert.equal(validateEmail('a@b').ok, false); // needs a dot
  assert.equal(validateEmail('a@b.').ok, false);
  assert.equal(validateEmail(null).ok, false);
});

test('validateEmail: rejects overly long', () => {
  const long = 'a'.repeat(250) + '@b.com';
  const r = validateEmail(long);
  assert.equal(r.ok, false);
  assert.match(r.reason, /too long/);
});

test('validateTitle: requires and caps', () => {
  assert.equal(validateTitle('').ok, false);
  assert.equal(validateTitle('a'.repeat(201)).ok, false);
  const r = validateTitle('Q2 Approvals');
  assert.equal(r.ok, true);
  assert.equal(r.value, 'Q2 Approvals');
});

test('validateTrustLevel: accepts all four and defaults', () => {
  for (const lvl of ['unverified', 'authorized', 'forwarded', 'verified']) {
    const r = validateTrustLevel(lvl);
    assert.equal(r.ok, true);
    assert.equal(r.value, lvl);
  }
  const def = validateTrustLevel('', 'verified');
  assert.equal(def.value, 'verified');
});

test('validateTrustLevel: rejects unknown', () => {
  assert.equal(validateTrustLevel('super-verified').ok, false);
  assert.equal(validateTrustLevel('paranoid').ok, false);
});

test('validateFlow: accepts three canonical values', () => {
  for (const f of ['sequential', 'non-sequential', 'hybrid']) {
    assert.equal(validateFlow(f).value, f);
  }
  assert.equal(validateFlow('parallel').ok, false);
});

test('validateDeadline: optional (empty ok), YYYY-MM-DD accepted', () => {
  assert.equal(validateDeadline('').value, null);
  assert.equal(validateDeadline(null).value, null);
  const r = validateDeadline('2026-12-31');
  assert.equal(r.ok, true);
  assert.match(r.value, /^2026-12-31T00:00:00\.000Z$/);
});

test('validateDeadline: ISO 8601 with time', () => {
  const r = validateDeadline('2026-12-31T23:59:00Z');
  assert.equal(r.ok, true);
  assert.match(r.value, /^2026-12-31T23:59:00\.000Z$/);
});

test('validateDeadline: rejects gibberish', () => {
  assert.equal(validateDeadline('next tuesday').ok, false);
  assert.equal(validateDeadline('2026-13-01').ok, false); // month 13
});

test('slugifyStepId: basic', () => {
  assert.equal(slugifyStepId('Legal review', 0), 'legal-review');
});

test('slugifyStepId: trims non-alphanumerics, caps length', () => {
  assert.equal(slugifyStepId('  !!! sign off @ 5pm !!!  ', 2), 'sign-off-5pm');
  assert.equal(slugifyStepId('x'.repeat(100), 0).length, 40);
});

test('slugifyStepId: empty name falls back to step-N', () => {
  assert.equal(slugifyStepId('', 3), 'step-4');
  assert.equal(slugifyStepId('   ', 0), 'step-1');
});

// ---- validateWorkflowEvent end-to-end ----------------------------------

test('validateWorkflowEvent: happy path two steps sequential', () => {
  const form = {
    title: 'Q2 Contract',
    initiator: 'ceo@example.com',
    flow: 'sequential',
    min_trust_level: 'verified',
    step_name: ['Legal review', 'CEO approval'],
    step_participant: ['legal@example.com', 'ceo@example.com'],
    step_deadline: ['2026-04-30', ''],
    step_requires_attachment: ['on', ''],
  };
  const r = validateWorkflowEvent(form);
  assert.equal(r.ok, true);
  assert.equal(r.value.title, 'Q2 Contract');
  assert.equal(r.value.flow, 'sequential');
  assert.equal(r.value.min_trust_level, 'verified');
  assert.equal(r.value.steps.length, 2);
  assert.equal(r.value.steps[0].id, 'legal-review');
  assert.equal(r.value.steps[0].participant, 'legal@example.com');
  assert.equal(r.value.steps[0].requires_attachment, true);
  assert.match(r.value.steps[0].deadline, /^2026-04-30/);
  assert.equal(r.value.steps[1].requires_attachment, false);
  assert.equal(r.value.steps[1].deadline, null);
});

test('validateWorkflowEvent: single-step form (not array) still works', () => {
  const form = {
    title: 'x', initiator: 'a@b.com', flow: 'non-sequential',
    step_name: 'Only step', step_participant: 'p@q.com', step_deadline: '',
  };
  const r = validateWorkflowEvent(form);
  assert.equal(r.ok, true);
  assert.equal(r.value.steps.length, 1);
});

test('validateWorkflowEvent: collects multiple errors', () => {
  const r = validateWorkflowEvent({
    title: '',
    initiator: 'bogus',
    flow: 'parallel',
    step_name: [],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 4);
  assert.ok(r.errors.some((e) => /title/.test(e)));
  assert.ok(r.errors.some((e) => /initiator/.test(e)));
  assert.ok(r.errors.some((e) => /flow/.test(e)));
  assert.ok(r.errors.some((e) => /step is required/.test(e)));
});

test('validateWorkflowEvent: dedupes step ids with numeric suffix', () => {
  const form = {
    title: 'x', initiator: 'a@b.com', flow: 'sequential',
    step_name: ['Review', 'Review'],
    step_participant: ['a@b.com', 'c@d.com'],
    step_deadline: ['', ''],
  };
  const r = validateWorkflowEvent(form);
  assert.equal(r.ok, true);
  assert.equal(r.value.steps[0].id, 'review');
  assert.equal(r.value.steps[1].id, 'review-2');
});

test('validateWorkflowEvent: per-step error cites step number', () => {
  const form = {
    title: 'x', initiator: 'a@b.com', flow: 'sequential',
    step_name: ['ok', 'also ok'],
    step_participant: ['a@b.com', 'not-an-email'],
    step_deadline: ['', ''],
  };
  const r = validateWorkflowEvent(form);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /step 2 participant/.test(e)));
});

test('validateWorkflowEvent: defaults min_trust_level to verified', () => {
  const form = {
    title: 'x', initiator: 'a@b.com', flow: 'sequential',
    step_name: 's', step_participant: 'p@q.com',
  };
  const r = validateWorkflowEvent(form);
  assert.equal(r.value.min_trust_level, 'verified');
});

test('validateWorkflowEvent: too many steps rejected', () => {
  const names = Array.from({ length: 51 }, (_, i) => `step ${i}`);
  const participants = names.map(() => 'p@q.com');
  const r = validateWorkflowEvent({
    title: 'x', initiator: 'a@b.com', flow: 'sequential',
    step_name: names, step_participant: participants, step_deadline: [],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /too many/.test(e)));
});
