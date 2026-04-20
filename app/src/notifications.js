// 1.I — participant notifications (1.H.2b-aware).
//
// A workflow step is "root" if its depends_on is empty. Root steps get
// notified at create time; downstream steps get notified by the
// completion engine (1.J) when every id in their depends_on has been
// marked complete. Crypto rules unchanged:
//
//   - Workflow               → every step with depends_on=[] at creation.
//   - Crypto declaration     → the designated signer gets one email.
//   - Crypto attestation     → no notification. Initiator shares the
//                              reply address manually (PRD §6.1).
//
// Every message is plain-text (§0.1.4 "invisible beats correct"). Outbound
// DKIM signing is handled by opendkim at the MTA; this module only composes.

'use strict';

const config = require('./config');
const { buildRawMessage, sendmail } = require('./outbound');

function stepReplyAddr(event, stepId) {
  return `event+${event.id}-${stepId}@${config.domain}`;
}

function cryptoReplyAddr(event) {
  return `event+${event.id}@${config.domain}`;
}

function gitdoneFrom() {
  return `gitdone@${config.domain}`;
}

// Compose the plain-text body for a workflow-step invitation. The reply
// address is the only thing the participant needs to act on.
function workflowStepBody({ event, step, stepIndex, totalSteps }) {
  const replyAddr = stepReplyAddr(event, step.id);
  const lines = [
    `You've been named as a participant in a gitdone event.`,
    ``,
    `Event: ${event.title}`,
    `Your step: ${step.name} (step ${stepIndex + 1} of ${totalSteps})`,
    `Organiser: ${event.initiator}`,
  ];
  if (step.deadline) {
    lines.push(
      `Deadline: ${step.deadline}`,
      `  (soft — replies after this date are still counted, but the organiser`,
      `  will be notified if your step is overdue.)`,
    );
  }
  if (step.requires_attachment) lines.push(`Required: include an attachment with your reply.`);
  if (step.details) {
    lines.push(
      ``,
      `What to do:`,
      ...step.details.split(/\r?\n/).map((l) => `  ${l}`),
    );
  }
  lines.push(
    ``,
    `Reply from ${step.participant} to:`,
    `  ${replyAddr}`,
    ``,
    `Write whatever you want in the body. Attachments are forwarded to the`,
    `organiser directly — gitdone only stores hashes of them, never content.`,
    `Your reply is DKIM-verified, OpenTimestamped, and committed to a`,
    `per-event git repository as a permanent record.`,
    ``,
    `If this is unexpected or you don't want to participate, ignore this`,
    `email. The organiser can see that your step is still pending.`,
  );
  return lines.join('\n');
}

function declarationSignerBody({ event }) {
  const replyAddr = cryptoReplyAddr(event);
  return [
    `${event.initiator} asked you to sign a gitdone declaration.`,
    ``,
    `Event: ${event.title}`,
    `Type: declaration (one signer, one permanent record)`,
    ``,
    `Reply from ${event.signer} to:`,
    `  ${replyAddr}`,
    ``,
    `Your DKIM-verified reply becomes the declaration. The message body is`,
    `what gets recorded. Attachments are forwarded to the organiser; gitdone`,
    `stores only hashes.`,
    ``,
    `If this is unexpected, ignore this email.`,
  ].join('\n');
}

// --- senders ---

async function sendOne({ to, subject, body, event, replyTo }) {
  const from = gitdoneFrom();
  const rawMessage = buildRawMessage({
    from,
    to,
    subject,
    body,
    replyTo,
    autoSubmitted: 'auto-generated',
    domain: config.domain,
    extraHeaders: { 'X-GitDone-Event': event.id },
  });
  const result = await sendmail({ from, rawMessage, to: [to] });
  return { to, ok: result.ok, reason: result.reason, code: result.code };
}

