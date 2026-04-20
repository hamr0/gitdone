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
  workflowStepBody,
  declarationSignerBody,
};
