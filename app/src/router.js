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

module.exports = { parseAddress, parseEventTag };
