'use strict';

// 1.I unit tests — body composers produce the right content for each
// participant type. End-to-end sendmail behaviour is covered by the
// integration tests in tests/integration/web-notifications.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { workflowStepBody, declarationSignerBody, renderOrganiserStepList } = require('../../src/notifications');

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
  assert.doesNotMatch(body, /Attachment:/);
  assert.doesNotMatch(body, /Aspirational date:/);
});

test('workflowStepBody: surfaces attachment + aspirational date in metadata block', () => {
  const body = workflowStepBody({
    event: { id: 'e1', title: 't', initiator: 'o@x.com' },
    step: {
      id: 's', name: 'Sign', participant: 'p@x.com',
      deadline: '2026-05-12', requires_attachment: true,
    },
    stepIndex: 0,
    totalSteps: 1,
  });
  assert.match(body, /Attachment: required/);
  assert.match(body, /Aspirational date: Tuesday, 2026-05-12/);
  // Both fields render before the reply-to block so the participant
  // sees them above the fold.
  assert.ok(body.indexOf('Attachment: required') < body.indexOf('Reply from'));
  assert.ok(body.indexOf('Aspirational date:') < body.indexOf('Reply from'));
});

test('workflowStepBody: aspirational date accepts full ISO timestamp (legacy data)', () => {
  const body = workflowStepBody({
    event: { id: 'e1', title: 't', initiator: 'o@x.com' },
    step: {
      id: 's', name: 'Sign', participant: 'p@x.com',
      deadline: '2026-05-12T12:00:00.000Z',
    },
    stepIndex: 0,
    totalSteps: 1,
  });
  assert.match(body, /Aspirational date: Tuesday, 2026-05-12/);
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

test('renderOrganiserStepList: marks active steps with ▸ and labels deps', () => {
  const event = {
    steps: [
      { id: 'a', name: 'audio', participant: 'a@x.com', deadline: '2026-05-06', depends_on: [] },
      { id: 'v', name: 'video', participant: 'v@x.com', deadline: '2026-05-07', depends_on: ['a'] },
    ],
  };
  const out = renderOrganiserStepList(event, ['a']);
  const lines = out.split('\n');
  assert.match(lines[0], /▸ 1\. audio → a@x\.com/);
  assert.match(lines[0], /deadline 2026-05-06/);
  // Non-active step gets a leading space placeholder, no ▸.
  assert.match(lines[1], /^    2\. video/);
  assert.doesNotMatch(lines[1], /▸/);
  assert.match(lines[1], /after #1/);
});

test('renderOrganiserStepList: completed status renders as DONE', () => {
  const event = {
    steps: [
      { id: 'a', name: 'audio', participant: 'a@x.com', status: 'complete', depends_on: [] },
      { id: 'v', name: 'video', participant: 'v@x.com', depends_on: ['a'] },
    ],
  };
  const out = renderOrganiserStepList(event, ['v']);
  assert.match(out, /1\. audio.*\[DONE\]/);
  assert.match(out, /▸ 2\. video.*\[pending\]/);
});
