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
    // Module 9 — when any senders are revoked, the raw commits.length
    // overstates the effective count. The proof block surfaces both so
    // the durable record matches the audit trail AND tells a reader
    // what counted post-revoke. Aggregate trust counts are over the
    // effective (live, non-revoked) subset — that's what "verified"
    // means in the proof context.
    const revokedSet = new Set(
      ((event.revoked_senders) || []).map((r) => r && r.sender_hash).filter(Boolean)
    );
    const liveCommits = revokedSet.size > 0
      ? commits.filter((c) => !c.sender_hash || !revokedSet.has(c.sender_hash))
      : commits;
    const ag = proofRender.aggregateTrust(liveCommits);
    const lines = [
      'Cryptographic receipt',
      '---------------------',
    ];
    if (revokedSet.size > 0) {
      lines.push(`Replies in audit  ${commits.length}`);
      lines.push(`Revoked           ${commits.length - liveCommits.length}`);
      lines.push(`Effective         ${liveCommits.length}`);
    } else {
      lines.push(`Replies counted   ${commits.length}`);
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
async function notifyEventCompletion(event, { reason = 'all_steps_done', publicBaseUrl, completedStepId, commits, extraRecipients } = {}) {
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
  // Loose attestation: anonymous addresses are stored as salted hashes
  // only — we never have plaintext to reach those repliers. Under
  // strict mode (4e) the caller passes attestor emails via
  // extraRecipients; receive.js then redacts them after the send.
  if (Array.isArray(extraRecipients)) {
    for (const r of extraRecipients) {
      if (typeof r === 'string' && r.includes('@')) recipients.add(r.toLowerCase());
    }
  }

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

  // Per-attestor own-receipt. We pinpoint THIS attestor's commit(s) by
  // recomputing their salted sender_hash from the event salt — much
  // tighter than matching by sender_domain (multiple gmail attestors
  // would collide). Strict attestation only stores plaintext emails
  // briefly (4e), so this lookup is local to this function.
  const ownReceiptForAttestor = (attestorEmail) => {
    if (!commits || !event.salt) return '';
    const hash = require('./completion').hashSender(attestorEmail, event.salt);
    const own = commits.filter((c) => c && c.sender_hash === hash);
    if (own.length === 0) return '';
    return [
      'Your receipt',
      '------------',
      ...own.map((c) => proofRender.plainReceipt(c)),
    ].join('\n');
  };
  const ownReceiptForStepParticipant = (participantEmail) => {
    if (!commits) return '';
    const own = commits.filter((c) => {
      const step = (event.steps || []).find((s) => s.id === c.step_id);
      return step && step.participant && step.participant.toLowerCase() === participantEmail.toLowerCase();
    });
    return renderProofBlock(event, own, {});
  };

  const jobs = [...recipients].map((to) => {
    const isOrganiser = event.initiator && to === event.initiator.toLowerCase();
    let body;
    if (isWorkflow) {
      // Workflow: organiser sees the full step table + per-step
      // receipts; participants see only their own step's receipt.
      if (isOrganiser) {
        const receipts = proofBlock ? ['', proofBlock].join('\n') : '';
        body = [
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
      } else {
        const ownReceipt = ownReceiptForStepParticipant(to);
        body = [
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
      }
    } else if (isDeclaration) {
      // Symmetric two-recipient notary. Same body for organiser and
      // signer — both have equal stake in the durable record. The
      // signer's identity is in the receipt; whoever sees this email
      // can verify offline who signed what, when.
      const receipts = proofBlock ? ['', proofBlock].join('\n') : '';
      body = [
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
    } else if (isAttestation) {
      if (isOrganiser) {
        // Organiser sees the aggregate trust posture — that's WHY they
        // ran the attestation. Reference URL/docs echoed so they can
        // verify what was attested to without opening the repo.
        const receipts = proofBlock ? ['', proofBlock].join('\n') : '';
        // Module 9 follow-up — revocation history block. When any
        // attestor was revoked, the proof email lists each revoke
        // event (date · sender_domain · reason-or-no-reason) so the
        // durable record matches what's visible on the manage ledger.
        // Best-effort domain lookup via commits[] hashes.
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
        body = [
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
      } else {
        // Attestor body — privacy-conservative. Tells them the
        // attestation they contributed to is closed and accountable,
        // their record is preserved, and what they attested to (ref
        // url + docs they signed). NO aggregate trust counts and NO
        // count-of-others — that's the organiser's view, not theirs.
        const ownReceipt = ownReceiptForAttestor(to);
        body = [
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
      }
    }
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
      const revokedSubjSet = new Set(
        ((event.revoked_senders) || []).map((r) => r && r.sender_hash).filter(Boolean)
      );
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
    const subject = commits
      ? `[gitdone] proof — "${event.title}"${closedEarlyTag}${counterTag}`
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

// Module 4d#3 (followup) — partial-sign progress notification to the
// initiator. Mirrors notifyOrganiserOfStepProgress in shape: a
// best-effort email summarising which docs are now signed and which
// remain. Only fires on partial progress; final completion goes
// through notifyEventCompletion which already covers the initiator.
async function notifyInitiatorOfSigningProgress(event, { signerDomain, addedFilenames = [] } = {}) {
  if (!event || event.type !== 'crypto' || !event.initiator) return null;
  if (!Array.isArray(event.reference_docs) || event.reference_docs.length === 0) return null;
  const docs = event.reference_docs;
  const signed = docs.filter((d) => d.signed_at);
  const pending = docs.filter((d) => !d.signed_at);
  const lines = [
    `An attestor signed ${addedFilenames.length} of your reference document${addedFilenames.length === 1 ? '' : 's'} on "${event.title}".`,
    ``,
    `Just matched in this reply:`,
    ...addedFilenames.map((f) => `  [x] ${f}`),
    ``,
    `Overall progress: ${signed.length} of ${docs.length} signed.`,
    ``,
  ];
  if (signed.length) {
    lines.push(`Signed so far:`);
    for (const d of signed) {
      const trustLabel = d.signed_trust_level || 'signed';
      const dom = d.signed_sender_domain || signerDomain || '';
      lines.push(`  [x] ${d.filename || '(unnamed)'} · ${trustLabel}${dom ? ` · @${dom}` : ''}`);
    }
    lines.push(``);
  }
  if (pending.length) {
    lines.push(`Still awaiting:`);
    for (const d of pending) {
      lines.push(`  [ ] ${d.filename || '(unnamed)'}`);
    }
    lines.push(``);
  }
  lines.push(
    `When the last doc is signed, you'll get the full proof email`,
    `automatically.`,
  );
  return sendOne({
    to: event.initiator,
    subject: `[gitdone] "${event.title}" — ${signed.length}/${docs.length} signed`,
    body: lines.join('\n'),
    event,
  });
}

// Module 4d#3 — on activation, when a crypto event cites a
// reference_url but no documents have been registered yet, email the
// initiator with explicit instructions on how to register the doc set.
// The signer invite is held until they do this (Module 4c flow).
async function notifyInitiatorAttachDocsNeeded(event, { publicBaseUrl } = {}) {
  if (!event || event.type !== 'crypto' || !event.initiator) return null;
  if (!event.reference_url) return null;
  if (Array.isArray(event.reference_docs) && event.reference_docs.length > 0) return null;
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
  return sendOne({
    to: event.initiator,
    subject: `[gitdone] "${event.title}" — please attach reference document${event.mode === 'declaration' ? '' : 's'} (${labelKind})`,
    body,
    event,
    replyTo: attachAddr,
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
  notifyInitiatorAttachDocsNeeded,
  notifyInitiatorOfSigningProgress,
  notifyEventCompletion,
  notifyProofAnchored,
  notifyOrganiserOfActivation,
  notifyOrganiserOfStepProgress,
  workflowStepBody,
  declarationSignerBody,
  renderOrganiserStepList,
  renderProofBlock,
};
