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
const { isStrictAttestation } = require('./email-recipients');
const bodies = require('./email-bodies');
// Body text + the helpers it shares with the senders now live in
// email-bodies.js. Re-exported below where tests import them.
const {
  renderProofBlock, renderOrganiserStepList,
  stepReplyAddr, cryptoReplyAddr,
  workflowStepBody, declarationSignerBody,
} = bodies;

function gitdoneFrom() {
  return `gitdone@${config.domain}`;
}

// workflowStepBody + declarationSignerBody now live in
// app/src/email-bodies.js (imported above, re-exported below).

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

// renderProofBlock + renderOrganiserStepList now live in
// app/src/email-bodies.js (imported above and re-exported below for
// test compatibility).

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

  // Recipients via the single resolver (email-recipients.js); body +
  // subject text via the catalogue (email-bodies.js). The shared
  // per-edge context is computed once, then each recipient's body is
  // picked by (kind, role).
  const { getRecipients } = require('./email-recipients');
  const isClosedEarly = reason === 'closed_by_initiator';
  const recipients = new Set(getRecipients(event, isClosedEarly ? 'closed' : 'completed').keys());
  const ctx = bodies.lifecycle.completed.context(event, { reason, completedStepId, commits });
  const subject = bodies.lifecycle.completed.subject(event, ctx);

  const jobs = [...recipients].map((to) => {
    const isOrganiser = event.initiator && to === event.initiator.toLowerCase();
    let body;
    if (ctx.isWorkflow) {
      body = isOrganiser
        ? bodies.lifecycle.completed.workflow.organiser(event, ctx)
        : bodies.lifecycle.completed.workflow.participant(event, ctx, to);
    } else if (ctx.isDeclaration) {
      body = bodies.lifecycle.completed.declaration(event, ctx, isOrganiser);
    } else if (ctx.isAttestation) {
      body = isOrganiser
        ? bodies.lifecycle.completed.attestation.organiser(event, ctx)
        : bodies.lifecycle.completed.attestation.attestor(event, ctx, to);
    }
    return sendOne({
      to,
      subject,
      body,
      event,
    });
  });
  return Promise.all(jobs);
}

// Email the organiser when a pending event is activated. Confirms what
// just left the server, lists every step, and marks (▸) the steps
// participants are waiting on right now — i.e. the "roots" of the DAG.
// Body/subject text lives in email-bodies.js (lifecycle.activated).
async function notifyOrganiserOfActivation(event, { sendResults = [], publicBaseUrl } = {}) {
  if (!event || event.type !== 'event' || !event.initiator) return null;
  const { subject, body } = bodies.lifecycle.activated(event, { sendResults, publicBaseUrl });
  return sendOne({ to: event.initiator, subject, body, event });
}

// Module 4d#3 — on activation, when a crypto event cites a
// reference_url but no documents have been registered yet, email the
// initiator with explicit instructions on how to register the doc set.
// The signer invite is held until they do this (Module 4c flow).
async function notifyInitiatorAttachDocsNeeded(event, { publicBaseUrl } = {}) {
  if (!event || event.type !== 'crypto' || !event.initiator) return null;
  if (!event.reference_url) return null;
  if (Array.isArray(event.reference_docs) && event.reference_docs.length > 0) return null;
  // Body/subject/replyTo from the catalogue (invite.attachDocsNeeded).
  const { subject, body, replyTo } = bodies.invite.attachDocsNeeded(event, { publicBaseUrl });
  return sendOne({ to: event.initiator, subject, body, event, replyTo });
}

