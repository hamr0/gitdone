// 1.J — completion engine.
//
// Given an event and an incoming commit, decides whether the commit counts
// toward progress, applies the appropriate state transition, and reports
// whether the event is now complete.
//
// Pure state transitions live here (no I/O); persistence + follow-up
// notifications are orchestrated by the caller (receive.js) via
// updateEventAtomic + the gitrepo/notifications modules.
//
// Completion rules (PRD §4 and §7.4.x):
//   workflow
//     - a reply counts for step S iff trust_level ≥ min_trust_level AND
//       participant_match=true AND, for sequential flow, S is the earliest
//       non-complete step
//     - event completes when every step is complete
//   declaration (crypto)
//     - reply counts iff trust_level ≥ min_trust_level AND the sender
//       matches event.signer (same sender_hash — salt is per-event so this
//       comparison is safe)
//     - event completes on the first counting reply
//   attestation (crypto) — trust policy is dedup-derived; the initiator
//     is never counted (self-replies stay in the audit trail as proof
//     they tried, but don't push the threshold)
//         unique        — DKIM-verified required (trust_level === 'verified');
//                         reject sender == initiator. Locks at threshold.
//         latest        — DKIM-verified required; reject sender == initiator.
//                         Locks at threshold.
//         accumulating  — no trust gate (counts both DKIM-verified and
//                         unverified); reject sender == initiator. Past
//                         threshold, count keeps growing — completion is
//                         only set on explicit close. Crossing threshold
//                         stamps event.threshold_reached_at /
//                         event.threshold_reached_count as the proof anchor.
//     - replies[] dedup:
//         unique        — keep all replies (audit trail), count distinct senders
//         latest        — keep one reply per sender (most recent), count = senders
//         accumulating  — keep all replies, count = replies.length
//
// Commits that don't count are still written to the per-event git repo
// by commitReply (accept-with-flag per §7.4.x); they just don't change
// the event state.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');

const TRUST_ORDER = ['unverified', 'authorized', 'forwarded', 'verified'];

function trustRank(level) {
  const i = TRUST_ORDER.indexOf(level);
  return i < 0 ? -1 : i;
}

function meetsTrust(commit, event) {
  const min = event.min_trust_level || 'verified';
  return trustRank(commit.trust_level) >= trustRank(min);
}

// Helper: compute sender_hash the same way gitrepo does, so declaration
// signer comparison works by hashing the configured signer against the
// event salt and matching against the commit's sender_hash.
// Must match gitrepo.saltedSenderHash byte-for-byte — that's what writes
// the sender_hash into commit metadata, so the declaration-signer
// comparison runs against the same encoding.
function hashSender(sender, salt) {
  if (!sender) return null;
  const material = `${salt || ''}|${String(sender).toLowerCase()}`;
  return `sha256:${crypto.createHash('sha256').update(material).digest('hex')}`;
}

// --- predicates ---

function senderMatchesSigner(commit, event) {
  if (!event.signer || !event.salt) return false;
  const expected = hashSender(event.signer, event.salt);
  return expected != null && expected === commit.sender_hash;
}

// Same compare against event.initiator. Used by attestation to drop
// initiator self-replies from the count (they still commit to the
// audit trail). Same spirit as declaration's create-time signer ≠
// initiator check.
function senderIsInitiator(commit, event) {
  if (!event.initiator || !event.salt) return false;
  const expected = hashSender(event.initiator, event.salt);
  return expected != null && expected === commit.sender_hash;
}

function isComplete(event) {
  return !!(event.completion && event.completion.status === 'complete');
}

function firstPendingStep(event) {
  if (!Array.isArray(event.steps)) return null;
  return event.steps.find((s) => s && s.status !== 'complete') || null;
}

// --- per-mode shouldCount ---

// A step is eligible for completion iff every id in its depends_on list
// is already complete. Empty depends_on → always eligible. Replaces the
// old sequential / non-sequential branching.
function stepDepsMet(event, step) {
  const deps = step.depends_on || [];
  if (deps.length === 0) return true;
  for (const depId of deps) {
    const dep = (event.steps || []).find((s) => s.id === depId);
    if (!dep || dep.status !== 'complete') return false;
  }
  return true;
}

function eligibleSteps(event) {
  return (event.steps || []).filter((s) => s.status !== 'complete' && stepDepsMet(event, s));
}

