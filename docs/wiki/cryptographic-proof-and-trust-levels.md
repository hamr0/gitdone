---
title: Cryptographic proof and trust levels
theme: Cryptographic proof and trust levels
source: docs/archive/prd.md
summary: What DKIM, git and OpenTimestamps guarantee (and do not), how proofs are verified offline, the four trust levels, and how the receipt is surfaced to users.
---

# Cryptographic proof and trust levels

Source: PRD section 7, "The Cryptographic Proof — What It Actually Guarantees" (docs/archive/prd.md:888-888).

## 7.1 What DKIM + git + OpenTimestamps prove

For each commit in an event's repo (docs/archive/prd.md:892-892):

1. **Authenticity:** the email was signed by its domain's mail server at signing time (DKIM) (docs/archive/prd.md:894-894).
2. **Integrity:** content was not modified after signing (DKIM body hash + header signature) (docs/archive/prd.md:895-895).
3. **Future-verifiable:** the DKIM public key is archived in the commit, so verification works even after DNS rotation (docs/archive/prd.md:896-896).
4. **Timestamped:** the commit hash was anchored to a Bitcoin block at time T, so gitdone cannot have backdated the commit (OpenTimestamps) (docs/archive/prd.md:897-897).
5. **Content-bound:** attachment SHA-256 hashes are in the commit, so when the initiator produces the original email, anyone can verify the attachment matches what was recorded (docs/archive/prd.md:898-898).

## 7.2 What it does NOT prove

- That a specific human pressed "send" (only that an authenticated session at the mail provider did) (docs/archive/prd.md:902-902).
- That the claimed From: address is the human typing; if Alice's Gmail is compromised, DKIM still validates the attacker's emails (docs/archive/prd.md:903-903).
- That attachments are authentic beyond their hash; only that what was received matches what was recorded (docs/archive/prd.md:904-904).
- Content authenticity of anything referenced externally (URLs, etc.) (docs/archive/prd.md:905-905).

These are standard email-security limitations, documented in the spec so users don't overclaim (docs/archive/prd.md:907-907).

## 7.3 Independent verification

Any third party can verify an event by (docs/archive/prd.md:911-919):

1. Cloning the event's git repo.
2. For each commit: read the archived DKIM public key; read the raw email metadata; reconstruct the DKIM canonical form and verify the signature; check the OpenTimestamps proof against Bitcoin block headers.
3. If all verify, the chain of events is cryptographically sound.

No trust in gitdone the service is required; it is a convenience layer and the proofs are self-contained (docs/archive/prd.md:921-921).

Two UX paths for re-verification, with the same cryptographic guarantees but different audiences (docs/archive/prd.md:923-926):

- **`verify+{id}@` by email:** forward the raw `.eml` or attachment to the event's verify address. GitDone re-runs checks and sends a DKIM-signed report back. Convenience UX; still requires GitDone to be running.
- **Offline CLI (`gitdone-verify`):** installable tool that works on any cloned repo without contacting GitDone (principle §0.1.2). Takes an optional `--emails` directory for full DKIM re-verification.

The artifacts in the repo are the cryptographic truth; both paths just run the same math (docs/archive/prd.md:928-928).

## 7.4.x Minimum trust threshold and contestation

Events declare a minimum trust level that counts toward completion (docs/archive/prd.md:932-938):

```json
{ "min_trust_level": "verified" | "forwarded" | "authorized" | "unverified" }
```

Commits below the threshold are written to the repo (accept-with-flag) but marked `contested: true` in metadata and **not counted** toward workflow-all-steps-done or attestation-threshold-reached (docs/archive/prd.md:940-940).

**Upgrade path:** the initiator (or the signer) forwards the raw `.eml` to `reverify+{id}-{commitN}@`. GitDone (docs/archive/prd.md:942-947):

