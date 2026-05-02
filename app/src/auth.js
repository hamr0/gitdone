'use strict';

// Bootstrap module for knowless-backed session auth (Surface A).
// getAuth() returns a memoised promise of the configured knowless instance.
// Call once at startup; subsequent calls return the same instance.
//
// gitdone uses knowless in two modes (per knowless GUIDE.md §"Two adoption modes"):
//   - Mode A — "do the thing, confirm by email" — POST /events / POST /crypto
//     call auth.startLogin() to mail a magic link whose nextUrl points at the
//     freshly-created event's dashboard. Clicking the link opens a session
//     and lands the initiator on /manage/event/:id, where the visit itself
//     activates the event (see GET /manage/event/:id in bin/server.js).
//   - Mode B — "sign in, then do the thing" — GET /manage hub for the
//     organiser to find their existing events.

const config = require('./config');
const { createAuthMailer } = require('./auth-mailer');

const FROM_ADDR = `noreply@${config.domain}`;
const FROM_NAME = 'GitDone';

let _authPromise = null;

async function _bootstrap() {
  const { knowless, dropShamRecipient } = await import('knowless');

  const secret = process.env.GITDONE_SESSION_SECRET;
  if (!secret) throw new Error('GITDONE_SESSION_SECRET is required for session auth');

  const baseUrl = process.env.GITDONE_PUBLIC_URL || `https://${config.domain}`;
  // Fail loudly if Secure-cookie config doesn't match the URL scheme:
  // a Secure cookie set over plain HTTP is silently dropped by browsers,
  // and a non-Secure cookie over HTTPS leaks across mixed-content contexts.
  // GITDONE_COOKIE_SECURE=0 is dev-only; refuse it for https baseUrl.
  const cookieSecure = process.env.GITDONE_COOKIE_SECURE !== '0';
  const baseProtocol = new URL(baseUrl).protocol;
  if (baseProtocol === 'https:' && !cookieSecure) {
    throw new Error('GITDONE_COOKIE_SECURE=0 is incompatible with an https GITDONE_PUBLIC_URL');
  }
  if (baseProtocol === 'http:' && cookieSecure) {
    throw new Error('GITDONE_COOKIE_SECURE must be 0 when GITDONE_PUBLIC_URL is http (cookies will be dropped otherwise)');
  }

  const mailer = createAuthMailer({
    from: FROM_ADDR,
    fromName: FROM_NAME,
    domain: config.domain,
    dropShamRecipient,
  });

  return knowless({
    secret,
    baseUrl,
    from: FROM_ADDR,
    fromName: FROM_NAME,
    dbPath: `${config.dataDir}/knowless.db`,
    mailer,
    loginPath: '/manage',
    linkPath: '/manage/callback',
    verifyPath: '/manage/verify',
    logoutPath: '/manage/logout',
    failureRedirect: '/manage',
    subject: 'Sign in to GitDone',
    confirmationMessage: 'Check your inbox. If {email} has events on GitDone, a sign-in link is on its way.',
    openRegistration: true,
    cookieSecure,
    devLogMagicLinks: process.env.GITDONE_DEV_MAGIC_LINKS === '1',
  });
}

function getAuth() {
  if (!_authPromise) _authPromise = _bootstrap();
  return _authPromise;
}

function _resetAuth() {
  _authPromise = null;
}

module.exports = { getAuth, _resetAuth, FROM_ADDR, FROM_NAME };
