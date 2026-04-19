'use strict';

// Unit tests for §6.4 initiator command handlers. Pure composers, so
// everything is synchronous except executeRemind (which calls the
// notifier — we stub that by seeding an event with no participants
// so notifier produces an empty result).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  authenticateInitiatorCommand,
  statsBody,
  workflowStatsBody,
  cryptoStatsBody,
  executeClose,
} = require('../../src/email-commands');

function mkWorkflow(o = {}) {
  return {
    id: 'ev1', type: 'event',
    min_trust_level: 'verified', initiator: 'boss@ex.com',
    title: 'Q2 sign-off',
    salt: 'a'.repeat(64),
    steps: [
      { id: 'one', name: 'one', participant: 'one@ex.com', status: 'pending', depends_on: [] },
      { id: 'two', name: 'two', participant: 'two@ex.com', status: 'pending', depends_on: ['one'] },
    ],
    ...o,
  };
}

// -- auth --

test('authenticateInitiatorCommand: trust + sender both required', () => {
  const ev = mkWorkflow();
  // wrong sender
  const a1 = authenticateInitiatorCommand(ev, { sender: 'imposter@ex.com', trustLevel: 'verified' });
  assert.equal(a1.ok, false);
  assert.match(a1.reason, /not the event initiator/);
  // low trust
  const a2 = authenticateInitiatorCommand(ev, { sender: 'boss@ex.com', trustLevel: 'unverified' });
  assert.equal(a2.ok, false);
  assert.match(a2.reason, /trust/);
  // happy path
  const a3 = authenticateInitiatorCommand(ev, { sender: 'boss@ex.com', trustLevel: 'verified' });
  assert.equal(a3.ok, true);
});

test('authenticateInitiatorCommand: case-insensitive email match', () => {
  const ev = mkWorkflow({ initiator: 'Boss@EX.com' });
  const a = authenticateInitiatorCommand(ev, { sender: 'boss@ex.com', trustLevel: 'verified' });
  assert.equal(a.ok, true);
});

test('authenticateInitiatorCommand: null event is rejected', () => {
  const a = authenticateInitiatorCommand(null, { sender: 'x@y.z', trustLevel: 'verified' });
  assert.equal(a.ok, false);
  assert.match(a.reason, /unknown event/);
});

// -- stats --

test('workflowStatsBody: lists steps with tick/cross and completion time', () => {
  const ev = mkWorkflow({
    steps: [
      { id: 'one', name: 'Legal', participant: 'l@ex.com',
        status: 'complete', completed_at: '2026-04-19T00:00:00Z' },
      { id: 'two', name: 'Design', participant: 'd@ex.com', status: 'pending' },
    ],
  });
  const body = workflowStatsBody(ev);
  assert.match(body, /Event: Q2 sign-off/);
  assert.match(body, /Status: open/);
  assert.match(body, /\[x\] Legal/);
  assert.match(body, /\[ \] Design/);
  assert.match(body, /2026-04-19T00:00:00Z/);
});

test('workflowStatsBody: complete event shows completed_at', () => {
  const ev = mkWorkflow({
    completion: { status: 'complete', completed_at: '2026-05-01T00:00:00Z' },
    steps: [{ id: 'one', name: 'x', participant: 'x@y.z', status: 'complete', completed_at: '2026-05-01T00:00:00Z' }],
  });
  const body = workflowStatsBody(ev);
  assert.match(body, /Status: complete/);
  assert.match(body, /Completed at: 2026-05-01/);
});

test('cryptoStatsBody declaration: names signer', () => {
  const body = cryptoStatsBody({
    id: 'evd', type: 'crypto', mode: 'declaration',
    title: 'Witness statement', signer: 'w@ex.com',
    min_trust_level: 'verified',
  });
  assert.match(body, /Type: declaration/);
  assert.match(body, /Signer: w@ex\.com/);
});

test('cryptoStatsBody attestation: threshold + dedup + reply count', () => {
  const body = cryptoStatsBody({
    id: 'eva', type: 'crypto', mode: 'attestation',
    title: 'Vouchers', threshold: 10, dedup: 'unique', allow_anonymous: true,
    min_trust_level: 'verified',
    replies: [{ sender_hash: 'a' }, { sender_hash: 'b' }, { sender_hash: 'a' }],
  });
  assert.match(body, /Type: attestation/);
  assert.match(body, /Threshold: 10/);
  assert.match(body, /Dedup: unique/);
  assert.match(body, /Anonymous: allowed/);
  assert.match(body, /Replies received: 3/);
});

test('statsBody: dispatches based on event.type', () => {
  const wf = mkWorkflow();
  const cr = { id: 'x', type: 'crypto', mode: 'declaration', title: 't', signer: 's@x.x', min_trust_level: 'verified' };
  assert.match(statsBody(wf), /ID: ev1/);
  assert.match(statsBody(cr), /Type: declaration/);
});

// -- close --

test('executeClose: flips state to complete with closed_by=initiator', () => {
  const ev = mkWorkflow();
  const r = executeClose(ev, { receivedAt: '2026-05-01T00:00:00Z' });
  assert.equal(r.wasAlreadyComplete, false);
  assert.equal(r.newEvent.completion.status, 'complete');
  assert.equal(r.newEvent.completion.closed_by, 'initiator');
  assert.equal(r.newEvent.completion.reason, 'close-command');
  assert.equal(r.newEvent.completion.completed_at, '2026-05-01T00:00:00Z');
  assert.match(r.body, /closed by initiator/);
});

test('executeClose: already-complete event is a no-op with explanatory body', () => {
  const ev = mkWorkflow({
    completion: { status: 'complete', completed_at: '2026-04-19T00:00:00Z' },
  });
  const r = executeClose(ev, { receivedAt: '2026-05-01T00:00:00Z' });
  assert.equal(r.wasAlreadyComplete, true);
  assert.equal(r.newEvent, ev);
  assert.match(r.body, /already complete/);
});