1. Re-runs DKIM verification against the commit's archived PEM using the supplied raw email.
2. If the signature validates cleanly, appends a new "re-verification" git commit updating commit N's metadata: `trust_level_upgraded: from → to`, `contested: false`.
3. Leaves the original commit-N.json untouched (immutable history); the upgrade is a new commit on top.
4. Re-evaluates completion logic.

Default `min_trust_level` by event type (docs/archive/prd.md:949-953):

- **Event (workflow):** `verified`.
- **Crypto Declaration** (legal/compliance weight): `verified`, required, no fallback.
- **Crypto Attestation** (petitions, vouches): `authorized`, allowing a broader audience while still rejecting entirely unauthenticated mail.

## 7.4 Handling real-world DKIM fragility

**Scope invariant:** participant replies are from humans only. GitDone does not accept replies from mailing lists, automated systems, or out-of-office responders; a pre-filter enforces this before any cryptographic verification. Participants are identified by personal or corporate mailbox, never a list address (docs/archive/prd.md:957-957).

Even from humans, DKIM is not uniformly reliable; signatures break when intermediaries modify the message. Common breakers (docs/archive/prd.md:959-963):

- **Corporate security gateways** (Proofpoint, Mimecast, Barracuda) may inject "external" warnings, rewrite URLs, or strip tracking pixels.
- **Forwarded mailboxes** modify headers and sometimes the body; sometimes ARC-saved, sometimes not.
- **Obscure providers that don't sign outbound**: rare in 2026 since Gmail/Yahoo mandated DKIM in 2024, but they exist.

**Architectural advantage: we are the MX.** Mail arrives at Postfix directly from the sender's MTA, with zero intermediaries on our side. This eliminates recipient-side modification failures (Microsoft/Outlook safety banners, inbound re-encoders) that would otherwise affect 15-30% of real-world mail. Only sender-side intermediaries (gateways, forwarders) remain (docs/archive/prd.md:965-965).

For residual cases GitDone uses **four layered verification methods** after the pre-filter. Every accepted reply commits to git regardless of outcome; the commit records which methods verified and a **trust level** per reply. The initiator sets the completion policy (docs/archive/prd.md:967-967).

### Pre-filter: reject automated and list-distributed messages

Rules (RFC 3834 and related) applied before any cryptographic verification (docs/archive/prd.md:971-976):

- `Auto-Submitted:` present and not `no` (out-of-office, vacation, ticketing): **Rejected**, with a polite explanatory bounce telling the sender to reply manually.
- `List-Id:`, `List-Post:`, or `List-Unsubscribe:` present (list-distributed): **Rejected**.
- `Precedence: bulk` / `list` / `junk`: **Rejected**.
- Sender matches a system address pattern (`noreply@`, `no-reply@`, `mailer-daemon@`, `postmaster@`, `bounces@`): **Rejected**.

Rejected messages are logged (sender, subject, reason) but not committed, so the repo records only human-initiated replies (docs/archive/prd.md:978-978).

### Method 1: DKIM (primary)

Verify the sender's DKIM signature against the DNS-published key; archive the public key alongside the commit so verification doesn't depend on DNS rotation (docs/archive/prd.md:982-982).

- **`pass`:** signature valid, domain authenticated, body integrity intact. **Highest trust** (docs/archive/prd.md:984-984).
- **`fail`:** signature invalid (modified in transit, or forgery). Not rejected, but flagged (docs/archive/prd.md:985-985).
- **`neutral` / `policy` / `temperror`:** inconclusive (DNS issue, expired key, algorithm mismatch). Flagged (docs/archive/prd.md:986-986).
- **`none`:** no DKIM header. Flagged as unsigned (docs/archive/prd.md:987-987).

### Method 2: ARC (fallback when DKIM fails due to intermediary modification)

ARC (Authenticated Received Chain, RFC 8617) recovers trust when a trustworthy intermediary modified the message after signing; it is the primary recovery path for participants behind corporate gateways. Each ARC hop adds a signed attestation of the authentication results it observed before modifying. If the chain verifies and intermediaries are trustworthy (e.g., Gmail, Fastmail, Google Workspace, Microsoft 365), original authenticity can be trusted even though current DKIM fails (docs/archive/prd.md:991-991).

