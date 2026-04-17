# GitDone — Product Requirements Document

**Version:** 2.0 (Revival)
**Date:** 2026-04-16
**Status:** Design agreed, implementation pending
**Supersedes:** v1 (event-management-only, archived)

---

## 0. Design Principles (non-negotiable)

Every identity and authentication system for the past 60 years has drifted from its original design toward centralization, surveillance, or extraction. The following principles are structural defenses against that drift. Each is a lesson paid for by a failed or captured predecessor (see §0.2).

### 0.1 Principles

1. **No user accounts. Ever.** Every URL is event-scoped or public stats. No profile pages that span events. No "my gitdone." No "sign in." Participants never register — they reply to emails.

2. **Proofs must verify without gitdone being alive.** A cloned repo + an open-source `gitdone-verify` script must validate every proof (DKIM signatures, OpenTimestamps anchors, content hashes) entirely offline, without calling any gitdone server. If gitdone the service dies tomorrow, every issued proof still works forever.

3. **Don't become a standard.** Stay a tool. No RFC, no W3C, no foundation, no committee. Other implementations are welcome; endorsement-chasing is not.

4. **Invisible beats correct.** The participant's action is "reply to email" or "tap mailto: link." If any proposed feature makes the participant think, reject it.

5. **No analytics, no tracking, no cross-event aggregation.** Only public per-event stats and platform totals. No user-level views, no behavioral data, no telemetry. The business model is that there is no business model.

6. **No public API in Phase 1.** The git repo IS the API. Integrators clone and parse. APIs attract integrations that lock in the current schema.

7. **Federation is portability of proofs, not federation of service.** Anyone can run their own verifier. Proofs from verifier-A validate at verifier-B because DKIM + OpenTimestamps are independently verifiable. No cross-verifier trust protocol needed; none should be built.

8. **Resist identity unification.** A person can have many `.vou` files across many email addresses, many events, many contexts. Forcing them together is the Facebook wave collapse — harmful by design.

9. **Name the trust deposits explicitly.** Every system concentrates trust somewhere. GitDone concentrates it in: mail providers (DKIM), Bitcoin miners (OpenTimestamps), git collision resistance, and the maintainer council. These are named and unavoidable. Reducing them further would require new cryptography and is out of scope.

10. **Plaintext discipline.** Sender addresses are hashed with public salt. Attachments never stored on the server (forwarded to event owner, only content hashes committed). Audit every commit payload for "plaintext equivalents."

### 0.2 What these principles protect against (historical context)

The principles above derive from the 5-part history of digital identity by Sar at Synthetic Auth, traced from CTSS (1961) through OAuth/OpenID Connect (2014):

