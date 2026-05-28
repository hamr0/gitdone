// 1.§6.4 — initiator email commands. DKIM + envelope-sender-matches-initiator
// is the auth; no magic-link click needed. This is the primary initiator
// surface: everyday interaction with a running event (check progress,
// poke pending participants, close early) happens here, not in a web form.
//
// Address namespace (router.parseInitiatorCommand):
//   stats+{id}@    — current progress report
//   remind+{id}@   — re-send pending-participant invitations
//   close+{id}@    — close the event early
//
// Each handler is pure computation / a state-machine: it fires the side
// effects it owns (remind sends; close advances the confirm machine) and
// returns a structured outcome. No body text lives here — the caller
// composes receipts via the email-bodies catalogue (bodies.cmd.*).
// Persistence and sendmail are the caller's (receive.js / server.js).

'use strict';

const crypto = require('node:crypto');
const { meetsTrust, applyReply, updateEventAtomic, eligibleSteps, isComplete } = require('./completion');
const { notifyWorkflowParticipants, notifyDeclarationSigner } = require('./notifications');

// close+ uses a two-step confirm so a single autoreply, stale forwarded
// message, or a one-off compromised send can't write an irreversible
// completion commit. First reply records a pending intent + token; a
// second DKIM-authenticated reply within CLOSE_CONFIRM_TTL_MS quoting
// the token actually closes.
const CLOSE_CONFIRM_TTL_MS = 30 * 60 * 1000; // 30 min
const CLOSE_TOKEN_RE = /CONFIRM\s+([A-Fa-f0-9]{8})\b/;

function generateCloseToken() {
  return crypto.randomBytes(4).toString('hex');
}

function extractCloseToken({ subject = '', body = '' } = {}) {
  const m = String(subject).match(CLOSE_TOKEN_RE) || String(body).match(CLOSE_TOKEN_RE);
  return m ? m[1].toLowerCase() : null;
}

function normaliseEmail(s) {
  return (s || '').trim().toLowerCase();
}

// Authenticate the command. Requires trust ≥ event.min_trust_level AND
// the envelope sender (or From, when envelope is absent) matches the
// event's initiator. PRD §6.4: DKIM-validated sender IS the auth.
function authenticateInitiatorCommand(event, { sender, trustLevel }) {
  if (!event) return { ok: false, reason: 'unknown event' };
  if (!meetsTrust({ trust_level: trustLevel }, event)) {
    return { ok: false, reason: `trust ${trustLevel} below event min ${event.min_trust_level}` };
  }
  if (!sender || normaliseEmail(sender) !== normaliseEmail(event.initiator)) {
    return { ok: false, reason: 'sender is not the event initiator' };
  }
  return { ok: true };
}

// --- composers ---

// stats bodies (statsBody / workflowStatsBody / cryptoStatsBody) moved
// to the email-bodies catalogue (bodies.cmd.stats / .statsWorkflow /
// .statsCrypto) — pure rendering, so they belong with the other body
// text. email-commands stays computation + state-machines only.

// Re-send invites to participants who haven't completed yet.
//   workflow     → every step that is (a) not complete AND (b) has all
//                  dependencies satisfied. Steps blocked on upstream
//                  deps are deliberately not reminded — their nudge
//                  comes from the cascade when their predecessor
//                  finishes.
//   declaration  → signer, if event not yet signed
//   attestation  → n/a, no participant list
// Returns a structured outcome { kind, sentTo }; the caller composes the
// receipt body via bodies.cmd.remind. Outcome kinds:
//   already_complete — event finished, nothing to nudge
//   no_eligible      — workflow, every pending step waits on upstream deps
//   no_pending       — workflow, nothing pending
//   attestation      — no participant list; share the reply address
//   sent             — reminders fired; sentTo carries per-recipient results
async function executeRemind(event) {
  if (isComplete(event)) {
    return { kind: 'already_complete', sentTo: [] };
  }
  let results = [];
  if (event.type === 'event') {
    const eligible = eligibleSteps(event);
    if (eligible.length === 0) {
      const anyPending = (event.steps || []).some((s) => s.status !== 'complete');
      return { kind: anyPending ? 'no_eligible' : 'no_pending', sentTo: [] };
    }
    results = await notifyWorkflowParticipants(event, { stepsOverride: eligible, reminder: true });
  } else if (event.type === 'crypto' && event.mode === 'declaration') {
    results = await notifyDeclarationSigner(event);
  } else if (event.type === 'crypto' && event.mode === 'attestation') {
    return { kind: 'attestation', sentTo: [] };
  }
  return { kind: 'sent', sentTo: results };
}

