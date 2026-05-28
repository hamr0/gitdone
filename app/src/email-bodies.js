// app/src/email-bodies.js
//
// The body/subject catalogue for per-event (B-axis) lifecycle emails.
// One named template per (edge, event-kind, role), following the tree
// in docs/01-product/emails.md. Senders (notifications.js) never
// compose body text inline — they resolve recipients (email-recipients.js),
// pick the template by (edge, kind, role), and hand the result to sendOne.
//
// Each lifecycle template returns either a body string or, for the
// single-recipient edges (activated/progressed/anchored), a
// { subject, body } pair. The multi-recipient completed/closed edge
// exposes a shared `context()` builder (the pieces every recipient's
// body shares), a per-event `subject()`, and per-(kind, role) body
// builders that take that context.
//
// Dependency direction: this module requires completion.js + the
// web/proof-render helper, never notifications.js — so notifications.js
// can require it without a cycle. The two render helpers
// (renderProofBlock, renderOrganiserStepList) live here because they
// are body rendering; notifications.js re-exports them so existing
// test imports keep working.
//
// 0.25.0 shipped the recipient resolver + dispatcher. This file is the
// 0.25.1 follow-up: it moves the lifecycle body text out of the
// (now-private) composers in notifications.js. Output is byte-identical
// to the pre-extraction composers — guarded by the proof-email,
// strict-signing, web-notifications, and oversubscribe-revoke-reopen
// tests, all of which assert on body/subject shape.

'use strict';

const config = require('./config');
const proofRender = require('./web/proof-render');
const { revokedHashSet, hashSender, isComplete } = require('./completion');
const { formatProgressBlock } = require('./ack-progress');

// --- reply-address + date helpers (moved from notifications.js) ---
// The invite bodies embed these addresses in their text; the senders
// also use stepReplyAddr/cryptoReplyAddr for the message Reply-To. One
// home for the address format keeps the body text and the header in
// lockstep.

function stepReplyAddr(event, stepId) {
  return `event+${event.id}-${stepId}@${config.domain}`;
}