function shouldCountWorkflow(event, commit) {
  if (!event.activated_at) return { count: false, reason: 'event not activated' };
  if (event.archived_at) return { count: false, reason: 'event archived' };
  if (isComplete(event)) return { count: false, reason: 'event already complete' };
  if (!meetsTrust(commit, event)) return { count: false, reason: 'trust below min_trust_level' };
  if (!commit.participant_match) return { count: false, reason: 'sender not a named participant' };
  if (!commit.step_id) return { count: false, reason: 'reply had no step id' };
  const step = (event.steps || []).find((s) => s.id === commit.step_id);
  if (!step) return { count: false, reason: `unknown step ${commit.step_id}` };
  if (step.status === 'complete') return { count: false, reason: 'step already complete' };
  if (!stepDepsMet(event, step)) {
    return { count: false, reason: 'step has unmet dependencies' };
  }
  if (step.requires_attachment && !commit.has_attachment) {
    // Reply is committed (audit trail) but step stays pending. receive.js
    // sends an auto-reply to the participant explaining the miss.
    return { count: false, reason: 'missing_attachment', step };
  }
  return { count: true, step };
}

// Module 4c — strict signing helper. Returns { strict, matched, mismatched, extras }.
//   matched:   ref docs whose sha256 == one of the attachment hashes
//   mismatched: filename matches an unsigned ref doc but sha256 differs
//   extras:    attachments unmatched by either hash or filename
//
// "strict" is a coarse flag: true when reference_url is set AND
// reference_docs has at least one entry. Caller uses it to decide whether
// to enforce attachment-set matching at all.
function matchAttachmentsAgainstRefDocs(attachments, refDocs) {
  const docs = Array.isArray(refDocs) ? refDocs : [];
  const atts = Array.isArray(attachments) ? attachments : [];
  const matched = [];
  const mismatched = [];
  const extras = [];
  const usedRefIdx = new Set();

  for (const a of atts) {
    if (!a || !a.sha256) { extras.push(a); continue; }
    const byHash = docs.findIndex((d) => d && d.sha256 === a.sha256);
    if (byHash >= 0) {
      matched.push({ ref_index: byHash, attachment: a });
      usedRefIdx.add(byHash);
      continue;
    }
    const byName = a.filename
      ? docs.findIndex((d) => d && d.filename === a.filename)
      : -1;
    if (byName >= 0) {
      mismatched.push({
        ref_index: byName,
        attachment: a,
        expected_sha256: docs[byName].sha256,
        got_sha256: a.sha256,
      });
    } else {
      extras.push(a);
    }
  }
  return { matched, mismatched, extras };
}

function isStrictSigningEvent(event) {
  if (!event || event.type !== 'crypto') return false;
  return !!(event.reference_url && Array.isArray(event.reference_docs) && event.reference_docs.length > 0);
}

function shouldCountDeclaration(event, commit) {
  if (!event.activated_at) return { count: false, reason: 'event not activated' };
  if (event.archived_at) return { count: false, reason: 'event archived' };
  if (isComplete(event)) return { count: false, reason: 'declaration already signed' };
  if (!meetsTrust(commit, event)) return { count: false, reason: 'trust below min_trust_level' };
  if (!senderMatchesSigner(commit, event)) {
    return { count: false, reason: 'sender is not the declared signer' };
  }
  // Module 4a/4b: if the initiator cited a reference_url but hasn't yet
  // registered any reference docs, the signature can't be evaluated
  // against a specific snapshot. Commit it for the audit trail but don't
  // count until docs land.
  if (event.reference_url && !(event.reference_docs && event.reference_docs.length)) {
    return { count: false, reason: 'awaiting_reference_docs' };
  }
  // Module 4c: strict signing — when the event has registered reference
  // docs, the signer must attach files whose sha256 hashes match. Partial
  // is allowed (some docs at a time); event completes only when all are
  // signed.
  if (isStrictSigningEvent(event)) {
    const matchRes = matchAttachmentsAgainstRefDocs(commit.attachments, event.reference_docs);
    if (matchRes.mismatched.length > 0) {
      return { count: false, reason: 'attachment_set_mismatch', match_result: matchRes };
    }
    if (matchRes.matched.length === 0) {
      return { count: false, reason: 'strict_no_matching_attachments', match_result: matchRes };
    }
    return { count: true, match_result: matchRes, strict: true };
  }
  return { count: true };
}