// Immediate close — used by the web dashboard, where the deliberate
// action is the button click + active session, not an email round-trip.
// Returns { newEvent, wasAlreadyComplete }; persistence + the completion
// commit are the caller's job. The web caller doesn't surface a body;
// the body text (if needed) is bodies.cmd.close.{closedImmediate,
// alreadyCompleteImmediate}.
function executeClose(event, { receivedAt }) {
  if (isComplete(event)) {
    return { newEvent: event, wasAlreadyComplete: true };
  }
  const newEvent = {
    ...event,
    completion: {
      status: 'complete',
      completed_at: receivedAt,
      closed_by: 'initiator',
      reason: 'close-command',
    },
  };
  return { newEvent, wasAlreadyComplete: false };
}

// Two-step close — used by the email path (close+<id>@). First call
// returns a pending intent + token; second call (within TTL, with the
// token quoted in subject or body) returns the committed close.
// Persistence and the git completion commit are the caller's job —
// receive.js orchestrates them.
//
// Outcome kinds:
//   already_complete  — event was already finished; no-op
//   committed         — token matched, write completion commit + notify
//   pending_started   — first request, or prior intent expired
//   pending_remind    — outstanding intent, no token in this reply
//   token_mismatch    — outstanding intent, but token didn't match
//
// Returns a structured outcome; the caller composes the receipt body via
// bodies.cmd.close.requestBody(outcome, event, receivedAt). The outcome
// carries kind + newEvent (+ token/expiresAt for the pending kinds, so
// the body resolver can reprint the confirmation instructions).
function executeCloseRequest(event, { receivedAt, replySubject = '', replyText = '', generateToken = generateCloseToken } = {}) {
  if (!event) return { kind: 'already_complete', newEvent: null };
  if (isComplete(event)) {
    return { kind: 'already_complete', newEvent: event };
  }

  const supplied = extractCloseToken({ subject: replySubject, body: replyText });
  const pending = event.pending_close || null;
  const pendingValid = pending && pending.expires_at && new Date(pending.expires_at) > new Date(receivedAt);

  // Confirm path: outstanding intent + matching token + within TTL.
  if (pending && pendingValid && supplied && supplied === pending.token) {
    const newEvent = {
      ...event,
      pending_close: undefined,
      completion: {
        status: 'complete',
        completed_at: receivedAt,
        closed_by: 'initiator',
        reason: 'close-command',
      },
    };
    return { kind: 'committed', newEvent };
  }

  // Outstanding intent + token in reply but mismatched.
  if (pending && pendingValid && supplied && supplied !== pending.token) {
    return { kind: 'token_mismatch', newEvent: null, token: pending.token, expiresAt: pending.expires_at };
  }

  // Outstanding intent + no token: just remind with the same token, do
  // NOT reissue (so a stray re-send can't refresh the window).
  if (pending && pendingValid && !supplied) {
    return { kind: 'pending_remind', newEvent: null, token: pending.token, expiresAt: pending.expires_at };
  }

  // Otherwise (no intent, or expired): start a fresh pending close.
  const token = generateToken();
  const expiresAt = new Date(new Date(receivedAt).getTime() + CLOSE_CONFIRM_TTL_MS).toISOString();
  const newEvent = { ...event, pending_close: { token, created_at: receivedAt, expires_at: expiresAt } };
  return { kind: 'pending_started', newEvent, token, expiresAt };
}

module.exports = {
  authenticateInitiatorCommand,
  executeRemind,
  executeClose,         // immediate close — web dashboard
  executeCloseRequest,  // two-step close — email path
  // exported for tests
  generateCloseToken,
  extractCloseToken,
  CLOSE_CONFIRM_TTL_MS,
};