function cryptoReplyAddr(event) {
  return `event+${event.id}@${config.domain}`;
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

// ---------------------------------------------------------------------------
// Shared render helpers (moved verbatim from notifications.js).
// ---------------------------------------------------------------------------

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
    // The receipt's primary line uses the SAME unit as event.threshold
    // so "N / T" reads as the threshold comparison. Three modes:
    //   - strict (reference_url + reference_docs): complete attestor
    //     buckets — the unit the engine actually compares to threshold.
    //   - loose accumulating: raw live replies (multi-counts are the
    //     point of accumulating).
    //   - loose unique/latest: distinct sender_hashes — one signer,
    //     one count.
    // Raw audit count surfaces as a second line only when it differs
    // from the primary (multi-doc submissions, accumulating with
    // revokes, etc.), so the durable record still matches the git log.
    const revokedSet = revokedHashSet(event);
    const liveCommits = revokedSet.size > 0
      ? commits.filter((c) => !c.sender_hash || !revokedSet.has(c.sender_hash))
      : commits;
    const ag = proofRender.aggregateTrust(liveCommits);
    const isStrict = !!event.reference_url
      && Array.isArray(event.reference_docs)
      && event.reference_docs.length > 0;
    const dedup = event.dedup || 'unique';
    let primaryLabel; let primaryN;
    if (isStrict) {
      primaryLabel = 'Attestors complete';
      const progressMap = event.attestor_progress || {};
      primaryN = Object.keys(progressMap)
        .filter((k) => progressMap[k] && progressMap[k].complete && !revokedSet.has(k))
        .length;
    } else if (dedup === 'accumulating') {
      primaryLabel = 'Replies';
      primaryN = liveCommits.length;
    } else {
      primaryLabel = 'Signers';
      const distinct = new Set();
      for (const c of liveCommits) {
        if (c.sender_hash) distinct.add(c.sender_hash);
      }
      primaryN = distinct.size || liveCommits.length;
    }
    const t = event.threshold != null ? String(event.threshold) : '?';
    const lines = [
      'Cryptographic receipt',
      '---------------------',
      `${primaryLabel.padEnd(18)} ${primaryN} / ${t}`,
    ];
    const auditN = commits.length;
    if (revokedSet.size > 0 || auditN !== primaryN) {
      lines.push(`Replies in audit  ${auditN}`);
    }
    if (revokedSet.size > 0) {
      lines.push(`Revoked           ${auditN - liveCommits.length}`);
    }
    lines.push(`Modal trust       ${ag.modal || 'unknown'}`);
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

// ---------------------------------------------------------------------------
// lifecycle.completed / closed — the durable proof email.
//
// Multi-recipient, per-(kind, role) bodies that share a context. The
// 'closed' edge is just 'completed' with reason='closed_by_initiator'
// (carried in the context as isClosedEarly).
// ---------------------------------------------------------------------------

// Per-recipient own-receipt for a strict-attestation attestor. Pinpoints
// THIS attestor's commit(s) by recomputing their salted sender_hash from
// the event salt — tighter than matching by sender_domain (multiple
// gmail attestors would collide).
function ownReceiptForAttestor(event, commits, attestorEmail) {
  if (!commits || !event.salt) return '';
  const hash = hashSender(attestorEmail, event.salt);
  const own = commits.filter((c) => c && c.sender_hash === hash);
  if (own.length === 0) return '';
  return [
    'Your receipt',
    '------------',
    ...own.map((c) => proofRender.plainReceipt(c)),
  ].join('\n');
}

function ownReceiptForStepParticipant(event, commits, participantEmail) {
  if (!commits) return '';
  const own = commits.filter((c) => {
    const step = (event.steps || []).find((s) => s.id === c.step_id);
    return step && step.participant && step.participant.toLowerCase() === participantEmail.toLowerCase();
  });
  return renderProofBlock(event, own, {});
}

// The pieces every recipient's completed/closed body shares. Computed
// once per send by notifyEventCompletion, then threaded into the
// per-(kind, role) body builders below.
function completedContext(event, { reason = 'all_steps_done', completedStepId, commits } = {}) {
  const completedAt = (event.completion && event.completion.completed_at) || new Date().toISOString();
  const finalStep = completedStepId && Array.isArray(event.steps)
    ? event.steps.find((s) => s.id === completedStepId)
    : null;
  const finalIdx = finalStep ? event.steps.indexOf(finalStep) : -1;

  const isWorkflow = event.type === 'event';
  const isDeclaration = event.type === 'crypto' && event.mode === 'declaration';
  const isAttestation = event.type === 'crypto' && event.mode === 'attestation';
  const isClosedEarly = reason === 'closed_by_initiator';

  // Mode-aware reason label so the body doesn't lie about what closed
  // the event ("Reason: all steps completed" on a crypto event was the
  // bug). subjectVerb stays generic so non-proof completion emails
  // (commits===undefined) keep working.
  const reasonLabel = isClosedEarly
    ? 'closed early by the organiser'
    : (isDeclaration
        ? 'the signer replied'
        : (isAttestation ? 'threshold reached' : 'all steps completed'));
  const subjectVerb = isClosedEarly ? 'closed early' : 'completed';

  // "Mode:" line for the body — clarifies what KIND of completion this
  // is, with the dedup rule when it changes the semantics. The
  // organiser already knows; the signer/attestor may not. Either way
  // the durable proof email should carry the answer.
  const dedupBlurb = isAttestation
    ? (event.dedup === 'unique'
        ? 'unique (one count per sender)'
        : (event.dedup === 'latest'
            ? 'latest (latest counts per sender)'
            : 'accumulating (every reply counts)'))
    : null;
  const modeLine = isWorkflow
    ? 'Mode: Workflow'
    : (isDeclaration
        ? 'Mode: Declaration (one signer, one record)'
        : `Mode: Attestation - ${dedupBlurb} - threshold ${event.threshold || '?'}`);

  // Reference URL + manifest get echoed when set — they are the WHAT
  // being signed and belong in the durable receipt. Hash-truncated so
  // the email stays readable; the full hash lives in the commit JSON.
  const refUrlLine = event.reference_url ? `Reference: ${event.reference_url}` : '';
  const refDocsBlock = (Array.isArray(event.reference_docs) && event.reference_docs.length)
    ? [
        '',
        `Reference documents (${event.reference_docs.length}):`,
        ...event.reference_docs.map((d) => {
          const h = (d.sha256 || '').replace(/^sha256:/, '');
          const head = h.slice(0, 8);
          const tail = h.slice(-8);
          return `  ${d.filename || '(unnamed)'}  sha256:${head}...${tail}`;
        }),
      ].join('\n')
    : '';

  const greetingParticiple = isClosedEarly ? 'been closed' : 'completed';
  const repoHint = event.id ? `  Event repo: git-done.com/events/${event.id} (auth required)` : '';
  const steps = (event.steps || []).map((s, i) => {
    const status = s.status === 'complete' ? 'DONE' : (s.status || 'pending').toUpperCase();
    return `  ${i + 1}. ${s.name} - ${status}`;
  }).join('\n');

  const proofBlock = renderProofBlock(event, commits, {});
  const verifyHint = event.id
    ? [
        '',
        'Verify offline:',
        `  gitdone-verify ${event.id}`,
      ].join('\n')
    : '';

  return {
    commits,
    completedAt, finalStep, finalIdx,
    isWorkflow, isDeclaration, isAttestation, isClosedEarly,
    reasonLabel, subjectVerb, modeLine,
    refUrlLine, refDocsBlock,
    greetingParticiple, repoHint, steps,
    proofBlock, verifyHint,
  };
}

// Per-event subject for the completed/closed proof email. Same for
// every recipient (does not vary by `to`).
function completedSubject(event, ctx) {
  const { isWorkflow, isAttestation, isClosedEarly, subjectVerb, commits } = ctx;
  // Workflow keeps [done/total]; attestation gains [effective/threshold]
  // (revoke-filtered — the subject must match what the body says, and
  // post-Module-9 the user-facing count drops revoked sender_hashes);
  // declaration has no natural counter.
  let counterTag = '';
  if (isWorkflow && Array.isArray(event.steps) && event.steps.length) {
    const done = event.steps.filter((s) => s.status === 'complete').length;
    counterTag = ` [${done}/${event.steps.length}]`;
  } else if (isAttestation && event.threshold) {
    const replies = Array.isArray(event.replies) ? event.replies : [];
    const revokedSubjSet = revokedHashSet(event);
    let counted;
    if (event.dedup === 'unique' || event.dedup === 'latest') {
      const distinct = new Set(replies.map((r) => r.sender_hash).filter(Boolean));
      counted = Array.from(distinct).filter((h) => !revokedSubjSet.has(h)).length;
    } else {
      counted = replies.reduce((n, r) => n + (revokedSubjSet.has(r.sender_hash) ? 0 : 1), 0);
    }
    counterTag = ` [${counted}/${event.threshold}]`;
  }
  // Module 9 — when closed early, the subject says so. Otherwise the
  // proof recipient can't tell from the subject alone whether the
  // event reached threshold naturally or was cut short.
  const closedEarlyTag = (isClosedEarly && isAttestation) ? ' — closed early' : '';
  return commits
    ? `[gitdone] proof — "${event.title}"${closedEarlyTag}${counterTag}`
    : `[gitdone] "${event.title}" — ${subjectVerb}${counterTag}`;
}

const completed = {
  context: completedContext,
  subject: completedSubject,

  workflow: {
    // Organiser sees the full step table + per-step receipts.
    organiser(event, ctx) {
      const { commits, modeLine, isClosedEarly, completedAt, reasonLabel,
        finalStep, finalIdx, steps, verifyHint, repoHint, greetingParticiple, proofBlock } = ctx;
      const receipts = proofBlock ? ['', proofBlock].join('\n') : '';
      return [
        `The event you organized has ${greetingParticiple}.`,
        ``,
        commits ? 'This email is your durable proof of completion. Keep it forever --' : '',
        commits ? 'it verifies offline against the per-event git repository, even if' : '',
        commits ? 'gitdone goes away.' : '',
        commits ? '' : '',
        `Event: ${event.title}`,
        `Event ID: ${event.id}`,
        modeLine,
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
        `can verify it offline with the gitdone-verify CLI, even if gitdone`,
        `itself goes away -- the proofs outlive the service.`,
        ``,
        repoHint,
        `  Organiser: ${event.initiator}`,
      ].filter((l) => l !== '').join('\n');
    },
    // Participants see only their own step's receipt.
    participant(event, ctx, recipient) {
      const { commits, modeLine, reasonLabel, verifyHint, greetingParticiple } = ctx;
      const ownReceipt = ownReceiptForStepParticipant(event, commits, recipient);
      return [
        `An event you contributed to has ${greetingParticiple}.`,
        ``,
        commits ? 'This email is your durable proof of completion. Keep it forever --' : '',
        commits ? "it verifies offline against the event's git audit trail." : '',
        commits ? '' : '',
        `Event: ${event.title}`,
        modeLine,
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
    },
  },

  // Symmetric two-recipient notary. Same body for organiser and signer
  // — both have equal stake in the durable record. The signer's identity
  // is in the receipt; whoever sees this email can verify offline who
  // signed what, when.
  declaration(event, ctx, isOrganiser) {
    const { commits, modeLine, completedAt, refUrlLine, refDocsBlock,
      verifyHint, repoHint, proofBlock } = ctx;
    const receipts = proofBlock ? ['', proofBlock].join('\n') : '';
    return [
      isOrganiser
        ? `The declaration you organised has been signed.`
        : `Your signature on a declaration has been recorded.`,
      ``,
      commits ? 'This email is your durable proof. Keep it forever -- it verifies' : '',
      commits ? 'offline against the per-event git repository, even if gitdone goes' : '',
      commits ? 'away.' : '',
      commits ? '' : '',
      `Event: ${event.title}`,
      `Event ID: ${event.id}`,
      modeLine,
      `Signed: ${completedAt}`,
      `Signer: ${event.signer || '(unknown)'}`,
      `Organiser: ${event.initiator}`,
      refUrlLine,
      refDocsBlock,
      ``,
      receipts,
      verifyHint,
      ``,
      `The audit trail is stored as a git repository with DKIM keys archived`,
      `and OpenTimestamps proofs attached. Anyone can verify it offline`,
      `with the gitdone-verify CLI, even if gitdone itself goes away --`,
      `the proofs outlive the service.`,
      ``,
      repoHint,
    ].filter((l) => l !== '').join('\n');
  },

  attestation: {
    // Organiser sees the aggregate trust posture — that's WHY they ran
    // the attestation. Reference URL/docs echoed so they can verify what
    // was attested to without opening the repo.
    organiser(event, ctx) {
      const { commits, modeLine, isClosedEarly, completedAt, reasonLabel,
        refUrlLine, refDocsBlock, verifyHint, repoHint, proofBlock } = ctx;
      const receipts = proofBlock ? ['', proofBlock].join('\n') : '';
      // Module 9 follow-up — revocation history block. When any attestor
      // was revoked, the proof email lists each revoke event (date ·
      // sender_domain · reason-or-no-reason) so the durable record
      // matches what's visible on the manage ledger. Best-effort domain
      // lookup via commits[] hashes.
      let revokeHistoryBlock = '';
      const revokedSenders = Array.isArray(event.revoked_senders) ? event.revoked_senders : [];
      if (revokedSenders.length > 0) {
        const h2d = new Map();
        for (const c of (commits || [])) {
          if (c && c.sender_hash && c.sender_domain && !h2d.has(c.sender_hash)) {
            h2d.set(c.sender_hash, c.sender_domain);
          }
        }
        revokeHistoryBlock = [
          '',
          `Revocations (${revokedSenders.length}):`,
          ...revokedSenders.map((r) => {
            const dom = h2d.get(r.sender_hash) || 'unknown sender';
            const when = (r.revoked_at || '').slice(0, 10) || '?';
            const why = r.reason ? ` — "${r.reason}"` : ' — no reason recorded';
            return `  ${when} · ${dom}${why}`;
          }),
        ].join('\n');
      }
      return [
        isClosedEarly
          ? `The attestation you organised has been closed early.`
          : `The attestation you organised has reached its threshold.`,
        ``,
        commits ? 'This email is your durable proof. Keep it forever -- it verifies' : '',
        commits ? 'offline against the per-event git repository, even if gitdone goes' : '',
        commits ? 'away.' : '',
        commits ? '' : '',
        `Event: ${event.title}`,
        `Event ID: ${event.id}`,
        modeLine,
        `${isClosedEarly ? 'Closed' : 'Reached'}: ${completedAt}`,
        `Reason: ${reasonLabel}`,
        refUrlLine,
        refDocsBlock,
        revokeHistoryBlock,
        ``,
        receipts,
        verifyHint,
        ``,
        `The full audit trail is stored as a git repository with one commit`,
        `per reply, DKIM keys archived, and OpenTimestamps proofs attached.`,
        `Anyone can verify it offline with the gitdone-verify CLI, even if`,
        `gitdone itself goes away -- the proofs outlive the service.`,
        ``,
        repoHint,
      ].filter((l) => l !== '').join('\n');
    },
    // Attestor body — privacy-conservative. Tells them the attestation
    // they contributed to is closed and accountable, their record is
    // preserved, and what they attested to (ref url + docs they signed).
    // NO aggregate trust counts and NO count-of-others — that's the
    // organiser's view, not theirs.
    attestor(event, ctx, recipient) {
      const { commits, modeLine, completedAt, refUrlLine, refDocsBlock, verifyHint } = ctx;
      const ownReceipt = ownReceiptForAttestor(event, commits, recipient);
      return [
        `An attestation you contributed to is now complete and accountable.`,
        `Your reply is preserved as part of the cryptographic record.`,
        ``,
        commits ? 'This email is your durable proof. Keep it forever -- it verifies' : '',
        commits ? "offline against your contribution's commit, even if gitdone goes" : '',
        commits ? 'away.' : '',
        commits ? '' : '',
        `Event: ${event.title}`,
        modeLine,
        `Threshold reached: ${completedAt}`,
        refUrlLine,
        refDocsBlock,
        ``,
        ownReceipt,
        ownReceipt ? '' : '',
        verifyHint,
        ``,
        `Your reply is committed to the event's git audit trail (DKIM-verified,`,
        `OpenTimestamped) and will stay verifiable offline even if gitdone`,
        `itself goes away. The aggregate result is private to the organiser;`,
        `this email is YOUR record only.`,
        ``,
        `  Organised by ${event.initiator}`,
      ].filter((l) => l !== '').join('\n');
    },
  },
};

// ---------------------------------------------------------------------------
// lifecycle.activated — organiser confirmation that a pending event
// went live (workflow only). Single recipient → { subject, body }.
// ---------------------------------------------------------------------------
function activated(event, { sendResults = [], publicBaseUrl } = {}) {
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
  return {
    subject: `[gitdone] "${event.title}" — activated, ${activeIds.length} invitation${activeIds.length === 1 ? '' : 's'} sent`,
    body,
  };
}

// ---------------------------------------------------------------------------
// lifecycle.progressed — organiser update that a workflow step completed
// and which participant(s) are now active. Single recipient. Returns
// null if the completed step can't be located (caller treats as no-op).
// ---------------------------------------------------------------------------
function progressed(event, { completedStepId, newlyActiveSteps = [], publicBaseUrl } = {}) {
  const completedIdx = event.steps.findIndex((s) => s.id === completedStepId);
  const completed_ = completedIdx >= 0 ? event.steps[completedIdx] : null;
  if (!completed_) return null;
  const activeIds = newlyActiveSteps.map((s) => s.id);
  const baseUrl = publicBaseUrl || process.env.GITDONE_PUBLIC_URL || `https://${config.domain}`;
  // Match by id, not reference: future refactors that clone steps would
  // silently produce #0 with indexOf.
  const idxOfStep = (s) => event.steps.findIndex((x) => x.id === s.id);
  const newlyActiveLabel = newlyActiveSteps.length === 0
    ? 'No new steps unblocked yet (still waiting on other dependencies).'
    : `Now waiting on: ${newlyActiveSteps.map((s) => `#${idxOfStep(s) + 1} ${s.name} (${s.participant})`).join(', ')}.`;
  const body = [
    `Step #${completedIdx + 1} "${completed_.name}" was just completed by ${completed_.participant}.`,
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
  return {
    subject: `[gitdone] "${event.title}" [${completedIdx + 1}/${event.steps.length}] step done${newlyActiveSteps.length ? ' · next active' : ''}`,
    body,
  };
}

// ---------------------------------------------------------------------------
// lifecycle.anchored — OTS proof upgraded to a Bitcoin anchor. Same body
// for every recipient; the caller threads In-Reply-To/References.
// ---------------------------------------------------------------------------
function anchored(event, { anchorInfo = {} } = {}) {
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
  return {
    subject: `[gitdone] proof anchored — "${event.title}"`,
    body,
  };
}

// ---------------------------------------------------------------------------
// replyAck — the per-inbound-reply acknowledgement bodies. One builder
// per decision outcome; receive.js owns the dispatch (decision.reason →
// which builder) and passes a shared `ctx` of precomputed primitives.
// Each builder returns { subject, body }. Output is byte-identical to
// the pre-extraction inline blocks in receive.js — guarded by the
// email-commands / receive / strict-signing / web-crypto / proof-emails
// integration suites, which assert exact ack text.
//
// ctx fields:
//   isCrypto      — event.type === 'crypto'
//   fromAddr      — the reply-back address (crypto: event+<id>@; workflow:
//                   event+<id>-<step>@)
//   cryptoLabel   — "Crypto Declaration" | "Crypto Attestation" | null
//   stepName      — workflow step name | null
//   stepCounter   — " [i/n]" workflow suffix | ''
//   ackSenderHash — salted sender hash for per-attestor progress | null
//   completion    — the completion record (decision, completed_event, …)
// ---------------------------------------------------------------------------

function humanSize(n) {
  if (!n && n !== 0) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// Format a reference_docs list for inclusion in an ack body.
// Bullet-only by default ("• <filename> · <sha256> · <size>"), or
// per-attestor progress checkboxes when signedSet is supplied
// ("[x]" / "[ ]"). The checkbox form keeps the ack symmetric with the
// manage UI's "N attestors signed" pill and answers the question
// repliers actually ask: "did the file I sent get through?".
function formatReferenceDocList(docs, { signedSet = null } = {}) {
  if (!Array.isArray(docs) || docs.length === 0) return '  (none yet)';
  return docs.map((d) => {
    const name = d.filename || '(unnamed)';
    const hashShort = d.sha256 ? d.sha256.replace(/^sha256:/, '').slice(0, 12) : '?';
    const sz = humanSize(d.size);
    const marker = signedSet ? (d.sha256 && signedSet.has(d.sha256) ? '[x]' : '[ ]') : '•';
    return `  ${marker} ${name} · ${hashShort} · ${sz}`;
  }).join('\n');
}

const replyAck = {
  // Strict declaration: partial progress lists matched/missing and the
  // event stays open; once every doc is signed the "final" body fires.
  acceptedDeclaration(event, ctx) {
    const { fromAddr, ackSenderHash, completion } = ctx;
    const strictMode = !!event.reference_url
      && Array.isArray(event.reference_docs)
      && event.reference_docs.length > 0;
    const allSigned = !!completion.completed_event;
    if (strictMode && !allSigned) {
      return {
        subject: `[gitdone] Signed in progress — ${event.title}`,
        body: [
          `Your reply on Crypto Declaration "${event.title}" was accepted in part.`,
          `Reply is DKIM-verified, OpenTimestamped, and committed to the audit`,
          `trail.`,
          ``,
          formatProgressBlock(event, { senderHash: ackSenderHash }),
          ``,
          `Reply again to ${fromAddr} attaching the remaining file${event.reference_docs.filter((d) => !d.signed_at).length === 1 ? '' : 's'}.`,
          ``,
          `Requester: ${event.initiator}`,
        ].join('\n'),
      };
    }
    const refDocsBlock = (event.reference_docs && event.reference_docs.length)
      ? `\n\nReference documents (${event.reference_docs.length}):\n${formatReferenceDocList(event.reference_docs)}`
      : '';
    return {
      subject: `[gitdone] Signed — ${event.title}`,
      body: [
        `Your signature on Crypto Declaration "${event.title}" was accepted.`,
        `The reply is DKIM-verified, OpenTimestamped, and committed to the`,
        `event's git audit trail.`,
        ``,
        `The declaration is now final and the audit trail is sealed. Thank you.`,
        ``,
        `Requester: ${event.initiator}` + refDocsBlock,
      ].join('\n'),
    };
  },

  acceptedAttestation(event, ctx) {
    const { ackSenderHash, completion } = ctx;
    const dedup = event.dedup || 'unique';
    const replies = event.replies || [];
    // Module 8 — drop revoked sender_hashes from both counted and
    // verified; the ack reflects current state, not raw audit-trail.
    const revokedSet = revokedHashSet(event);
    let counted;
    if (dedup === 'unique') {
      const seen = new Set();
      for (const r of replies) {
        if (r.sender_hash && !revokedSet.has(r.sender_hash)) seen.add(r.sender_hash);
      }
      counted = seen.size;
    } else {
      counted = replies.reduce((n, r) => n + (revokedSet.has(r.sender_hash) ? 0 : 1), 0);
    }
    // Module 6 — dual count. "Counted" reflects the dedup rule;
    // "verified" is the DKIM-verified subset (load-bearing for
    // vouching / legal use). Equal for unique/latest; can diverge for
    // accumulating. Surfacing both gives honest trust signal.
    let verified;
    if (dedup === 'unique') {
      const verifiedSenders = new Set();
      for (const r of replies) {
        if (r.trust_level === 'verified' && r.sender_hash && !revokedSet.has(r.sender_hash)) verifiedSenders.add(r.sender_hash);
      }
      verified = verifiedSenders.size;
    } else {
      verified = replies.filter((r) => r.trust_level === 'verified' && !revokedSet.has(r.sender_hash)).length;
    }
    const lockingDedup = dedup !== 'accumulating';
    const reachedThreshold = lockingDedup
      ? !!completion.completed_event
      : (!!event.threshold_reached_at);
    // Subject counter: `[counted/threshold]`, with `· N verified` only
    // when verified != counted (keeps the common case compact).
    const counterTag = event.threshold
      ? (verified === counted
          ? ` [${counted}/${event.threshold}]`
          : ` [${counted}/${event.threshold} · ${verified} verified]`)
      : '';
    const subject = (lockingDedup && reachedThreshold)
      ? `[gitdone] Attestation complete — ${event.title}${counterTag}`
      : `[gitdone] Attestation reply recorded — ${event.title}${counterTag}`;
    // Body always carries both numbers when they diverge — the body is
    // the durable record.
    const trustQual = (verified === counted)
      ? `${counted}`
      : `${counted} (${verified} verified)`;
    let tail;
    if (lockingDedup && reachedThreshold) {
      tail = `Threshold reached (${event.threshold}). The audit trail is sealed.`;
    } else if (!lockingDedup && reachedThreshold) {
      const dateStr = String(event.threshold_reached_at).slice(0, 10);
      tail = `Replies so far: ${trustQual} (threshold of ${event.threshold} reached on ${dateStr}). The attestation keeps counting; only the organiser can close it.`;
    } else {
      tail = `Replies so far: ${trustQual}/${event.threshold}. The attestation stays open until the threshold is met.`;
    }
    // Per-attestor progress checkboxes — same source of truth as
    // formatProgressBlock (attestor_progress[hash].signed_doc_hashes).
    const attProgressForSender = (event.attestor_progress || {})[ackSenderHash];
    const ackSignedSet = attProgressForSender
      ? new Set(attProgressForSender.signed_doc_hashes || [])
      : null;
    const refDocsBlock = (event.reference_docs && event.reference_docs.length)
      ? `\n\nReference documents (${event.reference_docs.length}):\n${formatReferenceDocList(event.reference_docs, { signedSet: ackSignedSet })}`
      : '';
    return {
      subject,
      body: [
        `Your reply to Crypto Attestation "${event.title}" was recorded.`,
        `It's DKIM-verified, OpenTimestamped, and committed to the event's`,
        `git audit trail.`,
        ``,
        tail,
        ``,
        `Requester: ${event.initiator}` + refDocsBlock,
      ].join('\n'),
    };
  },

  acceptedWorkflow(event, ctx) {
    const { stepName, stepCounter, completion } = ctx;
    const tail = completion.completed_event
      ? `All steps are now complete; the event is marked completed. Thank you.`
      : `Thank you — nothing else is needed from you on this step.`;
    return {
      subject: `[gitdone] Accepted — ${event.title} — ${stepName}${stepCounter}`,
      body: [
        `Your reply for "${stepName}" on event "${event.title}" was accepted.`,
        `The step is marked complete and the reply is recorded in the event's`,
        `git audit trail (DKIM-verified, OpenTimestamped).`,
        ``,
        tail,
        ``,
        `Organiser: ${event.initiator}`,
      ].join('\n'),
    };
  },

  // Initiator self-replied — committed to the audit trail (forensic
  // record) but never counts. The ack closes the round-trip loop and
  // explains why the count didn't move.
  selfReply(event, ctx) {
    const { isCrypto, cryptoLabel, fromAddr } = ctx;
    const kindLabel = isCrypto ? (cryptoLabel || 'crypto event') : 'event';
    return {
      subject: `[gitdone] Self-reply not counted — ${event.title}`,
      body: [
        `Your email to ${kindLabel} "${event.title}" was committed to`,
        `the audit trail (DKIM-verified, OpenTimestamped) but does NOT`,
        `count as your own ${event.type === 'crypto' && event.mode === 'declaration' ? 'signature' : 'attestation'}: you're the initiator and a`,
        `self-signature has no third-party value.`,
        ``,
        `If you meant to test, this confirms the round-trip works.`,
        `Otherwise, share the reply address with someone else:`,
        `  ${fromAddr}`,
      ].join('\n'),
    };
  },

  attachmentSetMismatch(event, ctx) {
    const { cryptoLabel, ackSenderHash, completion } = ctx;
    const m = (completion.decision && completion.decision.match_result) || {};
    const mismatchLines = (m.mismatched || []).map((mm) => {
      const exp = (mm.expected_sha256 || '').replace(/^sha256:/, '').slice(0, 16) + '…';
      const got = (mm.got_sha256 || '').replace(/^sha256:/, '').slice(0, 16) + '…';
      return `  • ${mm.attachment.filename || '(unnamed)'}   expected: ${exp}   got: ${got}`;
    }).join('\n') || '  (no diff available)';
    return {
      subject: `[gitdone] Attachment hash mismatch — ${event.title}`,
      body: [
        `Thanks — we received your reply on ${cryptoLabel} "${event.title}".`,
        ``,
        `One or more attachments share a filename with a reference doc but`,
        `their bytes don't match what was registered. Your reply is recorded`,
        `in the audit trail but does NOT count.`,
        ``,
        mismatchLines,
        ``,
        `Send the exact file${(m.mismatched || []).length === 1 ? '' : 's'} that ${event.initiator} registered.`,
        `You can spread the docs across multiple replies; we'll track`,
        `progress.`,
        ``,
        formatProgressBlock(event, { senderHash: ackSenderHash }),
      ].join('\n'),
    };
  },

  strictNoMatchingAttachments(event, ctx) {
    const { cryptoLabel, ackSenderHash, fromAddr } = ctx;
    return {
      subject: `[gitdone] No matching attachments — ${event.title}`,
      body: [
        `Thanks — we received your reply on ${cryptoLabel} "${event.title}".`,
        ``,
        `This event requires you to attach the registered reference document${event.reference_docs.length === 1 ? '' : 's'}.`,
        `Your reply is in the audit trail but does NOT count.`,
        ``,
        formatProgressBlock(event, { senderHash: ackSenderHash }),
        ``,
        `Reply again to ${fromAddr} with the file${event.reference_docs.length === 1 ? '' : 's'} attached.`,
      ].join('\n'),
    };
  },

  // Module 9 — a revoked attestor re-replied. The audit trail records
  // the reply; this ack tells the sender their prior signature was
  // withdrawn by the initiator and points to the public proof page.
  revokedSender(event, ctx) {
    const { cryptoLabel } = ctx;
    const publicBase = (process.env.GITDONE_PUBLIC_URL || `https://${config.domain}`).replace(/\/+$/, '');
    return {
      subject: `[gitdone] Reply not counted — ${event.title}`,
      body: [
        `Thanks — we received your reply on ${cryptoLabel} "${event.title}".`,
        ``,
        `Your prior signature on this attestation was revoked by the`,
        `initiator and no longer counts toward the threshold. Your`,
        `replies remain in the audit trail (DKIM-verified,`,
        `OpenTimestamped); the public proof page shows the revocation:`,
        `  ${publicBase}/proof/${event.id}`,
        ``,
        `If you believe this is in error, reach out to ${event.initiator}.`,
      ].join('\n'),
    };
  },

  // Module 6.5 — re-signing an already-complete bucket. The count
  // doesn't move because the manifest is finite and already signed.
  strictAlreadySigned(event, ctx) {
    const { cryptoLabel, ackSenderHash } = ctx;
    return {
      subject: `[gitdone] Already signed — ${event.title}`,
      body: [
        `Thanks — we received your reply on ${cryptoLabel} "${event.title}".`,
        ``,
        `You've already signed every required document for this`,
        `attestation. Your reply is recorded in the audit trail for the`,
        `record, but it does NOT add to the count — there's nothing`,
        `further to attest to (the manifest is finite and frozen).`,
        ``,
        formatProgressBlock(event, { senderHash: ackSenderHash }),
        ``,
        `Requester: ${event.initiator}`,
      ].join('\n'),
    };
  },

  awaitingReferenceDocs(event, ctx) {
    const { cryptoLabel, fromAddr } = ctx;
    return {
      subject: `[gitdone] Awaiting reference documents — ${event.title}`,
      body: [
        `Thanks — we received your reply on ${cryptoLabel} "${event.title}".`,
        ``,
        `The requester cited a reference URL but hasn't yet registered the`,
        `document hashes that pin what's being signed:`,
        `  ${event.reference_url}`,
        ``,
        `Your message is recorded in the event's audit trail, but doesn't`,
        `count yet — every signer needs to attest to the same document`,
        `snapshot. Once ${event.initiator} registers the docs (by emailing`,
        `attach+${event.id}@${config.domain} with the files attached), you`,
        `can resend to:`,
        `  ${fromAddr}`,
        ``,
        `If you believe this is a mistake, reach out to ${event.initiator}.`,
      ].join('\n'),
    };
  },

  missingAttachment(event, ctx) {
    const { isCrypto, cryptoLabel, stepName, stepCounter, fromAddr } = ctx;
    const subject = isCrypto
      ? `[gitdone] Attachment required — ${event.title}`
      : `[gitdone] Attachment required — ${event.title} — ${stepName}${stepCounter}`;
    const lede = isCrypto
      ? `Thanks — we received your reply on ${cryptoLabel} "${event.title}".`
      : `Thanks — we received your reply for "${stepName}" on event "${event.title}".`;
    return {
      subject,
      body: [
        lede,
        ``,
        `${isCrypto ? 'This event' : 'This step'} requires an attachment, and we didn't find one on your reply.`,
        `Your message is recorded in the event's audit trail, but ${isCrypto ? 'it will not count' : 'the step will\nstay pending'}`,
        `until a reply arrives with a file attached.`,
        ``,
        `Please reply again to this address with the document attached:`,
        `  ${fromAddr}`,
        ``,
        `If you believe this is a mistake, reach out to ${event.initiator}.`,
      ].join('\n'),
    };
  },

  eventArchived(event, ctx) {
    const { isCrypto, cryptoLabel, stepName } = ctx;
    const lede = isCrypto
      ? `Thanks — we received your reply on ${cryptoLabel} "${event.title}".`
      : `Thanks — we received your reply for "${stepName}" on event "${event.title}".`;
    return {
      subject: `[gitdone] ${isCrypto ? cryptoLabel + ' archived' : 'Event archived'} — ${event.title}`,
      body: [
        lede,
        ``,
        `This ${isCrypto ? cryptoLabel : 'event'} has been archived (either by the organiser, or automatically`,
        `after a long period of inactivity past its deadline). Your reply was not`,
        `counted toward completion, but is still recorded in the event's audit`,
        `trail.`,
        ``,
        `If this is unexpected, reach out to ${event.initiator} — they can`,
        `un-archive ${isCrypto ? 'it' : 'the event'} from their dashboard and your reply will become`,
        `valid on resend.`,
      ].join('\n'),
    };
  },

  eventNotActivated(event, ctx) {
    const { isCrypto, cryptoLabel, stepName } = ctx;
    const lede = isCrypto
      ? `Thanks — we received your reply on ${cryptoLabel} "${event.title}".`
      : `Thanks — we received your reply for "${stepName}" on event "${event.title}".`;
    return {
      subject: `[gitdone] ${isCrypto ? cryptoLabel + ' not yet activated' : 'Event not yet activated'} — ${event.title}`,
      body: [
        lede,
        ``,
        `This ${isCrypto ? cryptoLabel : 'event'} hasn't been activated by the ${isCrypto ? 'requester' : 'organiser'} yet, so your reply`,
        `was not counted. Your message is still recorded in the event's audit`,
        `trail. Once ${isCrypto ? 'they' : 'the organiser'} activate${isCrypto ? '' : 's'} the event, you'll get the normal`,
        `${isCrypto ? 'invitation; please reply again then so it can be marked complete.' : 'invitation; please reply again then so the step can be marked complete.'}`,
        ``,
        `If this is unexpected, reach out to ${event.initiator}.`,
      ].join('\n'),
    };
  },

  eventClosed(event, ctx) {
    const { isCrypto, cryptoLabel, stepName } = ctx;
    const lede = isCrypto
      ? `Thanks — we received your reply on ${cryptoLabel} "${event.title}".`
      : `Thanks — we received your reply for "${stepName}" on event "${event.title}".`;
    return {
      subject: `[gitdone] ${isCrypto ? cryptoLabel + ' closed' : 'Event closed'} — ${event.title}`,
      body: [
        lede,
        ``,
        `This ${isCrypto ? cryptoLabel : 'event'} has already been closed, so your reply was not counted`,
        `toward completion. Your message is still recorded in the event's`,
        `audit trail for posterity.`,
        ``,
        `If this was unexpected, reach out to ${event.initiator}.`,
      ].join('\n'),
    };
  },
};

// ---------------------------------------------------------------------------
// cmd — initiator-command (§6.4) acknowledgement bodies. Text only;
// email-commands.js owns the computation/state-machines and returns
// structured results, receive.js/server.js own the dispatch and call
// these for the body text. One home for every composed email body.
// ---------------------------------------------------------------------------

function statsWorkflowBody(event) {
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

function statsCryptoBody(event) {
  const lines = [];
  lines.push(`Event: ${event.title}`);
  lines.push(`ID: ${event.id}`);
  if (event.mode === 'declaration') {
    lines.push(`Type: ${event.mode}   Minimum trust: ${event.min_trust_level}`);
  } else {
    lines.push(`Type: ${event.mode}`);
  }
  lines.push(`Status: ${isComplete(event) ? 'complete' : 'open'}`);
  if (event.mode === 'declaration') {
    lines.push(`Signer: ${event.signer}`);
  } else {
    const replies = event.replies || [];
    const dedup = event.dedup || 'unique';
    const revokedSet = revokedHashSet(event);
    const isStrict = !!event.reference_url
      && Array.isArray(event.reference_docs)
      && event.reference_docs.length > 0;
    if (isStrict) {
      // Strict mode: threshold gates on attestor buckets, not raw
      // replies. Surface complete + partial separately so the
      // initiator sees "1 / 2 with 1 partial" instead of a misleading
      // raw count.
      const progressMap = event.attestor_progress || {};
      const liveKeys = Object.keys(progressMap).filter((k) => !revokedSet.has(k));
      const complete = liveKeys.filter((k) => progressMap[k] && progressMap[k].complete).length;
      const partial = liveKeys.length - complete;
      const docsTotal = event.reference_docs.length;
      lines.push(`Threshold: ${event.threshold} · Dedup: ${dedup} · Mode: strict (${docsTotal} docs)`);
      lines.push(`Attestors complete: ${complete} / ${event.threshold}`);
      if (partial > 0) lines.push(`Attestors partial:  ${partial} (some reference docs still pending)`);
      lines.push(`Replies in audit:   ${replies.length}`);
    } else {
      let count; let label;
      if (dedup === 'unique' || dedup === 'latest') {
        const seen = new Set();
        for (const r of replies) {
          if (r.sender_hash && !revokedSet.has(r.sender_hash)) seen.add(r.sender_hash);
        }
        count = seen.size;
        label = 'Signers';
      } else {
        count = replies.reduce((n, r) => n + (revokedSet.has(r.sender_hash) ? 0 : 1), 0);
        label = 'Replies';
      }
      lines.push(`Threshold: ${event.threshold} · Dedup: ${dedup}`);
      lines.push(`${label}: ${count} / ${event.threshold}`);
      if (replies.length !== count) lines.push(`Replies in audit: ${replies.length}`);
    }
    if (revokedSet.size > 0) {
      lines.push(`Revoked: ${revokedSet.size}`);
    }
    if (event.threshold_reached_at) {
      lines.push(`Threshold reached at: ${event.threshold_reached_at}`);
    }
  }
  if (isComplete(event) && event.completion && event.completion.completed_at) {
    lines.push(`Completed at: ${event.completion.completed_at}`);
  }
  return lines.join('\n');
}

function statsBody(event) {
  return event.type === 'event' ? statsWorkflowBody(event) : statsCryptoBody(event);
}

const cmd = {
  stats: statsBody,
  statsWorkflow: statsWorkflowBody,
  statsCrypto: statsCryptoBody,

  // Generic auth rejection — any command from a non-initiator.
  rejected(command, reason) {
    return `Command rejected: ${reason}.\nOnly the event initiator can issue ${command}+ commands.`;
  },

  bundle: {
    ready(event) {
      return [
        `Attached is the full git repository for "${event.title}".`,
        `Verify offline with: gitdone-verify ${event.id}`,
        `Keep it forever; this is your proof.`,
      ].join('\n');
    },
    empty(event) {
      return [
        `No proof bundle yet — "${event.title}" hasn't received any`,
        `replies, so there's nothing in the audit trail to bundle.`,
        ``,
        `Once a participant replies (or the signer signs), the next bundle+`,
        `command will return the full archive.`,
      ].join('\n');
    },
  },

  attach: {
    unknownEvent(eventId) {
      return `No such event: ${eventId}. The attach+ address is only valid for an existing crypto event.`;
    },
    notCrypto(event) {
      return `Event "${event.title}" is a workflow event, not a crypto event. The attach+ channel only registers reference docs for crypto declarations and attestations.`;
    },
    rejected(eventId, reason) {
      return [
        `Reference-doc registration rejected: ${reason}.`,
        ``,
        `Only the event initiator can register reference documents via`,
        `attach+${eventId}@${config.domain}. Send from the initiator's`,
        `address with DKIM signed and aligned.`,
      ].join('\n');
    },
    frozen(event) {
      return [
        `Reference-doc set frozen — "${event.title}" has already`,
        `received a counted reply, so the document set can't change.`,
        ``,
        `Fairness rule: every signer attests to the same documents.`,
        `Adding docs after the first reply would let you swap what people`,
        `effectively signed.`,
      ].join('\n');
    },
    noAttachments(fromAddr) {
      return [
        `No attachments found on your email to ${fromAddr}.`,
        ``,
        `Reply with one or more files attached. Each will be hashed`,
        `(SHA-256) and recorded in the event's audit trail; the bytes`,
        `themselves are discarded.`,
      ].join('\n');
    },
    // event = the post-update event (carries the full reference_docs set).
    registered(event, { added, strictNow }) {
      const docList = formatReferenceDocList(event.reference_docs);
      return [
        `Registered ${added} reference document${added === 1 ? '' : 's'} on "${event.title}".`,
        ``,
        `Current reference doc set (${event.reference_docs.length} total):`,
        docList,
        ``,
        `Bytes are NOT stored. Hashes (SHA-256) + filenames + sizes are`,
        `committed to the event's git audit trail and OpenTimestamped.`,
        ``,
        strictNow
          ? `Strict signing is on (reference_url set + docs registered).\nThe signer must attach matching files to sign. Doc set is now frozen.`
          : `Add more by replying with additional attachments. The doc set\nfreezes at the first counted reply.`,
      ].join('\n');
    },
  },

  revoke: {
    unknownEvent(eventId) {
      return `No such event: ${eventId}. The revoke+ address is only valid for an existing crypto attestation event.`;
    },
    notAttestation(event) {
      return [
        `Revocation rejected: "${event.title}" is a ${event.mode || event.type} event.`,
        ``,
        `The revoke+ channel only applies to crypto attestation events,`,
        `where individual attestors contribute toward a threshold. There`,
        `is nothing analogous for workflow or declaration events.`,
      ].join('\n');
    },
    rejected(fromAddr, reason) {
      return [
        `Revocation rejected: ${reason}.`,
        ``,
        `Only the event initiator can revoke attestors via`,
        `${fromAddr}. Send from the initiator's address with DKIM`,
        `signed and aligned.`,
      ].join('\n');
    },
    noTargets() {
      return [
        `No revocation targets found in the body of your email.`,
        ``,
        `Write one attestor email per line. Optional final line:`,
        `  reason: <free-form note>`,
        ``,
        `Example:`,
        `  bob@example.com`,
        `  carol@example.com`,
        `  reason: signed in error`,
      ].join('\n');
    },
    noMatching(event, emails) {
      return [
        `None of the addresses in your revoke email match a known`,
        `attestor for "${event.title}":`,
        ``,
        ...emails.map((e) => `  ${e}`),
        ``,
        `Check spelling. Only addresses that have actually replied to`,
        `event+${event.id}@${config.domain} can be revoked.`,
      ].join('\n');
    },
    // event = the post-revoke event (carries the updated threshold view).
    done(event, { resolved, notFound, reason, countAfter, reopened }) {
      const lines = [
        `Revoked ${resolved.length} attestor${resolved.length === 1 ? '' : 's'} on "${event.title}":`,
        ``,
        ...resolved.map((r) => `  ${r.email}`),
      ];
      if (notFound.length) {
        lines.push('', `Not found (skipped — no matching reply on file):`);
        for (const e of notFound) lines.push(`  ${e}`);
      }
      if (reason) {
        lines.push('', `Reason recorded: ${reason}`);
      } else {
        // No reason supplied — surface the syntax here so a future
        // revoke goes through with one. Reason stays optional by
        // spec (§24); this is the discovery surface.
        lines.push('',
          `No reason recorded. To attach one next time, add a line`,
          `to the body like:`,
          `  reason: signed in error`);
      }
      if (typeof countAfter === 'number') {
        const t = event.threshold || 0;
        lines.push('', `New count: ${countAfter} / ${t}.`);
      }
      if (reopened) {
        lines.push('', `Event was complete; count dropped below threshold so completion has reopened. A fresh reply from a different (non-revoked) attestor will re-complete it. The revoked attestor cannot un-revoke themselves; revocation is permanent.`);
      } else {
        lines.push('', `Revocation is permanent — the revoked attestor cannot re-sign and have it count.`);
      }
      lines.push('',
        `Audit trail preserved: the original signature commits stay`,
        `in the event's git repo. Revocation lands as a separate`,
        `commit (kind: 'revoke'), OpenTimestamped.`);
      return lines.join('\n');
    },
  },
};

// ---------------------------------------------------------------------------
// invite / setup bodies — NOT lifecycle B-edges (they kick off
// participation rather than report on an event's lifecycle), but they
// are composed body text, so they live in the catalogue too.
// ---------------------------------------------------------------------------

// Workflow-step invitation. The reply address is the only thing the
// participant needs to act on.
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
  const refDocs = Array.isArray(event.reference_docs) ? event.reference_docs : [];
  const strict = !!event.reference_url && refDocs.length > 0;
  if (strict) {
    const lines = [
      `${event.initiator} asked you to sign a gitdone declaration.`,
      ``,
      `Event: ${event.title}`,
      `Type: declaration (one signer, one permanent record)`,
      ``,
    ];
    if (event.details) {
      lines.push(`What you're being asked to sign:`, event.details, ``);
    }
    if (event.reference_url) {
      lines.push(`Reference: ${event.reference_url}`, ``);
    }
    lines.push(
      `To sign, reply from ${event.signer} to:`,
      `  ${replyAddr}`,
      ``,
      `Attach the following file${refDocs.length === 1 ? '' : 's'} — each must hash exactly to the value`,
      `recorded below (we verify on receipt):`,
      ``,
    );
    for (const d of refDocs) {
      const hashShort = d.sha256 ? d.sha256.replace(/^sha256:/, '').slice(0, 16) + '…' : '?';
      lines.push(`  • ${d.filename || '(unnamed)'}   sha256: ${hashShort}`);
    }
    lines.push(
      ``,
      `You can spread the files across multiple emails; we'll track progress`,
      `and confirm what we matched / what's still missing on every reply.`,
      `Your declaration completes only when every file is signed.`,
      ``,
      `If this is unexpected, ignore this email.`,
    );
    return lines.join('\n');
  }
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

// Module 4d#3 — when a crypto event cites a reference_url but no docs
// are registered yet, the initiator gets attach+ instructions on
// activation. Returns { subject, body, replyTo } — the caller threads
// replyTo to the attach+ address.
function attachDocsNeeded(event, { publicBaseUrl } = {}) {
  const baseUrl = publicBaseUrl || process.env.GITDONE_PUBLIC_URL || `https://${config.domain}`;
  const attachAddr = `attach+${event.id}@${config.domain}`;
  const labelKind = event.mode === 'declaration' ? 'declaration' : 'attestation';
  const subjectKind = event.mode === 'declaration' ? 'declaration' : 'attestation';
  const body = [
    `Your ${subjectKind} "${event.title}" is now active, but we still need`,
    `the reference document${event.mode === 'declaration' ? '' : 's'} before the ${event.mode === 'declaration' ? 'signer can sign' : 'attestors can vouch'}.`,
    ``,
    `What you cited as the reference:`,
    `  ${event.reference_url}`,
    ``,
    `Reply to this email (or send a fresh one) with the file${event.mode === 'declaration' ? '' : 's'} attached to:`,
    `  ${attachAddr}`,
    ``,
    `Important — this is a one-shot. The first email we receive at that`,
    `address with attachments becomes the canonical document set and`,
    `freezes immediately. Anything you send afterwards is rejected.`,
    `Send everything in ONE email.`,
    ``,
    `Format: anything. PDF, DOCX, images, plain text, whatever you like.`,
    `Practical guidance: keep it to ~5 files or fewer; if you need more,`,
    `zip them and attach the .zip. We hash each attachment (SHA-256) and`,
    `discard the bytes — only the hashes + filenames + sizes are recorded.`,
    ``,
    `Once we receive your docs, we'll automatically invite the`,
    `${event.mode === 'declaration' ? 'signer (' + (event.signer || 'configured signer') + ')' : 'attestors (you share the reply address with them yourself)'}`,
    `with the file list and the exact hashes they have to match.`,
    ``,
    `Manage: ${baseUrl}/manage/event/${event.id}`,
  ].join('\n');
  return {
    subject: `[gitdone] "${event.title}" — please attach reference document${event.mode === 'declaration' ? '' : 's'} (${labelKind})`,
    body,
    replyTo: attachAddr,
  };
}

module.exports = {
  // Render helpers (re-exported by notifications.js for test imports).
  renderProofBlock,
  renderOrganiserStepList,
  // Reply-address helpers (senders in notifications.js use these for
  // the message Reply-To; the invite bodies embed them in text).
  stepReplyAddr,
  cryptoReplyAddr,
  // Invite-body composers (re-exported by notifications.js for tests).
  workflowStepBody,
  declarationSignerBody,
  // reply-ack body helper (receive.js uses it for the attach+ command
  // ack too, which lists the frozen reference docs).
  formatReferenceDocList,
  // The per-inbound-reply acknowledgement catalogue.
  replyAck,
  // The initiator-command acknowledgement catalogue.
  cmd,
  // The lifecycle body/subject catalogue.
  lifecycle: {
    completed,
    activated,
    progressed,
    anchored,
  },
  // invite / setup bodies.
  invite: {
    workflowStep: workflowStepBody,
    declarationSigner: declarationSignerBody,
    attachDocsNeeded,
  },
};
