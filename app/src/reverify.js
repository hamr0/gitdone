// 1.L.3 — reverify+{eventId}-{commitN}@ orchestrator.
//
// A submitter forwards a raw `.eml` (as message/rfc822 attachment) to
// reverify+{id}-{seq}@. We:
//   1. Load commit-{seq}.json from the event's repo
//   2. Find the signing domain + selector + archived PEM in that commit
//   3. Extract the inner .eml bytes from the forwarded envelope
//   4. Re-run DKIM against the archived PEM
//   5. If it verifies cleanly, the trust level is upgraded; otherwise
//      the attempt is recorded (still a git commit — audit trail) but
//      the original commit's trust stays unchanged
//
// Upgrade semantics (PRD §7.4.x):
//   - Original commit-{seq}.json is immutable; this module writes a
//     NEW reverify-NNN.json that layers on top.
//   - gitdone-verify (1.L.2) and the completion logic (1.J, future)
//     consult both files together: the latest reverify with
//     `upgraded: true` wins.
//
// Auth model: cryptographic, not social. Anyone can submit — if they
// can produce a raw email whose DKIM validates against the archived
// PEM, they have cryptographic proof they hold the original. That IS
// the auth. No magic-link tokens, no sender verification.

'use strict';

const crypto = require('node:crypto');

const { reverifyDkim } = require('./verify');
const { loadCommit, commitReverify } = require('./gitrepo');

