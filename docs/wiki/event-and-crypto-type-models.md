---
title: Event and crypto type models
theme: Event and crypto type models
source: docs/archive/prd.md
summary: Defines the workflow event type and the crypto type (declaration and attestation modes), including dedup rules, strict signing with reference docs, and the shared engine.
---

# Event and crypto type models

This page condenses PRD section 4, "The Event Types" (docs/archive/prd.md:198-198).

## 4.1 Type 1: Event (workflow)

- An event has named steps. Each step has an assigned participant (by email) and must be completed. Ordering is sequential, non-sequential, or hybrid (docs/archive/prd.md:202-202).
- **Completion rule:** all steps marked complete (docs/archive/prd.md:204-204).
- **Multi-reply dedup (default):**
  - The same participant can reply to the same step multiple times, for example after forgetting an attachment or sending a corrected version (docs/archive/prd.md:206-206).
  - Every reply commits. There is no cap and no "already done" rejection (docs/archive/prd.md:206-206).
  - The latest reply wins for step completion. Earlier attempts stay in the audit trail (docs/archive/prd.md:206-206).
  - The stats view shows the reply count per (step, participant) (docs/archive/prd.md:206-206).
  - The policy is overridable per event at creation time (docs/archive/prd.md:206-206).

Example schema (docs/archive/prd.md:208-233):

```json
{
  "id": "evt-abc123",
  "type": "event",
  "flow": "sequential",
  "title": "Q2 Contract Signing",
  "initiator": "hamr@example.com",
  "steps": [
    { "id": "step-1", "name": "Legal review", "participant": "legal@example.com",
      "requires_attachment": true, "status": "pending" },
    { "id": "step-2", "name": "CEO approval", "participant": "ceo@example.com",
      "depends_on": ["step-1"], "status": "pending" }
  ]
}
```

## 4.2 Type 2: Crypto

A cryptographic record of an act, with two sub-modes based on signer count (docs/archive/prd.md:237-237).

### 4.2.1 Declaration mode

- Exactly one DKIM-verified email, one signer, one permanent record (docs/archive/prd.md:241-241).
- **Completion rule:** 1 email received (docs/archive/prd.md:243-243).
- Example schema (docs/archive/prd.md:245-255):

```json
{
  "id": "evt-decl-001",
  "type": "crypto",
  "mode": "declaration",
  "title": "Timestamped statement of witness",
  "initiator": "journalist@example.com",
  "signer": "witness@example.com"
}
```

- **Use cases:** personal declaration, timestamped statement, single-party consent, whistleblower submission, notarized record, "I hereby record that X happened at time T." (docs/archive/prd.md:257-257)

### 4.2.2 Attestation mode

- Multiple DKIM-verified emails from distinct signers, with count-based completion (docs/archive/prd.md:261-261).
- **Completion rule:** N distinct senders have replied, where N is the configured threshold (docs/archive/prd.md:263-263).
- **Dedup rule (required):**
  - It sets how multiple emails from the same sender are handled (docs/archive/prd.md:265-266).
  - It also encodes the trust policy. There is no separate `allow_anonymous` knob (docs/archive/prd.md:266-267).

| Dedup rule | Behavior | Trust policy | Best for |
|---|---|---|---|
| **unique** (default) | One reply per sender. Duplicates ignored. | DKIM-verified required. | Vouching, petitions, peer review quorum |
| **latest** | Same sender can submit multiple times. Only the most recent counts. | DKIM-verified required. | Revisable reviews, status updates, revocable consent |
| **accumulating** | Every email counts. Past threshold, count keeps growing. | None. Both DKIM-verified and unverified count; the proof archive marks each. | Supply chain checkpoints, multi-stage attestations, progress logs |

(docs/archive/prd.md:269-273)

- Replies whose sender matches the event initiator never count toward the threshold, though they still commit to the audit trail. This is in the same spirit as declaration's create-time signer != initiator check (docs/archive/prd.md:275-277).
- Example schema (docs/archive/prd.md:279-291):

```json
{
  "id": "evt-att-xyz789",
  "type": "crypto",
  "mode": "attestation",
  "title": "Proof of being known: hamr",
  "initiator": "hamr@example.com",
  "threshold": 10,
  "dedup": "unique",
  "replies": []
}
```

