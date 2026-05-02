'use strict';

// Custom mailer adapter for knowless, backed by gitdone's sendmail path.
// Satisfies all five obligations of the custom-mailer contract:
//   1. Sham-recipient handling via dropShamRecipient.
//   2. Timing equivalence: both real and sham paths spawn the sendmail
//      subprocess so subprocess-creation cost is equivalent; only the
//      I/O write (a few hundred bytes) differs, which is sub-millisecond.
//   3. RFC822 fidelity: raw message built and piped byte-for-byte.
//   4. verify(): probes binary existence + execute permission at startup.
//   5. close(): no persistent resources; no-op.

const { spawn } = require('node:child_process');
const { access, constants } = require('node:fs/promises');
const { newMessageId } = require('./outbound');

function sendmailBin() {
  return process.env.GITDONE_SENDMAIL_BIN || '/usr/sbin/sendmail';
}

function buildAuthRaw({ from, fromHeader, to, subject, body, messageId, domain }) {
  const id = messageId || newMessageId(domain);
  const date = new Date().toUTCString();
  const headers = [
    `From: ${fromHeader}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-Id: ${id}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
  ].join('\r\n');
  // knowless guarantees the body is ASCII; CRLF-normalise for RFC 822.
  const normalizedBody = body.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  return { raw: `${headers}\r\n\r\n${normalizedBody}`, messageId: id };
}

function spawnSendmail(from, rawMessage) {
  // -i: don't treat lone "." as end-of-input
  // -f: envelope MAIL FROM
  // -t: read recipients from headers (To:)
  const args = ['-i', '-f', from, '-t'];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(sendmailBin(), args, { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (err) {
      return resolve({ ok: false, reason: err.message || String(err) });
    }
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.on('error', () => {});
    child.on('error', (err) => resolve({ ok: false, reason: err.message || String(err) }));
    child.on('exit', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, code, stderr: stderr.trim() || null });
    });
    if (rawMessage) {
      child.stdin.end(rawMessage);
    } else {
      child.stdin.end();
    }
  });
}

function createAuthMailer({ from, fromName, domain, dropShamRecipient }) {
  if (typeof from !== 'string' || !from.includes('@')) {
    throw new Error('createAuthMailer: from must be a valid email address');
  }
  if (typeof dropShamRecipient !== 'function') {
    throw new Error('createAuthMailer: dropShamRecipient is required');
  }
  const fromHeader = fromName ? `${fromName} <${from}>` : from;
  const resolvedDomain = domain || from.split('@').pop();

  return {
    async submit({ to, subject, body }) {
      const isSham = dropShamRecipient({ to });

      if (isSham) {
        // Timing equalization: spawn sendmail subprocess with no content so
        // subprocess-creation cost equals the real path. Exit code ignored.
        await spawnSendmail(from, null);
        return { messageId: null };
      }

      const { raw, messageId } = buildAuthRaw({ from, fromHeader, to, subject, body, domain: resolvedDomain });
      const result = await spawnSendmail(from, raw);
      if (!result.ok) {
        // Never swallow silently — let handlers.js catch and log.
        throw new Error(`sendmail failed: ${result.stderr || result.reason || `exit ${result.code}`}`);
      }
      return { messageId };
    },

    async verify() {
      await access(sendmailBin(), constants.X_OK);
      return true;
    },

    close() {},
  };
}

module.exports = { createAuthMailer, buildAuthRaw, spawnSendmail };