- **`arc=pass` with DKIM=fail:** modified by a known, trustworthy intermediary that vouched for the original DKIM. **Medium trust.** Recorded with chain details (docs/archive/prd.md:993-993).
- **`arc=none`:** no ARC headers; no fallback (docs/archive/prd.md:994-994).
- **`arc=fail`:** chain broken or intermediary not trusted (docs/archive/prd.md:995-995).

The commit records which hops signed, what they claimed about upstream authentication, and whether the chain is unbroken (docs/archive/prd.md:997-997).

### Method 3: SPF + DMARC (secondary signal)

When DKIM fails but **SPF passes** (sender IP authorized for the claimed domain) and **DMARC aligns** (From: domain matches SPF identity), there is evidence the sending server was authorized by the domain owner. Weaker than DKIM-on-content (doesn't prove body integrity) but proves domain authorization (docs/archive/prd.md:1001-1001).

- `spf=pass` + `dmarc=pass` with `dkim=fail`: **low-medium trust.** Domain authorized the server, but body modification after signing can't be ruled out (docs/archive/prd.md:1003-1003).
- `spf=pass` + `dkim=none`: **low trust.** Provider authorized the MTA but doesn't sign outbound; rare at major providers in 2026, seen at smaller ISPs (docs/archive/prd.md:1004-1004).

### Method 4: Accept-with-flag, not reject (policy)

**GitDone does not reject unauthenticated replies.** Every reply is committed with its complete authentication record (DKIM, ARC, SPF, DMARC, other signals), and the initiator sees a per-reply trust level (docs/archive/prd.md:1008-1008):

| Trust level | Conditions | Meaning |
|---|---|---|
| **verified** | DKIM pass, aligned, DMARC pass | Cryptographically authenticated end-to-end |
| **forwarded** | DKIM fail, ARC pass through trusted intermediary | Authenticated at origin; modified in transit by a known relay |
| **authorized** | DKIM fail/none, SPF pass, DMARC pass | Domain authorized the server; body integrity not proven |
| **unverified** | None of the above validate | Flagged; initiator decides whether to accept |

(docs/archive/prd.md:1010-1015)

GitDone is not a gatekeeper but an evidence recorder. The initiator's policy (accept all, require `verified` for completion, ignore `unverified` toward the attestation threshold, etc.) is configurable per event (docs/archive/prd.md:1017-1017).

### Guidance for high-stakes use cases

For legal or regulatory weight (declarations, compliance attestations, whistleblower submissions), configure the event to require trust level `verified` and tell participants (docs/archive/prd.md:1021-1023):

> "Please reply from a mailbox that doesn't traverse corporate relays. Gmail, Fastmail, iCloud, and Proton all sign outbound mail cleanly. If your reply goes through a corporate security gateway or a forwarding address, GitDone will record it but downgrade the trust level."

For low-stakes attestations (petitions, casual vouches), the default `authorized`-or-better threshold is sufficient (docs/archive/prd.md:1025-1025).

## 7.5 Proof surfacing: the receipt is the product

The proof must arrive at the user, not the user at the proof; per §0.1.4 ("invisible beats correct") the receipt is surfaced in two places (docs/archive/prd.md:1029-1031).

### On the manage dashboard

- Every event page renders a 4-tier trust ladder (`unverified | authorized | forwarded | verified`): the achieved level filled in its trust color, rungs below outlined in their own color (they would also have passed), rungs above dimmed grey (docs/archive/prd.md:1033-1038).
- Crypto declaration and attestation get a hero headline (`DKIM-VERIFIED · @<domain> · <date>`) and a collapsible receipt block (docs/archive/prd.md:1038-1040).
- Workflow events get a trust strip + ladder above the steps table and a per-step trust pill next to each completed status; clicking expands the step's full receipt (docs/archive/prd.md:1040-1042).
- The dashboard matches the email exactly: same colors, key/value rows, truncated hash format (docs/archive/prd.md:1042-1044).

### As durable email artifacts

Two emails carry the proof outside the dashboard so it survives the service (docs/archive/prd.md:1045-1046).

**Completion email** (`[signedreply] proof — "<title>"<counter>`) fires once the event flips to `complete` (docs/archive/prd.md:1048-1049). Recipients by mode (docs/archive/prd.md:1050-1056):

- **Workflow:** initiator + every step participant who counted.
- **Declaration:** initiator AND the named signer; a two-sided notary with the same body for both (modulo a one-line lede swap).
- **Attestation:** initiator + every counted attestor whose plaintext email was persisted under strict mode (4e, §4.2.3). Loose attestation has only salted hashes, so initiator only.

Body shape varies by (mode x role). Every body has an explicit `Mode:` line (Workflow / Declaration / Attestation + dedup-blurb + threshold) and a mode-aware reason label (`threshold reached` / `the signer replied` / `all steps completed` / `closed early by the organiser`). Reference URL and reference-doc manifest are echoed when set (docs/archive/prd.md:1058-1063). The attestor's body is privacy-conservative: only their own DKIM+OTS receipt (looked up by recomputed salted hash, not domain-match) and the statement *"The aggregate result is private to the organiser; this email is YOUR record only."* No aggregate count, modal trust, or other attestors' domains. `emails.md` §11 documents all five (mode x role) bodies (docs/archive/prd.md:1064-1070).

**OTS-anchored email** (`[signedreply] proof anchored — "<title>"`) fires once per event when the 6-hour OTS upgrade cron flips the *last* pending commit to anchored. One consolidated email, threaded (same `In-Reply-To`) to the completion email, carrying the Bitcoin block height, anchor timestamp, and proof file path. Recipients match the completion email (docs/archive/prd.md:1071-1077).

### OTS state

The dashboard tracks three phases (docs/archive/prd.md:1079-1084):

- **pending Bitcoin upgrade:** only the calendar attestation is folded in.
- **anchored to Bitcoin:** Bitcoin has confirmed but the block number can't be parsed locally (graceful fallback).
- **anchored at block N:** `ots info` extracted the block height.

The upgrade worker records state in per-commit JSON (`ots_anchored`, `ots_anchored_at`, `ots_block`); dashboard, email and `gitdone-verify` read the same on-disk truth and never disagree (docs/archive/prd.md:1084-1088). Both emails verify offline via `gitdone-verify <id>` against the per-event git repository (docs/archive/prd.md:1090-1092).

### The artifact handoff: proof bundle download

The completion and OTS-anchored emails carry the receipt (text + a single `.ots` file), not the audit trail. To lift the whole per-event git repo off the service, the organiser has two routes to the same archive (docs/archive/prd.md:1094-1098):

- **Dashboard button:** `/manage/event/:id` shows a primary amber **Download proof bundle (.tar.gz)** action, session-gated to the initiator (`auth.deriveHandle(initiator) === handle`). It streams a `.tar.gz` of `data/repos/<id>/` through tar(1) to the HTTP response, never landing on disk or Node's heap (docs/archive/prd.md:1100-1105).
- **Email command:** `bundle+<id>@<domain>`, authenticated like every initiator command (DKIM + envelope-sender hash matches `event.initiator`). The reply is `multipart/mixed` with the same `.tar.gz` attached, threaded to the proof email when there is one. Emails #20-21 in `emails.md` describe the proof receipts; #22 the bundle command (docs/archive/prd.md:1106-1111).

The emails carry the receipt; the bundle carries the full repo so an auditor can replay it offline with `gitdone-verify <id>`. Together they discharge "proofs outlive the service" (docs/archive/prd.md:1113-1117). Frozen UI reference: `docs/product/proof-surfacing-v1.md` (docs/archive/prd.md:1119-1119).
