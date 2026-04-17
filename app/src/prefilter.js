// Humans-only pre-filter (PRD §7.4). Reject auto-responders, mailing lists,
// bulk-mail, and system senders BEFORE any cryptographic verification.
//
// Scans headers from the raw email buffer (regex on the raw byte block) so
// we don't depend on mailparser's structured-header parsing — that was the
// latent bug we caught in Phase 0.

'use strict';

function extractHeaderBlock(raw, maxBytes) {
  const limit = Math.min(raw.length, maxBytes);
  const s = raw.slice(0, limit).toString('utf8');
  const endIdx = s.search(/\r?\n\r?\n/);
  return endIdx > 0 ? s.slice(0, endIdx) : s;
}

function rawHeader(headerBlock, name) {
  const re = new RegExp('^' + name + '\\s*:\\s*(.+(?:\\r?\\n[ \\t].+)*)', 'im');
  const m = headerBlock.match(re);
  return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : null;
}

const SYSTEM_SENDER = /^(noreply|no-reply|mailer-daemon|postmaster|bounces)$/;
const BULK_PRECEDENCE = /^(bulk|list|junk)$/;

function preFilter(headerBlock, fromAddr) {
  const autoSubmitted = rawHeader(headerBlock, 'Auto-Submitted');
  if (autoSubmitted && autoSubmitted.toLowerCase() !== 'no') {
    return { rejected: true, reason: `auto-submitted: ${autoSubmitted}` };
  }

  if (rawHeader(headerBlock, 'List-Id')
      || rawHeader(headerBlock, 'List-Post')
      || rawHeader(headerBlock, 'List-Unsubscribe')) {
    return { rejected: true, reason: 'mailing list headers present' };
  }

  const prec = (rawHeader(headerBlock, 'Precedence') || '').toLowerCase();
  if (BULK_PRECEDENCE.test(prec)) {
    return { rejected: true, reason: `precedence: ${prec}` };
  }

  const addr = (fromAddr || '').toLowerCase();
  const local = addr.split('@')[0] || '';
  if (SYSTEM_SENDER.test(local)) {
    return { rejected: true, reason: `system sender: ${addr}` };
  }

  return { rejected: false, reason: null };
}

module.exports = { preFilter, extractHeaderBlock, rawHeader };