function sha256Tagged(buf) {
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

// Policy: which trust levels are eligible for upgrade, and what they
// upgrade to on a DKIM pass. Order matters — we upgrade to the best
// demonstrable level.
function resolveUpgrade(currentLevel) {
  // An already-verified commit doesn't need reverify; we still record
  // the attempt as an audit entry but don't "upgrade."
  if (currentLevel === 'verified') return { upgradeTo: null, reason: 'already verified' };
  // Below verified → verified on DKIM pass
  if (['unverified', 'authorized', 'forwarded'].includes(currentLevel)) {
    return { upgradeTo: 'verified', reason: null };
  }
  return { upgradeTo: null, reason: `unknown source trust level: ${currentLevel}` };
}

// Given a parsed forwarded-email (from mailparser) find the inner .eml
// bytes to re-verify. Prefer an explicit message/rfc822 attachment; fall
// back to the first attachment; otherwise null.
function extractCandidateEmail(parsedForwarded) {
  const atts = (parsedForwarded && parsedForwarded.attachments) || [];
  for (const a of atts) {
    if (a.content && (a.contentType || '').toLowerCase().startsWith('message/rfc822')) {
      return a.content;
    }
  }
  for (const a of atts) {
    if (a.content) return a.content;
  }
  return null;
}

// Find the signing material in a commit's dkim summary. Returns
// { domain, selector } or null if the commit has no signatures.
function pickSigner(commit) {
  const sigs = (commit && commit.dkim && commit.dkim.signatures) || [];
  for (const s of sigs) {
    // Prefer the signature that was valid at reception
    if (s.result === 'pass' && s.domain && s.selector) {
      return { domain: s.domain, selector: s.selector };
    }
  }
  // Fall back to any signature with domain+selector, even if the
  // reception-time result was fail or neutral — reverify is exactly
  // about those cases.
  for (const s of sigs) {
    if (s.domain && s.selector) {
      return { domain: s.domain, selector: s.selector };
    }
  }
  return null;
}

// Main entry. eventId and targetSequence come from router.parseReverifyTag.
// parsedForwarded is the mailparser output for the submitted email.
// Returns a structured record suitable both for the git commit AND for
// the DKIM-signed ack email.
//
// Caller (receive.js) is responsible for writing the commit via
// commitReverify and sending the ack reply — this module just computes
// the decision.
async function buildReverifyRecord(eventId, targetSequence, parsedForwarded, { readPem }) {
  const target = await loadCommit(eventId, targetSequence);
  if (!target) {
    return {
      found: false,
      reason: `no commit-${String(targetSequence).padStart(3, '0')}.json in event ${eventId}`,
    };
  }

  const currentLevel = target.trust_level || 'unverified';
  const keyRel = target.dkim_key_file;
  if (!keyRel) {
    return {
      found: true,
      target,
      upgraded: false,
      trust_level_before: currentLevel,
      trust_level_after: currentLevel,
      dkim_reverify: { ok: false, reason: 'no archived DKIM key (original message was unsigned)' },
    };
  }

  const signer = pickSigner(target);
  if (!signer) {
    return {
      found: true,
      target,
      upgraded: false,
      trust_level_before: currentLevel,
      trust_level_after: currentLevel,
      dkim_reverify: { ok: false, reason: 'no signing domain/selector in committed DKIM record' },
    };
  }

  const candidate = extractCandidateEmail(parsedForwarded);
  if (!candidate) {
    return {
      found: true,
      target,
      upgraded: false,
      trust_level_before: currentLevel,
      trust_level_after: currentLevel,
      dkim_reverify: {
        ok: false,
        reason: 'no .eml attachment or forwarded content to re-verify. ' +
                'Attach the raw email as message/rfc822 and resubmit.',
      },
    };
  }

  const pem = await readPem(keyRel);
  if (!pem) {
    return {
      found: true,
      target,
      upgraded: false,
      trust_level_before: currentLevel,
      trust_level_after: currentLevel,
      dkim_reverify: { ok: false, reason: `archived key not readable: ${keyRel}` },
    };
  }

  const verdict = await reverifyDkim(candidate, pem, signer.domain, signer.selector);
  const policy = resolveUpgrade(currentLevel);
  const upgraded = Boolean(verdict.ok && policy.upgradeTo);

  return {
    found: true,
    target,
    upgraded,
    trust_level_before: currentLevel,
    trust_level_after: upgraded ? policy.upgradeTo : currentLevel,
    policy_note: policy.reason,
    dkim_reverify: verdict,
    signer,
    evidence: {
      raw_sha256: sha256Tagged(candidate),
      raw_size: candidate.length,
    },
  };
}

// Persist the record as an immutable reverify-NNN.json commit.
async function persistReverifyRecord(eventId, event, targetSequence, record, receivedAt) {
  return commitReverify(eventId, event, targetSequence, {
    trust_level_before: record.trust_level_before,
    trust_level_after: record.trust_level_after,
    upgraded: record.upgraded,
    dkim_reverify: record.dkim_reverify,
    evidence: record.evidence || null,
  }, receivedAt);
}

// Render an email body summarising the reverify outcome — sent back to
// the submitter, DKIM-signed via opendkim on outbound.
function formatReverifyReportBody(eventId, targetSequence, record) {
  const lines = [];
  const target = `commit-${String(targetSequence).padStart(3, '0')}.json`;
  lines.push('GitDone re-verification report');
  lines.push('==============================');
  lines.push('');
  lines.push(`Event: ${eventId}`);
  lines.push(`Target: ${target}`);
  lines.push('');

  if (!record.found) {
    lines.push(`Result: NOT FOUND`);
    lines.push(`  ${record.reason}`);
    lines.push('');
  } else if (record.upgraded) {
    lines.push(`Result: UPGRADED`);
    lines.push(`  Trust level: ${record.trust_level_before} -> ${record.trust_level_after}`);
    lines.push(`  DKIM re-verification: PASS against archived key`);
    lines.push(`  Signer: ${record.signer.domain} / ${record.signer.selector}`);
    lines.push(`  Evidence hash: ${record.evidence.raw_sha256}`);
    lines.push('');
    lines.push('A new reverify commit has been appended to the event repo.');
    lines.push('The original commit is untouched — history is preserved.');
  } else {
    lines.push(`Result: NOT UPGRADED`);
    lines.push(`  Trust level stays: ${record.trust_level_before}`);
    if (record.dkim_reverify) {
      if (record.dkim_reverify.ok) {
        lines.push(`  DKIM verified, but no upgrade applies`);
        if (record.policy_note) lines.push(`  Policy: ${record.policy_note}`);
      } else {
        lines.push(`  DKIM re-verification: FAIL`);
        if (record.dkim_reverify.reason) lines.push(`  Reason: ${record.dkim_reverify.reason}`);
      }
    }
    lines.push('');
    lines.push('The submission has been recorded in the event repo as an');
    lines.push('audit entry (reverify-NNN.json), but the target commit\'s');
    lines.push('trust level is unchanged.');
  }

  lines.push('---');
  lines.push('An automated re-verification response.');
  lines.push('Cryptographic guarantees are verifiable offline — clone the');
  lines.push('event repo and run gitdone-verify.');
  return lines.join('\r\n');
}

module.exports = {
  buildReverifyRecord,
  persistReverifyRecord,
  formatReverifyReportBody,
  extractCandidateEmail,
  pickSigner,
  resolveUpgrade,
};
