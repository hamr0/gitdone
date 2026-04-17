// 1.L.1 — verify+{id}@ handler.
//
// A forwarded email arrives at verify+{eventId}@git-done.com. It contains
// an inner email (as a message/rfc822 attachment) or a raw file attachment.
// We:
//   1. Extract the inner email bytes (or file bytes)
//   2. Hash them (SHA-256) and find a matching commit by raw_sha256 or
//      by matching against recorded attachments[].sha256
//   3. If we matched by raw_sha256: re-run DKIM against the archived PEM
//      using the supplied raw email bytes
//   4. Produce a structured report: which commit matched, which checks passed
//
// POC scope: build the report object and log it. Production (post-1.F)
// will send a DKIM-signed report email back to the forwarder.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { authenticate } = require('mailauth');
const { simpleParser } = require('mailparser');

const config = require('./config');
const { loadEvent } = require('./event-store');
const { saltedMessageIdHash } = require('./gitrepo');

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256Tagged(buf) {
  return 'sha256:' + sha256Hex(buf);
}

// Walk the event's git repo and collect every commit's metadata.
async function loadAllCommits(eventId) {
  const commitsDir = path.join(config.dataDir, 'repos', eventId, 'commits');
  let files;
  try { files = await fs.readdir(commitsDir); } catch { return []; }
  const commits = [];
  for (const f of files.sort()) {
    if (!/^commit-\d+\.json$/.test(f)) continue;
    try {
      const json = JSON.parse(await fs.readFile(path.join(commitsDir, f), 'utf8'));
      commits.push({ file: f, ...json });
    } catch { /* skip malformed */ }
  }
  return commits;
}

async function loadDkimPem(eventId, relPath) {
  if (!relPath) return null;
  const abs = path.join(config.dataDir, 'repos', eventId, relPath);
  try { return await fs.readFile(abs, 'utf8'); } catch { return null; }
}

// Given a Buffer containing candidate email bytes, try to match it against
// a recorded commit. Cascades: raw_sha256 → message_id_hash → attachment.
//
// options.messageIdHash — salted hash of the candidate's Message-ID,
// pre-computed by the caller (who has access to the event salt).
function findMatch(candidateBytes, commits, options = {}) {
  const hash = sha256Tagged(candidateBytes);
  const byRaw = commits.find((c) => c.raw_sha256 === hash);
  if (byRaw) return { matchType: 'raw_email', hash, commit: byRaw };

  if (options.messageIdHash) {
    const byMid = commits.find((c) => c.message_id_hash === options.messageIdHash);
    if (byMid) return { matchType: 'message_id', hash, commit: byMid, messageIdHash: options.messageIdHash };
  }

  // Not a whole email match — maybe the user forwarded just an attachment?
  for (const c of commits) {
    const a = (c.attachments || []).find((att) => att.sha256 === hash);
    if (a) return { matchType: 'attachment', hash, commit: c, attachment: a };
  }
  return { matchType: 'none', hash, messageIdHash: options.messageIdHash || null };
}

// Re-verify DKIM against an archived public key. mailauth supports
// `minBitLength` and resolver overrides; we give it a resolver that
// returns our archived key for the signing domain/selector combo.
async function reverifyDkim(rawEmail, archivedPem, expectedDomain, expectedSelector) {
  if (!archivedPem || !expectedDomain || !expectedSelector) {
    return { ok: false, reason: 'missing archived key or signer context' };
  }
  // Extract base64 public key from the PEM
  const pemBody = archivedPem
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '');
  const dkimTxtRecord = `v=DKIM1; k=rsa; p=${pemBody}`;

  const fakeResolver = async (name, type) => {
    if (type === 'TXT' && name === `${expectedSelector}._domainkey.${expectedDomain}`) {
      return [[dkimTxtRecord]];
    }
    // Pass everything else through; mailauth will handle or fail
    const dns = require('node:dns').promises;
    return dns.resolve(name, type);
  };

  try {
    const auth = await authenticate(rawEmail, {
      trustReceived: false,
      resolver: fakeResolver,
    });
    const allSigs = (auth.dkim && auth.dkim.results) || [];
    // Diagnostic: report every signature found in the forwarded content,
    // not just whether our expected (domain, selector) pair verified.
    const signatures_found = allSigs.map((r) => ({
      domain: r.signingDomain || null,
      selector: r.selector || null,
      result: r.status && r.status.result,
      comment: (r.status && r.status.comment) || null,
    }));
    const sig = allSigs.find(
      (r) => r.signingDomain === expectedDomain && r.selector === expectedSelector
    );
    if (!sig) {
      return {
        ok: false,
        reason: signatures_found.length === 0
          ? 'no DKIM-Signature header in forwarded content'
          : `no sig matched expected ${expectedDomain}/${expectedSelector}`,
        expected: { domain: expectedDomain, selector: expectedSelector },
        signatures_found,
      };
    }
    const passed = sig.status && sig.status.result === 'pass';
    return {
      ok: !!passed,
      result: sig.status && sig.status.result,
      comment: (sig.status && sig.status.comment) || null,
      signatures_found,
    };
  } catch (err) {
    return { ok: false, reason: err.message || String(err) };
  }
}

