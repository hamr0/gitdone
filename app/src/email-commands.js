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
// Each handler is a pure composer: returns the reply body (+ for remind
// and close, the side effects they fired). Persistence and sendmail are
// the caller's (receive.js).

'use strict';

const crypto = require('node:crypto');
const config = require('./config');
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

function workflowStatsBody(event) {
  const lines = [];
  lines.push(`Event: ${event.title}`);
  lines.push(`ID: ${event.id}`);
  lines.push(`Minimum trust: ${event.min_trust_level}`);
  lines.push(`Status: ${isComplete(event) ? 'complete' : 'open'}`);
  if (isComplete(event) && event.completion && event.completion.completed_at) {
    lines.push(`Completed at: ${event.completion.completed_at}`);
  }
  lines.push('');
  lines.push('Steps:');
  for (const s of (event.steps || [])) {
    const tick = s.status === 'complete' ? '[x]' : '[ ]';
    const deps = (s.depends_on && s.depends_on.length)
      ? ` · after ${s.depends_on.join(', ')}`
      : '';
    const extra = s.status === 'complete' && s.completed_at ? ` · ${s.completed_at}` : '';
    lines.push(`  ${tick} ${s.name} → ${s.participant}${deps}${extra}`);
  }
  return lines.join('\n');
}

function cryptoStatsBody(event) {
  const lines = [];
  lines.push(`Event: ${event.title}`);
  lines.push(`ID: ${event.id}`);
  lines.push(`Type: ${event.mode}   Minimum trust: ${event.min_trust_level}`);
  lines.push(`Status: ${isComplete(event) ? 'complete' : 'open'}`);
  if (event.mode === 'declaration') {
    lines.push(`Signer: ${event.signer}`);
  } else {
    const counted = (event.replies || []).length;
    lines.push(`Threshold: ${event.threshold} · Dedup: ${event.dedup} · Anonymous: ${event.allow_anonymous ? 'allowed' : 'no'}`);
    lines.push(`Replies received: ${counted}`);
  }
  if (isComplete(event) && event.completion && event.completion.completed_at) {
    lines.push(`Completed at: ${event.completion.completed_at}`);
  }
  return lines.join('\n');
}

function statsBody(event) {
  return event.type === 'event' ? workflowStatsBody(event) : cryptoStatsBody(event);
}

// Re-send invites to participants who haven't completed yet.
//   workflow     → every step that is (a) not complete AND (b) has all
//                  dependencies satisfied. Steps blocked on upstream
//                  deps are deliberately not reminded — their nudge
//                  comes from the cascade when their predecessor
//                  finishes.
//   declaration  → signer, if event not yet signed
//   attestation  → n/a, no participant list
// Returns { body, sentTo: [{to, ok}] }
async function executeRemind(event) {
  if (isComplete(event)) {
    return { body: `Event ${event.id} is already complete; nothing to remind.`, sentTo: [] };
  }
  let results = [];
  if (event.type === 'event') {
    const eligible = eligibleSteps(event);
    if (eligible.length === 0) {
      const anyPending = (event.steps || []).some((s) => s.status !== 'complete');
      return {
        body: anyPending
          ? 'No eligible steps — every pending step is waiting on upstream dependencies.'
          : 'No pending steps.',
        sentTo: [],
      };
    }
    results = await notifyWorkflowParticipants(event, { stepsOverride: eligible, reminder: true });
  } else if (event.type === 'crypto' && event.mode === 'declaration') {
    results = await notifyDeclarationSigner(event);
  } else if (event.type === 'crypto' && event.mode === 'attestation') {
    return {
      body: 'Attestation events have no participant list — share the reply address manually.',
      sentTo: [],
    };
  }
  const lines = ['Reminders sent:'];
  for (const r of results) lines.push(`  ${r.ok ? '✓' : '✗'} ${r.to}${r.reason ? ' · ' + r.reason : ''}`);
  return { body: lines.join('\n'), sentTo: results };
}

// Immediate close — used by the web dashboard, where the deliberate
// action is the button click + active session, not an email round-trip.
// Returns { body, newEvent, wasAlreadyComplete }; persistence + the
// completion commit are the caller's job.
function executeClose(event, { receivedAt }) {
  if (isComplete(event)) {
    return {
      body: `Event ${event.id} is already complete (${event.completion.completed_at}).`,
      newEvent: event,
      wasAlreadyComplete: true,
    };
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
  return {
    body: `Event ${event.id} ("${event.title}") closed by initiator at ${receivedAt}.`,
    newEvent,
    wasAlreadyComplete: false,
  };
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
// The body is plain text the caller drops straight into the receipt.
function executeCloseRequest(event, { receivedAt, replySubject = '', replyText = '', generateToken = generateCloseToken } = {}) {
  if (!event) return { kind: 'already_complete', body: 'Unknown event.', newEvent: null };
  if (isComplete(event)) {
    return {
      kind: 'already_complete',
      body: `Event ${event.id} ("${event.title}") is already complete (${event.completion.completed_at}). No action taken.`,
      newEvent: event,
    };
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
    return {
      kind: 'committed',
      body: `Confirmed. Event ${event.id} ("${event.title}") closed by initiator at ${receivedAt}.`,
      newEvent,
    };
  }

  // Outstanding intent + token in reply but mismatched.
  if (pending && pendingValid && supplied && supplied !== pending.token) {
    return {
      kind: 'token_mismatch',
      body: closeConfirmInstructions(event, pending.token, pending.expires_at, {
        leadIn: 'That confirmation token does not match the outstanding close request.',
      }),
      newEvent: null,
    };
  }

  // Outstanding intent + no token: just remind with the same token, do
  // NOT reissue (so a stray re-send can't refresh the window).
  if (pending && pendingValid && !supplied) {
    return {
      kind: 'pending_remind',
      body: closeConfirmInstructions(event, pending.token, pending.expires_at, {
        leadIn: 'A close request for this event is already outstanding.',
      }),
      newEvent: null,
    };
  }

  // Otherwise (no intent, or expired): start a fresh pending close.
  const token = generateToken();
  const expiresAt = new Date(new Date(receivedAt).getTime() + CLOSE_CONFIRM_TTL_MS).toISOString();
  const newEvent = { ...event, pending_close: { token, created_at: receivedAt, expires_at: expiresAt } };
  return {
    kind: 'pending_started',
    body: closeConfirmInstructions(event, token, expiresAt, {
      leadIn: 'Closing an event is irreversible — confirmation required.',
    }),
    newEvent,
    token,
    expiresAt,
  };
}

function closeConfirmInstructions(event, token, expiresAt, { leadIn = '' } = {}) {
  return [
    leadIn,
    '',
    `To close "${event.title}" (${event.id}), reply to this message`,
    `from the same address with the following confirmation:`,
    '',
    `  CONFIRM ${token}`,
    '',
    `(in the subject or anywhere in the body — case-insensitive).`,
    `This token expires at ${expiresAt}.`,
    '',
    'Closing the event writes a final completion commit to the audit',
    'trail and notifies all participants. It cannot be undone.',
  ].join('\n');
}

module.exports = {
  authenticateInitiatorCommand,
  statsBody,
  executeRemind,
  executeClose,         // immediate close — web dashboard
  executeCloseRequest,  // two-step close — email path
  workflowStatsBody,
  cryptoStatsBody,
  // exported for tests
  generateCloseToken,
  extractCloseToken,
  CLOSE_CONFIRM_TTL_MS,
};
