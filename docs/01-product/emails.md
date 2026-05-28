# Email system

Complete catalog of every email gitdone sends — taxonomy, subject
grammar, body shapes, source files, and the architectural plan that
unifies them.

> **Renamed 2026-05-28** from `email-formats.md` to `emails.md`. The
> taxonomy tree below was prepended so the structural overview and
> the per-template details (later sections) live in one place.

---

## Taxonomy — every email at a glance

Two trigger categories. ~68 distinct templates. Each gets a stable
name that maps directly to its tree path; sender code looks templates
up by name instead of composing subject/body inline.

```
gitdone emails
│
├─ A. per-COMMIT  (one inbound message → one reply; transactional; sender = recipient)
│  │  trigger: a single email landed at our MTA. We reply to whoever sent it.
│  │  No event-state effect on its own. No recipient-set computation needed.
│  │
│  ├─ auth (not event-scoped)
│  │  └─ magic-link.signin                                                       [knowless]
│  │
│  ├─ command acks  (sender = event.initiator, DKIM-authenticated)
│  │  ├─ stats.<kind>                                                            [workflow | decl | att]
│  │  ├─ remind.summary                                                          [workflow only]
│  │  ├─ close.token-issued        (close+ stage 1)                              [any]
│  │  ├─ close.confirmed           (close+ stage 2 CONFIRM)                      [any]
│  │  ├─ close.token-mismatch                                                    [any]
│  │  ├─ close.already-complete                                                  [any]
│  │  ├─ attach.registered                                                       [crypto, ref_url set]
│  │  ├─ attach.frozen             (post-first-attach)                           [crypto]
│  │  ├─ attach.rejected           (validation failed)                           [crypto]
│  │  ├─ revoke.applied                                                          [crypto-att]
│  │  ├─ revoke.no-targets         (empty body)                                  [crypto-att]
│  │  ├─ revoke.not-found          (unknown emails)                              [crypto-att]
│  │  ├─ revoke.not-attestation    (wrong event kind)                            [decl / wf]
│  │  └─ bundle.tarball                                                          [any]
│  │
│  ├─ reply acks  (sender = a participant/signer/attestor)
│  │  ├─ workflow step  (event+id-step@)
│  │  │  ├─ accepted                                                             [counted, with own receipt]
│  │  │  ├─ no-step-id              (bare event+id@ on a workflow)
│  │  │  ├─ wrong-step              (sender ≠ step.participant)
│  │  │  ├─ trust-too-low           (below min_trust_level)
│  │  │  ├─ deps-not-met            (step blocked by depends_on)
│  │  │  └─ already-done            (step.status === complete)
│  │  ├─ declaration   (event+id@)
│  │  │  ├─ signed-in-progress      (strict, more docs to sign)
│  │  │  ├─ signed                  (event complete)
│  │  │  ├─ already-signed          (re-reply post-sign)
│  │  │  ├─ wrong-signer            (sender ≠ event.signer)
│  │  │  └─ awaiting-ref-docs       (strict, no docs registered yet)
│  │  └─ attestation   (event+id@)
│  │     ├─ accepted.loose                                                       [unique/latest/accumulating]
│  │     ├─ accepted.strict.partial (some docs signed, bucket open)
│  │     ├─ accepted.strict.complete (bucket complete)
│  │     ├─ self-reply-not-counted  (sender == initiator)
│  │     ├─ attachment-hash-mismatch (strict, wrong content)
│  │     ├─ no-matching-attachments (strict, none of the listed docs)
│  │     ├─ already-signed          (strict, bucket already complete)
│  │     ├─ awaiting-ref-docs       (strict, no docs registered yet)
│  │     ├─ revoked-sender          (revoked attestor's re-reply)
│  │     ├─ archived                (event archived)
│  │     ├─ not-yet-activated       (pending_activation)
│  │     └─ closed                  (event closed-early; reply lands in audit, not counted)
│  │
│  ├─ public (no auth, anyone can ask)
│  │  ├─ verify.report                                                           [verify+id@]
│  │  ├─ reverify.report                                                         [reverify+id-N@]
│  │  └─ revoke.unknown-event       (revoke+ to nonexistent id)
│  │
│  └─ ops (system-generated, per-message)
│     ├─ dsn.invitation-bounced     → initiator, per failed step delivery
│     └─ forward.attachment-relay   → initiator, per counted reply WITH attachments
│                                     (preserves bytes; gitdone never stores)
│
└─ B. per-EVENT  (lifecycle edge: event transitioned → 1..N recipients in defined roles)
   │  trigger: event-state changed. Recipient set is computed from event state
   │  + role + edge. PII state is owned by this category. Each edge has an
   │  idempotency stamp. This is where the recent dual-source bugs lived.
   │
   ├─ ACTIVATED edge   (organiser activated)
   │  ├─ initiator           → activated.<kind>.organiser                        [3 templates]
   │  └─ signer/participant
   │     ├─ workflow         → activated.workflow.participant   (root steps only)
   │     ├─ crypto-dec       → activated.decl.signer            (gated on ref_docs)
   │     └─ crypto-att       — (none; initiator broadcasts manually)
   │
   ├─ PROGRESSED edge   (sub-piece done, NOT terminal)
   │  ├─ initiator
   │  │  ├─ workflow         → progressed.workflow.organiser    (one step done)
   │  │  ├─ crypto-dec       → progressed.decl.organiser        (partial doc-sign)
   │  │  └─ crypto-att       → progressed.att.organiser         (attestor bucket complete pre-threshold)
   │  └─ signer/participant
   │     └─ workflow         → progressed.workflow.participant  (next-step cascade invite)
   │     (decl / att: no participant notify on this edge)
   │
   ├─ COMPLETED edge   (natural terminal — threshold/steps/sign)
   │  ├─ initiator           → completed.<kind>.organiser                        [3 templates]
   │  └─ signer/participant  → completed.<kind>.participant                      [3 templates, role-aware body]
   │
   ├─ CLOSED edge   (explicit terminal — close+ command or dashboard close)
   │  ├─ Same recipient shape as COMPLETED
   │  ├─ Body says "closed early" via a flag passed to the same templates
   │  └─ SIDE EFFECT (this edge only): redactAttestorEmails for strict-att
   │
   ├─ ANCHORED edge   (OTS Bitcoin upgrade — durability event, post-redact)
   │  ├─ initiator           → anchored.<kind>.organiser                         [3 templates]
   │  ├─ workflow            → anchored.workflow.participant   (completed steps only)
   │  ├─ decl                → anchored.decl.signer
   │  └─ att                 — (none; PII already redacted on close)
   │
   ├─ ARCHIVED edge   (45d idle, sweep)
   │  └─ initiator           → archived.organiser              (with unarchive pointer)
   │
   ├─ OVERDUE-NUDGE sub-edge   (pre-archive warning, gated by nudged_overdue_at)
   │  └─ initiator           → overdue.<kind>.organiser                          [3 templates]
   │
   └─ PENDING-ACTIVATION-WARN sub-edge   (T+N hours before 72h GC)
      └─ initiator           → pending-activation.organiser    (one-shot)
```

