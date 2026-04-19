// 1.I — participant notifications.
//
// On event creation, tell the people who need to reply:
//   - Workflow non-sequential → every step's participant gets an email.
//   - Workflow sequential     → only step 1 gets an email. Step 2+ are
//                               notified by the completion engine (1.J)
//                               when their predecessor completes.
//   - Workflow hybrid         → not yet shipped (1.H.2b). Falls back to
//                               notifying every step for now.
//   - Crypto declaration      → the designated signer gets one email.
//   - Crypto attestation      → no notification. Initiator shares the
//                               reply address manually (PRD §6.1).
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
  if (step.deadline) lines.push(`Deadline: ${step.deadline}`);
  if (step.requires_attachment) lines.push(`Required: include an attachment with your reply.`);
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

async function sendOne({ to, subject, body, event }) {
  const from = gitdoneFrom();
  const rawMessage = buildRawMessage({
    from,
    to,
    subject,
    body,
    autoSubmitted: 'auto-generated',
    domain: config.domain,
    extraHeaders: { 'X-GitDone-Event': event.id },
  });
  const result = await sendmail({ from, rawMessage, to: [to] });
  return { to, ok: result.ok, reason: result.reason, code: result.code };
}

// Returns [{to, ok, reason?}] — caller logs per-recipient. Non-sequential
// sends in parallel; sequential sends one (step 1 only).
async function notifyWorkflowParticipants(event) {
  if (!event || event.type !== 'event' || !Array.isArray(event.steps) || event.steps.length === 0) {
    return [];
  }
  const flow = event.flow || 'sequential';
  const total = event.steps.length;
  const eligible = flow === 'sequential'
    ? [event.steps[0]]
    : event.steps;
  const subj = `[gitdone] "${event.title}" — your step`;
  const jobs = eligible.map((step) => {
    const idx = event.steps.indexOf(step);
    return sendOne({
      to: step.participant,
      subject: subj,
      body: workflowStepBody({ event, step, stepIndex: idx, totalSteps: total }),
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
  });
  return [result];
}

module.exports = {
  notifyWorkflowParticipants,
  notifyDeclarationSigner,
  workflowStepBody,
  declarationSignerBody,
};