function shouldCountAttestation(event, commit) {
  // Attestation events stay open past completion (audit trail continues).
  // Trust policy is derived from the dedup rule:
  //   unique / latest → DKIM-verified required
  //   accumulating    → no trust gate
  // Initiator self-replies never count (still committed). For unique +
  // latest, completion is sticky (locks at threshold). For accumulating,
  // there is no "complete" gate from threshold — explicit close only.
  if (!event.activated_at) return { count: false, reason: 'event not activated' };
  if (event.archived_at) return { count: false, reason: 'event archived' };
  const dedup = event.dedup || 'unique';
  // Only unique/latest lock at threshold. Accumulating keeps counting
  // forever (completion comes from explicit close, not threshold).
  if (dedup !== 'accumulating' && isComplete(event)) {
    return { count: false, reason: 'event already complete' };
  }
  // Even accumulating respects organiser-initiated close.
  if (dedup === 'accumulating' && isComplete(event)) {
    return { count: false, reason: 'event already complete' };
  }
  if (senderIsInitiator(commit, event)) {
    return { count: false, reason: 'sender is the event initiator (self-reply)' };
  }
  if (dedup !== 'accumulating') {
    // unique/latest: require DKIM-verified
    if (commit.trust_level !== 'verified') {
      return { count: false, reason: `${dedup} dedup requires DKIM-verified reply` };
    }
  }
  // accumulating: no trust gate (both DKIM-verified and unverified count)
  // Module 4a/4b: reference_url set but no reference_docs yet → don't
  // count. Commit lands in audit trail so the would-be attestor's intent
  // is preserved; when docs land they can resend.
  if (event.reference_url && !(event.reference_docs && event.reference_docs.length)) {
    return { count: false, reason: 'awaiting_reference_docs' };
  }
  // Module 4c: strict signing — same rules as declaration but per-attestor
  // progress is tracked in event.attestor_progress[sender_hash]. An
  // attestor only counts toward threshold when their personal progress
  // covers every reference doc.
  if (isStrictSigningEvent(event)) {
    const matchRes = matchAttachmentsAgainstRefDocs(commit.attachments, event.reference_docs);
    if (matchRes.mismatched.length > 0) {
      return { count: false, reason: 'attachment_set_mismatch', match_result: matchRes };
    }
    if (matchRes.matched.length === 0) {
      return { count: false, reason: 'strict_no_matching_attachments', match_result: matchRes };
    }
    return { count: true, match_result: matchRes, strict: true };
  }
  return { count: true };
}

function shouldCount(event, commit) {
  if (event.type === 'event') return shouldCountWorkflow(event, commit);
  if (event.type === 'crypto' && event.mode === 'declaration') return shouldCountDeclaration(event, commit);
  if (event.type === 'crypto' && event.mode === 'attestation') return shouldCountAttestation(event, commit);
  return { count: false, reason: `unknown event type/mode: ${event.type}/${event.mode}` };
}

// --- attestation dedup ---

// Returns { replies: deduped, count: number }
function applyDedup(replies, rule) {
  if (rule === 'accumulating') {
    return { replies, count: replies.length };
  }
  // unique | latest — count distinct senders
  const bySender = new Map();
  for (const r of replies) {
    if (!r.sender_hash) continue;
    bySender.set(r.sender_hash, r);   // latest-wins
  }
  if (rule === 'latest') {
    // replies[] is pruned to the latest per sender (stored in insertion-latest-wins order)
    return { replies: Array.from(bySender.values()), count: bySender.size };
  }
  // unique: keep all replies in replies[] (audit trail) but count distinct
  return { replies, count: bySender.size };
}

// --- state transitions (pure) ---

