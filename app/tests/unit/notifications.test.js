'use strict';

// 1.I unit tests — body composers produce the right content for each
// participant type. End-to-end sendmail behaviour is covered by the
// integration tests in tests/integration/web-notifications.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { workflowStepBody, declarationSignerBody } = require('../../src/notifications');

test('workflowStepBody: names the step, position, reply-to, and organiser', () => {
  const body = workflowStepBody({
    event: { id: 'abc123xyz000', title: 'Q2 sign-off', initiator: 'boss@ex.com' },
    step: { id: 'legal', name: 'Legal review', participant: 'legal@ex.com' },
    stepIndex: 1,
    totalSteps: 3,
  });
  assert.match(body, /Event: Q2 sign-off/);
  assert.match(body, /Your step: Legal review \(step 2 of 3\)/);
  assert.match(body, /Organiser: boss@ex\.com/);
  assert.match(body, /Reply from legal@ex\.com to:/);
  assert.match(body, /event\+abc123xyz000-legal@/);
  assert.doesNotMatch(body, /Required: include an attachment/);
  assert.doesNotMatch(body, /Deadline:/);
});

test('workflowStepBody: includes deadline + attachment hint when set', () => {
  const body = workflowStepBody({
    event: { id: 'e1', title: 't', initiator: 'o@x.com' },
    step: {
      id: 's', name: 'Sign', participant: 'p@x.com',
      deadline: '2026-05-01T12:00:00.000Z', requires_attachment: true,
    },
    stepIndex: 0,
    totalSteps: 1,
  });
  assert.match(body, /Deadline: 2026-05-01T12:00:00\.000Z/);
  assert.match(body, /Required: include an attachment/);
});

test('declarationSignerBody: names organiser, signer, reply-to', () => {
  const body = declarationSignerBody({
    event: {
      id: 'decl01',
      title: 'Witness statement',
      initiator: 'journo@ex.com',
      signer: 'witness@ex.com',
      mode: 'declaration',
      type: 'crypto',
    },
  });
  assert.match(body, /journo@ex\.com asked you to sign/);
  assert.match(body, /Event: Witness statement/);
  assert.match(body, /Reply from witness@ex\.com to:/);
  assert.match(body, /event\+decl01@/);
  // Declaration reply-to does NOT have a -step suffix
  assert.doesNotMatch(body, /event\+decl01-/);
});
