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

const config = require('./config');
const { meetsTrust, applyReply, updateEventAtomic, eligibleSteps, isComplete } = require('./completion');
const { notifyWorkflowParticipants, notifyDeclarationSigner } = require('./notifications');

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
    results = await notifyWorkflowParticipants(event, { stepsOverride: eligible });
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

// Mark event complete by initiator command. Does NOT write the git
// completion commit here — receive.js orchestrates that so stamp/commit
// stays in one place. Returns { body, newEvent, wasAlreadyComplete }.
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

module.exports = {
  authenticateInitiatorCommand,
  statsBody,
  executeRemind,
  executeClose,
  workflowStatsBody,
  cryptoStatsBody,
};
