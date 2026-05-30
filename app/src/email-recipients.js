// app/src/email-recipients.js
//
// Single recipient resolver for every outbound lifecycle notification.
// Pre-0.25.0 there were six copy-pasted inline recipient sets across
// notifications.js and the close+ / dashboard-close handlers, each
// reading a slightly different combination of event.initiator,
// event.steps, event.signer, attestor_progress[h].email, and
// revoked_senders. The structural class of bug shipped in 0.24.7
// (attestors missing from the recomplete proof email) came from
// exactly that drift. One resolver, one PII state owner, one place
// to read.
//
// getRecipients(event, edge) → Map<email, role>
//
// Roles match the email taxonomy tree
// (docs/01-product/emails.md):
//   organiser | participant | signer | attestor
//
// Edges match the per-event (B) taxonomy:
//   activated | progressed | completed | closed |
//   anchored  | archived   | overdue
//
// The role lets the caller pick the right per-role body without
// re-deriving event shape; organiser-vs-attestor split bodies (the
// privacy posture for strict-attestation proof emails) iterate the
// Map and dispatch on role.
//
// Iteration order is insertion order. The organiser is added first
// whenever present, so a caller that only wants the primary
// recipient can take .keys().next().value.
//
// Strict-attestation PII state (attestor_progress[h].email) is read
// here. Once event.attestor_emails_redacted_at is set (close-by-
// initiator + future archive sweep), the addStrictAttestors helper
// is a no-op — privacy by design, the redaction stamp is the single
// signal.

'use strict';

const ROLES = Object.freeze({
  ORGANISER: 'organiser',
  PARTICIPANT: 'participant',
  SIGNER: 'signer',
  ATTESTOR: 'attestor',
});

const SUPPORTED_EDGES = Object.freeze(new Set([
  'activated',
  'progressed',
  'completed',
  'closed',
  'anchored',
  'archived',
  'overdue',
]));

function isStrictAttestation(event) {
  return event
    && event.type === 'crypto'
    && event.mode === 'attestation'
    && !!event.reference_url
    && Array.isArray(event.reference_docs)
    && event.reference_docs.length > 0;
}

function addOrganiser(map, event) {
  if (event && event.initiator) {
    map.set(event.initiator.toLowerCase(), ROLES.ORGANISER);
  }
}

function addWorkflowParticipants(map, event, { onlyCompleted = false, onlyPending = false } = {}) {
  if (!event || !Array.isArray(event.steps)) return;
  for (const s of event.steps) {
    if (!s || !s.participant) continue;
    if (onlyCompleted && s.status !== 'complete') continue;
    if (onlyPending && s.status === 'complete') continue;
    const email = s.participant.toLowerCase();
    // Preserve the first-seen role for this email (don't downgrade
    // an organiser back to participant if they're also a step
    // participant on their own event).
    if (!map.has(email)) map.set(email, ROLES.PARTICIPANT);
  }
}

function addDeclarationSigner(map, event) {
  if (event && event.signer) {
    const email = event.signer.toLowerCase();
    if (!map.has(email)) map.set(email, ROLES.SIGNER);
  }
}

// Set of revoked sender_hashes. The resolver owns revoked_senders
// reading (see header) so a revoked attestor is dropped from every
// lifecycle recipient set — revoke means "stop counting AND stop
// communicating." Mirrors completion.js#revokedHashSet; kept inline
// to avoid coupling email-recipients to the completion module.
function revokedHashSet(event) {
  const out = new Set();
  for (const r of (event && event.revoked_senders) || []) {
    if (r && r.sender_hash) out.add(r.sender_hash);
  }
  return out;
}

// Strict-attestation only: attestor emails persist in
// attestor_progress[h].email through the active lifetime. Once
// attestor_emails_redacted_at is set, every p.email is null and
// this loop adds nothing. Revoked attestors are excluded: their
// reply stays in the audit trail, but they no longer count toward
// the threshold (completion.js#countCompleteAttestors) and must not
// receive the durable proof email — it would name them as a
// contributor they were explicitly removed from being.
function addStrictAttestors(map, event) {
  if (!isStrictAttestation(event) || !event.attestor_progress) return;
  const revoked = revokedHashSet(event);
  for (const [hash, p] of Object.entries(event.attestor_progress)) {
    if (revoked.has(hash)) continue;
    if (p && typeof p.email === 'string' && p.email.includes('@')) {
      const email = p.email.toLowerCase();
      if (!map.has(email)) map.set(email, ROLES.ATTESTOR);
    }
  }
}

function getRecipients(event, edge) {
  if (!event) return new Map();
  if (!SUPPORTED_EDGES.has(edge)) {
    throw new Error(`email-recipients: unknown lifecycle edge: ${edge}`);
  }
  const m = new Map();

  switch (edge) {
    case 'activated':
      // Activation acks land in the organiser's inbox. Step
      // invitations to participants are a separate edge
      // (notifyWorkflowParticipants in notifications.js — not
      // yet folded under this resolver).
      addOrganiser(m, event);
      return m;

    case 'progressed':
      // Partial progress acks (per-step done, partial threshold
      // reach) are organiser-only — participants get their own
      // per-reply ack on the receive side, not via this edge.
      addOrganiser(m, event);
      return m;

    case 'completed':
      addOrganiser(m, event);
      if (event.type === 'event') {
        // Workflow completion notifies every named participant,
        // contributing or not — the event being done is event-
        // level news.
        addWorkflowParticipants(m, event);
      } else if (event.type === 'crypto' && event.mode === 'declaration') {
        addDeclarationSigner(m, event);
      } else if (event.type === 'crypto' && event.mode === 'attestation') {
        // Strict: every attestor whose email is still stored.
        // Loose: only the organiser (no PII to use).
        addStrictAttestors(m, event);
      }
      return m;

    case 'closed':
      // Same shape as completed — the close-by-initiator email
      // mirrors the completion proof email's recipient set.
      addOrganiser(m, event);
      if (event.type === 'event') {
        addWorkflowParticipants(m, event);
      } else if (event.type === 'crypto' && event.mode === 'declaration') {
        addDeclarationSigner(m, event);
      } else if (event.type === 'crypto' && event.mode === 'attestation') {
        addStrictAttestors(m, event);
      }
      return m;

    case 'anchored':
      // Anchor confirmation goes to everyone who is named in the
      // proof (contributing participants under workflow; signer
      // under declaration; nobody-by-name under attestation).
      addOrganiser(m, event);
      if (event.type === 'event') {
        addWorkflowParticipants(m, event, { onlyCompleted: true });
      } else if (event.type === 'crypto' && event.mode === 'declaration') {
        addDeclarationSigner(m, event);
      }
      // Attestation under strict mode: emails have been redacted by
      // close (anchored fires post-close). Loose attestation never
      // had PII. Either way, no attestor recipients to add.
      return m;

    case 'archived':
      // Auto-archive after idle period — heads-up to organiser
      // only. Participants moved on long ago.
      addOrganiser(m, event);
      return m;

    case 'overdue':
      // Deadline nudge: organiser + every step still pending.
      addOrganiser(m, event);
      if (event.type === 'event') {
        addWorkflowParticipants(m, event, { onlyPending: true });
      }
      return m;

    default:
      return m;
  }
}

module.exports = {
  getRecipients,
  ROLES,
  SUPPORTED_EDGES,
  isStrictAttestation,
};