// Returns a new event object. Does NOT mutate input. Only transitions state
// when shouldCount(event, commit).count === true.
function applyReply(event, commit, { now = new Date().toISOString() } = {}) {
  const decision = shouldCount(event, commit);
  if (!decision.count) return { event, applied: false, decision };

  if (event.type === 'event') {
    const steps = event.steps.map((s) =>
      s.id === commit.step_id
        ? { ...s, status: 'complete', completed_at: now, commit_sequence: commit.sequence }
        : s
    );
    const allDone = steps.every((s) => s.status === 'complete');
    const updated = {
      ...event,
      steps,
      completion: allDone
        ? { status: 'complete', completed_at: now, commit_sequence: commit.sequence }
        : (event.completion || { status: 'open', completed_at: null, commit_sequence: null }),
    };
    return { event: updated, applied: true, decision, completedStep: commit.step_id, completedEvent: allDone };
  }

  if (event.type === 'crypto' && event.mode === 'declaration') {
    // Module 4c strict signing: partial signs are allowed across emails.
    // Mark every matched reference doc as signed; event only completes
    // when ALL docs are signed.
    if (decision.strict && decision.match_result) {
      const matched = decision.match_result.matched;
      const refDocs = (event.reference_docs || []).map((d, i) => {
        const hit = matched.find((m) => m.ref_index === i);
        if (!hit || d.signed_at) return d;     // already signed → don't re-stamp
        return {
          ...d,
          signed_at: now,
          signed_by_hash: commit.sender_hash,
          signed_commit_sequence: commit.sequence,
        };
      });
      const allSigned = refDocs.every((d) => !!d.signed_at);
      const updated = {
        ...event,
        reference_docs: refDocs,
        completion: allSigned
          ? { status: 'complete', completed_at: now, commit_sequence: commit.sequence }
          : (event.completion || { status: 'open', completed_at: null, commit_sequence: null }),
      };
      return {
        event: updated, applied: true, decision,
        completedEvent: allSigned,
        // newly_signed_count: how many docs this commit moved to signed
        newly_signed_count: refDocs.filter((d, i) => {
          const before = (event.reference_docs || [])[i];
          return d.signed_at && (!before || !before.signed_at);
        }).length,
      };
    }
    return {
      event: {
        ...event,
        completion: { status: 'complete', completed_at: now, commit_sequence: commit.sequence },
      },
      applied: true,
      decision,
      completedEvent: true,
    };
  }

  if (event.type === 'crypto' && event.mode === 'attestation') {
    const newReply = {
      sender_hash: commit.sender_hash,
      sender_domain: commit.sender_domain,
      sequence: commit.sequence,
      received_at: commit.received_at,
      trust_level: commit.trust_level,
    };
    // Module 4c strict signing for attestation: per-attestor progress map.
    // An attestor's reply is appended to replies[] for audit, but they
    // count toward threshold only when their attestor_progress entry has
    // signed every reference doc.
    if (decision.strict && decision.match_result) {
      const matched = decision.match_result.matched;
      const senderKey = commit.sender_hash || 'unknown';
      const progress = { ...(event.attestor_progress || {}) };
      const prior = progress[senderKey] || { signed_doc_hashes: [], complete: false, first_seen_at: now };
      const seen = new Set(prior.signed_doc_hashes);
      const addedHashes = [];
      for (const m of matched) {
        const h = (event.reference_docs[m.ref_index] || {}).sha256;
        if (h && !seen.has(h)) { seen.add(h); addedHashes.push(h); }
      }
      const totalDocs = (event.reference_docs || []).length;
      const wasComplete = !!prior.complete;
      const nowComplete = seen.size >= totalDocs && totalDocs > 0;
      progress[senderKey] = {
        ...prior,
        signed_doc_hashes: Array.from(seen),
        complete: nowComplete,
        completed_at: nowComplete ? (prior.completed_at || now) : prior.completed_at || null,
        last_seen_at: now,
        sender_domain: commit.sender_domain || prior.sender_domain || null,
      };
      const completeAttestors = Object.keys(progress).filter((k) => progress[k].complete).length;
      const threshold = event.threshold || 0;
      const reachedThreshold = completeAttestors >= threshold;
      const firstCrossing = !wasComplete && nowComplete && reachedThreshold && !event.threshold_reached_at;
      const dedup = event.dedup || 'unique';
      const lockingDedup = dedup !== 'accumulating';
      const justCompleted = !wasComplete && nowComplete;
      const updated = {
        ...event,
        replies: [...(event.replies || []), newReply],
        attestor_progress: progress,
      };
      if (firstCrossing) {
        updated.threshold_reached_at = now;
        updated.threshold_reached_count = completeAttestors;
        updated.threshold_reached_sequence = commit.sequence;
      }
      if (lockingDedup && reachedThreshold && !event.completion) {
        updated.completion = { status: 'complete', completed_at: now, commit_sequence: commit.sequence };
      } else {
        updated.completion = event.completion || { status: 'open', completed_at: null, commit_sequence: null };
      }
      return {
        event: updated, applied: true, decision,
        countedReplies: completeAttestors,
        completedEvent: lockingDedup ? (justCompleted && reachedThreshold) : firstCrossing,
        thresholdReached: reachedThreshold,
        thresholdJustCrossed: firstCrossing,
        // surface for receive.js ack composition
        newly_signed_count: addedHashes.length,
        attestor_complete_after: nowComplete,
        attestor_complete_before: wasComplete,
      };
    }
    const all = [...(event.replies || []), newReply];
    const dedup = event.dedup || 'unique';
    const { replies, count } = applyDedup(all, dedup);
    const threshold = event.threshold || 0;
    const reachedThreshold = count >= threshold;

    if (dedup === 'accumulating') {
      // Stamp threshold_reached_at on the first crossing only. Past
      // threshold, replies[] keeps extending and count keeps growing,
      // but completion stays open (organiser closes explicitly).
      const firstCrossing = reachedThreshold && !event.threshold_reached_at;
      const updated = {
        ...event,
        replies,
        completion: event.completion || { status: 'open', completed_at: null, commit_sequence: null },
      };
      if (firstCrossing) {
        updated.threshold_reached_at = now;
        updated.threshold_reached_count = count;
        updated.threshold_reached_sequence = commit.sequence;
      }
      return {
        event: updated,
        applied: true,
        decision,
        countedReplies: count,
        // For accumulating, "completedEvent" signals threshold-was-just-crossed
        // (first time). Callers use this for ack subjects/bodies. The
        // event itself is NOT marked complete.
        completedEvent: firstCrossing,
        thresholdReached: reachedThreshold,
        thresholdJustCrossed: firstCrossing,
      };
    }

    // unique / latest: lock at threshold (current behaviour)
    const updated = {
      ...event,
      replies,
      completion: reachedThreshold
        ? { status: 'complete', completed_at: now, commit_sequence: commit.sequence, reached_threshold_at: count }
        : (event.completion || { status: 'open', completed_at: null, commit_sequence: null }),
    };
    return { event: updated, applied: true, decision, countedReplies: count, completedEvent: reachedThreshold };
  }

  return { event, applied: false, decision: { count: false, reason: 'unreachable' } };
}

