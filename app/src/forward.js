// 1.G — forward received mail (verbatim, with attachments) to the
// event's initiator.
//
// Privacy model (PRD §0.1.10): GitDone does NOT store attachments.
// We hash them at reception, commit the hashes to git, and hand the
// original message to the initiator's inbox. The initiator's mailbox
// is the attachment archive; GitDone keeps only verifiable metadata.
//
// Forwarding strategy: byte-preserving re-injection via sendmail(8).
// We prepend a small block of X-GitDone-* tracking headers and submit
// the original bytes unchanged. This:
//   - preserves the original DKIM-Signature (signed bodies + headers
//     like From/Subject are untouched)
//   - lets opendkim add a git-done.com signature on the way out
//     (double DKIM is normal for forwarded mail)
//   - keeps the initiator's forwarded copy exactly byte-identical to
//     what we received, so they can re-verify DKIM later if needed
//
// We override the envelope (-f + positional recipient) instead of
// rewriting To/Cc — the original To: was `event+{id}-{step}@` and
// we want it to stay that way in the forwarded headers for context.

'use strict';

const { sendmail } = require('./outbound');
const config = require('./config');

// Produce the forwarded-message bytes: X-GitDone-* headers prepended
// to the original email's header block. Because these headers appear
// before the original's first `\r\n\r\n`, they become part of the
// forwarded message's header block, not the body.
//
// Inputs:
//   rawEmail      Buffer — the original received email, byte-for-byte
//   meta          { eventId, stepId, commitFile, trustLevel, receivedAt }
function buildForwardMessage(rawEmail, meta) {
  if (!Buffer.isBuffer(rawEmail)) {
    throw new Error('buildForwardMessage: rawEmail must be a Buffer');
  }
  const headerLines = [
    `X-GitDone-Event: ${meta.eventId}`,
    `X-GitDone-Step: ${meta.stepId || ''}`,
    `X-GitDone-Commit: ${meta.commitFile || ''}`,
    `X-GitDone-Trust: ${meta.trustLevel || 'unknown'}`,
    `X-GitDone-Received-At: ${meta.receivedAt || new Date().toISOString()}`,
    `X-GitDone-Forwarded-At: ${new Date().toUTCString()}`,
  ];
  // CRLF-terminated block that will merge into the original's headers
  const prefix = Buffer.from(headerLines.join('\r\n') + '\r\n');
  return Buffer.concat([prefix, rawEmail]);
}

// Forward a received email to the event initiator. Returns the same
// shape as sendmail(): { ok, code?, stderr?, reason? }.
//
// Failure-mode policy: forwarding is best-effort. If it fails, the
// commit stays in the event's git repo — the caller should LOG but
// not reject the inbound mail on forward failure.
async function forwardToOwner({ rawEmail, initiator, eventId, stepId, commitFile, trustLevel, receivedAt }) {
  if (!initiator) {
    return { ok: false, reason: 'no initiator on event' };
  }
  if (!rawEmail || !rawEmail.length) {
    return { ok: false, reason: 'empty rawEmail' };
  }
  const envelopeFrom = `event+${eventId}@${config.domain}`;
  const message = buildForwardMessage(rawEmail, {
    eventId, stepId, commitFile, trustLevel, receivedAt,
  });
  return sendmail({
    from: envelopeFrom,
    to: [initiator],
    rawMessage: message,
  });
}

module.exports = { forwardToOwner, buildForwardMessage };