**Counts.** Per-commit (A): 1 auth + 14 command acks + 23 reply acks
(6 wf + 5 decl + 12 att) + 3 public + 2 ops = **43 templates**.
Per-event (B): ~25 templates across 7 edges × 3 kinds. Total **≈ 68
named templates**.

---

## Architecture (shipped — 0.25.0 + 0.25.1)

The 0.24.6–0.24.8 dual-source bugs (`proof_email_sent_at`,
`attestor_emails_redacted_at` stamped at one edge, read by another)
were structural: ~8 trigger functions each computed their own
recipient set, and PII redaction was tied to "first proof email send"
instead of the terminal close edge. The unification shipped across two
internal-architecture releases, both byte-identical (no user-visible
change):

- **`app/src/email-recipients.js`** (0.25.0) — single
  `getRecipients(event, edge) → Map<email, role>`. Owns the
  strict-attestation PII state (respects `attestor_emails_redacted_at`
  as the one redaction signal). Anyone asking "who's connected to this
  event?" calls this and only this. Edges: `activated | progressed |
  completed | closed | anchored | archived | overdue`; roles:
  `organiser | participant | signer | attestor`.
- **`app/src/notifications.js`** (0.25.0) — one entry point for
  per-event lifecycle mail: `notifyLifecycleEdge(event, edge, payload)`
  over the edges `completed | closed | anchored | activated |
  progressed`. It resolves recipients via `getRecipients`, picks the
  body template by `(edge, kind, role)`, and owns the single
  edge-specific side effect: **redaction fires only on `closed`** (and
  only for strict attestation), post-notify. The lifecycle composers
  (`notifyEventCompletion`, `notifyProofAnchored`,
  `notifyOrganiserOfActivation`, `notifyOrganiserOfStepProgress`) are
  now private behind the dispatcher; `notifyInitiatorOfSigningProgress`
  was dead and deleted. The invite/setup senders
  (`notifyWorkflowParticipants`, `notifyDeclarationSigner`,
  `notifyInitiatorAttachDocsNeeded`) stay public — they kick off
  participation rather than report a lifecycle edge.
- **`app/src/email-bodies.js`** (0.25.1–0.25.3) — every composed
  body/subject template, keyed by tree path:
  `bodies.lifecycle.completed.attestation.organiser`,
  `bodies.lifecycle.{activated,progressed,anchored}`,
  `bodies.invite.{workflowStep,declarationSigner,attachDocsNeeded}`,
  `bodies.replyAck.*` (per-inbound-reply acks; 0.25.2),
  `bodies.cmd.*` (initiator-command acks — `stats`, `bundle`, `attach`,
  `revoke`, `remind`, `close`; 0.25.3),
  `bodies.sweep.{pendingActivation,overdue,archived}` (sweep-timer
  notices; 0.25.3), `bodies.notice.invitationBounced` (DSN bounce alert;
  0.25.3), plus the `renderProofBlock` / `renderOrganiserStepList` /
  `formatReferenceDocList` renderers. Senders never compose subject/body
  inline. The two exceptions by design — the verification reports
  (`verify.js` / `reverify.js`) — are the verify subsystem's own product,
  not scattered transactional text, so they stay in their domain modules.

Deliberate deviations from the original plan: there is **no
`${edge}_notified_at` idempotency stamp** — a per-notify write would
add non-semantic commits to the per-event proof repo (which IS the
proof artifact). Re-fire is instead prevented per edge by state that
already exists, so no extra stamp is needed:

- `completed` / `closed` — gated by `proof_email_sent_at` vs
  `completion.completed_at` (the gate the oversubscribe-revoke-reopen
  regression test guards).
- `activated` — gated by `activateEvent`'s mutex + `alreadyActive`
  return and the `event.activated_at` early-return in the activate
  handler. It's web-triggered (a dashboard POST), so a mail re-delivery
  can't re-fire it at all; a double-click / retry hits the guard.
- `progressed` — gated by idempotent reply application: a re-delivered
  reply lands on an already-`complete` step → "already-done" ack → the
  step doesn't re-complete, so the `progressed` block never re-enters.
  (The realistic risk here is a *missed* notice on mid-send crash, not a
  duplicate.)
- Redaction idempotency is the `attestor_emails_redacted_at` stamp,
  written once on close.

If observability ever needs a notified-at stamp, add it as a NON-gating
field alongside an existing semantic commit, never as its own write.

**Fully migrated (0.25.3):** the per-commit (A) reply/command acks now
live in `email-bodies.js` (`bodies.replyAck.*` / `bodies.cmd.*`);
`email-commands.js` is computation + state-machines only, returning
structured outcomes that `receive.js` / `server.js` turn into receipts
via the catalogue. The dispatch logic (decision.reason / command →
which builder) stays in the caller. No composed transactional email
text remains inline in `receive.js`, `sweep.js`, or `email-commands.js`.

After the refactor, the dual-source bug class is structurally
unreachable: one recipient resolver, one PII-state owner, one redaction
site. See `CHANGELOG.md` 0.24.6–0.24.8 (symptoms) and 0.25.0 / 0.25.1
(the fix).

---

## Subject grammar

Every email gitdone sends, indexed by trigger. For each: who sends it,
who receives it, the subject template, the body shape, and the source
file. Subjects follow a consistent grammar:

- **Tag** — every gitdone-originated subject starts with `[gitdone]`.
- **Title quoted** — the event title is wrapped in double quotes when
  present, so subjects that survive auto-quoting in mail clients still
  read clearly. **Exception:** the participant step-scoped subjects
  (invitation #2, accepted #4, attachment-required #5) lead with the
  bare title because it heads a `<title> — <step.name> [<idx>/<total>]`
  clause chain, where quoting reads worse; every other subject quotes.
- **`[N/M]` counter** — when a workflow has progress to report, the
  counter goes after the title.
- **Em dash separator** — clauses inside a subject are joined with ` — `.

Most emails have a `from:` of `gitdone@git-done.com` and are
DKIM-signed by the milter. Per-event replies use a `Reply-To` set to
the per-step or per-event reply address (`event+<id>-<step>@…`,
`crypto+<id>@…`, `verify+<id>@…`, `stats+<id>@…`, etc.) so participants
can reply normally.

## Index

| # | Email | Trigger | Recipient |
|---|-------|---------|-----------|
| 1 | Sign-in magic link | User submits `/manage` form | The signing-in address |
| 2 | Workflow invitation | Activation, cascade, or `remind+` | Participant for an active step |
| 3 | Crypto declaration ask | Crypto event activated (declaration mode) | Single signer |
| 4 | Reply ack — accepted | Participant reply accepted | Participant |
| 5 | Reply ack — missing attachment | Reply accepted but attachment required | Participant |
| 6 | Reply ack — event archived | Reply on a sweep-archived event | Participant |
| 7 | Reply ack — event not activated | Reply on a pending-activation event | Participant |
| 8 | Reply ack — event closed | Reply on a closed event | Participant |
| 8b | Reply ack — revoked sender | Reply from an attestor whose sender_hash is in `revoked_senders[]` | Participant |
| 9 | Activation receipt | Organiser activates pending event | Organiser |
| 10 | Step-progress update | Step completes, downstream(s) become active | Organiser |
| 11 | Completion proof | Event reaches terminal state | Initiator + every contributor |
| 12 | Bounce alert | DSN arrives for a participant invite | Organiser |
| 13 | Pending-activation reminder | Event sat unactivated >48h | Organiser |
| 14 | Overdue nudge | Event past deadline with open steps | Organiser |
| 15 | Auto-archive notice | Inactive event auto-archived | Organiser |
| 16 | Initiator command — stats | Inbound to `stats+<id>@` | Sender (initiator) |
| 17 | Initiator command — remind | Inbound to `remind+<id>@` | Sender (initiator) |
| 18 | Initiator command — close | Inbound to `close+<id>@` | Sender (initiator) |
| 19 | Verify report | Inbound to `verify+<id>@` | Sender |
| 20 | Re-verify report | Inbound to `reverify+<id>-<seq>@` | Sender |
| 21 | Proof anchored (OTS) | Last pending OTS proof anchors to Bitcoin | Initiator + signers/participants |
| 22 | Initiator command — bundle | Inbound to `bundle+<id>@` | Sender (initiator) |
| 23 | Initiator command — attach (register reference docs) | Inbound to `attach+<id>@` | Sender (initiator) |
| 24 | Initiator command — revoke (drop an attestor) | Inbound to `revoke+<id>@` | Sender (initiator) |

## 1. Sign-in magic link

- **Trigger.** Anyone POSTs an email to `/manage` (Mode B sign-in) or
  to `/events` / `/crypto` (Mode A — the activation flow uses the same
  knowless `startLogin` with `bypassRateLimit`).
- **Sent by.** `app/src/auth.js` via knowless.
- **Recipient.** The submitted email address.
- **Subject.** `Sign in to gitdone`
- **Body.** A short magic link valid for 15 minutes; opens a 30-day
  session and lands on either `/manage` (Mode B) or
  `/manage/event/<id>` (Mode A).

## 2. Workflow invitation

- **Trigger.** (a) organiser activation (sends to every step whose
  `depends_on` is empty), (b) cascade after a dependency completes, or
  (c) inbound `remind+<id>@`.
- **Sent by.** `notifyWorkflowParticipants` in `app/src/notifications.js`.
- **Recipient.** Step `participant`.
- **Subject.**
  - first invite (activation/cascade): `[gitdone] <title> — <step.name> [<idx>/<total>] — your step`
  - re-send via `remind+`: `[gitdone] "reminder" <title> — <step.name> [<idx>/<total>] — your step`
- **Reply-To.** `event+<id>-<stepId>@<domain>`
- **Body.** "What we need from you", deadline, attachment requirement
  flag, plain instructions to reply (with anything in the body) for
  yes/no.

## 3. Crypto declaration ask

- **Trigger.** Crypto event in `declaration` mode is created (single
  signer flow) or `remind+` is invoked.
- **Sent by.** `notifyDeclarationSigner`.
- **Recipient.** `event.signer`.
- **Subject.** `[gitdone] "<title>" — please sign`
- **Reply-To.** `crypto+<id>@<domain>`
- **Body.** Signing prompt + DKIM/OTS guarantees; reply with anything
  to sign.

## 4–8. Reply acknowledgements

All sent by `app/bin/receive.js` after classifying an inbound reply.
Reply-To is the same address the inbound was sent to so the
participant's MUA threads correctly. Subjects and bodies branch on
event type — the workflow `<step> [<idx>/<total>]` shape doesn't apply
to crypto, where there's only one logical reply per signer / per
attestation slot.

### Workflow events

| # | Reason | Subject |
|---|--------|---------|
| 4 | accepted | `[gitdone] Accepted — <title> — <step> [<idx>/<total>]` |
| 5 | `missing_attachment` | `[gitdone] Attachment required — <title> — <step> [<idx>/<total>]` |
| 6 | `event archived` | `[gitdone] Event archived — <title>` |
| 7 | `event not activated` | `[gitdone] Event not yet activated — <title>` |
| 8 | `event closed` | `[gitdone] Event closed — <title>` |

Bodies all open with "Thanks — we received your reply for "<step>" on
event "<title>".", then explain the specific outcome and the audit
trail guarantee.

### Crypto declaration

Same five reasons; subject + body adapted so they don't reference
"step" or `[N/M]` (declarations don't have steps), and they call the
event a **Crypto Declaration** in body copy.

| # | Reason | Subject |
|---|--------|---------|
| 4d | accepted (full strict match) | `[gitdone] Signed — <title>` |
| 4d-partial | accepted, partial strict match (declaration only) | `[gitdone] Signed in progress — <title>` |
| 5d | `missing_attachment` | `[gitdone] Attachment required — <title>` |
| 5d-mismatch | `attachment_set_mismatch` (filename matched, bytes differ) | `[gitdone] Attachment hash mismatch — <title>` |
| 5d-strict | `strict_no_matching_attachments` (no file matched any registered hash) | `[gitdone] No matching attachments — <title>` |
| 5d-already | `strict_already_signed` (matching reply but bucket already complete; Module 6.5) | `[gitdone] Already signed — <title>` |
| 5d-awaiting | `awaiting_reference_docs` (`reference_url` set but no docs registered yet) | `[gitdone] Awaiting reference documents — <title>` |
| 6d | `event archived` | `[gitdone] Crypto Declaration archived — <title>` |
| 7d | `event not activated` | `[gitdone] Crypto Declaration not yet activated — <title>` |
| 8d | `event closed` | `[gitdone] Crypto Declaration closed — <title>` |

Under **strict signing mode** (§4.2.3 of the PRD — `reference_url`
set AND `reference_docs[]` registered), the signer/attestor MUST
attach files whose SHA-256 hashes match the registered manifest.
Matching is by hash, not filename. Three outcomes:

- **Full match** (every registered doc has been signed): the
  declaration completes; subject is the normal `Signed —` ack and
  the body confirms the final state.
- **Partial match** (declaration only — a subset of docs ticked):
  subject is `Signed in progress —` and the body carries a progress
  block: `[x] doc1.pdf · signed` / `[ ] doc2.pdf · awaiting`. Matches
  accumulate across replies. Attestation does not surface a partial
  ack to the attestor — their per-attestor bucket fills up silently
  and only counts toward the threshold when complete.
- **Filename match, bytes differ** (`attachment_set_mismatch`): the
  ack lists the offending filename, the expected
  `sha256:head4…tail4`, and the received one, so the signer can fix
  the file instead of guessing.
- **No matching hashes** (`strict_no_matching_attachments`): the
  ack reproduces the manifest so the signer can attach the right
  thing without leaving their inbox.

Accepted body:

```
Your signature on Crypto Declaration "<title>" was accepted.
The reply is DKIM-verified, OpenTimestamped, and committed to the
event's git audit trail.

