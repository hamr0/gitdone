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
const proofRender = require('./web/proof-render');

function stepReplyAddr(event, stepId) {
  return `event+${event.id}-${stepId}@${config.domain}`;
}

// "2026-05-12" or "2026-05-12T12:00:00Z" → "Saturday, 2026-05-12".
// Date-only strings come from the <input type=date> in the form;
// older events may carry full ISO timestamps. Both render in UTC so
// the weekday matches the calendar date the organiser picked.
function formatAspirationalDate(deadline) {
  const dateOnly = String(deadline).slice(0, 10);
  const d = new Date(`${dateOnly}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(deadline);
  const weekday = d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  return `${weekday}, ${dateOnly}`;
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
  if (step.requires_attachment) lines.push(`Attachment: required`);
  if (step.deadline) lines.push(`Aspirational date: ${formatAspirationalDate(step.deadline)}`);
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

const { newMessageId } = require('./outbound');

async function sendOne({ to, subject, body, event, replyTo, stepId, inReplyTo, references, messageId }) {
  const from = gitdoneFrom();
  // Mint the Message-Id ourselves so the caller can persist it (proof
  // email threading needs it for the OTS-anchored follow-up).
  const mid = messageId || newMessageId(config.domain || 'git-done.com');
  const rawMessage = buildRawMessage({
    from,
    to,
    subject,
    body,
    replyTo,
    inReplyTo,
    references,
    messageId: mid,
    autoSubmitted: 'auto-generated',
    domain: config.domain,
    extraHeaders: { 'X-GitDone-Event': event.id },
  });
  const result = await sendmail({ from, rawMessage, to: [to] });
  return { to, ok: result.ok, reason: result.reason, code: result.code, step_id: stepId, message_id: mid };
}

// Returns [{to, ok, reason?}] — caller logs per-recipient. Sends in
// parallel. If `stepsOverride` is supplied, notifies exactly those steps
// (used by the cascade path after a dependency completes, and by
// remind+). Otherwise notifies every step whose depends_on is empty —
// the "roots" of the dependency graph.
async function notifyWorkflowParticipants(event, { stepsOverride, reminder = false } = {}) {
  if (!event || event.type !== 'event' || !Array.isArray(event.steps) || event.steps.length === 0) {
    return [];
  }
  const total = event.steps.length;
  const target = stepsOverride
    ? stepsOverride
    : event.steps.filter((s) => !s.depends_on || s.depends_on.length === 0);
  // remind+ command resends the same prompt with a "reminder" tag so the
  // participant's MUA can disambiguate this from the original invite.
  const tag = reminder ? '"reminder" ' : '';
  const jobs = target.map((step) => {
    const idx = event.steps.indexOf(step);
    return sendOne({
      to: step.participant,
      subject: `[gitdone] ${tag}${event.title} — ${step.name} [${idx + 1}/${total}] — your step`,
      body: workflowStepBody({ event, step, stepIndex: idx, totalSteps: total }),
      event,
      replyTo: stepReplyAddr(event, step.id),
      stepId: step.id,
    });
  });
  const results = await Promise.all(jobs);
  // Persist a per-step delivery flag so the dashboard can warn the
  // organiser when sendmail rejects synchronously (bad address, MTA
  // misconfig, etc.). Successes clear any prior flag — a retry that
  // works should erase the warning. Best-effort: a persistence failure
  // doesn't change the send outcome we return to the caller.
  const errorsByStepId = {};
  for (const r of results) {
    if (!r.step_id) continue;
    errorsByStepId[r.step_id] = r.ok
      ? null
      : { reason: r.reason || null, code: r.code == null ? null : r.code, at: new Date().toISOString() };
  }
  if (Object.keys(errorsByStepId).length) {
    try {
      const { recordStepSendErrors } = require('./event-store');
      await recordStepSendErrors(event.id, errorsByStepId);
    } catch (err) {
      process.stderr.write(`notify-record-error: ${err.message || err}\n`);
    }
  }
  return results;
}

// Per-step / per-reply receipt block for the proof email body. Returns
// "" if no commits are available (e.g. dashboard-close before any
// reply, attestation closed early). ASCII-only.
function renderProofBlock(event, commits, { recipient } = {}) {
  if (!Array.isArray(commits) || commits.length === 0) return '';
  if (event.type === 'event') {
    // One receipt per completed step. If the email is going to a step
    // participant, surface their step first; otherwise just iterate.
    const stepCommits = commits.filter((c) => c.step_id);
    if (stepCommits.length === 0) return '';
    const sections = stepCommits.map((c) => {
      const step = (event.steps || []).find((s) => s.id === c.step_id);
      const idx = (event.steps || []).findIndex((s) => s.id === c.step_id);
      const stepLabel = step
        ? `Step ${idx + 1}: ${step.name} (${c.sender_domain || 'unknown'})`
        : `Reply ${c.sequence}`;
      const dashes = '-'.repeat(Math.min(stepLabel.length, 60));
      return [
        stepLabel,
        dashes,
        proofRender.plainReceipt(c),
      ].join('\n');
    });
    return sections.join('\n\n');
  }
  if (event.type === 'crypto' && event.mode === 'declaration') {
    const c = commits[0];
    if (!c) return '';
    return [
      'Cryptographic receipt',
      '---------------------',
      proofRender.plainReceipt(c),
    ].join('\n');
  }
  if (event.type === 'crypto' && event.mode === 'attestation') {
    const ag = proofRender.aggregateTrust(commits);
    const lines = [
      'Cryptographic receipt',
      '---------------------',
      `Replies counted   ${commits.length}`,
      `Modal trust       ${ag.modal || 'unknown'}`,
    ];
    const c = ag.counts;
    if (c.verified) lines.push(`Verified          ${c.verified}`);
    if (c.forwarded) lines.push(`Forwarded         ${c.forwarded}`);
    if (c.authorized) lines.push(`Authorized        ${c.authorized}`);
    if (c.unverified) lines.push(`Unverified        ${c.unverified}`);
    // Surface the recipient's own contribution if matched.
    if (recipient) {
      const own = commits.find((cm) => cm.sender_domain && recipient.toLowerCase().endsWith('@' + cm.sender_domain.toLowerCase()));
      if (own) {
        lines.push('');
        lines.push('Your contribution');
        lines.push('-----------------');
        lines.push(proofRender.plainReceipt(own));
      }
    }
    return lines.join('\n');
  }
  return '';
}

// Email everyone who contributed to an event + the initiator when the
// event transitions to complete (all steps done, or organiser close,
// or declaration signed). One email per distinct address. Plain text,
// DKIM-signed via the MTA milter. Best-effort — failures don't block
// the completion commit itself.
//
// `commits` (optional) is the list of reply commits that count toward
// the event's outcome — if provided, the email body embeds the
// cryptographic receipt(s). When supplied, the message is the durable
// PROOF email; the Message-Id is returned to the caller so the
// OTS-anchored follow-up can thread to it.
async function notifyEventCompletion(event, { reason = 'all_steps_done', publicBaseUrl, completedStepId, commits } = {}) {
  if (!event) return [];
  const completedAt = (event.completion && event.completion.completed_at) || new Date().toISOString();
  const finalStep = completedStepId && Array.isArray(event.steps)
    ? event.steps.find((s) => s.id === completedStepId)
    : null;
  const finalIdx = finalStep ? event.steps.indexOf(finalStep) : -1;
  const recipients = new Set();
  if (event.initiator) recipients.add(event.initiator.toLowerCase());
  if (event.type === 'event' && Array.isArray(event.steps)) {
    for (const s of event.steps) {
      if (s && s.participant) recipients.add(s.participant.toLowerCase());
    }
  } else if (event.type === 'crypto' && event.mode === 'declaration' && event.signer) {
    recipients.add(event.signer.toLowerCase());
  }
  // Attestation: anonymous addresses are stored as salted hashes only —
  // we never have plaintext to reach those repliers. The initiator
  // gets the proof email and can verify offline; counted repliers got
  // their per-reply ack at receive time.

  // Keep vocabulary in sync with the /manage hub pills: "completed"
  // means every step ran its full course; "closed early" means the
  // organiser ended it with work still pending. Declaration is its
  // own natural completion.
  const isClosedEarly = reason === 'closed_by_initiator';
  const isDeclaration = reason === 'declaration_signed';
  const reasonLabel = isClosedEarly
    ? 'closed early by the organiser'
    : (isDeclaration ? 'the signer replied' : 'all steps completed');
  const subjectVerb = isClosedEarly ? 'closed early' : 'completed';
  const greetingParticiple = isClosedEarly ? 'been closed' : 'completed';
  const repoHint = event.id ? `  Event repo: git-done.com/events/${event.id} (auth required)` : '';
  const steps = (event.steps || []).map((s, i) => {
    const status = s.status === 'complete' ? 'DONE' : (s.status || 'pending').toUpperCase();
    return `  ${i + 1}. ${s.name} — ${status}`;
  }).join('\n');

  // ASCII-only middle dot replacement: receive.js outbound rule is
  // strict. plainReceipt + the rest of this body have to stay 7-bit.
  const proofBlock = renderProofBlock(event, commits, {});
  // Bound the per-recipient receipt: organisers see all step receipts,
  // participants see only their own step.
  const receiptForParticipant = (participantEmail) => {
    if (!commits) return '';
    if (event.type !== 'event') return renderProofBlock(event, commits, { recipient: participantEmail });
    const own = commits.filter((c) => {
      const step = (event.steps || []).find((s) => s.id === c.step_id);
      return step && step.participant && step.participant.toLowerCase() === participantEmail.toLowerCase();
    });
    return renderProofBlock(event, own, {});
  };
  const verifyHint = event.id
    ? [
        '',
        'Verify offline:',
        `  gitdone-verify ${event.id}`,
      ].join('\n')
    : '';

  const jobs = [...recipients].map((to) => {
    const isOrganiser = event.initiator && to === event.initiator.toLowerCase();
    let body;
    if (isOrganiser) {
      const receipts = proofBlock
        ? ['', proofBlock].join('\n')
        : '';
      body = [
        `The event you organized has ${greetingParticiple}.`,
        ``,
        commits ? 'This email is your durable proof of completion. Keep it forever -- it' : '',
        commits ? 'verifies offline against the per-event git repository, even if gitdone' : '',
        commits ? 'goes away.' : '',
        commits ? '' : '',
        `Event: ${event.title}`,
        `Event ID: ${event.id}`,
        `${isClosedEarly ? 'Closed' : 'Completed'}: ${completedAt}`,
        `Reason: ${reasonLabel}`,
        finalStep ? `Final step: #${finalIdx + 1} "${finalStep.name}" by ${finalStep.participant}` : '',
        ``,
        steps ? `Steps:` : '',
        steps,
        steps ? `` : '',
        receipts,
        verifyHint,
        ``,
        `The full audit trail is stored as a git repository with one commit per`,
        `reply, DKIM keys archived, and OpenTimestamps proofs attached. Anyone`,
        `can verify it offline with the gitdone-verify CLI, even if gitdone itself`,
        `goes away -- the proofs outlive the service.`,
        ``,
        repoHint,
        `  Organiser: ${event.initiator}`,
      ].filter((l) => l !== '').join('\n');
    } else {
      // Slim participant version. Do NOT leak the step table — that's
      // private to the organiser. Participants see only what they need:
      // the event closed, reason, and how to verify their own record.
      const ownReceipt = receiptForParticipant(to);
      body = [
        `An event you contributed to has ${greetingParticiple}.`,
        ``,
        commits ? 'This email is your durable proof of completion. Keep it forever -- it' : '',
        commits ? "verifies offline against the event's git audit trail." : '',
        commits ? '' : '',
        `Event: ${event.title}`,
        `Reason: ${reasonLabel}`,
        ``,
        ownReceipt,
        ownReceipt ? '' : '',
        verifyHint,
        ``,
        `Your reply is recorded in the event's git audit trail (DKIM-verified,`,
        `OpenTimestamped) and will stay verifiable offline even if gitdone`,
        `itself goes away.`,
        ``,
        `  Organised by ${event.initiator}`,
      ].filter((l) => l !== '').join('\n');
    }
    // Workflow events get a [done/total] tag so the organiser sees at
    // a glance whether everything ran ([5/5] = full completion) or
    // closed early with pending work ([3/5]). Crypto events have no
    // step counter.
    let counterTag = '';
    if (event.type === 'event' && Array.isArray(event.steps) && event.steps.length) {
      const done = event.steps.filter((s) => s.status === 'complete').length;
      counterTag = ` [${done}/${event.steps.length}]`;
    }
    // When commits are supplied the email IS the durable proof — say
    // so in the subject. Workflow keeps [N/M] for at-a-glance
    // completion state; crypto drops the counter.
    const subject = commits
      ? `[gitdone] proof — "${event.title}"${event.type === 'event' ? counterTag : ''}`
      : `[gitdone] "${event.title}" — ${subjectVerb}${counterTag}`;
    return sendOne({
      to,
      subject,
      body,
      event,
    });
  });
  return Promise.all(jobs);
}

