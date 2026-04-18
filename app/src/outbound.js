// 1.L.1 send path — submit outbound mail to the local MTA via sendmail(8).
//
// Why sendmail(8) rather than an SMTP client library:
//   - Postfix ships a drop-in sendmail binary at /usr/sbin/sendmail that
//     takes raw RFC-822 on stdin and injects into the queue.
//   - opendkim is wired as a non_smtpd milter, so locally-submitted mail
//     gets signed automatically without any Node-side crypto.
//   - Zero external deps (stdlib child_process is enough).
//   - No SMTP AUTH / TLS / retry logic to maintain — Postfix owns that.
//
// The caller is responsible for building a valid RFC-822 message
// (CRLF line endings, headers separated from body by an empty line).
// buildRawMessage below is the canonical builder.

'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

const SENDMAIL_BIN = process.env.GITDONE_SENDMAIL_BIN || '/usr/sbin/sendmail';

function randomToken() {
  return crypto.randomBytes(8).toString('hex');
}

// Generate an RFC 5322-conformant Message-Id in the form
// <timestamp.random@domain>. Uniqueness within a single second on a
// single host is provided by the 16-hex-char suffix (2^64 keyspace).
function newMessageId(domain) {
  return `<${Date.now()}.${randomToken()}@${domain}>`;
}

// Format a UTC date as an RFC 5322 date-time string
// (e.g. "Fri, 17 Apr 2026 20:07:18 GMT"). Node's toUTCString() happens
// to be this format, but we wrap it for clarity and to make the
// dependency explicit.
function rfc5322Date(d = new Date()) {
  return d.toUTCString();
}

// Build a raw RFC-822 message from structured fields. Only text/plain
// bodies are supported at this stage — verify reports, notifications,
// and receipts are all plaintext in Phase 1 (§0.1.4 — "invisible beats
// correct"; no HTML to render or sanitise).
//
// Headers passed here are emitted verbatim. The caller should not
// pre-encode subjects with RFC 2047 unless they contain non-ASCII;
// for ASCII subjects pass them as-is.
function buildRawMessage({ from, to, subject, body, inReplyTo, references, autoSubmitted, messageId, extraHeaders, domain }) {
  if (!from || !to || !subject || body == null) {
    throw new Error('buildRawMessage: from, to, subject, body are required');
  }
  const lines = [];
  lines.push(`From: ${from}`);
  lines.push(`To: ${to}`);
  lines.push(`Subject: ${subject}`);
  lines.push(`Message-Id: ${messageId || newMessageId(domain || 'git-done.com')}`);
  lines.push(`Date: ${rfc5322Date()}`);
  if (autoSubmitted !== false) {
    // RFC 3834: auto-replied is the right value for a response to a
    // specific human message; auto-generated for pure notifications.
    lines.push(`Auto-Submitted: ${autoSubmitted || 'auto-replied'}`);
  }
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset=utf-8');
  lines.push('Content-Transfer-Encoding: 8bit');
  if (extraHeaders) {
    for (const [name, value] of Object.entries(extraHeaders)) {
      lines.push(`${name}: ${value}`);
    }
  }
  lines.push(''); // header/body separator
  lines.push(body);
  // RFC-822 requires CRLF line endings.
  return lines.join('\r\n');
}

// Submit rawMessage to the local MTA. Returns { ok, code?, stderr? }.
// Never throws under normal operation — failure is reported via the
// resolved object so the caller can log + continue.
//
// Two addressing modes:
//   - default: sendmail -t reads recipients from To/Cc/Bcc headers
//     (used by the verify-report reply path in 1.L.1)
//   - positional: pass `to: [addr, ...]` to override the envelope
//     and ignore header recipients (used by 1.G forward-to-owner,
//     where the original email's To: is the event+ address, not
//     the initiator)
function sendmail({ from, rawMessage, binary = SENDMAIL_BIN, to }) {
  if (!rawMessage) {
    return Promise.resolve({ ok: false, reason: 'empty message' });
  }
  // -i: do NOT treat a line with a single "." as end-of-input
  //     (message bodies and forwarded emails may contain one)
  // -f: envelope MAIL FROM
  // If `to` given, pass positional recipients; otherwise use -t and
  // let Postfix parse To/Cc/Bcc out of headers.
  const args = ['-i'];
  if (from) args.push('-f', from);
  if (to && to.length) {
    args.push('--', ...to);
  } else {
    args.push('-t');
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ ok: false, reason: err.message || String(err) });
    }
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => resolve({ ok: false, reason: err.message || String(err) }));
    // If the child exits before consuming stdin (e.g. it failed at startup),
    // writing to stdin raises EPIPE. Swallow it — the exit-code handler is
    // the authoritative signal for success/failure.
    child.stdin.on('error', () => {});
    child.on('exit', (code) => {
      if (code === 0) return resolve({ ok: true });
      resolve({ ok: false, code, stderr: stderr.trim() || null });
    });
    child.stdin.end(rawMessage);
  });
}

module.exports = { sendmail, buildRawMessage, newMessageId, rfc5322Date };