| Article | Failure mode gitdone must avoid |
|---|---|
| [Part 1 — The Birth of Digital Authentication](https://syntheticauth.ai/posts/synthetic-auth-the-making-of-digital-identity-01-the-birth-of-digital-authentication) | Plaintext storage, "whoever knows the secret IS the person" |
| [Part 2 — The Cryptographic Solution](https://syntheticauth.ai/posts/the-making-of-digital-identity-02-the-cryptographic-solution) | Solving the wrong puzzle — identity isn't just secret-knowledge |
| [Part 3 — The Network Era](https://syntheticauth.ai/posts/the-making-of-digital-identity-03-the-network-era) | The boundary problem — trust concentration when verifying strangers |
| [Part 4 — The Web Identity Crisis](https://syntheticauth.ai/posts/the-making-of-digital-identity-04-the-web-identity-crisis) | Account proliferation, shadow profiles, user as product |
| [Part 5 — The Federation Wars](https://syntheticauth.ai/posts/the-making-of-digital-identity-05-the-federation-wars) | Federation → oligopoly, identity merged with surveillance, OpenID lost to FB Connect on UX |

### 0.3 The cumulative lessons (60+ years)

- **Scale breaks trust.** Systems for known communities fail at stranger-scale.
- **Trust always gets deposited somewhere.** "Trustless" is marketing. The design question is *who* you trust — name it.
- **Mathematical purity loses to convenience every time.** OpenID (correct, hard) lost to Facebook Connect (dirty, easy).
- **Commerce drives architecture.** Frictionless paths win even when they're technically wrong.
- **Each solution breeds the next problem.** Passwords → hashing → federation → oligopoly → surveillance.
- **The user becomes the product** whenever identity and business merge.
- **Identity fragmentation is natural; forced unification is harmful.**
- **Plaintext is the original sin** and still lurks in every stack.

GitDone's core bet is that by being a *coordination* tool that produces cryptographically-verifiable git repos as a side effect — rather than an *identity* product — it can avoid the drift that captured every predecessor.

### 0.4 The filter

Every future feature request passes this test: "Does it violate a principle in §0.1?" If yes, reject, regardless of how clever, requested, or commercially tempting. The principles are the moat.

---

## 1. What GitDone Is

**GitDone is a universal coordination protocol for getting cryptographically verifiable multi-party actions, using email as the participant interface and git as the permanent record.**

An initiator defines what needs to happen, who needs to do it, and when it's done. Participants receive emails. They reply. Their replies are DKIM-verified, timestamped via OpenTimestamps, and committed to a per-event git repository. When the completion criteria are met, the event closes and the repository becomes the permanent, independently-verifiable proof.

**Two event types cover every use case:**

1. **Event** (workflow) — named steps with ordering (sequential / non-sequential / hybrid). Completion = all steps done. Examples: wedding vendor coordination, multi-signer contracts, release approval chains.

2. **Crypto** — one of two sub-modes:
   - **Declaration** — exactly one DKIM-verified email, one signer, one cryptographic record. Examples: personal declaration, timestamped statement, whistleblower submission, single-party consent.
   - **Attestation** — multiple DKIM-verified emails from distinct signers, count-based completion. Examples: proof of being known (vouching), petitions, peer review quorums, multi-witness statements, supply chain checkpoints.

**Type hierarchy:**

```
GitDone Event
├── Type 1: Event (workflow)
│   └── Flow: sequential | non-sequential | hybrid
│
└── Type 2: Crypto
    ├── Mode: Declaration   → exactly 1 email
    └── Mode: Attestation   → N emails
        └── Dedup: unique | latest | accumulating
```

**The three properties that make this novel:**

- "I want cryptographic proof of a human action" → normally requires account systems or blockchains. GitDone uses DKIM (already deployed by every major mail provider).
- "I want it verifiable by any third party" → normally requires trusted CAs or consensus. GitDone uses git + OpenTimestamps (Bitcoin-anchored).
- "I want it one-click for the user" → normally impossible with the above. GitDone uses email reply (universal since 1982).

---

## 2. What Exists Today (v1)

GitDone v1 is a working multi-vendor workflow coordination platform, ~80% complete for one specific use case (event/wedding vendor management).

### 2.1 Tech stack
- **Frontend:** Next.js 15, TypeScript, Tailwind CSS
- **Backend:** Node.js, Express
- **Storage:** JSON files (`data/events/*.json`), git repos (`data/git_repos/`), file uploads
- **Auth:** JWT magic links (30-day expiry, one-time use)
- **Email (outbound only):** Nodemailer over SMTP
- **File processing:** Sharp (images), fluent-ffmpeg (videos)

### 2.2 What works end-to-end
- Event creation with 3 flow types (sequential, non-sequential, hybrid)
- Magic link authentication (vendor receives email → clicks → uploads files → step completes)
- Git commits created per step completion with files + metadata
- Real-time event dashboard showing progress (initiator view)
- Read-only public event views
- Platform statistics with 6-hour aggregation cron
- Management/edit links for event owners
- File size/type validation + image compression

### 2.3 What's partially built
- Video processing (dependency imported, not tested end-to-end)
- Analytics dashboard
- Reminder emails (infrastructure present, may need testing)

### 2.4 What's missing
- Inbound email (system only sends, never receives)
- DKIM verification (not present anywhere)
- OpenTimestamps anchoring
- Multi-use-case abstraction (everything hardcoded to "vendor uploads files")
- Crypto event type (count-based completion)
- Attachment forwarding model (current design stores files on server)

### 2.5 Critical gaps that blocked v1
1. **No moat.** v1 is another event-management tool. Nothing structurally unique.
2. **Storage burden.** Every uploaded file lives on the server.
3. **Privacy concern.** Server holds all attachments.
4. **Tight coupling.** Web app is required for both initiator and participants.
5. **Single use case.** Engine doesn't generalize beyond wedding-style vendor workflows.

---

## 3. What's Changing (v2)

v2 is a structural rebuild of the participant flow and a generalization of the event model. The initiator web app stays (simplified). Participant web forms disappear. Email becomes the interface for everything participants do.

### 3.1 Architectural diff

| Component | v1 | v2 |
|---|---|---|
| Initiator UI | Next.js web app | **Simplified** — plain HTML forms, minimal JS |
| Participant UI | Next.js magic link form | **Removed** — email reply IS the interface |
| Magic link tokens | Everyone, JWT 30-day | **Initiator only** for management |
| SMTP send | Nodemailer | Same |
| SMTP receive | None | **New** — Postfix on VPS → pipe to Node |
| DKIM verification | None | **New** — `mailauth` library |
| OpenTimestamps | None | **New** — anchor every commit to Bitcoin |
| DKIM key archival | None | **New** — store signing keys with each commit |
| Reply parsing | None | **New** — `mailparser`, extract metadata |
| Attachment storage | Server filesystem | **Removed** — forwarded to event owner, hash only in git |
| Event types | Sequential / non / hybrid | Same + **crypto** (declaration + attestation modes) |
| Data storage | JSON files | Same + archived DKIM keys |
| Git commits | Per step completion (via web) | Per reply received (via email) |
| Stats, reminders, management UI | Working | Same (mostly unchanged) |

### 3.2 What gets deleted
- All participant-facing web pages (`/participate/:token`, upload forms, progress views from participant perspective)
- Participant magic link generation (no more per-participant tokens)
- File upload endpoints for participants
- Server-side file storage for attachments (only hashes remain)

### 3.3 What gets added
- **Postfix configuration** on the VPS for receiving email at `*@gitdone.yourdomain`
- **`receive.js`** — script that reads inbound email from Postfix pipe, verifies DKIM, parses MIME, routes to correct event, forwards attachments to event owner, commits metadata to git, anchors to OpenTimestamps, sends receipt to sender
- **`mailauth`** npm dependency for DKIM, SPF, DMARC, and **ARC** verification
- **`mailparser`** npm dependency for MIME parsing
- **`opentimestamps-client`** dependency (Node or Python) for Bitcoin timestamp anchoring
- **New event type: `crypto`** — count-based completion with distinct DKIM-verified senders
- **DKIM public key archival** — each commit stores the DKIM public key used to verify the signature, so future verification doesn't depend on DNS archives
- **Attachment hash recording** — when forwarding attachments to event owner, record SHA-256 hashes in the git commit
- **Humans-only pre-filter** — reject messages with `Auto-Submitted`, `List-Id`, `List-Post`, `Precedence: bulk|list|junk` headers, or system-sender patterns (`noreply@`, `mailer-daemon@`); keeps the git repo free of auto-responders and list traffic

### 3.4 What stays the same
- Event creation flow (initiator defines steps, participants, sequence)
- JSON-based storage model
- One git repo per event
- Git commits as the audit trail
- Sequential / non-sequential / hybrid workflows
- Platform stats aggregation
- Reminder email infrastructure
- Management links for initiators

---

## 4. The Event Types

### 4.1 Type 1 — Event (workflow)

Named steps, each with an assigned participant (by email), each requiring completion. Ordering is sequential, non-sequential, or hybrid.

**Completion rule:** all steps marked complete.

**Example schema:**
```json
{
  "id": "evt-abc123",
  "type": "event",
  "flow": "sequential",
  "title": "Q2 Contract Signing",
  "initiator": "hamr@example.com",
  "steps": [
    {
      "id": "step-1",
      "name": "Legal review",
      "participant": "legal@example.com",
      "requires_attachment": true,
      "status": "pending"
    },
    {
      "id": "step-2",
      "name": "CEO approval",
      "participant": "ceo@example.com",
      "depends_on": ["step-1"],
      "status": "pending"
    }
  ]
}
```

### 4.2 Type 2 — Crypto

Cryptographic record of an act. Two sub-modes based on signer count.

#### 4.2.1 Declaration mode

Exactly one DKIM-verified email. One signer. One permanent record.

**Completion rule:** 1 email received.

**Example schema:**
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

**Use cases:** personal declaration, timestamped statement, single-party consent, whistleblower submission, notarized record, "I hereby record that X happened at time T."

#### 4.2.2 Attestation mode

Multiple DKIM-verified emails from distinct signers. Count-based completion.

**Completion rule:** N distinct senders have replied (where N is the configured threshold).

**Dedup rule (optional):** how to handle multiple emails from the same sender.

| Dedup rule | Behavior | Best for |
|---|---|---|
| **unique** (default) | One email per sender. Duplicates ignored. | Vouching, petitions, peer review quorum |
| **latest** | Same sender can submit multiple times. Only the most recent counts. | Revisable reviews, status updates, revocable consent |
| **accumulating** | Every email from same sender counts separately. | Supply chain checkpoints, multi-stage attestations, progress logs |

**Example schema:**
```json
{
  "id": "evt-att-xyz789",
  "type": "crypto",
  "mode": "attestation",
  "title": "Proof of being known: hamr",
  "initiator": "hamr@example.com",
  "threshold": 10,
  "dedup": "unique",
  "allow_anonymous": true,
  "replies": []
}
```

**Use cases:** vouching (proof of being known), petitions, peer review quorums, multi-witness statements, supply chain checkpoints, multi-party attestations, collective consent.

### 4.3 Shared engine

All event types use the same email receive, DKIM verify, OpenTimestamps, git commit pipeline. The only differences are:
- **Outbound email content** — event: step-specific prompt; declaration: single-signer prompt; attestation: generic attestation prompt
- **Completion calculation**:
  - Event → all steps done
  - Declaration → 1 email received
  - Attestation → N distinct senders reached (per dedup rule)

---

## 5. The Participant Experience

### 5.1 What participants receive

```
From: hamr@example.com   (spoofed via initiator's email, OR gitdone-on-behalf-of)
Reply-To: event+abc123-step1@gitdone.yourdomain
Subject: [Action needed] Legal review for Q2 Contract

Hi Legal team,

I need your review on the attached Q2 contract.

Please reply to this email with:
- Your approval or concerns
- Attach the redlined document if needed

Your reply is cryptographically recorded via git + OpenTimestamps.
Due date: 2026-04-23

—
Sent via GitDone
```

### 5.2 What they do

Hit Reply. Type their response. Attach files if needed. Send.

**Total effort: reply to an email.**

No clicks on magic links. No web forms. No accounts. No app installs.

### 5.3 What happens next

1. Reply arrives at `event+abc123-step1@gitdone.yourdomain`
2. Postfix pipes to `receive.js`
3. `receive.js`:
   a. Verifies DKIM via `mailauth`
   b. Parses MIME via `mailparser`
   c. Extracts sender, body, attachment hashes
   d. Forwards the original email (with attachments) to the initiator's inbox
   e. Commits metadata JSON to the event's git repo
   f. Archives the DKIM public key alongside the commit
   g. Submits commit hash to OpenTimestamps
   h. Replies to participant with commit hash and OTS proof reference
   i. Checks if event is complete; if yes, notifies initiator
4. Git repo now has a cryptographically verifiable record

### 5.4 What they DO NOT see

- The git repo (unless initiator chooses to share)
- Other participants' replies
- The initiator's management dashboard
- Any gitdone web UI

---

## 6. The Initiator Experience

### 6.1 Event creation (web UI, simplified)

Initiator visits `gitdone.yourdomain` and fills out a minimal form:

```
Event type:  [ Workflow | Crypto ]
Title:       [________________]
Your email:  [________________]

(Workflow)
  Flow:        [ Sequential | Non-sequential | Hybrid ]
  Steps:
    + Add step
      Step name: [_________]
      Participant email: [_________]
      Requires attachment: [yes/no]
      Due date: [optional]

(Crypto)
  Completion threshold: [__] distinct replies
  Allow anonymous: [yes/no]
  Expected participants: [optional list of emails]
```

Submit. Receives:
- Event ID
- Management magic link (emailed)
- For workflow events: emails sent to participants with reply-to addresses
- For crypto events: a shareable mailto: link to send to potential vouchers

### 6.2 Management

Click the management link from the email. See:
- Progress (X of Y steps done, or X of Y vouches received)
- Timeline (commits with timestamps and OTS anchors)
- Pending actions
- Option to resend reminder emails
- Option to close event early
- When complete: download repo as zip, or clone URL

### 6.3 Receipt

Every reply triggers a forward to the initiator's inbox with the original attachments. The initiator's email is the attachment archive. GitDone only stores hashes.

When the event completes, the initiator has:
1. A git repo with all metadata, DKIM keys, OpenTimestamps proofs
2. Their inbox full of forwarded emails with original attachments
3. A permanent, verifiable record

### 6.4 Initiator email commands (primary interaction)

Per the moat (§0.1.4 — "invisible beats correct"), the initiator's day-to-day interactions with a running event happen via email, not web forms. The magic-link management URL exists as a fallback for initiators whose outbound DKIM is broken (corporate gateways) or who prefer a visual view.

**Address namespace:**

| Address | Purpose | Authentication |
|---|---|---|
| `event+{id}-{step}@` | participant reply → commit | DKIM + §7.4 trust classifier |
| `verify+{id}@` | anyone forwards a raw `.eml` or attachment; gets a verification report back | none (public op) |
| `stats+{id}@` | initiator: current event state + progress | DKIM + envelope sender == `event.initiator` |
| `remind+{id}@` | initiator: resend reminders to pending-step participants | same |
| `close+{id}@` | initiator: close event early | same |
| `reverify+{id}-{commitN}@` | initiator or auditor: re-run verification on a specific commit with supplied evidence (raw `.eml`, attachment) | none |

**Initiator authentication via DKIM:** when an inbound message is DKIM-verified and its envelope sender matches `event.initiator`, that's cryptographic proof that the initiator authorised the command. As strong as (and often stronger than) a magic link — DKIM can't be spoofed, magic links can be forwarded.

**Every outbound email from GitDone includes a footer** pointing to `verify+{id}@` and `stats+{id}@` for the event. Zero-friction discoverability.

---

## 7. The Cryptographic Proof — What It Actually Guarantees

### 7.1 What DKIM + git + OpenTimestamps prove

For each commit in an event's repo:

1. **Authenticity:** the email was signed by its domain's mail server at signing time (DKIM)
2. **Integrity:** the email content was not modified after signing (DKIM body hash + header signature)
3. **Future-verifiable:** the DKIM public key is archived in the commit, so verification works even after DNS rotation
4. **Timestamped:** the commit hash was anchored to a Bitcoin block at time T, so gitdone cannot have backdated the commit (OpenTimestamps)
5. **Content-bound:** attachment SHA-256 hashes are in the commit, so when the initiator produces the original email, anyone can verify the attachment matches what was recorded

### 7.2 What it does NOT prove

- That a specific human pressed "send" (only that an authenticated session at the mail provider did)
- That the claimed From: address is the human typing — if Alice's Gmail is compromised, DKIM still validates attacker's emails
- That attachments are authentic beyond their hash — only that what was received matches what was recorded
- Content authenticity of anything referenced externally (URLs, etc.)

These are standard email-security limitations. Documented in the spec so users don't overclaim.

### 7.3 Independent verification

Any third party can verify a gitdone event by:

1. Cloning the event's git repo
2. For each commit:
   - Read the archived DKIM public key
   - Read the raw email metadata
   - Reconstruct the DKIM canonical form and verify signature
   - Check the OpenTimestamps proof against Bitcoin block headers
3. If all verify, the chain of events is cryptographically sound

No trust in gitdone the service is required. GitDone is a convenience layer; the proofs are self-contained.

**Two UX paths for re-verification** (same cryptographic guarantees, different audiences):

- **`verify+{id}@` by email** — forward the raw `.eml` or attachment to the event's verify address. GitDone re-runs checks and sends a DKIM-signed report back. Convenience UX; still requires GitDone to be running.
- **Offline CLI** (`gitdone-verify`) — installable tool that works on any cloned repo without contacting GitDone. Principle §0.1.2 embodiment. Takes an optional `--emails` directory for full DKIM re-verification.

The artifacts in the repo are the cryptographic truth; both paths are just different ways to run the same math.

### 7.4.x Minimum trust threshold and contestation

Events declare a minimum trust level that counts toward completion:

```json
{
  "min_trust_level": "verified" | "forwarded" | "authorized" | "unverified"
}
```

Commits with a trust level below the threshold are written to the repo (accept-with-flag) but marked `contested: true` in their metadata and **not counted** toward workflow-all-steps-done or attestation-threshold-reached.

**Upgrade path:** the initiator (or the signer themselves) forwards the raw `.eml` to `reverify+{id}-{commitN}@`. GitDone:

1. Re-runs DKIM verification against the commit's archived PEM using the supplied raw email
2. If the signature validates cleanly, appends a new "re-verification" git commit that updates commit N's metadata: `trust_level_upgraded: from → to`, `contested: false`
3. The original commit-N.json stays untouched (immutable history); the upgrade is a new commit layered on top
4. Completion logic re-evaluates

Default `min_trust_level` by event type:

- **Event (workflow):** `verified`
- **Crypto Declaration** (legal/compliance weight): `verified` — required, no fallback
- **Crypto Attestation** (petitions, vouches): `authorized` — allows a broader audience while still rejecting entirely unauthenticated mail

### 7.4 Handling real-world DKIM fragility — trust levels and verification methods

**Scope invariant: participant replies are from humans only.** GitDone does not accept replies from mailing lists, automated systems, or out-of-office responders. This is enforced by a pre-filter (below) before any cryptographic verification. Participants are identified by their personal or corporate mailbox, never by a list address.

**Even from humans, DKIM is not uniformly reliable.** Signatures break when intermediaries modify the message in transit. For human participants, the common breakers are:

- **Corporate security gateways** (Proofpoint, Mimecast, Barracuda) — a participant replying from `@bigcorp.com` transits their company's outbound scanner, which may inject "external" warnings, rewrite URLs, or strip tracking pixels. Common among enterprise participants.
- **Forwarded mailboxes** (`old@oldjob` → `new@gmail`) — the forwarder modifies headers and sometimes the body; sometimes ARC-saved, sometimes not.
- **Obscure providers that don't sign outbound** — rare in 2026 since Gmail/Yahoo mandated DKIM in 2024, but exists.

**GitDone's architectural advantage: we are the MX.** Mail arrives at `gitdone.yourdomain`'s Postfix directly from the sender's MTA. Zero intermediaries on our side. This eliminates all *recipient-side* modification failures (Microsoft/Outlook safety banners, inbound re-encoders) that would otherwise affect 15–30% of real-world mail. Only sender-side intermediaries (gateways, forwarders) remain as concerns.

For those residual cases, GitDone uses **four verification methods, layered**, after the pre-filter. Every accepted reply commits to git regardless of verification outcome; the commit records which methods verified and produces a **trust level** per reply. The initiator sets the completion policy (accept all, require verified, etc.).

#### Pre-filter — reject automated and list-distributed messages

Before any cryptographic verification, the reply is checked against these rejection rules (RFC 3834 and related):

- `Auto-Submitted:` header present and not `no` → out-of-office, vacation responder, automated ticketing. **Rejected**, with a polite explanatory bounce telling the sender to reply manually.
- `List-Id:`, `List-Post:`, or `List-Unsubscribe:` headers present → message is list-distributed, not a direct human reply. **Rejected**.
- `Precedence: bulk` / `list` / `junk` → bulk-mail indicator. **Rejected**.
- Sender is a known system address pattern (`noreply@`, `no-reply@`, `mailer-daemon@`, `postmaster@`, `bounces@`) → **Rejected**.

Rejected messages are logged (sender, subject, reason) but not committed. The git repo stays clean — only human-initiated replies are recorded.

#### Method 1 — DKIM (primary)

Verify the sender's DKIM signature against the DNS-published public key. Archive the public key alongside the commit so future verification doesn't depend on DNS rotation.

- **`pass`** — signature valid, sender's domain authenticated, body integrity intact. **Highest trust.**
- **`fail`** — signature invalid (modified in transit, or forgery attempt). Not rejected, but flagged.
- **`neutral` / `policy` / `temperror`** — signature present but verification inconclusive (DNS issue, expired key, algorithm mismatch). Flagged.
- **`none`** — no DKIM header. Flagged as unsigned.

#### Method 2 — ARC (fallback when DKIM fails due to intermediary modification)

**ARC (Authenticated Received Chain, RFC 8617)** is how we recover trust when a trustworthy intermediary modified the message after the original signing. This is the primary recovery path for participants behind corporate security gateways that modify outbound mail. Each ARC-participating hop adds a signed attestation of the authentication results it observed before modifying. If the chain verifies and the intermediaries are trustworthy (e.g., Gmail, Fastmail, Google Workspace, Microsoft 365), we can trust the original authenticity even though current DKIM fails.

- **`arc=pass` with DKIM=fail** — message was modified by a known, trustworthy intermediary that vouched for the original DKIM. **Medium trust.** Recorded with the chain details.
- **`arc=none`** — no ARC headers. No fallback available.
- **`arc=fail`** — chain broken or intermediary not trusted.

We record ARC trust details in the commit: which hops signed, what they claimed about upstream authentication, whether the chain is unbroken.

#### Method 3 — SPF + DMARC (secondary signal)

Even when DKIM fails, if **SPF passes** (sender's IP is authorized for the claimed domain) and **DMARC aligns** (the From: domain matches SPF identity), we have cryptographic evidence that the sending server was authorized by the domain owner to send on their behalf. Not as strong as DKIM-on-content (doesn't prove body integrity), but proves domain authorization.

- `spf=pass` + `dmarc=pass` with `dkim=fail` → **low-medium trust.** Domain authorized the server, but we can't prove the body wasn't modified after signing.
- `spf=pass` + `dkim=none` → **low trust.** Sender's provider authorized the MTA but doesn't sign outbound. Rare at major providers in 2026; seen at smaller ISPs.

#### Method 4 — Accept-with-flag, not reject (policy)

**GitDone does not reject unauthenticated replies.** Every reply is committed to git with its complete authentication record: DKIM result, ARC result, SPF, DMARC, and any other available signals. The initiator sees a per-reply trust level:

| Trust level | Conditions | Meaning |
|---|---|---|
| **verified** | DKIM pass, aligned, DMARC pass | Cryptographically authenticated end-to-end |
| **forwarded** | DKIM fail, ARC pass through trusted intermediary | Authenticated at origin; modified in transit by a known relay |
| **authorized** | DKIM fail/none, SPF pass, DMARC pass | Domain authorized the server; body integrity not proven |
| **unverified** | None of the above validate | Flagged; initiator decides whether to accept |

GitDone is not a gatekeeper — it is an evidence recorder. The initiator's policy decision (accept all replies regardless, require `verified` for completion, ignore `unverified` toward the attestation threshold, etc.) is configurable per event.

#### Guidance for high-stakes use cases

For events where legal or regulatory weight matters (declarations, compliance attestations, whistleblower submissions), the initiator should configure the event to require **trust level `verified`** for completion and communicate to participants:

> "Please reply from a mailbox that doesn't traverse corporate relays. Gmail, Fastmail, iCloud, and Proton all sign outbound mail cleanly. If your reply goes through a corporate security gateway or a forwarding address, GitDone will record it but downgrade the trust level."

For low-stakes attestations (petitions, casual vouches), the default `authorized`-or-better threshold is sufficient.

---

## 8. Technical Architecture (v2)

### 8.1 Services

```
┌──────────────────────────────────────────────┐
│                    VPS                        │
│                                               │
│  ┌─────────┐  ┌──────────────────────────┐   │
│  │ Nginx   │  │ Node.js Express server   │   │
│  │ (TLS)   │←→│  - /api/events (POST)    │   │
│  └─────────┘  │  - /api/events/:id       │   │
│       ↑       │  - /manage/:token        │   │
│   HTTPS       │  - /v/:id (public view) │   │
│       │       └──────────────────────────┘   │
│       │              ↓ file I/O               │
│       │       ┌──────────────────────────┐   │
│       │       │ data/                    │   │
│       │       │  events/*.json           │   │
│       │       │  git_repos/*/            │   │
│       │       │  dkim_keys_archive/*     │   │
│       │       └──────────────────────────┘   │
│       │                                       │
│  ┌─────────┐  ┌──────────────────────────┐   │
│  │ Postfix │→ │ receive.js (pipe)        │   │
│  │ (MX)    │  │  - mailauth (DKIM)       │   │
│  └─────────┘  │  - mailparser (MIME)     │   │
│       ↑       │  - ots-client (OTS)      │   │
│    SMTP       │  - forward email to owner │   │
│       │       │  - commit to event repo  │   │
│                └──────────────────────────┘   │
└──────────────────────────────────────────────┘
       ↑
    Email
 from participants
```

### 8.2 Dependencies

**Existing (keep):**
- `express`, `nodemailer`, `sharp`, `fluent-ffmpeg` (if video needed)
- Whatever frontend stays (simplify to vanilla or keep Next.js minimal)

**New:**
- `mailauth` — DKIM / SPF / DMARC / **ARC** verification (Node, by Nodemailer author, actively maintained)
- `mailparser` — MIME parsing (Node, by same author, stdlib of Node email processing)
- `opentimestamps-client` — OpenTimestamps Bitcoin anchoring (Python binary called via subprocess, or Node equivalent if available)
- `simple-git` or equivalent — git operations from Node (already in use)

**Infrastructure:**
- Postfix (installed via `dnf install postfix`, configured with pipe transport to `receive.js`)
- MX DNS record pointing VPS
- SPF + DKIM + DMARC records for outbound from `gitdone.yourdomain` (so our own emails validate)

### 8.3 Data model (git repo per event)

```
data/git_repos/evt-abc123/
├── event.json              # initial event definition
├── commits/
│   ├── commit-001.json     # first reply
│   ├── commit-002.json     # second reply
│   └── ...
├── dkim_keys/
│   ├── commit-001.pem      # archived DKIM public key for commit 1
│   ├── commit-002.pem
│   └── ...
├── ots_proofs/
│   ├── commit-001.ots      # OpenTimestamps proof
│   ├── commit-002.ots
│   └── ...
└── completion.json         # when event closes, final state
```

Each `commit-NNN.json`:

```json
{
  "schema_version": 2,
  "event_id": "evt-abc123",
  "step_id": "step-1",
  "sequence": 1,
  "received_at": "2026-04-16T14:22:00Z",
  "sender_hash": "sha256:a1b2c3...",
  "sender_domain": "gmail.com",
  "trust_level": "verified",
  "participant_match": true,
  "attachments": [
    {
      "filename": "contract-signed.pdf",
      "size": 1234567,
      "sha256": "sha256:d4e5f6..."
    }
  ],
  "dkim": { "signatures": [ { "result": "pass", "aligned": "gmail.com", "selector": "20230601", "domain": "gmail.com" } ] },
  "spf": { "result": "pass" },
  "dmarc": { "result": "pass" },
  "arc": { "result": "none" },
  "envelope": { "client_ip": "209.85.218.52", "client_helo": "mail-ed1.google.com" },
  "raw_sha256": "sha256:...",
  "raw_size": 12345,
  "dkim_key_file": "dkim_keys/commit-001.pem",
  "ots_proof_file": "ots_proofs/commit-001.ots"
}
```

**Schema v2 rationale (per §0.1.10 plaintext discipline):** sender is represented only by its salted hash (salt lives in the event's `event.json`) and by domain. Subject, body preview, message ID, and plaintext sender are **not** stored in the committed metadata — they live only in the forwarded email to the event owner. The event salt is per-event public, so a verifier can re-hash a claimed address and match, but bulk correlation across events is infeasible.

---

## 9. Deployment and Infrastructure

### 9.1 Target environment

- **VPS:** NerdWallet (user's existing)
- **OS:** Fedora Linux (user's standard)
- **Domain:** fresh, MX records pointing to VPS
- **Deployment:** PM2 + Nginx + TLS (matches current gitdone deployment)
- **Storage budget:** minimal (no attachment storage; JSON + DKIM keys + OTS proofs are all small)

### 9.2 Setup steps (infrastructure)

1. Install Postfix: `dnf install postfix`
2. Configure Postfix to receive mail for `*@gitdone.yourdomain`
3. Configure pipe transport in `/etc/postfix/master.cf` to hand email to `receive.js`
4. Set up DNS:
   - MX record → VPS
   - SPF record for outbound
   - DKIM keys and DKIM TXT record for outbound
   - DMARC record
5. Generate OpenTimestamps client binary on VPS
6. Configure Node service (PM2) for Express + receive.js listener

### 9.3 No vendor dependencies

- No SendGrid, no Mailgun, no Postmark — Postfix directly
- No cloud functions — Node scripts on VPS
- No proprietary timestamp service — OpenTimestamps is free, open, Bitcoin-anchored
- No platform lock-in

---

## 10. Rollout Phases

### Phase 0 — POC (1 weekend) — **COMPLETE 2026-04-17**

Prove the core email-in pipeline works:

1. Install Postfix on a test VPS
2. Write minimal `receive.js` that:
   - Reads email from stdin
   - Verifies DKIM with `mailauth`
   - Logs sender, body, attachment list
3. Send a test email, confirm processing
4. **Independent verifier (`gitdone-verify`)** — the structural integrity check (see §10.4)

**Graduation:** one real email, DKIM verified, metadata extracted, logged to console. `gitdone-verify` successfully validates a sample repo *without making any network call to gitdone's server* — only public DNS (for DKIM keys) and Bitcoin block headers (for OpenTimestamps).

Validation results recorded in §10.5.

### Phase 0 tail — `gitdone-verify` (independent verification)

Principle §0.2 says **proofs must verify without gitdone being alive.** This isn't a Phase 3 nice-to-have — it's the one feature whose absence would make every other feature meaningless. If a customer can't verify their proof after gitdone dies, gitdone is just another Keybase waiting to happen.

**What to build:**

A single-file, open-source, zero-server-dependency verifier. Takes a cloned gitdone event repo as input; outputs a pass/fail report.

```
$ gitdone-verify ./some-cloned-event-repo/
```

**What it verifies, in order:**

1. **Git integrity** — every commit is well-formed, the chain is intact, no rewriting.
2. **DKIM signatures on each committed email** — using the DKIM public key archived *inside* the repo alongside the commit. No DNS call needed for the verification itself; optional DNS cross-check if current keys still exist.
3. **OpenTimestamps proofs** — each commit's `.ots` proof is validated against Bitcoin block headers. Can run against a local Bitcoin node if available, or against any OTS calendar server (redundant, Bitcoin headers are the real anchor).
4. **Attachment hashes** — if the event owner produces the original forwarded emails, their attachments are re-hashed and compared to the hash recorded in the commit.
5. **Event-type rules** — for workflow events: all steps complete in valid order. For crypto/declaration: exactly one signer. For crypto/attestation: distinct senders per dedup rule, threshold met.

**Constraints:**

- **No call to any gitdone service.** Not `verify.gitdone.example`, not `api.gitdone.example`. Zero.
- **Single binary or single Python/Node file.** No server, no database, no Docker. Run it anywhere.
- **Open source under a permissive license (MIT or Apache-2.0).** So it can be forked, audited, or re-implemented.
- **Deterministic output.** Same repo in, same report out. No timestamps, no flaky network retries.

**Deliverable:** one file in the gitdone repo at `tools/gitdone-verify/` + a worked example verifying a sample event repo end-to-end. Checked into git, reproducibly buildable.

**Definition of done:**

- Disconnect the VPS from the internet.
- Clone a real gitdone event repo to a different machine that has *never* talked to gitdone.
- Run `gitdone-verify`.
- Get a green pass.

If that works, gitdone dying tomorrow doesn't invalidate a single proof ever issued. That's the entire architectural point, made concrete.

### Phase 1 — Core rebuild (2 weekends)

Build the receive pipeline end-to-end:

1. Hook `receive.js` into actual event routing
2. Add `mailparser` for full MIME extraction
3. Add OpenTimestamps anchoring
4. Add DKIM key archival
5. Add attachment forwarding to event owner via SMTP
6. Remove participant magic link routes and frontend pages
7. Simplify initiator UI (plain HTML form, no heavy React)

**Deliverable:** one workflow event, one participant replies via email, git commit created with OTS proof and DKIM key, attachment forwarded to initiator.

### Phase 2 — Crypto event type (1 weekend)

Add the crypto event primitive with both modes:

1. New event type in schema with `mode` field (declaration | attestation)
2. Declaration mode: single-signer, 1-email completion
3. Attestation mode: multi-signer, count-based completion
4. Dedup rules for attestation (unique / latest / accumulating)
5. Generic mailto: share link generation for attestation
6. Single-signer email flow for declaration
7. Test with a real declaration event (one signer) and a real attestation event (vouching with 3+ senders)

**Deliverable:**
- Declaration: one signer sends DKIM-verified email, committed with OTS anchor, event closes
- Attestation: 3+ real people reply from different domains, all DKIM-verified, threshold reached, event closes with unique dedup

### Phase 3 — Polish and documentation (1 weekend)

1. Receipt emails to participants (with commit hash + OTS proof reference)
2. Management dashboard improvements
3. User documentation (what is a gitdone event, how verification works)
4. Small landing page explaining the two event types
5. Publish `gitdone-verify` (built in Phase 0 tail) as a standalone GitHub repo with its own release + usage docs

**Deliverable:** public launch with documentation, standalone verifier, sample events.

### 10.5 Phase 0 Validation Results (2026-04-17)

Phase 0 completed on a RackNerd VPS (AlmaLinux 8, Postfix 3.5.8, Node 20). All architectural assumptions in §1, §3, §7, and §8 empirically validated with real external mail.

**Happy-path matrix (external SMTP, real senders):**

| Sender | client_ip / HELO | DKIM | SPF | DMARC | ARC | trust_level |
|---|---|---|---|---|---|---|
| MSN (`avoidaccess@msn.com`) | 52.103.33.36 / `*.outbound.protection.outlook.com` | pass (aligned) | pass | pass | pass (M365 chain) | **verified** |
| Gmail (`avoidaccess@gmail.com`) | 209.85.208.53 / `mail-ed1-f53.google.com` | pass (aligned) | pass | pass | none (direct, expected) | **verified** |

**Pre-filter classifier (§7.4):** 4/4 cases matched spec. `Precedence: bulk` on a real newsletter (AlgorithmWatch) rejected correctly without touching DKIM. Boddy-hash-fail (Mailjet via MSN inbox) correctly classified `unverified`. Gmail self-delivery (no DKIM) correctly `unverified`. MSN→Gmail direct correctly `verified`.

**Findings worth recording:**

1. **Direct MX receives untampered DKIM mail.** The core architectural bet — "we are the MX, so no intermediary modifies the body" — holds empirically. Both providers produced clean DKIM pass + DMARC pass.

2. **Attachment hashing is deterministic across sessions.** The same PDF + DOCX sent from two different providers (MSN and Gmail, different routing paths, different hosts) produced byte-identical SHA-256 hashes. Validates the privacy model: we record only hashes, owners retain content, independent third parties can re-verify.

3. **Plus-tag survives external SMTP end-to-end.** `event+ID-step@git-done.com` made it from a sender's outbound MTA through inbound SMTP, routing, and the pipe transport all the way to `${original_recipient}` in `receive.js`. Phase 1 event routing by plus-tag is architecturally viable.

4. **ARC behavior matches §7.4 theory.** M365-mediated mail carries an ARC chain and passes; direct-Gmail mail has no ARC (nothing to attest) and classifies `verified` via DKIM+DMARC alone. No anomalies.

5. **DMARC pass achievable from DKIM alignment alone** (SPF unreachable because mailauth needs envelope `ip`/`helo`, which requires Postfix pipe transport — see finding 7). Good: DMARC remains a reliable `verified` anchor even when SPF context is unavailable.

**Architectural lessons not in the original PRD (add to Phase 1 spec):**

6. **Postfix on systemd uses `PrivateTmp=yes` by default on RHEL/AlmaLinux.** The service has an isolated `/tmp`. Pipe-transport scripts must log outside `/tmp` (use `/var/log/gitdone/`). Originally hit while debugging: pipe ran, script wrote to `/tmp/gitdone-poc.log`, log appeared empty from our login shell because Postfix's log was inside `/tmp/systemd-private-*/tmp/`.

7. **Alias-pipe (`"|command"` in `/etc/aliases`) loses envelope metadata.** `local(8)` runs the pipe under `/bin/sh -c` with no `${client_address}` / `${client_helo}` / `${sender}` / `${original_recipient}` available. SPF verification and plus-tag preservation both require these.

8. **Correct production setup: Postfix `pipe(8)` transport.** Required config sketch:

   ```
   # /etc/postfix/master.cf
   gitdone  unix - n n - - pipe
     flags=R user=<runtime-user> argv=/opt/gitdone/bin/receive.sh ${client_address} ${client_helo} ${sender} ${original_recipient}

   # /etc/postfix/main.cf
   virtual_mailbox_domains = git-done.com
   virtual_mailbox_maps = static:nothing
   virtual_transport = gitdone
   transport_maps = hash:/etc/postfix/transport

   # /etc/postfix/transport
   git-done.com  gitdone:
   ```

   `mydestination` must **not** contain the GitDone domain (or `local(8)` intercepts before the transport runs). `luser_relay` must be unset.

9. **`receive.js` must accept envelope args** and pass them to `mailauth.authenticate()` as `{ip, helo, sender, mta}`. Without these, SPF evaluates as `none` / `neutral`, costing us one of the §7.4 fallback signals.

10. **POC `receive.js` ran as `nobody` under the alias-pipe.** For production, create a dedicated `gitdone` system user with restricted home (for git repos) and run the pipe under that identity.

**Validated spec delta:** §3.3, §7.4, §8.1 are correct as written. §8.2 transport section needs the concrete pipe(8) config from finding 8. §9.2 setup steps need PrivateTmp / pipe-transport guidance. The Phase 1 design should incorporate findings 6–10 directly.

**Additional findings from Phase 1.L.1 (verify+{id}@ email handler, 2026-04-17):**

11. **Raw-byte email match is structurally unreliable across forward paths.** Tested with 5 real forwards (2 from MSN Outlook, 1 from Gmail web) of the same committed email; each produced a different SHA-256 from the stored `raw_sha256` (off by hundreds of bytes). Every major mail client normalises headers, line endings, charsets, or re-encodes MIME when exporting via "Forward as attachment." Conclusion: `raw_sha256` is a useful integrity anchor at reception time but unreliable for post-hoc matching from user-forwarded copies.

12. **Message-ID is the only stable cross-client identifier.** RFC 5322 requires Message-ID to be preserved verbatim by any compliant client (it's how threading works). Forwards from MSN and Gmail both preserved the original Message-ID intact. Adding **`message_id_hash`** (salted, per §0.1.10) to commit schema v2 gave us reliable matching across all tested forward paths. Cascade order in verify: `raw_sha256` → `message_id_hash` → attachment `sha256`.

13. **DKIM re-verification from forwarded .eml is not possible.** Gmail and MSN both strip the DKIM-Signature header when exporting an email as attachment. mailauth reports "message not signed" on every forwarded-as-attachment sample we tested, even when the original email was verifiably DKIM-signed. This is a universal limitation of mail clients, not our system.

    **Implication for the trust model:** DKIM is verified ONCE at reception and its result is stored with an archived public key (1.D) + OTS anchor (1.E). The stored result is the truth; the OTS + git chain make tampering with that stored result detectable. Forwarded copies can only *identify* which commit they correspond to (Message-ID match) — they cannot be used to re-run DKIM. This does not weaken the cryptographic guarantee, because the guarantee never relied on repeated DKIM verification; it relied on the one-shot verification being immutable.

14. **`verify+{id}@` email flow graduates on commit identification, not content re-verification.** The per-commit verification report tells the user: "this forwarded email corresponds to commit-N in event X, and here's what we recorded about it at reception (trust level, signatures, attachment hashes)." That's the practical upper bound given finding 13, and it's the useful outcome — the user can now cross-reference a specific reply to a specific recorded commit.

---

### Phase 4 — Optional (deferred)

- Federation across multiple gitdone instances
- Bootstrap integration (accept GitHub age, domain ownership, etc. as pre-vouch signals for crypto events)
- Webhook notifications
- API for external integrations
- Visual CAPTCHA layer for high-volume crypto events

---

## 11. Success Criteria

**Phase 0 success:**
- Postfix receives mail, `receive.js` verifies DKIM on the happy path (see §10.5)
- `gitdone-verify` validates a sample repo on a disconnected machine that has never contacted gitdone — DKIM + OpenTimestamps + attachment hashes all pass offline (principle §0.1.2)

**Phase 1 success:**
- Postfix receives email, `receive.js` verifies DKIM, commits to git, forwards attachment to owner
- Zero server-side attachment storage
- OpenTimestamps anchor validates via `gitdone-verify` without any network call to gitdone
- Initiator UI creates workflow event in < 30 seconds

**Phase 2 success:**
- Declaration mode: single signer, 1 email, commits with OTS anchor, event closes
- Attestation mode: 3+ real external senders, DKIM-verified, threshold reached, event closes
- Duplicate senders correctly ignored under `unique` dedup rule

**Phase 3 (launch) success:**
- One real user (not the developer) creates and completes an event
- Third party runs `gitdone-verify` on a cloned event repo — passes without access to gitdone.example
- Documentation clear enough that a non-technical user understands what GitDone provides

**Ongoing:**
- Storage remains minimal (< 1 MB per 100 events, excluding git objects)
- DKIM verification pass rate > 95% for major mail providers
- No vendor dependencies beyond open-source libraries and Bitcoin
- `gitdone-verify` passes on every released event repo (regression test — if a schema change breaks offline verification, it's a bug)

---

## 12. Out of Scope (Deliberately)

- End-to-end encryption of emails (not needed — attachments don't live on server)
- Identity verification beyond DKIM (we prove mail authentication, not human identity)
- Legal document validity (GitDone proofs are records, not legal signatures — legal weight depends on jurisdiction and use)
- Real-time notifications (email is asynchronous by design)
- Mobile apps (web + email works everywhere)
- Authentication beyond magic links (initiator convenience only)
- Built-in document editor (users attach what they already have)
- Blockchain anchoring beyond OpenTimestamps
- Zero-knowledge proofs or advanced cryptography
- Federation in v2 (deferred to Phase 4)
- Inbuilt template library for the 9+ use cases (users describe what they need; GitDone routes it)

---

## 13. Risks and Open Questions

### 13.1 Risks

| Risk | Mitigation |
|---|---|
| **Postfix operational complexity** | Document setup thoroughly; provide `setup.sh` script |
| **DKIM breakage by intermediaries** (mailing lists, corporate gateways, forwarders) | Four-method verification per §7.4: DKIM → ARC fallback → SPF/DMARC → accept-with-flag. Trust level recorded per reply; initiator sets policy |
| **Operator tampering window before cryptographic seal** | Between Phase 1.C landing and Phase 1.D+1.E completing, the event git repo is only as trustworthy as the GitDone operator — a root user on the VPS could technically forge or delete commits. **1.D (DKIM key archival per commit) + 1.E (OpenTimestamps anchoring) close this window** by making backdated rewrites cryptographically detectable. Interim: we run on infrastructure we control and auditors should expect repos from this era to have lower assurance |
| **DKIM verification failures on edge providers** | Accept-with-flag model; user can upgrade to verified provider |
| **OpenTimestamps calendar server downtime** | OTS is async; the proof completes within 24h, no blocking |
| **Email spam filtering of our outbound** | Proper SPF/DKIM/DMARC setup from day one |
| **Deliverability of receipts to participants** | Test with top 10 mail providers before launch |
| **Attachment size limits from Postfix defaults** | Configure message_size_limit; document user expectations |

### 13.2 Open questions

- Should the initiator's email be hashed or plaintext in event JSON? (Leaning: hashed for public view, plaintext for management)
- How long to retain DKIM key archives? (Proposal: forever — they're tiny)
- How to handle legal discovery requests for event data? (Standard response: we have hashes and DKIM proofs; content is with event owners)
- Should we offer an opt-in "keep attachments for 30 days" mode for users who want the convenience? (Leaning: no — keeps the privacy story clean)
- What's the migration path from v1 data? (Proposal: none — v2 starts fresh)

---

## 14. Alignment with Dev Rules

This PRD adheres to the project's dev standards:

- **POC first:** Phase 0 is explicitly a POC before any production code
- **Build incrementally:** 4 phases, each independently useful
- **Dependency hierarchy:** uses Postfix (system), Node stdlib where possible, adds only 3 libraries (mailauth, mailparser, opentimestamps-client) — all pass the checklist
- **Lightweight over complex:** no new frameworks, no database migration, no vendor services
- **Open-source only:** every dependency is MIT/Apache/BSD licensed
- **Every line has a purpose:** the refactor deletes more code than it adds

---

## 15. One-Paragraph Summary

**GitDone v2 is a universal coordination protocol that lets an initiator define any cryptographically-verifiable action — a multi-step workflow (Event), a single-signer cryptographic record (Declaration), or a multi-signer attestation with N distinct signers (Attestation) — and receive immutable proof of completion. Participants act by replying to emails. Their replies are DKIM-verified by their mail providers, attachments are forwarded to the event owner (never stored on the server), and metadata is committed to a per-event git repository with OpenTimestamps anchors to Bitcoin. The result is immutable, independently verifiable proof, using infrastructure that's already deployed globally (DKIM, email, git), without requiring accounts, blockchains, vendor services, or user-managed cryptography. Two types cover every use case — Event (workflow) and Crypto (declaration or attestation). The initiator uses a minimal web UI. Participants never touch anything except their email client.**

---

**End of PRD.**
