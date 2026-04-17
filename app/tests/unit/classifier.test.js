'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classifyTrust } = require('../../src/classifier');

// Synthetic mailauth result shapes. Only fields the classifier reads are set.

const dkimPassAligned = (domain = 'example.com') => ({
  results: [{ status: { result: 'pass', aligned: domain }, signingDomain: domain }],
});
const dkimPassUnaligned = () => ({
  results: [{ status: { result: 'pass', aligned: null }, signingDomain: 'other.com' }],
});
const dkimFail = () => ({
  results: [{ status: { result: 'fail', aligned: null } }],
});
const dkimNone = () => ({ results: [] });

const arcPass = () => ({ status: { result: 'pass' }, authResults: [{}, {}] });
const arcNone = () => ({ status: { result: 'none' } });

const spfPass = () => ({ status: { result: 'pass' } });
const spfNone = () => ({ status: { result: 'none' } });

const dmarcPass = () => ({ status: { result: 'pass' } });
const dmarcFail = () => ({ status: { result: 'fail' } });
const dmarcNone = () => ({ status: { result: 'none' } });

test('verified: DKIM pass aligned + DMARC pass', () => {
  const auth = { dkim: dkimPassAligned(), dmarc: dmarcPass(), spf: spfPass(), arc: arcPass() };
  assert.equal(classifyTrust(auth), 'verified');
});

test('verified: DKIM pass aligned + DMARC pass even with SPF none', () => {
  const auth = { dkim: dkimPassAligned(), dmarc: dmarcPass(), spf: spfNone(), arc: arcNone() };
  assert.equal(classifyTrust(auth), 'verified');
});

test('forwarded: DKIM fail + ARC pass', () => {
  const auth = { dkim: dkimFail(), arc: arcPass(), spf: spfNone(), dmarc: dmarcFail() };
  assert.equal(classifyTrust(auth), 'forwarded');
});

test('forwarded: DKIM none + ARC pass', () => {
  const auth = { dkim: dkimNone(), arc: arcPass(), spf: spfNone(), dmarc: dmarcNone() };
  assert.equal(classifyTrust(auth), 'forwarded');
});

test('authorized: DKIM fail + SPF pass + DMARC pass', () => {
  const auth = { dkim: dkimFail(), arc: arcNone(), spf: spfPass(), dmarc: dmarcPass() };
  assert.equal(classifyTrust(auth), 'authorized');
});

test('unverified: DKIM none, no ARC, no SPF/DMARC pass', () => {
  const auth = { dkim: dkimNone(), arc: arcNone(), spf: spfNone(), dmarc: dmarcNone() };
  assert.equal(classifyTrust(auth), 'unverified');
});

test('unverified: DKIM pass but unaligned (does not satisfy verified)', () => {
  const auth = { dkim: dkimPassUnaligned(), arc: arcNone(), spf: spfNone(), dmarc: dmarcFail() };
  assert.equal(classifyTrust(auth), 'unverified');
});

test('unverified: DKIM pass aligned but DMARC fail (cannot be verified)', () => {
  // Pathological case: DKIM passes but DMARC didn't align — classifier requires both
  const auth = { dkim: dkimPassAligned(), arc: arcNone(), spf: spfNone(), dmarc: dmarcFail() };
  assert.equal(classifyTrust(auth), 'unverified');
});

test('unverified: empty auth object', () => {
  assert.equal(classifyTrust({}), 'unverified');
});

test('unverified: null/undefined auth', () => {
  assert.equal(classifyTrust(null), 'unverified');
  assert.equal(classifyTrust(undefined), 'unverified');
});

test('forwarded takes precedence over authorized when both qualify', () => {
  // ARC pass beats SPF+DMARC pass in our priority order
  const auth = { dkim: dkimFail(), arc: arcPass(), spf: spfPass(), dmarc: dmarcPass() };
  assert.equal(classifyTrust(auth), 'forwarded');
});