- **Use cases:** vouching (proof of being known), petitions, peer review quorums, multi-witness statements, supply chain checkpoints, multi-party attestations, collective consent (docs/archive/prd.md:293-293).

### 4.2.3 Reference docs and strict signing

**`reference_url`**
- Both crypto modes accept an optional `reference_url`, a public HTTPS link to the thing being signed (contract, position paper, statement) (docs/archive/prd.md:297-298).
- Validation is `https://` only and at most 2048 chars. The manage hero renders it as a linkified row (docs/archive/prd.md:299-300).

**Registering the manifest via `attach+{id}@`**
- When `reference_url` is set, the organiser is asked to register the canonical document(s) via the `attach+{id}@` channel (see §6.4 address namespace) (docs/archive/prd.md:302-304).
- The first `attach+` email is the canonical one-shot manifest (docs/archive/prd.md:304-305). It does the following (docs/archive/prd.md:305-307):
  - hashes every attachment (SHA-256 + filename + size);
  - commits a `kind: 'attach'` record to the per-event git repo;
  - OTS-stamps it;
  - discards the bytes;
  - freezes the doc set.
- Subsequent `attach+` emails bounce (docs/archive/prd.md:307-308).
- The signer invite is held at activation until the first `attach+` lands. The invite body then lists the manifest so the signer can fetch and attach the exact bytes (docs/archive/prd.md:308-311).

**Strict mode**
- `reference_url` plus registered docs means **strict signing mode** (docs/archive/prd.md:313-313).
- The signer (declaration) or attestor (attestation) MUST attach files whose SHA-256 hashes match the registered manifest before their reply counts (docs/archive/prd.md:313-316).

Matching rules:
- **Exact hash set match.** Partial signing is allowed across multiple replies. Matches accumulate per signer (declaration) or per per-attestor bucket (attestation), keyed by the same salted-hash identifier the loose-mode dedup ledger uses (docs/archive/prd.md:318-321).
- **Filename match with different bytes** is rejected as `attachment_set_mismatch`, with a diff in the ack, so the signer fixes the file (docs/archive/prd.md:322-324).
- **No matching hashes at all** is rejected as `strict_no_matching_attachments`, with the manifest reproduced inline (docs/archive/prd.md:325-327).
- **A reply counts only when it adds at least one new manifest hash to the attestor's bucket** (Module 6.5) (docs/archive/prd.md:328-329).
  - Re-signing the same doc(s) is committed to the audit trail but rejected as `strict_already_signed`. It does NOT tick the user-facing count (docs/archive/prd.md:329-332).
  - The manifest is finite and frozen, so a fully-signed bucket has nothing further to attest to (docs/archive/prd.md:332-333).
  - The rule applies across all three dedup rules (unique / latest / accumulating). A signer is counted once, when their bucket fills (docs/archive/prd.md:333-335).
  - The dashboard count for strict attestations is "distinct attestors with complete buckets," not raw `replies.length` (docs/archive/prd.md:335-337).
- **Extras** (unrelated attachments alongside the matching set) are ignored (docs/archive/prd.md:338-339).

**Privacy posture**
- File bytes are never stored, only hashes (docs/archive/prd.md:341-342).
- Declaration's strict mode adds `signed_trust_level` and `signed_sender_domain` per doc. The signer's domain is part of the DKIM-bound proof anyway (docs/archive/prd.md:342-344).
- Attestation's strict mode keeps the per-attestor map keyed by salted sender_hash, the same shape as loose attestation's dedup ledger (docs/archive/prd.md:344-346).

**Attestor email under strict mode (Module 4e)**
- Strict-mode attestation persists each attestor's plaintext email (`attestor_progress[hash].email`) on the reply that fills their bucket, so the proof email can reach them (docs/archive/prd.md:348-351).
- The email persists through the event's active lifetime, not just the first proof send. Every completion edge can therefore still reach every eligible attestor (docs/archive/prd.md:351-355). The edges are:
  - natural threshold-reach;
  - the revoke, reopen, recomplete cycle;
  - post-threshold bucket completions under oversubscribe.
- Redaction is deferred to the **terminal close edge** (docs/archive/prd.md:356-357):
  - The initiator closes the event via the `close+{id}@` command or the dashboard "Close event" button (docs/archive/prd.md:357-358).
  - `notifyLifecycleEdge(event, 'closed', ...)` then clears every stored email and stamps `event.attestor_emails_redacted_at` after sending. This is the one place that side effect lives (docs/archive/prd.md:358-361).
