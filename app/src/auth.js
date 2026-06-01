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
const { SIGNATURE_FOOTER, senderAddress, SENDER_NAME } = require('./outbound');

const FROM_ADDR = senderAddress(config.domain);
const FROM_NAME = SENDER_NAME;

let _authPromise = null;
// Captured from knowless at bootstrap so the CommonJS call sites in
// bin/server.js can resolve the client IP synchronously (knowless is ESM).
let _determineSourceIp = null;

async function _bootstrap() {
  const { knowless, dropShamRecipient, determineSourceIp } = await import('knowless');
  _determineSourceIp = determineSourceIp;

  const secret = process.env.GITDONE_SESSION_SECRET;
  if (!secret) throw new Error('GITDONE_SESSION_SECRET is required for session auth');
  // Fail loud + early on a weak secret: session cookies and email→handle
  // HMACs are only as strong as this key. The documented contract is 64
  // hex chars (32 bytes); knowless enforces ≥64 internally, so this just
  // surfaces the error at boot with an actionable message (audit M4).
  if (!/^[0-9a-f]{64}$/i.test(secret)) {
    throw new Error('GITDONE_SESSION_SECRET must be 64 hex chars (32 bytes)');
  }

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
    subject: 'Sign in to signedreply',
    bodyFooter: SIGNATURE_FOOTER,
    confirmationMessage: 'Check your inbox. If {email} has events on signedreply, a sign-in link is on its way.',
    openRegistration: true,
    cookieSecure,
    devLogMagicLinks: process.env.GITDONE_DEV_MAGIC_LINKS === '1',
  });
}

function getAuth() {
  if (!_authPromise) _authPromise = _bootstrap();
  return _authPromise;
}

// Resolve the real client IP for per-IP login rate-limiting, honouring
// X-Forwarded-For only when the peer is a trusted reverse proxy (knowless's
// anti-spoofing resolver + gitdone's config.trustedProxies policy). Feed the
// result to startLogin({ sourceIp }); passing req.socket.remoteAddress instead
// buckets every login behind the proxy under one key and disables per-IP
// limits. Callers MUST await getAuth() first — that bootstraps the resolver.
// Safe only behind an XFF-overwriting proxy (see config.trustedProxies note).
function sourceIp(req) {
  if (!_determineSourceIp) {
    throw new Error('auth not bootstrapped; await getAuth() before sourceIp()');
  }
  return _determineSourceIp(req, config.trustedProxies);
}

function _resetAuth() {
  _authPromise = null;
  _determineSourceIp = null;
}

module.exports = { getAuth, sourceIp, _resetAuth, FROM_ADDR, FROM_NAME };