// "▸" marks every step the organiser is currently waiting on. Shared
// by activation and per-step-transition emails so the visual cue stays
// consistent.
function renderOrganiserStepList(event, activeStepIds) {
  const active = new Set(activeStepIds || []);
  return event.steps.map((s, i) => {
    const marker = active.has(s.id) ? '▸' : ' ';
    const status = s.status === 'complete' ? 'DONE' : (s.status || 'pending');
    const tail = [];
    if (s.depends_on && s.depends_on.length) {
      const after = s.depends_on.map((id) => {
        const idx = event.steps.findIndex((x) => x.id === id);
        return idx >= 0 ? `#${idx + 1}` : id;
      }).join(', ');
      tail.push(`after ${after}`);
    }
    if (s.deadline) tail.push(`deadline ${String(s.deadline).slice(0, 10)}`);
    if (s.requires_attachment) tail.push('attachment required');
    const tailStr = tail.length ? `  (${tail.join(', ')})` : '';
    return `  ${marker} ${i + 1}. ${s.name} → ${s.participant}  [${status}]${tailStr}`;
  }).join('\n');
}

// Email the organiser when a pending event is activated. Confirms what
// just left the server, lists every step, and marks (▸) the steps
// participants are waiting on right now — i.e. the "roots" of the DAG.
async function notifyOrganiserOfActivation(event, { sendResults = [], publicBaseUrl } = {}) {
  if (!event || event.type !== 'event' || !event.initiator) return null;
  const roots = event.steps.filter((s) => !s.depends_on || s.depends_on.length === 0);
  const activeIds = roots.map((s) => s.id);
  const baseUrl = publicBaseUrl || process.env.GITDONE_PUBLIC_URL || `https://${config.domain}`;
  const deliveryLines = sendResults.length
    ? sendResults.map((r) => `  ${r.ok ? 'sent  ' : 'FAILED'} → ${r.to}${r.ok ? '' : `  (${r.reason || r.code || 'unknown error'})`}`).join('\n')
    : '';
  const body = [
    `Your event is now active. Invitations have been sent to the participants`,
    `whose steps are unblocked (▸ in the list below). Downstream participants`,
    `will be invited automatically as their dependencies complete.`,
    ``,
    `Event: ${event.title}`,
    `Activated: ${event.activated_at || new Date().toISOString()}`,
    ``,
    `Steps (▸ = waiting on this person now):`,
    renderOrganiserStepList(event, activeIds),
    ``,
    deliveryLines ? `Delivery:` : '',
    deliveryLines,
    deliveryLines ? `` : '',
    `If a participant's address bounces you'll get a separate "invitation`,
    `bounced" email and the dashboard will show "delivery failed" on that step.`,
    ``,
    `Manage: ${baseUrl}/manage/event/${event.id}`,
  ].filter((l) => l !== '').join('\n');
  return sendOne({
    to: event.initiator,
    subject: `[gitdone] "${event.title}" — activated, ${activeIds.length} invitation${activeIds.length === 1 ? '' : 's'} sent`,
    body,
    event,
  });
}

