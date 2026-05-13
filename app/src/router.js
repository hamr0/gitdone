// Address router. Parses Postfix's ${original_recipient} (preserved through
// pipe transport) into structured routing fields.
//
// Address grammar (PRD §5.1, §6.1):
//   event+{eventId}-{stepId}@<domain>     → workflow reply for a specific step
//   event+{eventId}@<domain>              → workflow reply, step unspecified
//   manage+{token}@<domain>               → initiator management (Phase 1.H)
//   attest+{eventId}@<domain>             → crypto attestation (Phase 2)
//
// Constraint: eventId is alphanumeric only (validated at event creation).
// Step IDs may contain dashes; everything after the FIRST dash in the
// extension is the stepId.

'use strict';

const ADDR_RE = /^([a-z][a-z0-9]*)\+([^@\s]+)@([^\s@]+)$/i;
const EVENT_ID_RE = /^[a-zA-Z0-9]+$/;

function parseAddress(recipient) {
  if (!recipient || typeof recipient !== 'string') return null;
  const m = recipient.trim().match(ADDR_RE);
  if (!m) return null;
  return {
    kind: m[1].toLowerCase(),
    extension: m[2],
    domain: m[3].toLowerCase(),
  };
}

function parseEventTag(recipient) {
  const a = parseAddress(recipient);
  if (!a || a.kind !== 'event') return null;
  const dashIdx = a.extension.indexOf('-');
  const eventId = dashIdx < 0 ? a.extension : a.extension.slice(0, dashIdx);
  const stepId = dashIdx < 0 ? null : a.extension.slice(dashIdx + 1);
  if (!EVENT_ID_RE.test(eventId)) return null;
  return { eventId, stepId };
}

// verify+{eventId}@ — public verification endpoint. No step component.
function parseVerifyTag(recipient) {
  const a = parseAddress(recipient);
  if (!a || a.kind !== 'verify') return null;
  if (!EVENT_ID_RE.test(a.extension)) return null;
  return { eventId: a.extension };
}

// reverify+{eventId}-{commitSeq}@ — contested-commit upgrade path (1.L.3).
// commitSeq is the sequence of the commit being re-evaluated (e.g., 3 for
// commit-003.json). Anyone may submit; the auth is cryptographic — the
// submitter must supply a raw .eml that validates against the archived
// DKIM key for that commit.
function parseReverifyTag(recipient) {
  const a = parseAddress(recipient);
  if (!a || a.kind !== 'reverify') return null;
  const dashIdx = a.extension.lastIndexOf('-');
  if (dashIdx < 0) return null;
  const eventId = a.extension.slice(0, dashIdx);
  const seqStr = a.extension.slice(dashIdx + 1);
  if (!EVENT_ID_RE.test(eventId)) return null;
  if (!/^\d+$/.test(seqStr)) return null;
  const commitSequence = parseInt(seqStr, 10);
  if (commitSequence < 1 || commitSequence > 99999) return null;
  return { eventId, commitSequence };
}

// 1.§6.4 initiator commands: stats+{id}@, remind+{id}@, close+{id}@,
// bundle+{id}@. All share the same address shape — one eventId, no step
// suffix. Authentication (DKIM + envelope sender == event.initiator)
// happens in email-commands.js; this just parses.
const INITIATOR_COMMANDS = new Set(['stats', 'remind', 'close', 'bundle']);
function parseInitiatorCommand(recipient) {
  const a = parseAddress(recipient);
  if (!a || !INITIATOR_COMMANDS.has(a.kind)) return null;
  if (!EVENT_ID_RE.test(a.extension)) return null;
  return { command: a.kind, eventId: a.extension };
}

// attach+{eventId}@ — initiator-only reference-doc registration channel
// for crypto events (Module 4a). Each email's attachments are hashed
// (SHA-256 + filename + size) and appended to event.reference_docs[].
// Bytes are discarded after hashing — never persisted to disk. Channel
// freezes at first counted reply so all signers attest to the same doc
// set.
function parseAttachTag(recipient) {
  const a = parseAddress(recipient);
  if (!a || a.kind !== 'attach') return null;
  if (!EVENT_ID_RE.test(a.extension)) return null;
  return { eventId: a.extension };
}

// revoke+{eventId}@ — initiator-only attestation-revocation channel
// (Module 8). Body lists one email per line (optional `reason: ...`); the
// handler hashes each against event.salt and appends matches to
// event.revoked_senders[]. Audit trail is preserved — original replies
// stay in the per-event repo; revoked sender_hashes just drop from the
// counted/verified totals and may flip completion back to open.
function parseRevokeTag(recipient) {
  const a = parseAddress(recipient);
  if (!a || a.kind !== 'revoke') return null;
  if (!EVENT_ID_RE.test(a.extension)) return null;
  return { eventId: a.extension };
}

module.exports = {
  parseAddress, parseEventTag, parseVerifyTag, parseReverifyTag,
  parseInitiatorCommand, parseAttachTag, parseRevokeTag,
};
