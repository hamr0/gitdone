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
//   attestation (crypto)
//     - reply counts iff trust_level ≥ min_trust_level OR event.allow_anonymous
//     - appended to replies[]; dedup applied on count:
//         unique        — distinct sender_hash
//         latest        — distinct sender_hash (count same as unique, but
//                         replies[] keeps only the latest per sender)
//         accumulating  — every reply counts
//     - event completes when counted ≥ threshold
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

function shouldCountDeclaration(event, commit) {
  if (!event.activated_at) return { count: false, reason: 'event not activated' };
  if (event.archived_at) return { count: false, reason: 'event archived' };
  if (isComplete(event)) return { count: false, reason: 'declaration already signed' };
  if (!meetsTrust(commit, event)) return { count: false, reason: 'trust below min_trust_level' };
  if (!senderMatchesSigner(commit, event)) {
    return { count: false, reason: 'sender is not the declared signer' };
  }
  return { count: true };
}

function shouldCountAttestation(event, commit) {
  // Attestation events stay open past completion (audit trail continues),
  // but counting-for-completion stops. Keep committing; stop counting.
  if (!event.activated_at) return { count: false, reason: 'event not activated' };
  if (event.archived_at) return { count: false, reason: 'event archived' };
  if (isComplete(event)) return { count: false, reason: 'event already complete' };
  const trustOk = meetsTrust(commit, event);
  if (!trustOk && !event.allow_anonymous) {
    return { count: false, reason: 'trust below min_trust_level (anonymous not allowed)' };
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
    const all = [...(event.replies || []), newReply];
    const { replies, count } = applyDedup(all, event.dedup || 'unique');
    const done = count >= (event.threshold || 0);
    const updated = {
      ...event,
      replies,
      completion: done
        ? { status: 'complete', completed_at: now, commit_sequence: commit.sequence, reached_threshold_at: count }
        : (event.completion || { status: 'open', completed_at: null, commit_sequence: null }),
    };
    return { event: updated, applied: true, decision, countedReplies: count, completedEvent: done };
  }

  return { event, applied: false, decision: { count: false, reason: 'unreachable' } };
}

// --- persistence helper ---

// Atomic read-modify-write on events/{eventId}.json. `updater(event)` receives
// the loaded JSON and returns either a new event object OR null/undefined to
// skip the write. Temp-file + rename for crash safety.
async function updateEventAtomic(eventId, updater) {
  const file = path.join(config.dataDir, 'events', `${eventId}.json`);
  const raw = await fs.readFile(file, 'utf8');
  const event = JSON.parse(raw);
  const next = await updater(event);
  if (!next) return { event, changed: false };
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(next, null, 2) + '\n');
  await fs.rename(tmp, file);
  return { event: next, changed: true };
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
  updateEventAtomic,
  TRUST_ORDER,
};