// Returns [{to, ok, reason?}] — caller logs per-recipient. Sends in
// parallel. If `stepsOverride` is supplied, notifies exactly those steps
// (used by the cascade path after a dependency completes, and by
// remind+). Otherwise notifies every step whose depends_on is empty —
// the "roots" of the dependency graph.
async function notifyWorkflowParticipants(event, { stepsOverride } = {}) {
  if (!event || event.type !== 'event' || !Array.isArray(event.steps) || event.steps.length === 0) {
    return [];
  }
  const total = event.steps.length;
  const target = stepsOverride
    ? stepsOverride
    : event.steps.filter((s) => !s.depends_on || s.depends_on.length === 0);
  const jobs = target.map((step) => {
    const idx = event.steps.indexOf(step);
    return sendOne({
      to: step.participant,
      subject: `[gitdone] ${event.title} — ${step.name} — your step`,
      body: workflowStepBody({ event, step, stepIndex: idx, totalSteps: total }),
      event,
      replyTo: stepReplyAddr(event, step.id),
    });
  });
  return Promise.all(jobs);
}

// Email everyone who contributed to an event + the initiator when the
// event transitions to complete (all steps done, or organiser close,
// or declaration signed). One email per distinct address. Plain text,
// DKIM-signed via the MTA milter. Best-effort — failures don't block
// the completion commit itself.
async function notifyEventCompletion(event, { reason = 'all_steps_done', publicBaseUrl } = {}) {
  if (!event) return [];
  const completedAt = (event.completion && event.completion.completed_at) || new Date().toISOString();
  const recipients = new Set();
  if (event.initiator) recipients.add(event.initiator.toLowerCase());
  if (event.type === 'event' && Array.isArray(event.steps)) {
    for (const s of event.steps) {
      if (s && s.participant) recipients.add(s.participant.toLowerCase());
    }
  } else if (event.type === 'crypto' && event.mode === 'declaration' && event.signer) {
    recipients.add(event.signer.toLowerCase());
  }
  // Attestation: participants may be anonymous crowd; only notify initiator.

  const reasonLabel = reason === 'closed_by_initiator'
    ? 'closed early by the organiser'
    : reason === 'declaration_signed'
      ? 'the signer replied'
      : 'all steps completed';
  const repoHint = event.id ? `  Event repo: git-done.com/events/${event.id} (auth required)` : '';
  const steps = (event.steps || []).map((s, i) => {
    const status = s.status === 'complete' ? 'DONE' : (s.status || 'pending').toUpperCase();
    return `  ${i + 1}. ${s.name} — ${status}`;
  }).join('\n');

  const jobs = [...recipients].map((to) => {
    const isOrganiser = event.initiator && to === event.initiator.toLowerCase();
    let body;
    if (isOrganiser) {
      body = [
        `The event you organized has completed.`,
        ``,
        `Event: ${event.title}`,
        `Event ID: ${event.id}`,
        `Completed: ${completedAt}`,
        `Reason: ${reasonLabel}`,
        ``,
        steps ? `Steps:` : '',
        steps,
        steps ? `` : '',
        `The full audit trail is stored as a git repository with one commit per`,
        `reply, DKIM keys archived, and OpenTimestamps proofs attached. Anyone`,
        `can verify it offline with the gitdone-verify CLI, even if gitdone itself`,
        `goes away — the proofs outlive the service.`,
        ``,
        repoHint,
        `  Organiser: ${event.initiator}`,
      ].filter((l) => l !== '').join('\n');
    } else {
      // Slim participant version. Do NOT leak the step table — that's
      // private to the organiser. Participants see only what they need:
      // the event closed, reason, and how to verify their own record.
      body = [
        `An event you contributed to has completed.`,
        ``,
        `Event: ${event.title}`,
        `Reason: ${reasonLabel}`,
        ``,
        `Your reply is recorded in the event's git audit trail (DKIM-verified,`,
        `OpenTimestamped) and will stay verifiable offline even if gitdone`,
        `itself goes away.`,
        ``,
        `  Organised by ${event.initiator}`,
      ].join('\n');
    }
    return sendOne({
      to,
      subject: `[gitdone] "${event.title}" — complete`,
      body,
      event,
    });
  });
  return Promise.all(jobs);
}

async function notifyDeclarationSigner(event) {
  if (!event || event.type !== 'crypto' || event.mode !== 'declaration' || !event.signer) {
    return [];
  }
  const result = await sendOne({
    to: event.signer,
    subject: `[gitdone] "${event.title}" — please sign`,
    body: declarationSignerBody({ event }),
    event,
    replyTo: cryptoReplyAddr(event),
  });
  return [result];
}

module.exports = {
  notifyWorkflowParticipants,
  notifyDeclarationSigner,
  notifyEventCompletion,
  workflowStepBody,
  declarationSignerBody,
};
