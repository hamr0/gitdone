'use strict';

// Phase D unit tests — RFC 3464 DSN parsing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { simpleParser } = require('mailparser');
const {
  isDeliveryStatusReport,
  extractDsn,
  parseDeliveryStatusBody,
  parseFieldGroup,
  stripAddressType,
} = require('../../src/dsn');

const POSTFIX_DSN = [
  'From: MAILER-DAEMON@mta.example.com (Mail Delivery System)',
  'To: gitdone@git-done.com',
  'Subject: Undelivered Mail Returned to Sender',
  'Date: Sun, 03 May 2026 10:00:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: multipart/report; report-type=delivery-status; boundary="ZZZ"',
  '',
  '--ZZZ',
  'Content-Type: text/plain; charset=us-ascii',
  '',
  'This is the mail system at host mta.example.com.',
  '',
  'I\'m sorry to have to inform you that your message could not',
  'be delivered to one or more recipients.',
  '',
  '--ZZZ',
  'Content-Type: message/delivery-status',
  '',
  'Reporting-MTA: dns; mta.example.com',
  'X-Postfix-Queue-ID: ABC123',
  'Arrival-Date: Sun, 3 May 2026 10:00:00 +0000',
  '',
  'Original-Recipient: rfc822;event+abc123-step1@git-done.com',
  'Final-Recipient: rfc822; nobody@external.example',
  'Action: failed',
  'Status: 5.1.1',
  'Diagnostic-Code: smtp; 550 5.1.1 <nobody@external.example>: user unknown',
  '',
  '--ZZZ',
  'Content-Type: message/rfc822-headers',
  '',
  'From: gitdone@git-done.com',
  'To: nobody@external.example',
  'Subject: hello',
  '',
  '--ZZZ--',
  '',
].join('\r\n');

test('stripAddressType: strips rfc822; / smtp; prefix', () => {
  assert.equal(stripAddressType('rfc822;event+abc-step@x'), 'event+abc-step@x');
  assert.equal(stripAddressType('rfc822; spaced@x'), 'spaced@x');
  assert.equal(stripAddressType('smtp; 550 boom'), '550 boom');
  assert.equal(stripAddressType(''), null);
  assert.equal(stripAddressType('no-prefix@x'), 'no-prefix@x');
});

test('parseFieldGroup: handles folded continuations and blank-line termination', () => {
  const f = parseFieldGroup([
    'Original-Recipient: rfc822;a@x',
    'Diagnostic-Code: smtp; 550 5.1.1',
    ' user unknown',
    'Action: failed',
  ].join('\n'));
  assert.equal(f['original-recipient'], 'rfc822;a@x');
  assert.equal(f['diagnostic-code'], 'smtp; 550 5.1.1 user unknown');
  assert.equal(f['action'], 'failed');
});

test('parseDeliveryStatusBody: separates per-message and per-recipient groups', () => {
  const body = [
    'Reporting-MTA: dns; mta.example.com',
    '',
    'Original-Recipient: rfc822;event+abc-step1@git-done.com',
    'Final-Recipient: rfc822;nobody@external.example',
    'Action: failed',
    'Status: 5.1.1',
    'Diagnostic-Code: smtp; 550 user unknown',
    '',
    'Original-Recipient: rfc822;event+abc-step2@git-done.com',
    'Action: failed',
    'Status: 5.2.2',
    '',
  ].join('\n');
  const r = parseDeliveryStatusBody(body);
  assert.equal(r.reporting['reporting-mta'], 'dns; mta.example.com');
  assert.equal(r.recipients.length, 2);
  assert.equal(r.recipients[0].originalRecipient, 'event+abc-step1@git-done.com');
  assert.equal(r.recipients[0].action, 'failed');
  assert.equal(r.recipients[0].status, '5.1.1');
  assert.match(r.recipients[0].diagnostic, /user unknown/);
  assert.equal(r.recipients[1].originalRecipient, 'event+abc-step2@git-done.com');
  assert.equal(r.recipients[1].status, '5.2.2');
  assert.equal(r.recipients[1].diagnostic, null);
});

test('isDeliveryStatusReport: matches multipart/report; report-type=delivery-status', async () => {
  const parsed = await simpleParser(POSTFIX_DSN);
  assert.equal(isDeliveryStatusReport(parsed), true);
});

test('isDeliveryStatusReport: false for plain replies', async () => {
  const parsed = await simpleParser([
    'From: a@b',
    'To: c@d',
    'Subject: hi',
    'MIME-Version: 1.0',
    'Content-Type: text/plain',
    '',
    'just a reply',
    '',
  ].join('\r\n'));
  assert.equal(isDeliveryStatusReport(parsed), false);
});

test('extractDsn: end-to-end on a Postfix-shaped DSN', async () => {
  const parsed = await simpleParser(POSTFIX_DSN);
  const dsn = extractDsn(parsed, POSTFIX_DSN);
  assert.ok(dsn, 'parsed as DSN');
  assert.equal(dsn.recipients.length, 1);
  assert.equal(dsn.recipients[0].originalRecipient, 'event+abc123-step1@git-done.com');
  assert.equal(dsn.recipients[0].finalRecipient, 'nobody@external.example');
  assert.equal(dsn.recipients[0].action, 'failed');
  assert.equal(dsn.recipients[0].status, '5.1.1');
  assert.match(dsn.recipients[0].diagnostic, /user unknown/);
});

test('extractDsn: returns null for non-DSN parsed messages', async () => {
  const raw = [
    'From: a@b',
    'To: c@d',
    'Subject: hi',
    '',
    'just a reply',
    '',
  ].join('\r\n');
  const parsed = await simpleParser(raw);
  assert.equal(extractDsn(parsed, raw), null);
});
