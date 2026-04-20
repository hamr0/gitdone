'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateWorkflowEvent,
  validateEmail,
  validateTitle,
  validateTrustLevel,
  validateDeadline,
  slugifyStepId,
  parseDependsOn,
  detectDependencyCycles,
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

test('parseDependsOn: empty / whitespace → []', () => {
  assert.deepEqual(parseDependsOn('', 3, 2), { ok: true, value: [] });
  assert.deepEqual(parseDependsOn('   ', 3, 2), { ok: true, value: [] });
  assert.deepEqual(parseDependsOn(null, 3, 2), { ok: true, value: [] });
});

test('parseDependsOn: comma-separated step numbers → 0-based indices', () => {
  assert.deepEqual(parseDependsOn('1, 2', 4, 3), { ok: true, value: [0, 1] });
  assert.deepEqual(parseDependsOn('3', 4, 0), { ok: true, value: [2] });
});

test('parseDependsOn: dedupes silently', () => {
  assert.deepEqual(parseDependsOn('1,1,2', 4, 3), { ok: true, value: [0, 1] });
});

test('parseDependsOn: rejects self-reference, out-of-range, non-numeric', () => {
  const self = parseDependsOn('3', 3, 2);
  assert.equal(self.ok, false);
  assert.match(self.reason, /itself/);

  const oor = parseDependsOn('5', 3, 0);
  assert.equal(oor.ok, false);
  assert.match(oor.reason, /out of range/);

  const nan = parseDependsOn('foo, 2', 3, 0);
  assert.equal(nan.ok, false);
  assert.match(nan.reason, /"foo"/);
});

test('detectDependencyCycles: self-loop by chain', () => {
  // step 1 depends on 2, step 2 depends on 1 (indices 0<->1)
  const steps = [
    { id: 'a', depends_on_indices: [1] },
    { id: 'b', depends_on_indices: [0] },
  ];
  assert.match(detectDependencyCycles(steps), /cycle/);
});

test('detectDependencyCycles: longer cycle', () => {
  const steps = [
    { id: 'a', depends_on_indices: [1] },
    { id: 'b', depends_on_indices: [2] },
    { id: 'c', depends_on_indices: [0] },
  ];
  assert.match(detectDependencyCycles(steps), /cycle/);
});