The declaration is now final and the audit trail is sealed. Thank you.

Requester: <initiator>
```

### Crypto attestation

| # | Reason | Subject |
|---|--------|---------|
| 4a-partial | accepted, threshold not yet reached | `[gitdone] Attestation reply recorded — <title> [<K>/<threshold>]` |
| 4a-final | accepted, this reply hits the threshold (locking dedups) | `[gitdone] Attestation complete — <title> [<threshold>/<threshold>]` |
| 4a-overshoot | accepted, accumulating dedup past threshold | `[gitdone] Attestation reply recorded — <title> [<K>/<threshold>]` (with `K > threshold`, e.g. `[5/2]`) |
| 5a | `missing_attachment` | `[gitdone] Attachment required — <title>` |
| 6a | `event archived` | `[gitdone] Crypto Attestation archived — <title>` |
| 7a | `event not activated` | `[gitdone] Crypto Attestation not yet activated — <title>` |
| 8a | `event closed` | `[gitdone] Crypto Attestation closed — <title>` |

The `[<K>/<threshold>]` tag mirrors the workflow step counter so the
participant sees their position at a glance. `K` is the post-update
count (the just-applied reply is included). For `unique`/`latest`
dedup the count caps at `threshold` by construction; for
`accumulating` dedup, every additional reply after threshold gets a
fresh ack with an overshot tag — `[3/2]`, `[5/2]`, etc — paired with
the body tail below that flags the overshoot.

**Module 6 — dual count on subject + body.** When the DKIM-verified
subset of counted replies is **less than** the counted count
(possible under accumulating dedup, which accepts both verified and
unverified mail), the subject appends a `· N verified` qualifier and
the body inlines the same split:

| Shape | Subject | Body tail |
|---|---|---|
| counted == verified (common; always true under strict + unique/latest) | `[3/10]` | `Replies so far: 3/10. …` |
| counted > verified (some unsigned mail counted) | `[3/10 · 1 verified]` | `Replies so far: 3 (1 verified)/10. …` |

The compact form on equal-counts keeps the subject readable in the
overwhelming majority of cases; the qualified form fires only when
the trust shape is load-bearing to disclose.

Accepted body (partial — threshold not yet reached):

```
Your reply to Crypto Attestation "<title>" was recorded.
It's DKIM-verified, OpenTimestamped, and committed to the event's
git audit trail.