// --- persistence helper ---

// Atomic read-modify-write on events/{eventId}.json. `updater(event)` receives
// the loaded JSON and returns either a new event object OR null/undefined to
// skip the write. Temp-file + rename for crash safety.
//
// Serialised through the shared per-event mutex (event-mutex.js) so this
// can't race with activate/edit/recordStepSendErrors in event-store.js, or
// archive/unarchive in sweep.js. The git operations inside syncEventJson
// MUST be inside the lock — concurrent `simple-git` calls against the
// same .git dir collide on `index.lock`.
async function updateEventAtomic(eventId, updater, { syncMessage } = {}) {
  const { withEventMutex } = require('./event-mutex');
  return withEventMutex(eventId, async () => {
    const file = path.join(config.dataDir, 'events', `${eventId}.json`);
    const raw = await fs.readFile(file, 'utf8');
    const event = JSON.parse(raw);
    const next = await updater(event);
    if (!next) return { event, changed: false };
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(next, null, 2) + '\n');
    await fs.rename(tmp, file);
    // Mirror state into the per-event repo's event.json. The repo IS
    // the proof artifact; once it exists, every master-JSON state
    // transition must also land there or the offline verifier reads a
    // stale snapshot. No-ops cleanly when the repo doesn't exist yet
    // (e.g. pending-activation events).
    try {
      const { syncEventJson } = require('./gitrepo');
      await syncEventJson(eventId, next, syncMessage || 'event state update');
    } catch { /* repo-sync failure shouldn't undo the master write */ }
    return { event: next, changed: true };
  });
}

module.exports = {
  shouldCount,
  applyReply,
  applyDedup,
  isComplete,
  firstPendingStep,
  stepDepsMet,
  eligibleSteps,
  meetsTrust,
  hashSender,
  senderMatchesSigner,
  senderIsInitiator,
  updateEventAtomic,
  matchAttachmentsAgainstRefDocs,
  isStrictSigningEvent,
  TRUST_ORDER,
};
