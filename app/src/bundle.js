// Proof-bundle export. Streams a `.tar.gz` of an event's per-event git
// repo (data/repos/{eventId}/) so the organiser can carry the full
// audit trail off-server and verify offline with `gitdone-verify`.
//
// PRD §0.1.4 / §7.5: proofs outlive the service. Two surfaces share
// this module:
//   - the dashboard download button (GET /manage/event/:id/bundle)
//   - the email-path command (bundle+<id>@<domain>)
//
// Tar is invoked via child_process — no new deps. tar(1) is in the
// AlmaLinux 8 base. The repo dir is the inner directory inside the
// archive, e.g. `tar tzf bundle.tar.gz` → `evXYZ/event.json`,
// `evXYZ/commits/...`, `evXYZ/dkim_keys/...`, `evXYZ/ots_proofs/...`.

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const config = require('./config');
const { repoPath } = require('./gitrepo');

const TAR_BIN = process.env.GITDONE_TAR_BIN || 'tar';
const EVENT_ID_RE = /^[a-zA-Z0-9]+$/;

function bundleFilename(eventId, now = new Date()) {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `gitdone-${eventId}-${yyyy}${mm}${dd}.tar.gz`;
}

// Locate the repo on disk and confirm it actually exists (events that
// haven't received any replies — pending-activation, or activated-but-
// unanswered — have no repo dir yet, so there's nothing to bundle).
async function locateRepo(eventId) {
  if (!eventId || !EVENT_ID_RE.test(eventId)) {
    return { ok: false, reason: 'bad_event_id' };
  }
  const root = repoPath(eventId);
  // .git presence is the canonical "this event has at least one commit"
  // signal — initRepoIfNeeded only runs on the first commitReply.
  try {
    const st = await fsp.stat(path.join(root, '.git'));
    if (!st.isDirectory()) return { ok: false, reason: 'no_repo' };
  } catch {
    return { ok: false, reason: 'no_repo' };
  }
  return { ok: true, root, parent: path.dirname(root), name: path.basename(root) };
}

// Stream a tar.gz of the event repo to a writable stream. Returns
// { ok, bytes? , reason? } on close. Caller is responsible for setting
// HTTP headers before calling. On non-zero tar exit the stream is left
// truncated; the caller should treat any earlier bytes as garbage.
function streamBundle(eventId, writable, { tarBin = TAR_BIN, onError } = {}) {
  return new Promise(async (resolve) => {
    const loc = await locateRepo(eventId);
    if (!loc.ok) return resolve({ ok: false, reason: loc.reason });
    let bytes = 0;
    let child;
    try {
      child = spawn(tarBin, ['czf', '-', '-C', loc.parent, loc.name], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return resolve({ ok: false, reason: err.message || String(err) });
    }
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      writable.write(chunk);
    });
    child.on('error', (err) => {
      if (onError) onError(err);
      resolve({ ok: false, reason: err.message || String(err) });
    });
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true, bytes });
      else resolve({ ok: false, code, reason: stderr.trim() || `tar exited ${code}` });
    });
  });
}

// Same as streamBundle, but buffers the full archive into memory so it
// can be embedded as a MIME attachment (the email path needs the full
// bytes before the message can be RFC-822-built). Bundles are small —
// commits/dkim_keys/ots_proofs are tiny JSON / PEM / .ots files, no
// attachment bodies — so memory is not a concern for v1 traffic.
function bundleToBuffer(eventId, { tarBin = TAR_BIN } = {}) {
  return new Promise(async (resolve) => {
    const loc = await locateRepo(eventId);
    if (!loc.ok) return resolve({ ok: false, reason: loc.reason });
    let child;
    try {
      child = spawn(tarBin, ['czf', '-', '-C', loc.parent, loc.name], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return resolve({ ok: false, reason: err.message || String(err) });
    }
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => resolve({ ok: false, reason: err.message || String(err) }));
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true, buffer: Buffer.concat(chunks) });
      else resolve({ ok: false, code, reason: stderr.trim() || `tar exited ${code}` });
    });
  });
}

// Build a multipart/mixed RFC-822 message with a plain-text body and one
// binary attachment. We do this inline (vs. importing nodemailer or
// mimekit) because it keeps the dep budget at zero — see CLAUDE.md.
//
// Inputs:
//   from, to, subject     standard envelope/headers
//   body                  plain-text body (sanitised by caller)
//   attachment            { filename, contentType, content: Buffer }
//   inReplyTo, references for threading (optional)
//   domain, messageId     Message-Id host / explicit override
function buildAttachmentMessage({
  from, to, subject, body, attachment,
  inReplyTo, references, domain, messageId, autoSubmitted,
} = {}) {
  if (!from || !to || !subject || body == null || !attachment || !attachment.content) {
    throw new Error('buildAttachmentMessage: from, to, subject, body, attachment.content are required');
  }
  const sanitizedSubject = String(subject).replace(/[\r\n]+/g, ' ');
  const filename = String(attachment.filename || 'attachment.bin').replace(/[\r\n"\\]/g, '_');
  const contentType = String(attachment.contentType || 'application/octet-stream');
  const boundary = 'gitdone_' + crypto.randomBytes(16).toString('hex');
  const msgId = messageId || `<${Date.now()}.${crypto.randomBytes(8).toString('hex')}@${domain || 'git-done.com'}>`;
  const date = new Date().toUTCString();

  const headers = [];
  headers.push(`From: ${from}`);
  headers.push(`To: ${to}`);
  headers.push(`Subject: ${sanitizedSubject}`);
  headers.push(`Message-Id: ${msgId}`);
  headers.push(`Date: ${date}`);
  if (autoSubmitted !== false) {
    headers.push(`Auto-Submitted: ${autoSubmitted || 'auto-replied'}`);
  }
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);
  headers.push('MIME-Version: 1.0');
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  const crlfBody = String(body).replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  const attachB64 = attachment.content.toString('base64').match(/.{1,76}/g) || [];

  const parts = [];
  parts.push(`--${boundary}`);
  parts.push('Content-Type: text/plain; charset=utf-8');
  parts.push('Content-Transfer-Encoding: 8bit');
  parts.push('');
  parts.push(crlfBody);
  parts.push(`--${boundary}`);
  parts.push(`Content-Type: ${contentType}; name="${filename}"`);
  parts.push('Content-Transfer-Encoding: base64');
  parts.push(`Content-Disposition: attachment; filename="${filename}"`);
  parts.push('');
  parts.push(attachB64.join('\r\n'));
  parts.push(`--${boundary}--`);
  parts.push('');

  return headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n');
}

// ASCII-safe Content-Disposition filename — the title-bearing variants
// for email subjects elsewhere already strip CR/LF; this is the
// belt-and-braces sweep for the HTTP header that nginx forwards verbatim.
function asciiFilename(s) {
  return String(s || '').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
}

module.exports = {
  bundleFilename,
  locateRepo,
  streamBundle,
  bundleToBuffer,
  buildAttachmentMessage,
  asciiFilename,
};
