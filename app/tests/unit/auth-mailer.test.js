'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createAuthMailer, buildAuthRaw } = require('../../src/auth-mailer');

// Stub dropShamRecipient for tests: returns true only for the sham address.
const SHAM = 'null@knowless.invalid';
const dropShamRecipient = ({ to }) => to === SHAM;

test('buildAuthRaw: produces 7bit headers, CRLF, and URL-safe body', () => {
  const { raw, messageId } = buildAuthRaw({
    from: 'noreply@git-done.com',
    fromHeader: 'GitDone <noreply@git-done.com>',
    to: 'user@example.com',
    subject: 'Sign in to GitDone',
    body: 'Click to sign in:\n\nhttps://git-done.com/manage/callback?t=abc\n',
    domain: 'git-done.com',
  });
  assert.ok(raw.includes('From: GitDone <noreply@git-done.com>'), 'From header present');
  assert.ok(raw.includes('To: user@example.com'), 'To header present');
  assert.ok(raw.includes('Subject: Sign in to GitDone'), 'Subject header present');
  assert.ok(raw.includes('Content-Transfer-Encoding: 7bit'), '7bit encoding');
  assert.ok(raw.includes('\r\n\r\n'), 'header/body separator');
  // URL must appear verbatim (no quoted-printable soft-breaks)
  assert.ok(raw.includes('https://git-done.com/manage/callback?t=abc'), 'URL intact');
  assert.match(messageId, /^<.+@git-done\.com>$/, 'messageId shape');
});

test('buildAuthRaw: LF-only body is CRLF-normalised', () => {
  const { raw } = buildAuthRaw({
    from: 'noreply@example.com',
    fromHeader: 'noreply@example.com',
    to: 'u@x.com',
    subject: 'S',
    body: 'line1\nline2\n',
    domain: 'example.com',
  });
  // After the blank separator, CRLF
  const bodyPart = raw.split('\r\n\r\n')[1];
  assert.ok(bodyPart.includes('line1\r\nline2'), 'LF → CRLF in body');
});

test('submit: sham recipient spawns dummy subprocess and returns messageId:null', async () => {
  const mailer = createAuthMailer({
    from: 'noreply@git-done.com',
    fromName: 'GitDone',
    domain: 'git-done.com',
    dropShamRecipient,
  });

  // Point sendmail at /bin/true so the dummy spawn exits cleanly.
  process.env.GITDONE_SENDMAIL_BIN = '/bin/true';
  const result = await mailer.submit({
    to: SHAM,
    subject: 'Sign in to GitDone',
    body: 'Click:\n\nhttps://git-done.com/manage/callback?t=abc\n',
  });
  delete process.env.GITDONE_SENDMAIL_BIN;

  assert.equal(result.messageId, null, 'sham path returns null messageId');
});

test('submit: real recipient sends via sendmail binary and returns messageId', async () => {
  const mailer = createAuthMailer({
    from: 'noreply@git-done.com',
    fromName: 'GitDone',
    domain: 'git-done.com',
    dropShamRecipient,
  });

  process.env.GITDONE_SENDMAIL_BIN = '/bin/true';
  const result = await mailer.submit({
    to: 'user@example.com',
    subject: 'Sign in to GitDone',
    body: 'Click:\n\nhttps://git-done.com/manage/callback?t=abc\n',
  });
  delete process.env.GITDONE_SENDMAIL_BIN;

  assert.match(result.messageId, /^<.+@git-done\.com>$/, 'real path returns valid messageId');
});

test('submit: real recipient throws when sendmail exits non-zero', async () => {
  const mailer = createAuthMailer({
    from: 'noreply@git-done.com',
    fromName: 'GitDone',
    domain: 'git-done.com',
    dropShamRecipient,
  });

  process.env.GITDONE_SENDMAIL_BIN = '/bin/false';
  await assert.rejects(
    () => mailer.submit({
      to: 'user@example.com',
      subject: 'Sign in',
      body: 'Click:\n\nhttps://example.com/callback?t=x\n',
    }),
    /sendmail failed/,
  );
  delete process.env.GITDONE_SENDMAIL_BIN;
});

test('verify: resolves true when binary is executable', async () => {
  const mailer = createAuthMailer({
    from: 'noreply@git-done.com',
    fromName: 'GitDone',
    domain: 'git-done.com',
    dropShamRecipient,
  });
  process.env.GITDONE_SENDMAIL_BIN = '/bin/true';
  const result = await mailer.verify();
  delete process.env.GITDONE_SENDMAIL_BIN;
  assert.equal(result, true);
});

test('verify: rejects when binary does not exist', async () => {
  const mailer = createAuthMailer({
    from: 'noreply@git-done.com',
    fromName: 'GitDone',
    domain: 'git-done.com',
    dropShamRecipient,
  });
  process.env.GITDONE_SENDMAIL_BIN = '/nonexistent/sendmail';
  await assert.rejects(() => mailer.verify());
  delete process.env.GITDONE_SENDMAIL_BIN;
});

test('createAuthMailer: throws if from is invalid', () => {
  assert.throws(() => createAuthMailer({
    from: 'notanemail',
    domain: 'example.com',
    dropShamRecipient,
  }), /from must be a valid email/);
});

test('createAuthMailer: throws if dropShamRecipient is missing', () => {
  assert.throws(() => createAuthMailer({
    from: 'a@b.com',
    domain: 'b.com',
  }), /dropShamRecipient is required/);
});