Replies so far: <K>/<threshold>. The attestation stays open until the
threshold is met.

Requester: <initiator>
```

**Module 9 — per-attestor doc checkboxes.** Strict-mode attestation
acks (`reference_url` + frozen `reference_docs[]`) replace the
bullet-only list with checkboxes against THIS attestor's
`attestor_progress[sender_hash].signed_doc_hashes`. The same source
of truth as the manage UI's per-attestor pill, so the ack closes the
"did the file I sent get through?" loop without needing the dashboard:

```
…

Reference documents (2):
  [x] braun-shipping.pdf · cac058a42136 · 9.0 KB
  [ ] braun-invoice.pdf · 0602bd85ca7e · 79.3 KB
```

Loose attestation (no `reference_docs`) keeps the bullet form
(`• <filename> …`) since there's no per-doc progress to surface.

When the reply that lands tips a **locking** dedup (unique/latest) to
threshold, the body swaps to:

```
…
Threshold reached (<threshold>). The audit trail is sealed.
…
```

For **accumulating** dedup, threshold is the proof anchor but the
event keeps counting — the body tail surfaces both the running count
and the day the threshold was first crossed:

```
…
Replies so far: <K> (threshold of <threshold> reached on <YYYY-MM-DD>).
The attestation keeps counting; only the organiser can close it.
…
```

## 9. Activation receipt

- **Trigger.** Organiser POSTs `/manage/event/<id>/activate`.
- **Sent by.** `notifyLifecycleEdge(event, 'activated', …)`; body from
  `bodies.lifecycle.activated`.
- **Recipient.** `event.initiator`.
- **Subject.** `[gitdone] "<title>" — activated, <K> invitation(s) sent`
- **Body.** Confirms what just left, lists every step with `▸` next to
  the ones currently waiting on a participant, and a per-recipient
  `sent`/`FAILED` delivery line so synchronous send errors are visible
  immediately.

## 10. Step-progress update

- **Trigger.** A step transitions to `complete` and the cascade unblocks
  zero-or-more downstream steps.
- **Sent by.** `notifyLifecycleEdge(event, 'progressed', …)`; body from
  `bodies.lifecycle.progressed`.
- **Recipient.** `event.initiator`.
- **Subject.** `[gitdone] "<title>" [<N>/<M>] step done · next active`
  (the ` · next active` suffix is dropped when no downstream steps
  unblocked — i.e. fan-in waiting on parallel branches).
- **Body.** Which step finished and by whom, what's now active, and
  the step list with `▸` markers.

## 11. Completion proof

The durable record of an event closing. Body shape diverges by **mode**
(workflow / declaration / attestation) and **role** (organiser /
contributor) because each combination has a different stake in the
record:

- **Workflow** — organiser holds the multi-step audit; each participant
  holds proof of their step only.
- **Declaration** — symmetric two-sided notary; signer and organiser
  hold the same proof, neither has more right to it than the other.
- **Attestation, organiser** — the *aggregate* (count, trust posture,
  who attested to what) is why they ran it.
- **Attestation, attestor** — privacy-conservative receipt: confirms
  their contribution is preserved and the event closed, but does NOT
  surface the count of others or aggregate trust. The aggregate is
  the organiser's view.

Common contract across every body:
- **Trigger.** Event reaches `complete` (all steps done, declaration
  signed, attestation threshold reached, or `close+` initiator command).
- **Sent by.** `notifyLifecycleEdge(event, 'completed' | 'closed', …)`;
  bodies from `bodies.lifecycle.completed.<kind>.<role>`. The `closed`
  edge additionally redacts strict-attestation emails post-send.
- **Subject.** `[gitdone] proof — "<title>"<counterTag>` where
  `counterTag` is `[<done>/<total>]` for workflow, `[<counted>/<threshold>]`
  for attestation, omitted for declaration. When no commits are
  available (rare edge case) it falls back to
  `[gitdone] "<title>" — completed` or `… — closed early`.
- **Mode line.** Every body now carries an explicit `Mode:` line
  (`Workflow` / `Declaration (one signer, one record)` /
  `Attestation - <dedup-blurb> - threshold N`) so the recipient
  reading the email three years later can recover what shape of proof
  this was without opening the repo.
- **Reason label.** Mode-aware — `threshold reached` for attestation,
  `the signer replied` for declaration, `all steps completed` for
  workflow, `closed early by the organiser` for any mode when the
  initiator ended it via `close+` / the dashboard.

### 11a. Workflow — organiser

- **Recipient.** `event.initiator`.
- **Body.** Title + ID + Mode + completion timestamp + reason label +
  final-step pointer ("Final step: #3 'CEO sign' by ceo@example.com"),
  the **full step table** (status per step), and a per-step
  cryptographic-receipt block (one DKIM+OTS receipt per counted
  reply). Closes with the "proofs outlive the service" paragraph and
  the `gitdone-verify <id>` hint.

### 11b. Workflow — participant

- **Recipient.** Every distinct `event.steps[*].participant`, deduped
  against the organiser address.
- **Body.** Slim — title + Mode + reason + their **own** step's
  receipt only (no step table, that's organiser-private). Same verify
  hint + audit-trail guarantee paragraph.

### 11c. Declaration — both recipients (symmetric)

- **Recipients.** `event.initiator` AND `event.signer`. Same body.
  The signer holds the receipt because they signed; the organiser
  holds it because they asked. Two-sided notary semantics.
- **Body.** Title + ID + Mode (`Declaration (one signer, one record)`)
  + `Signed: <iso>` + `Signer: <email>` + `Organiser: <email>` +
  `Reference: <url>` (when set) + reference-doc manifest (when set:
  `filename  sha256:head8...tail8` per row) + the single cryptographic
  receipt + verify hint + audit-trail paragraph.
- **Difference between recipients.** Only the lede: organiser sees
  *"The declaration you organised has been signed."*, signer sees
  *"Your signature on a declaration has been recorded."* — everything
  else (record content, receipt, verify command) is identical.

### 11d. Attestation — organiser

- **Recipient.** `event.initiator`.
- **Subject.** `[gitdone] proof — "<title>" [<E>/<threshold>]` where
  `E` is the **effective** (revoke-filtered) count: distinct
  non-revoked senders under `unique`/`latest`, raw non-revoked
  replies under `accumulating`. When the event was cut short via
  the dashboard or `close+<id>@`, the subject inserts ` — closed
  early` before the counter: `[gitdone] proof — "<title>" — closed
  early [<E>/<threshold>]`.
- **Body.** Title + ID + Mode (`Attestation - <dedup> - threshold N`)
  + `<Reached|Closed>: <iso>` (label flips on close-early) +
  `Reason: <threshold reached | closed early by the organiser>` +
  `Reference: <url>` (when set) + reference-doc manifest (when set)
  + the **aggregate cryptographic-receipt block** + verify hint +
  audit-trail paragraph. The lede mirrors: *"has reached its
  threshold."* on natural completion, *"has been closed early."*
  on initiator close.
- **Receipt block — Module 9 revoke-aware.** When the event has
  `revoked_senders[]` entries, the block swaps `Replies counted N`
  for the **triple**:
  ```
  Replies in audit  <total>
  Revoked           <revoked-commit-count>
  Effective         <effective-commit-count>
  Modal trust       verified
  Verified          <verified-over-effective>
  …
  ```
  Trust counts (`Modal trust`, `Verified`, `Forwarded`, etc.) are
  computed over the effective (non-revoked) subset so the email
  matches the manage UI's triple-count tiles and the durable proof
  doesn't overstate what counted. When no revocation has occurred
  the block keeps the pre-Module-9 shape (`Replies counted N` + the
  trust counts over all replies).

### 11e. Attestation — attestor (strict mode only)

- **Recipient.** Each counted attestor whose plaintext email was
  persisted by completion.js's strict branch (4e). Loose attestation
  has no attestor recipients here — only salted hashes are stored.
- **Body.** Privacy-conservative. Opens with *"An attestation you
  contributed to is now complete and accountable. Your reply is
  preserved as part of the cryptographic record."* Carries: title +
  Mode + `Threshold reached: <iso>` + `Reference: <url>` (when set) +
  reference-doc manifest (when set) + a **"Your receipt"** block
  containing only their own commit's DKIM+OTS receipt (looked up
  by recomputing their salted sender_hash against `event.salt` — much
  tighter than domain-matching when multiple attestors share a domain).
  Verify hint + audit-trail paragraph closes with an explicit
  *"The aggregate result is private to the organiser; this email is
  YOUR record only."* line.
- **What's deliberately absent.** Counted-replies count, modal trust,
  per-trust-level aggregate, other attestors' domains or commits.
  Anything that would let one attestor enumerate the others.

## 12. Bounce alert (DSN)

- **Trigger.** RFC 3464 DSN arrives at gitdone reporting a failed
  delivery for an event invitation.
- **Sent by.** `app/bin/receive.js` DSN handler.
- **Recipient.** `event.initiator`.
- **Subject.** `[gitdone] "<title>" — invitation bounced`
- **Body.** Each failed recipient with status code + diagnostic, then a
  link to the dashboard so the organiser can edit the address.

## 13. Pending-activation reminder

- **Trigger.** Event sat unactivated and is within 24h of the 72h TTL.
- **Sent by.** `app/bin/sweep.js` (`gitdone-sweep.timer`).
- **Recipient.** `event.initiator`.
- **Subject.** `[gitdone] "<title>" — activate within <H>h or it expires`
- **Body.** Activation link + what happens at TTL.

## 14. Overdue nudge

- **Trigger.** Event past its deadline with open steps, hadn't been
  nudged before.
- **Sent by.** `app/bin/sweep.js`.
- **Recipient.** `event.initiator`.
- **Subject.** `[gitdone] "<title>" — overdue, <D> days past deadline [<done>/<total>]`
  (the `[N/M]` tag is omitted for crypto events).
- **Body.** Step state summary + nudge to use `remind+<id>@` or close.

## 15. Auto-archive notice

- **Trigger.** Event has been idle past deadline long enough to trip
  the archive sweep.
- **Sent by.** `app/bin/sweep.js`.
- **Recipient.** `event.initiator`.
- **Subject.** `[gitdone] "<title>" — auto-archived`
- **Body.** What "archived" means, that the audit trail is preserved,
  and how to re-open from the dashboard.

## 16. Initiator command — stats

- **Trigger.** DKIM-authenticated reply to `stats+<id>@<domain>`.
- **Sent by.** `app/bin/receive.js` (body in `bodies.cmd.stats`).
- **Recipient.** Sender (envelope sender, must equal initiator).
- **Subject.**
  - Workflow: `[gitdone] stats "<title>" [<done>/<total>] step done`
    (or `… complete` when finished).
  - Crypto: `[gitdone] stats "<title>" — <mode> · <open|complete>`.
- **Body.** Title, ID, min trust, status, then a per-step list with
  `[x]/[ ]` ticks, dependencies, and completion timestamps.

## 17. Initiator command — remind

- **Trigger.** DKIM-authenticated reply to `remind+<id>@<domain>`.
- **Sent by.** `app/bin/receive.js`. Also fans out **workflow invitations**
  (#2) to every still-pending participant whose dependencies are met,
  with the `"reminder"` subject tag.
- **Subject.**
  - workflow: `[gitdone] reminded "<title>" [<done>/<total>] step done`
    (or `… complete` when the event has already finished).
  - crypto: `[gitdone] reminded "<title>" — <mode> · <open|complete>`.
- **Body.** Either "no eligible steps" / "already complete", or
  `Reminders sent:` followed by per-recipient `✓`/`✗` lines.

## 18. Initiator command — close (two-step confirm)

Closing an event is irreversible — it writes a final completion commit
and notifies all participants. To stop a single autoreply, stale
forwarded message, or one-off compromised send from triggering it, the
email path uses a two-step confirm. (The web dashboard close button is
unchanged — the deliberate click + active session is its own
confirmation.)

- **Trigger.** DKIM-authenticated reply to `close+<id>@<domain>`.
- **Sent by.** `app/bin/receive.js`.

### Step 1 — pending intent

The first reply records a `pending_close = { token, expires_at }` on
the event (TTL 30 min) and replies with the token + instructions. No
completion commit is written yet.

- **Subject.** `[gitdone] close pending "<title>" — reply to confirm`
- **Body.** "Closing is irreversible — to confirm, reply within 30 min
  with `CONFIRM <token>` in the subject or body. The token is
  case-insensitive."

### Step 2 — confirm

A second DKIM-authenticated reply within the TTL, containing
`CONFIRM <token>`, commits the close.

- **Subject.**
  - workflow: `[gitdone] closed "<title>" [<done>/<total>] step done`
    (or `… complete` when finished).
  - crypto: `[gitdone] closed "<title>" — <mode> · <open|complete>`.
- **Body.** Confirmation that the event is now closed + completion
  timestamp. The event itself also fans out a **completion notice**
  (#11) to participants.

### Edge subjects

- `[gitdone] close pending "<title>" — still awaiting confirmation` —
  a `close+` reply arrived without the token while a valid intent is
  outstanding (gitdone reminds with the *same* token; doesn't reissue,
  so a stray re-send can't refresh the window).
- `[gitdone] close pending "<title>" — token mismatch, retry` — token
  was supplied but didn't match the outstanding intent.
- `[gitdone] closed "<title>" — already complete` — event was already
  finished; no-op.

## 19. Verify report

- **Trigger.** Anyone forwards an `.eml` (or attachment-bearing
  message) to `verify+<id>@<domain>`.
- **Sent by.** `app/bin/receive.js`.
- **Recipient.** Sender.
- **Subject.** `[gitdone] verification report for event <eventId>`
- **Body.** Pass/fail per check (DKIM, OTS, sequence presence,
  per-event-repo match) and the verified commit shas.

## 20. Re-verify report

- **Trigger.** Inbound to `reverify+<id>-<commitSequence>@<domain>` —
  the same verifier flow but pinned to one commit.
- **Sent by.** `app/bin/receive.js`.
- **Subject.** `[gitdone] re-verification report for <eventId> commit-<NNN>`
- **Body.** Same shape as #19, scoped to the one commit.

## 21. Proof anchored (OTS)

The durability follow-up. A completed event's `.ots` proofs start
calendar-pending; once the last one upgrades to a Bitcoin anchor, every
contributor who received the completion proof gets a one-time
confirmation that the proof is now permanently anchored.

- **Trigger.** `ots upgrade` folds a Bitcoin attestation into the last
  pending `.ots` file for an event (the `ANCHORED` edge — post-completion,
  post-redaction).
- **Sent by.** `app/bin/ots-upgrade.js` (`gitdone-ots-upgrade.timer`,
  every 6h) → `notifyLifecycleEdge(event, 'anchored')`.
- **Recipient.** Initiator + each contributor who got the proof email:
  workflow participants of completed steps, the declaration signer.
  Strict attestation has **none** here — attestor PII was already
  redacted on the `closed`/`completed` edge.
- **Subject.** `[gitdone] proof anchored — "<title>"`
- **Body.** Confirmation the proof is permanently Bitcoin-anchored, with
  block height, anchored-at timestamp, and the in-repo proof file path.
- **Idempotency.** Once-only: the upgrade run that flips a proof to
  anchored is the single trigger; a later height-blind re-run that
  changes nothing fires nothing (see `ots-upgrade.js`).

## 22. Initiator command — bundle

The artifact handoff. PRD §0.1.4 / §7.5: proofs outlive the service,
so the organiser needs a way to lift the entire per-event audit trail
off the running gitdone instance and keep it forever. Two surfaces
share one packaging path:

- the dashboard's amber **Download proof bundle (.tar.gz)** button on
  `/manage/event/:id` (session-gated), and
- this email-path command.

Both stream a `.tar.gz` of `data/repos/<id>/`, which contains
`event.json`, `commits/commit-NNN.json`, `dkim_keys/*.pem`,
`ots_proofs/*.ots`, and the `.git/` history. Verify offline with
`gitdone-verify <id>` against the unpacked tree.

- **Trigger.** DKIM-authenticated reply to `bundle+<id>@<domain>`.
- **Auth.** Identical to the other initiator commands — DKIM verified
  AND envelope-sender hash matches `event.initiator`.
- **Sent by.** `app/bin/receive.js` (packaging in `app/src/bundle.js`).
- **Recipient.** Sender (must equal initiator).
- **Threading.** Replies thread to `event.proof_email_message_id` when
  set (so the bundle lands under the same conversation as the proof
  receipt). Falls back to the inbound message-id otherwise.

### When the repo has commits

- **Subject.** `[gitdone] proof bundle — "<title>"`
- **Headers.** `Content-Type: multipart/mixed; boundary=…`,
  `Content-Disposition: attachment; filename="gitdone-<id>-YYYYMMDD.tar.gz"`,
  `Content-Type: application/gzip` on the attachment part.
- **Body.** Three lines: "Attached is the full git repository for
  `<title>`. Verify offline with: `gitdone-verify <id>`. Keep it
  forever; this is your proof."

### When the repo has no commits yet

The event was created but never received a reply (pending-activation,
or activated but no inbound mail), so there's nothing to package.

- **Subject.** `[gitdone] no proof yet — "<title>"`
- **Body.** Plain text explaining the audit trail is empty and that a
  later `bundle+` after a reply arrives will return the archive.

## 23. Initiator command — attach (register reference docs)

Crypto-only. Registers the canonical reference doc(s) on a crypto
event whose `reference_url` is set, freezing the manifest the signer
will be asked to attach (PRD §4.2.3). gitdone hashes every attachment
(SHA-256 + filename + size), commits a `kind: 'attach'` record to the
per-event git repo, OTS-stamps it, and **discards the file bytes** —
no document content is ever stored. The doc set is frozen on the
first reply.

- **Trigger.** DKIM-authenticated reply to `attach+<id>@<domain>`.
- **Auth.** Same as other initiator commands — DKIM-verified AND
  envelope sender matches `event.initiator`.
- **Sent by.** `app/bin/receive.js` (commit in `app/src/gitrepo.js:commitAttach`).
- **Recipient.** Sender (must equal initiator).

All outcomes (success, frozen, auth failure, etc.) share the same
subject `[gitdone] attach+ — <title>` so the organiser's MUA threads
every attempt on the manifest together. The body distinguishes the
outcome.

### Step 1 — first attach+ reply (registration)

The first DKIM-authenticated reply with attachments hashes them,
commits the manifest (`kind: 'attach'`, OTS-stamped), freezes the
doc set, AND fires the held signer invite if the event was activated
with `reference_url` set but no docs (the invite body lists the
manifest with filename + hash + size per row).

- **Body.** Per-doc line: `filename · sha256:head4…tail4 · <size>`,
  then a paragraph that the signer invite has been sent (or was
  already in flight) and the strict-signing rule (signer must attach
  files whose hashes match this manifest exactly).

### Step 2 — subsequent attach+ replies (frozen)

The manifest is one-shot. Any later attach+ reply bounces:

- **Body.** Names the manifest as it stands, explains that the doc
  set was frozen at first registration to give the signer a stable
  target, and points at the dashboard for editing options (currently
  none — the manifest is immutable; future modules may add a
  versioning path).

### Edge cases

- **No attachments** — bounces with a body explaining the reply
  needs at least one attached file.
- **Wrong event type** (workflow, not crypto) — bounces with a body
  noting `attach+` is crypto-only.
- **Sender ≠ initiator** — auth fails like any other initiator
  command; the reply is dropped per audit-trail policy and no ack
  is sent.
- **Event already complete / closed / archived** — bounce with the
  matching lifecycle subject; no commit written.

## 24. Initiator command — revoke (drop an attestor)

- **Trigger.** Initiator emails `revoke+<id>@git-done.com` with one
  attestor email per body line. Optional `reason: <free-form>` line
  is captured separately. Crypto attestation events only —
  declarations have a single signer (no revocation surface) and
  workflows have no signature semantics to revoke.
- **Sent by.** `app/bin/receive.js` (handler block parses body via
  `parseRevokeBody`, resolves emails to sender_hashes against
  `event.salt`, applies `applyRevoke` from `app/src/completion.js`,
  writes a `kind: 'revoke'` commit, sends the ack).
- **Recipient.** The initiator (the sender of the revoke email).
- **From.** `revoke+<id>@<domain>`.
- **Subject.** `[gitdone] revoke+ — <event title>` on success;
  `[gitdone] revoke+ — <id>` if the event couldn't be loaded.

**Auth.** DKIM-verified + envelope sender == `event.initiator`
(same as `stats+ / remind+ / close+ / attach+`). Wrong sender →
rejected ack explaining "Only the event initiator can revoke
attestors via `revoke+<id>@`".

**Body grammar (input).** One attestor email per line. Lines
starting with `>` (quoted reply) and the `-- ` signature delimiter
are skipped. An optional `reason: <free-form>` (or `reason= ...`)
line is captured separately. Parsing scans at most the first 80
non-quoted lines.

Example body:

```
bob@example.com
carol@example.com
reason: signed in error
```

**Effect.** Each parsed email is hashed (`hashSender(email,
event.salt)`) and looked up in the union of `attestor_progress`
keys (strict mode) and `replies[].sender_hash` (loose). Matches
are appended as new entries on `event.revoked_senders[]`:

```json
{
  "sender_hash": "sha256:…",
  "revoked_at": "2026-05-13T01:00:00Z",
  "reason": "signed in error",
  "revoke_commit_sequence": 7
}
```

Original signature commits are **never** removed — the per-event
git repo is append-only. Revocation lands as a separate
`kind: 'revoke'` commit (OpenTimestamped). The offline verifier
sees the full history.

**Counter behaviour.** Every counted-replies surface (manage hero
stat band, dashboard row, ack subject's dual-count, `stats+` body)
filters revoked sender_hashes out:

- strict attestation: distinct attestors with complete buckets
  minus revoked hashes
- loose `unique`: distinct sender_hashes minus revoked
- loose `latest`: revoked hashes drop from both deduped replies
  list and count
- loose `accumulating`: every non-revoked reply counts (originals
  + revokes still committed for the audit trail)

**Completion re-evaluation.** Under locking dedup (`unique` +
`latest`), if the count drops below `event.threshold` and the event
was previously complete, `event.completion` flips back to
`{ status: 'open', reopened_at, reopened_reason: 'revoke dropped
count below threshold' }`. Accumulating events never auto-complete
via threshold, so completion stays as it was; the
`threshold_reached_at` anchor is preserved as a historical record.

**Body (ack).**

```
Revoked 1 attestor on "<event title>":

  bob@example.com

Reason recorded: signed in error

New count: 1 / 2.

Event was complete; count dropped below threshold so completion
has reopened. A new reply that fills the bucket will re-complete it.

Audit trail preserved: the original signature commits stay in the
event's git repo. Revocation lands as a separate commit
(kind: 'revoke'), OpenTimestamped.
```

When some body addresses don't match a known attestor, the ack
appends a "Not found (skipped — no matching reply on file)" list.
When the revoke doesn't drop completion (e.g. threshold still met,
or accumulating dedup), the "completion has reopened" paragraph is
omitted.

**Edge cases.**

- **No emails in body** — "no targets" ack with the expected
  grammar shown back to the initiator.
- **None of the supplied emails match a known attestor** — "None
  of the addresses … match a known attestor" with the supplied list
  echoed; no `revoke` commit written.
- **Wrong event type** (declaration or workflow) — bounces with a
  body noting `revoke+` only applies to attestation events.
- **Unknown event id** — "No such event" bounce.
- **Sender ≠ initiator** — rejected ack; no commit written, no
  state change.

**Revocation is permanent.** A revoked attestor's hash stays in
`revoked_senders[]` forever; their `attestor_progress[h].complete`
flag stays true. The only way for the event to re-complete is a
brand-new (different, non-revoked) attestor's reply that fills
their bucket. There is no `unrevoke+` channel today — revocation
is a one-way operation, matching the audit-first ethos of the rest
of the system. The initiator's ack explicitly states this.

**Re-reply from a revoked attestor — Module 9.** When a revoked
sender_hash sends to `event+<id>@`, the engine returns the new
decision reason `revoked_sender` (gated **before** strict-mode
checks, so it overrides `strict_already_signed`). The reply still
commits to the audit trail; the ack tells the sender:

- **Subject.** `[gitdone] Reply not counted — <event title>`
- **Body.**
  ```
  Thanks — we received your reply on Crypto Attestation "<title>".

  Your prior signature on this attestation was revoked by the
  initiator and no longer counts toward the threshold. Your
  replies remain in the audit trail (DKIM-verified,
  OpenTimestamped); the public proof page shows the revocation:
    https://git-done.com/proof/<id>

  If you believe this is in error, reach out to <initiator>.
  ```

The initiator's free-form `reason:` is **not** surfaced in this
ack — that text stays on the ledger / manage hero, never in
participant-facing email. Rationale: the /proof page already
discloses the revoke commit to anyone with the event id, so
silence-to-the-signer would create an asymmetric truth state;
telling them keeps the system honest without exposing the
initiator's private reasoning.

**Idempotent proof email.** If a locking-dedup event had previously
auto-completed and emitted a proof email, then a revoke dropped it
below threshold and reopened it, then a fresh attestor refilled the
threshold: a `kind: 'completion'` commit is still written (audit
honesty — every transition is recorded) but the proof email does
**not** re-fire. `event.proof_email_sent_at` is stamped on the
first proof email; the gate in `receive.js` won't re-emit.

## Worked example

A two-step workflow with both steps requiring an attachment and
carrying an aspirational date, to make it easy to scan the actual
subject + body shape end-to-end.

**Event setup (what the organiser submitted):**

```
title:      wedding video
organiser:  jane@example.com
min trust:  authorized
steps:
  1. audio mix    → contractor1@example.com   deadline 2026-06-01   attachment required
  2. video edit   → contractor2@example.com   deadline 2026-06-15   attachment required   after #1
```

Event id assumed: `evd47k0vqc23`. Domain: `git-done.com`.

### Email A — activation receipt to organiser (#9)

```
From:    gitdone <gitdone@git-done.com>
To:      jane@example.com
Subject: [gitdone] "wedding video" — activated, 1 invitation sent

Your event is now active. Invitations have been sent to the participants
whose steps are unblocked (▸ in the list below). Downstream participants
will be invited automatically as their dependencies complete.

Event: wedding video
Activated: 2026-05-04T19:30:00Z

Steps (▸ = waiting on this person now):
  ▸ 1. audio mix → contractor1@example.com  [pending]  (deadline 2026-06-01, attachment required)
    2. video edit → contractor2@example.com  [pending]  (after #1, deadline 2026-06-15, attachment required)

Delivery:
  sent   → contractor1@example.com

If a participant's address bounces you'll get a separate "invitation
bounced" email and the dashboard will show "delivery failed" on that step.

Manage: https://git-done.com/manage/event/evd47k0vqc23
```

### Email B — first invitation to step 1 participant (#2)

```
From:     gitdone <gitdone@git-done.com>
To:       contractor1@example.com
Reply-To: event+evd47k0vqc23-s1@git-done.com
Subject:  [gitdone] wedding video — audio mix [1/2] — your step

You've been named as a participant in a gitdone event.

Event: wedding video
Your step: audio mix (step 1 of 2)
Organiser: jane@example.com
Attachment: required
Aspirational date: Mon 1 Jun 2026

Reply from contractor1@example.com to:
  event+evd47k0vqc23-s1@git-done.com

Write whatever you want in the body. Attachments are forwarded to the
organiser directly — gitdone only stores hashes of them, never content.
Your reply is DKIM-verified, OpenTimestamped, and committed to a
per-event git repository as a permanent record.

If this is unexpected or you don't want to participate, ignore this
email. The organiser can see that your step is still pending.
```

### Email C — reply ack: accepted (#4)

After contractor1 replies with the audio file attached:

```
From:    gitdone <event+evd47k0vqc23-s1@git-done.com>
To:      contractor1@example.com
Subject: [gitdone] Accepted — wedding video — audio mix [1/2]

Your reply for "audio mix" on event "wedding video" was accepted.
The step is marked complete and the reply is recorded in the event's
git audit trail (DKIM-verified, OpenTimestamped).

Thank you — nothing else is needed from you on this step.

Organiser: jane@example.com
```

### Email D — step-progress update to organiser (#10)

```
From:    gitdone <gitdone@git-done.com>
To:      jane@example.com
Subject: [gitdone] "wedding video" [1/2] step done · next active

Step #1 "audio mix" was just completed by contractor1@example.com.

Now waiting on: #2 video edit (contractor2@example.com).

Event: wedding video

Steps (▸ = waiting on this person now):
    1. audio mix → contractor1@example.com  [DONE]  (deadline 2026-06-01, attachment required)
  ▸ 2. video edit → contractor2@example.com  [pending]  (after #1, deadline 2026-06-15, attachment required)

Manage: https://git-done.com/manage/event/evd47k0vqc23
```

### Email E — cascaded invitation to step 2 participant (#2)

Same shape as Email B, sent the moment step 1 commits. Note `[2/2]`.

```
From:     gitdone <gitdone@git-done.com>
To:       contractor2@example.com
Reply-To: event+evd47k0vqc23-s2@git-done.com
Subject:  [gitdone] wedding video — video edit [2/2] — your step

You've been named as a participant in a gitdone event.

Event: wedding video
Your step: video edit (step 2 of 2)
Organiser: jane@example.com
Attachment: required
Aspirational date: Mon 15 Jun 2026

Reply from contractor2@example.com to:
  event+evd47k0vqc23-s2@git-done.com

[…body identical to Email B…]
```

### Email F — completion notice to organiser (#11)

After contractor2 replies, the event reaches `complete` and one email
goes to every distinct contributor. The organiser's variant:

```
From:    gitdone <gitdone@git-done.com>
To:      jane@example.com
Subject: [gitdone] "wedding video" — completed [2/2]

The event you organized has completed.

Event: wedding video
Event ID: evd47k0vqc23
Completed: 2026-05-15T18:14:22Z
Reason: all steps completed
Final step: #2 "video edit" by contractor2@example.com

Steps:
  1. audio mix — DONE
  2. video edit — DONE

The full audit trail is stored as a git repository with one commit per
reply, DKIM keys archived, and OpenTimestamps proofs attached. Anyone
can verify it offline with the gitdone-verify CLI, even if gitdone itself
goes away — the proofs outlive the service.

  Event repo: git-done.com/events/evd47k0vqc23 (auth required)
  Organiser: jane@example.com
```

Each contributor gets a slimmer participant variant — same subject, no
step table.

### Email G — what jane sees if she sends `remind+` mid-flow (#17, #2)

After Email B but before contractor1 replies, jane sends to
`remind+evd47k0vqc23@git-done.com`. Two messages go out:

**Receipt back to jane:**

```
From:    gitdone <remind+evd47k0vqc23@git-done.com>
To:      jane@example.com
Subject: [gitdone] reminded "wedding video" [0/2] step done

Reminders sent:
  ✓ contractor1@example.com
```

**Reminder to contractor1** — same as Email B but the subject is
prefixed with `"reminder"` so the participant's MUA can disambiguate
the resend:

```
Subject: [gitdone] "reminder" wedding video — audio mix [1/2] — your step
```

### Email H — what jane sees if she sends `close+` (#18)

Two replies are required. First — pending intent:

```
From:    gitdone <close+evd47k0vqc23@git-done.com>
To:      jane@example.com
Subject: [gitdone] close pending "wedding video" — reply to confirm

Closing an event is irreversible — confirmation required.

To close "wedding video" (evd47k0vqc23), reply to this message
from the same address with the following confirmation:

  CONFIRM 7af31b9c

(in the subject or anywhere in the body — case-insensitive).
This token expires at 2026-05-04T20:00:00Z.

Closing the event writes a final completion commit to the audit
trail and notifies all participants. It cannot be undone.
```

Then jane replies with `CONFIRM 7af31b9c` in the subject (or anywhere
in the body) within 30 minutes:

```
From:    gitdone <close+evd47k0vqc23@git-done.com>
To:      jane@example.com
Subject: [gitdone] closed "wedding video" [1/2] step done

Confirmed. Event evd47k0vqc23 ("wedding video") closed by initiator at 2026-05-04T19:42:08Z.
```

The completion notice (#11) fans out to participants in the same tick
with `closed early` rather than `completed` in the subject and reason.

## Conventions worth keeping

When adding a new email to gitdone, match these patterns so subjects
stay scannable in cluttered inboxes:

1. Always start with `[gitdone]`.
2. Quote the event title with `"…"` when present — except the
   participant step subjects (invitation, accepted, attachment-required),
   which lead with the bare title heading a `<title> — <step.name>`
   chain.
3. Use `[N/M]` for workflow progress; drop it for crypto.
4. Separate clauses with ` — ` (em dash) or ` · ` (middle dot for
   tighter pairs like `complete` / `next active`). **Exception:** the
   activation magic-link subject (sent via knowless, whose
   `validateSubject` is ASCII-only) falls back to a plain ` - ` hyphen,
   since `—`/`·` aren't ASCII. This applies only to knowless-sent
   subjects; everything on gitdone's own outbound path uses the em
   dash / middle dot.
5. Keep subjects bounded — if the natural form grows with step count,
   move detail into the body and surface only the counter.
6. Set `Auto-Submitted: auto-replied` (acks) or `auto-generated`
   (alerts) so loops are killed by the inbound prefilter.