// Email the organiser when a step completes and one or more downstream
// steps become the new active set. Keeps the organiser in the loop
// without forcing them to poll the dashboard.
async function notifyOrganiserOfStepProgress(event, { completedStepId, newlyActiveSteps = [], publicBaseUrl } = {}) {
  if (!event || event.type !== 'event' || !event.initiator) return null;
  const completedIdx = event.steps.findIndex((s) => s.id === completedStepId);
  const completed = completedIdx >= 0 ? event.steps[completedIdx] : null;
  if (!completed) return null;
  const activeIds = newlyActiveSteps.map((s) => s.id);
  const baseUrl = publicBaseUrl || process.env.GITDONE_PUBLIC_URL || `https://${config.domain}`;
  // Match by id, not reference: future refactors that clone steps would
  // silently produce #0 with indexOf.
  const idxOfStep = (s) => event.steps.findIndex((x) => x.id === s.id);
  const newlyActiveLabel = newlyActiveSteps.length === 0
    ? 'No new steps unblocked yet (still waiting on other dependencies).'
    : `Now waiting on: ${newlyActiveSteps.map((s) => `#${idxOfStep(s) + 1} ${s.name} (${s.participant})`).join(', ')}.`;
  const body = [
    `Step #${completedIdx + 1} "${completed.name}" was just completed by ${completed.participant}.`,
    ``,
    newlyActiveLabel,
    ``,
    `Event: ${event.title}`,
    ``,
    `Steps (▸ = waiting on this person now):`,
    renderOrganiserStepList(event, activeIds),
    ``,
    `Manage: ${baseUrl}/manage/event/${event.id}`,
  ].join('\n');
  return sendOne({
    to: event.initiator,
    subject: `[gitdone] "${event.title}" [${completedIdx + 1}/${event.steps.length}] step done${newlyActiveSteps.length ? ' · next active' : ''}`,
    body,
    event,
  });
}