test('detectDependencyCycles: DAG returns null', () => {
  const steps = [
    { id: 'a', depends_on_indices: [] },
    { id: 'b', depends_on_indices: [0] },
    { id: 'c', depends_on_indices: [0, 1] },
  ];
  assert.equal(detectDependencyCycles(steps), null);
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

test('validateWorkflowEvent: happy path two steps, second depends on first', () => {
  const form = {
    title: 'Q2 Contract',
    initiator: 'ceo@example.com',
    min_trust_level: 'verified',
    step_name: ['Legal review', 'CEO approval'],
    step_participant: ['legal@example.com', 'ceo@example.com'],
    step_deadline: ['2026-04-30', ''],
    step_requires_attachment: ['on', ''],
    step_depends_on: ['', '1'],
  };
  const r = validateWorkflowEvent(form);
  assert.equal(r.ok, true);
  assert.equal(r.value.title, 'Q2 Contract');
  assert.equal(r.value.min_trust_level, 'verified');
  assert.equal(r.value.steps.length, 2);
  assert.equal(r.value.steps[0].id, 'legal-review');
  assert.deepEqual(r.value.steps[0].depends_on, []);
  assert.deepEqual(r.value.steps[1].depends_on, ['legal-review']);
  assert.equal(r.value.steps[0].requires_attachment, true);
  assert.match(r.value.steps[0].deadline, /^2026-04-30/);
});

test('validateWorkflowEvent: single-step form (not array) still works', () => {
  const form = {
    title: 'x', initiator: 'a@b.com',
    step_name: 'Only step', step_participant: 'p@q.com', step_deadline: '',
  };
  const r = validateWorkflowEvent(form);
  assert.equal(r.ok, true);
  assert.equal(r.value.steps.length, 1);
  assert.deepEqual(r.value.steps[0].depends_on, []);
});

test('validateWorkflowEvent: collects multiple errors', () => {
  const r = validateWorkflowEvent({
    title: '',
    initiator: 'bogus',
    step_name: [],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 3);
  assert.ok(r.errors.some((e) => /title/.test(e)));
  assert.ok(r.errors.some((e) => /initiator/.test(e)));
  assert.ok(r.errors.some((e) => /step is required/.test(e)));
});

test('validateWorkflowEvent: rejects deadline before dependency deadline', () => {
  const r = validateWorkflowEvent({
    title: 'x', initiator: 'a@b.com',
    step_name: ['draft', 'review'],
    step_participant: ['a@x.com', 'b@x.com'],
    step_deadline: ['2026-05-10', '2026-05-01'],
    step_depends_on: ['', '1'],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /step 2 deadline.*before step 1/.test(e)));
});

test('validateWorkflowEvent: accepts equal deadlines on dep and dependent', () => {
  const r = validateWorkflowEvent({
    title: 'x', initiator: 'a@b.com',
    step_name: ['draft', 'review'],
    step_participant: ['a@x.com', 'b@x.com'],
    step_deadline: ['2026-05-10', '2026-05-10'],
    step_depends_on: ['', '1'],
  });
  assert.equal(r.ok, true);
});

test('validateWorkflowEvent: skips deadline ordering when dependent has no deadline', () => {
  const r = validateWorkflowEvent({
    title: 'x', initiator: 'a@b.com',
    step_name: ['draft', 'review'],
    step_participant: ['a@x.com', 'b@x.com'],
    step_deadline: ['2026-05-10', ''],
    step_depends_on: ['', '1'],
  });
  assert.equal(r.ok, true);
});

test('validateWorkflowEvent: accepts and preserves step details', () => {
  const det = 'Please review section 3.2 of the contract.\nFocus on indemnification.\nReply with signed PDF.';
  const r = validateWorkflowEvent({
    title: 'x', initiator: 'a@b.com',
    step_name: ['review'],
    step_participant: ['legal@x.com'],
    step_details: [det],
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.steps[0].details, det);
});

test('validateWorkflowEvent: empty details is stored as null (not empty string)', () => {
  const r = validateWorkflowEvent({
    title: 'x', initiator: 'a@b.com',
    step_name: ['s'],
    step_participant: ['a@x.com'],
    step_details: [''],
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.steps[0].details, null);
});

test('validateWorkflowEvent: rejects details over 4096 chars', () => {
  const r = validateWorkflowEvent({
    title: 'x', initiator: 'a@b.com',
    step_name: ['s'],
    step_participant: ['a@x.com'],
    step_details: ['a'.repeat(4097)],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /details.*too long/i.test(e)));
});

test('validateWorkflowEvent: rejects circular dependency', () => {
  // step 1 depends on 2, step 2 depends on 1
  const r = validateWorkflowEvent({
    title: 'x', initiator: 'a@b.com',
    step_name: ['A', 'B'],
    step_participant: ['a@x.com', 'b@x.com'],
    step_depends_on: ['2', '1'],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /cycle/.test(e)));
});

test('validateWorkflowEvent: rejects dependency on nonexistent step', () => {
  const r = validateWorkflowEvent({
    title: 'x', initiator: 'a@b.com',
    step_name: ['only'],
    step_participant: ['a@x.com'],
    step_depends_on: ['5'],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /out of range/.test(e)));
});

test('validateWorkflowEvent: dedupes step ids with numeric suffix', () => {
  const form = {
    title: 'x', initiator: 'a@b.com',
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
    title: 'x', initiator: 'a@b.com',
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
    title: 'x', initiator: 'a@b.com',
    step_name: 's', step_participant: 'p@q.com',
  };
  const r = validateWorkflowEvent(form);
  assert.equal(r.value.min_trust_level, 'verified');
});

test('validateWorkflowEvent: too many steps rejected', () => {
  const names = Array.from({ length: 51 }, (_, i) => `step ${i}`);
  const participants = names.map(() => 'p@q.com');
  const r = validateWorkflowEvent({
    title: 'x', initiator: 'a@b.com',
    step_name: names, step_participant: participants, step_deadline: [],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /too many/.test(e)));
});