// Email the organiser when a step completes and one or more downstream
// steps become the new active set. Keeps the organiser in the loop
// without forcing them to poll the dashboard.
async function notifyOrganiserOfStepProgress(event, { completedStepId, newlyActiveSteps = [], publicBaseUrl } = {}) {
  if (!event || event.type !== 'event' || !event.initiator) return null;
  // Body/subject text lives in email-bodies.js (lifecycle.progressed);
  // it returns null when the completed step can't be located.
  const out = bodies.lifecycle.progressed(event, { completedStepId, newlyActiveSteps, publicBaseUrl });
  if (!out) return null;
  return sendOne({ to: event.initiator, subject: out.subject, body: out.body, event });
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
  // Same resolver as notifyEventCompletion — see email-recipients.js.
  // The 'anchored' edge is the post-completion follow-up: every contributor
  // who got the proof email gets the anchored confirmation. Attestation
  // (strict or loose) goes organiser-only here by design — anchor fires
  // post-close, after strict-attestation emails are redacted.
  const { getRecipients } = require('./email-recipients');
  const recipients = new Set(getRecipients(event, 'anchored').keys());

  // Body/subject text lives in email-bodies.js (lifecycle.anchored).
  const { subject, body } = bodies.lifecycle.anchored(event, { anchorInfo });

  const inReplyTo = event.proof_email_message_id || null;
  const references = event.proof_email_message_id || null;
  const jobs = [...recipients].map((to) => sendOne({
    to,
    subject,
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

// ---------------------------------------------------------------------------
// Single lifecycle-edge dispatcher.
//
// notifyLifecycleEdge(event, edge, payload) is the ONE entry point for
// per-event (B-axis) lifecycle notifications. It routes the edge to the
// right composer, normalises every return to a results array
// ([{ to, ok, message_id?, reason? }, ...]), and owns the edge-specific
// side effects that were previously copy-pasted across call sites.
//
// Edges (match the per-event taxonomy in docs/01-product/emails.md and
// the resolver in email-recipients.js):
//   completed  → threshold reached / all steps done   (proof email)
//   closed     → closed early by initiator             (proof email + redaction)
//   anchored   → OTS proof upgraded to a BTC anchor    (follow-up)
//   activated  → pending event went live               (organiser confirm)
//   progressed → a workflow step completed, next active (organiser update)
//
// Side effects this function owns:
//   * edge === 'closed' AND strict attestation → redactAttestorEmails,
//     fired POST-notify. This was the identical 11-line block duplicated
//     in receive.js (close+ committed) and server.js (dashboard close);
//     folding it here kills that dual-source-of-truth. redactAttestorEmails
//     is idempotent (alreadyRedacted guard), so a call site that hasn't
//     migrated yet and still redacts inline is harmless.
//
// Deliberately NOT owned here: a generic `${edge}_notified_at` idempotency
// stamp. The original handoff plan called for one, but a per-notify
// updateEventAtomic write would add a non-semantic "lifecycle edge
// notified" commit to the per-event git repo on every send — and that
// repo IS the proof artifact. Polluting it with notification bookkeeping
// is the wrong trade for a system whose whole pitch is a clean,
// offline-verifiable audit trail. Re-fire is instead prevented per edge
// by state that already exists, so no extra stamp is needed:
//   * completed / closed — gated by the proof_email_sent_at vs
//     completion.completed_at comparison in receive.js (the gate the
//     oversubscribe-revoke-reopen regression test guards). A second
//     gating field would risk breaking re-fire.
//   * activated — gated by activateEvent's mutex + alreadyActive return
//     and the event.activated_at early-return in the activate handler.
//     Web-triggered, so a mail re-delivery can't re-fire it; a
//     double-click / retry hits the guard.
//   * progressed — gated by idempotent reply application: a re-delivered
//     reply hits an already-complete step → "already-done" ack, so the
//     step doesn't re-complete and the progressed block never re-enters.
// If observability needs the stamp later, add it as a NON-gating field
// written alongside an existing semantic commit, never on its own.
async function notifyLifecycleEdge(event, edge, payload = {}) {
  if (!event) return [];
  const asArray = (r) => (Array.isArray(r) ? r : (r ? [r] : []));

  let results;
  switch (edge) {
    case 'completed':
      results = await notifyEventCompletion(event, {
        reason: payload.reason || 'all_steps_done',
        completedStepId: payload.completedStepId,
        commits: payload.commits,
      });
      break;

    case 'closed':
      results = await notifyEventCompletion(event, {
        reason: 'closed_by_initiator',
        commits: payload.commits,
      });
      break;

    case 'anchored':
      results = await notifyProofAnchored(event, { anchorInfo: payload.anchorInfo });
      break;

    case 'activated':
      results = asArray(await notifyOrganiserOfActivation(event, {
        sendResults: payload.sendResults,
      }));
      break;

    case 'progressed':
      results = asArray(await notifyOrganiserOfStepProgress(event, {
        completedStepId: payload.completedStepId,
        newlyActiveSteps: payload.newlyActiveSteps,
      }));
      break;

    default:
      throw new Error(`notifyLifecycleEdge: unknown edge "${edge}"`);
  }
  results = asArray(results);

  // Side effect: close-by-initiator is the terminal signal. Redact
  // strict-attestation attestor emails now (post-notify) so PII doesn't
  // linger past the event's active life. event.id drives a fresh
  // read-modify-write; best-effort — a redaction failure never undoes
  // the notification.
  if (edge === 'closed' && isStrictAttestation(event)) {
    try {
      const { redactAttestorEmails } = require('./completion');
      await redactAttestorEmails(event.id, payload.now ? { now: payload.now } : {});
    } catch (err) {
      process.stderr.write(`lifecycle-edge-redact: ${err.message || err}\n`);
    }
  }

  return results;
}

module.exports = {
  // The single lifecycle-edge entry point. Every per-event (B-axis)
  // notification goes through here.
  notifyLifecycleEdge,
  // Invite / setup notifications — NOT lifecycle edges, so they stay
  // as their own exported functions (step invites, signer invite,
  // attach-docs prompt). External callers: receive.js, server.js,
  // email-commands.js.
  notifyWorkflowParticipants,
  notifyDeclarationSigner,
  notifyInitiatorAttachDocsNeeded,
  // Body composers still imported by tests. The lifecycle composers
  // (notifyEventCompletion, notifyProofAnchored, notifyOrganiserOf*)
  // are intentionally NOT exported — they are private implementation
  // of notifyLifecycleEdge now. Their body logic moves to
  // email-bodies.js in a later phase, after which they collapse into
  // the dispatcher.
  workflowStepBody,
  declarationSignerBody,
  renderOrganiserStepList,
  renderProofBlock,
};