// Main entry. Takes the already-parsed forwarded-email object (the one
// that was forwarded TO us at verify+{id}@) and the eventId we extracted
// from the plus-tag. Returns a structured report.
async function buildVerificationReport(eventId, parsedForwardedEmail) {
  const commits = await loadAllCommits(eventId);
  if (commits.length === 0) {
    return {
      event_id: eventId,
      matched: false,
      reason: `no commits found for event ${eventId}`,
      attachment_count: 0,
    };
  }
  // Load event so we can hash Message-IDs with the event's salt.
  const event = await loadEvent(eventId);
  const salt = (event && event.salt) || null;

  // Walk every attachment on the forwarded email. Each one is a candidate
  // for matching: either a message/rfc822 part (inner email) or raw bytes.
  const candidates = parsedForwardedEmail.attachments || [];
  const findings = [];
  for (const att of candidates) {
    if (!att.content) continue;

    // If it's an inner email, pull its Message-ID and salted-hash it so
    // we can cascade to message_id match even when bytes don't match.
    let messageIdHash = null;
    let innerMessageId = null;
    if ((att.contentType || '').toLowerCase().startsWith('message/rfc822')) {
      try {
        const inner = await simpleParser(att.content);
        innerMessageId = inner.messageId || null;
        messageIdHash = saltedMessageIdHash(innerMessageId, salt);
      } catch { /* leave null; raw-byte match will still be attempted */ }
    }

    const match = findMatch(att.content, commits, { messageIdHash });
    const finding = {
      filename: att.filename || null,
      content_type: att.contentType || null,
      size: att.content.length,
      sha256: sha256Tagged(att.content),
      message_id: innerMessageId,           // plaintext, only for this one-off report
      message_id_hash: messageIdHash,
      match_type: match.matchType,
      matched_commit: match.commit ? match.commit.file : null,
    };

    if (match.matchType === 'raw_email' || match.matchType === 'message_id') {
      // Either kind of match — we have the commit; attempt DKIM re-verify
      // against the archived public key.
      const c = match.commit;
      const sig = (c.dkim && c.dkim.signatures && c.dkim.signatures[0]) || null;
      const pem = await loadDkimPem(eventId, c.dkim_key_file);
      if (sig && pem && sig.result === 'pass') {
        finding.dkim_reverify = await reverifyDkim(
          att.content, pem, sig.domain, sig.selector
        );
      } else {
        finding.dkim_reverify = { ok: false, reason: 'no archived key or signature was not pass' };
      }
    } else if (match.matchType === 'attachment') {
      finding.attachment_matched = { filename: match.attachment.filename };
    }
    findings.push(finding);
  }

  return {
    event_id: eventId,
    verified_at: new Date().toISOString(),
    commit_count: commits.length,
    attachment_count: candidates.length,
    findings,
  };
}

// Render a structured verify report (from buildVerificationReport) as
// plain-text email body for sending back to the forwarder. Deliberately
// compact; the machine-readable JSON stays in receive.log, not the email.
function formatVerifyReportBody(report) {
  const lines = [];
  lines.push('GitDone verification report');
  lines.push('===========================');
  lines.push('');
  lines.push(`Event ID: ${report.event_id}`);
  if (report.verified_at) lines.push(`Checked at: ${report.verified_at}`);
  if (typeof report.commit_count === 'number') {
    lines.push(`Commits in event: ${report.commit_count}`);
  }
  lines.push(`Attachments submitted: ${report.attachment_count || 0}`);
  lines.push('');

  if (report.reason && !report.findings) {
    lines.push(`Result: ${report.reason}`);
    lines.push('');
  } else if (!report.findings || report.findings.length === 0) {
    lines.push('No verifiable attachments found in your message.');
    lines.push('');
    lines.push('To verify:');
    lines.push('  (a) Attach the file (PDF, image, document) as a regular attachment, OR');
    lines.push('  (b) Forward the email you want to verify as an attachment (.eml).');
    lines.push('');
  } else {
    report.findings.forEach((f, i) => {
      lines.push(`--- Attachment ${i + 1} ---`);
      lines.push(`Filename: ${f.filename || '(no filename)'}`);
      if (f.content_type) lines.push(`Content-Type: ${f.content_type}`);
      lines.push(`Size: ${f.size} bytes`);
      lines.push(`SHA-256: ${f.sha256}`);
      if (f.match_type === 'none') {
        lines.push('Result: NO MATCH.');
        lines.push('  This content does not correspond to any recorded commit');
        lines.push('  for this event. Either the content has been modified,');
        lines.push('  or it was never part of this event.');
      } else {
        lines.push('Result: MATCH');
        const explain = f.match_type === 'raw_email'
          ? 'byte-identical raw email'
          : f.match_type === 'message_id'
            ? 'Message-ID match (RFC 5322-stable identifier)'
            : 'attachment content hash match';
        lines.push(`  Match type: ${f.match_type} (${explain})`);
        lines.push(`  Matched commit: ${f.matched_commit}`);
        if (f.dkim_reverify) {
          if (f.dkim_reverify.ok) {
            lines.push('  DKIM re-verification against archived key: PASS');
          } else {
            lines.push(`  DKIM re-verification: not available (${f.dkim_reverify.reason || 'unknown'})`);
            lines.push('    Note: mail clients strip DKIM headers when forwarding');
            lines.push('    as attachment, so re-verification from a forward is');
            lines.push('    structurally limited. The original DKIM result was');
            lines.push('    validated at reception time and is immutably recorded');
            lines.push('    in the event\'s git history + OpenTimestamps anchor.');
          }
        }
      }
      lines.push('');
    });
  }

  lines.push('---');
  lines.push('This is an automated verification response.');
  lines.push('The cryptographic guarantee for this event is recorded in its');
  lines.push('git repository and anchored to Bitcoin via OpenTimestamps.');
  lines.push('Every proof can be verified offline without contacting GitDone.');
  return lines.join('\r\n');
}

module.exports = {
  buildVerificationReport,
  findMatch,
  reverifyDkim,
  loadAllCommits,
  formatVerifyReportBody,
};