- Post-redaction replies (only possible under accumulating dedup) refuse to re-introduce PII (docs/archive/prd.md:361-362).
- Loose attestation never stores emails (docs/archive/prd.md:362-363).
- The PII window is bounded by bucket-completion to close, never longer than the event's open life (docs/archive/prd.md:363-364).
- The trade is justified by strict mode's self-selected non-anonymity. Signers attach files matching a manifest, and their domain is already in the proof (docs/archive/prd.md:364-366).

**History note** (docs/archive/prd.md:368-373)
- The original Module 4e redacted "the instant the proof email returns", at the first threshold-reach send.
- That broke revoke-reopen-recomplete and oversubscribe, because later completion edges had no emails to reach.
- 0.24.8 moved redaction to the close edge. 0.25.0 made that the dispatcher's single `closed`-edge side effect.
- Do not reintroduce redact-on-first-send.

**Loose vs strict**
- `reference_url` alone (no docs registered) is not strict mode. It is just a pointer, and replies count under the normal trust + dedup rules (docs/archive/prd.md:375-377).
- Strict mode requires both halves: URL set AND `reference_docs.length > 0` (docs/archive/prd.md:377-378).

## 4.3 Shared engine

All event types use the same email receive, DKIM verify, OpenTimestamps, and git commit pipeline (docs/archive/prd.md:382-382). They differ only in two ways:

- **Outbound email content** (docs/archive/prd.md:383-383):
  - event: step-specific prompt;
  - declaration: single-signer prompt;
  - attestation: generic attestation prompt.
- **Completion calculation** (docs/archive/prd.md:384-387):
  - Event: all steps done.
  - Declaration: 1 email received.
  - Attestation: N distinct senders reached (per dedup rule).

## 4.4 Where this shines: worked use cases

- The three event shapes (workflow, declaration, attestation) cover many small, high-friction social actions that currently need a platform to be honest about its database (docs/archive/prd.md:391-393).
- **Declaration** is the primitive for "who attested, when, to what, provably." **Workflow** is for "did the sequence complete." **Attestation** is for "did enough people agree." (docs/archive/prd.md:393-396)
- The list is ranked roughly by how big the gap is between current practice and what gitdone makes possible (docs/archive/prd.md:397-398).

1. **Witness statements and incident records.** Declaration mode (docs/archive/prd.md:400-406).
   - The statement is DKIM-bound to the witness's professional email and OTS-anchored.
   - It is verifiable offline forever.
   - The proof lives in the git repo, not gitdone's database.
2. **Reference letters and professional endorsements.** A declaration from a previous employer's domain is DKIM-bound to that domain and anchored in time. The recipient owns the proof file (docs/archive/prd.md:408-414).
3. **Authorship and first-publication claims.** OpenTimestamps proves you had the text at that time. Combined with DKIM from your own domain, this gives a portable priority claim (docs/archive/prd.md:416-421).
4. **Consent receipts (GDPR / data use).** Declaration. Both the user and the operator hold the receipt, and neither can rewrite history (docs/archive/prd.md:423-429).
5. **Domain-ownership and identity-binding claims.** A portable identity anchor that does not depend on the domain registrar being honest (docs/archive/prd.md:430-433).
6. **Single-step approvals and sign-offs.** One reply is the right weight, so declaration mode fits. The alternatives today are DocuSign or an unverifiable email screenshot (docs/archive/prd.md:435-439).
7. **Whistleblower attestations from a named source.** The proof survives if the hosting platform goes dark or the journalist is pressured. Decoupling from the platform is the whole point (docs/archive/prd.md:441-445).
8. **NDA acknowledgement / TOS acceptance.** Both parties can produce the same verifiable record, and the user holds a copy too (docs/archive/prd.md:447-449).

- These eight are not exhaustive. They are the cases where the gap between current practice and what is now possible is widest (docs/archive/prd.md:451-452).
- Workflow mode (§4.1) covers multi-step coordination: vendor management, supply-chain checkpoints with dependencies, and multi-party contracts with sequenced sign-offs (docs/archive/prd.md:452-455).
- Attestation mode (§4.2.2) covers threshold cases: peer review quorums, multi-witness statements, petitions, and collective consent (docs/archive/prd.md:455-457).