// Email the proof recipients (initiator + signer/participants) when the
// last pending OTS proof for an event is upgraded to a Bitcoin anchor.
// Threaded via In-Reply-To/References to the original completion proof
// email if event.proof_email_message_id is set; standalone otherwise.
//
// `anchorInfo` carries the upgrade summary {block_height?, anchored_at}
// from the OTS-upgrade worker.
async function notifyProofAnchored(event, { anchorInfo = {}, publicBaseUrl } = {}) {
  if (!event) return [];
  const recipients = new Set();
  if (event.initiator) recipients.add(event.initiator.toLowerCase());
  if (event.type === 'event' && Array.isArray(event.steps)) {
    for (const s of event.steps) {
      if (s && s.participant && s.status === 'complete') recipients.add(s.participant.toLowerCase());
    }
  } else if (event.type === 'crypto' && event.mode === 'declaration' && event.signer) {
    recipients.add(event.signer.toLowerCase());
  }
  // Attestation: anonymous repliers — only the initiator gets the
  // anchored email.

  const blockLine = anchorInfo.block_height
    ? `Block height   ${anchorInfo.block_height}`
    : 'Block height   (anchored, height not parsed)';
  const anchoredAt = anchorInfo.anchored_at || new Date().toISOString();
  const proofPath = anchorInfo.proof_path
    ? `Proof file     ${anchorInfo.proof_path}`
    : `Proof file     ${event.id}/ots_proofs/`;
  const body = [
    `The cryptographic proof for "${event.title}" is now permanently anchored`,
    `to the Bitcoin blockchain.`,
    ``,
    `Anchored`,
    `--------`,
    blockLine,
    `Anchored at    ${anchoredAt}`,
    proofPath,
    ``,
    `Combined with the DKIM signature on every reply (archived per-event)`,
    `and the git commit chain, this gives you offline-verifiable proof`,
    `that the contents existed at this point in time.`,
    ``,
    `Verify offline:`,
    `  gitdone-verify ${event.id}`,
  ].join('\n');

  const inReplyTo = event.proof_email_message_id || null;
  const references = event.proof_email_message_id || null;
  const jobs = [...recipients].map((to) => sendOne({
    to,
    subject: `[gitdone] proof anchored — "${event.title}"`,
    body,
    event,
    inReplyTo,
    references,
  }));
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
  notifyProofAnchored,
  notifyOrganiserOfActivation,
  notifyOrganiserOfStepProgress,
  workflowStepBody,
  declarationSignerBody,
  renderOrganiserStepList,
  renderProofBlock,
};
