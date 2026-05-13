# Changelog

All notable changes to GitDone are recorded here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
GitDone is pre-launch; versions are **phase-based** rather than semver
until a public release cuts v1.0 (tracked in `docs/01-product/prd.md`
§10). Newest first.

**Entry scope:** user-visible or principle-visible changes. A reader
should be able to answer "can GitDone do X yet?" from this file alone —
internal refactors and commit-level churn stay in `git log`.

---

## [Unreleased]

### Module 9 hotfix — proof email + subtitle persistence

Live-deploy test of Module 9 surfaced two follow-ups:

- **Proof email for an attestation closed-early after revoke was lying.**
  Body opened "has reached its threshold" even when the organiser cut
  short; the receipt block surfaced raw audit counts (`Replies counted
  5 · Verified 5`) without distinguishing revoked from effective;
  subject said `[2/2]` and didn't mention close. Fixed:
  - Body opening: "has been closed early." when closed by initiator.
  - Date label: `Closed:` (was `Reached:`) on close-early.
  - Proof block: when any revoke present, replaces `Replies counted`
    with the triple `Replies in audit / Revoked / Effective`, and
    trust counts (`Modal trust`, `Verified`, etc.) are computed over
    the effective subset.
  - Subject: appends `— closed early` when closed by initiator;
    `[counted/threshold]` now revoke-filters under `unique`/`latest`
    and skips revoked sender_hashes under `accumulating`.
- **"Originally reached, since revoked" subtitle survives close-early.**
  Was gated on `completion.reopened_at`, which `executeClose`
  overwrites — so a closed-early event with revocation lost the
  subtitle even when the historical fact still held. Now gated on
  the durable `threshold_reached_at` anchor.

### Module 9 — visible revocation + ack-body fixes

Live-deploy smoke test of Module 8 surfaced three real bugs and one
policy gap. All fixed in one commit, deployed as 0.24.0.

- **Ack body now reads per-attestor progress.** In multi-doc
  attestation events, the partial-sign / wrong-attachment / already-
  signed acks rendered `[ ] [ ]` (all open) because `formatProgressBlock`
  read `reference_docs[].signed_at` — a declaration-only field that's
  never populated in attestation. Now reads
  `attestor_progress[senderHash].signed_doc_hashes`, so the ack
  correctly reflects what THIS sender has signed so far. Pulled into
  a new `app/src/ack-progress.js` module with full unit coverage.
- **Revocation is now visible in the UI.** Module 8 made revocation
  mechanically correct but invisible — the manage hero still showed
  `2 of 2 · complete` after a revoke. Module 9 adds:
  - Triple-count stat band — when any revocations exist, the tiles
    become `attested · revoked · effective` (amber on revoked, green
    on effective).
  - "Originally reached <date>, since revoked <date>" subtitle on the
    hero when the effective count has dropped below threshold.
  - Strikethrough + amber "revoked" badge on ledger rows whose
    `sender_hash` is in `revoked_senders[]`.
  - Revoke commits render as a distinct ledger row (amber accent,
    `−N attestors`, inline reason).
  - Dashboard row uses the same triple-count compaction.
- **Revoked senders are now told.** Previously a revoked attestor's
  re-reply landed in `strict_already_signed` and got an ack saying
  "you've already signed every required document" — misleading,
  because the engine had silently dropped them. New decision reason
  `revoked_sender` fires first, and the ack reads "Your prior
  signature on this attestation was revoked by the initiator and no
  longer counts… the public proof page shows the revocation". No
  reason text exposed; the initiator's reason stays on the ledger.
- **Share buttons promoted above the trust ladder** on both
  attestation and declaration heroes. Reading flow: action first
  (share with someone), then audit (trust posture).
- **Long URLs truncate to 30 chars** with `…` and a hover `title=`
  showing the full URL. Fixes mobile viewport overflow on the crypto
  manage view. New `truncateText` helper in templates.js.

### Module 8 hotfix — idempotent proof email + tighter body parser

Code-review pass on Module 8 caught four issues; all four fixed in a
single follow-up:

- **Critical: duplicate proof-email on revoke→re-complete.** When a
  locking-dedup event auto-completed, then a revoke dropped it back
  below threshold, then a fresh attestor's reply re-filled the
  threshold, the proof email and `kind: 'completion'` commit fired a
  second time. Audit-honest behaviour is to write the completion
  commit (every transition is recorded) but suppress the
  user-facing email. Now gated on a new `event.proof_email_sent_at`
  field stamped after the first proof email; receive.js skips
  `notifyEventCompletion` + `commitCompletion` when set.
  Accumulating dedup was already protected via `threshold_reached_at`.
- **Theoretical race: loadEvent outside the mutex.** The revoke
  handler resolved body emails to sender_hashes against the OUTER
  event snapshot, before the atomic block. A concurrent inbound
  could have shifted `attestor_progress` between snapshot and lock.
  Resolution moved INSIDE `updateEventAtomic`'s updater so it
  always uses the freshly-loaded `current.salt` /
  `attestor_progress` / `replies`.
- **`applyRevoke` guard on declaration/workflow.** Calling the
  pure transition directly on a non-attestation event would have
  silently persisted `revoked_senders[]`. Guard added at the top
  of the function — returns `applied: false` with
  `reason: 'not_attestation'`. (Receive.js already rejects these
  routes; the guard hardens the pure function against direct
  test calls or future surfaces.)
- **Body parser false positive on attribution lines.** The previous
  `REVOKE_EMAIL_RE` matched any email anywhere in a non-quoted line,
  so a mobile client's flattened `On Tue, bob <bob@ex.com> wrote:`
  attribution would have revoked bob. Tightened to require the
  trimmed line to consist of ONLY the email (with optional `<>`
  wrap, optional `revoke:` prefix).

**Permanence made explicit (was implicit).** The ack body and the
email-formats §24 doc now state that revocation is one-way: a
revoked attestor cannot un-revoke themselves, their
`attestor_progress[h].complete` flag stays true, and re-signs reject
under `strict_already_signed`. The only path to re-complete is a
brand-new (different) attestor.

Tests 559 → 563 (+4: applyRevoke declaration/workflow guards,
attribution-line body parsing, re-revoke dedup).

### Crypto rework module 8 — `revoke+<id>@` channel

The initiator of an attestation event can now revoke individual
attestors after they've signed. The mechanic is a dedicated inbound
address `revoke+<id>@git-done.com`, DKIM-gated to the event's
initiator (same auth as `stats+ / remind+ / close+ / attach+`).

**Body grammar:** one attestor email per line, plus an optional
`reason: <free-form>` line. Quoted-reply prefixes (`>`) and the
`-- ` signature delimiter are ignored, and parsing caps at the
first 80 lines of body to bound pathological input. Multiple
attestors can be revoked in a single email.

**State change:** each parsed email is hashed (`hashSender(email,
event.salt)`) and matched against the event's known attestor hashes
(`attestor_progress` keys for strict mode + `replies[].sender_hash`
for loose). Matches are appended to a new `event.revoked_senders[]`
array — one entry per revoke, recording the sender hash, the
revoke timestamp, the initiator's reason, and the revoke commit
sequence.

**Audit trail is preserved.** The original signature commits stay
in the per-event git repo untouched; revocation lands as a separate
`kind: 'revoke'` commit (OpenTimestamped). The offline verifier
sees the full ledger — what was signed, what was revoked, when,
and why.

**Counter behaviour.** Every counted-replies surface (manage hero
stat band, dashboard row, ack subject's dual-count, organiser
stats body) now drops revoked hashes from totals. Strict-mode
distinct-attestor count, loose-unique distinct senders, loose-latest
deduped replies, and loose-accumulating raw-replies all converge on
the same rule: revoked sender_hashes don't tick the counter.

**Completion re-evaluation.** Locking dedup (`unique` + `latest`)
auto-completes at threshold; a revoke that drops the count below
threshold flips `event.completion` back to `open` with
`reopened_at` + `reopened_reason` stamped. Accumulating dedup never
auto-completes via threshold, so revoking leaves completion alone
(the `threshold_reached_at` anchor stays as a historical record).

**Silent on the attestor side.** Revocation does not email the
revoked attestor — Module 9 will paint the visible strikethrough on
the public ledger when they revisit. Avoids accusation-by-email and
keeps revoke reasons private to the initiator's ack.

Module 9 will surface revoked counts on the manage UI (triple-count
`N attested · R revoked · E effective` + strikethrough ledger rows);
Module 10 will gate revoke against post-close events so committing a
revoke after explicit close lands in the audit trail without moving
the counter.

### Crypto rework module 7 — three share buttons on the manage hero

Every crypto manage page now carries a row of three share controls
sitting between the stat band and Event Details:

- **Email** — `mailto:` with prefilled subject (`Sign attestation:
  "<title>"` / `Sign declaration: "<title>"`) and a plain-text pitch
  in the body. Opens the user's mail client, recipient empty so they
  pick.
- **Share** — Web Share API (`navigator.share`). Server renders the
  button `hidden`; client JS unhides only when the API is present
  (most desktops don't have it; mobile + some Safari do). Native
  share sheet → Slack / WhatsApp / SMS / etc.
- **Copy** — clipboard. Same pitch the Email / Share buttons use.
  Brief inline toast ("Copied to clipboard") on success.

The shared pitch is computed server-side from event title + ask +
reply address + (strict-mode attachment hint when applicable) + the
reference URL when set. Five lines, organiser-ready for pasting
into any channel. Drops the friction of "what should I say when I
share this?" entirely.

Integration tests pin the surface: all three buttons present in the
DOM, Web Share button starts hidden, mailto carries the right
subject + reply address, data-share-pitch carries the full text.

### Manage hero — unified stat band (signers / verified tiles)

The numbers that matter on a crypto manage page (how many distinct
signers, how many of them DKIM-verified, audit-only count, threshold
date) were diluted across three places: hero headline, a per-reply
"3 VERIFIED" tile that counted replies rather than signers, and a
"Counted signers" row buried deep in Event Details.

New shape on both declaration and attestation, sitting right under
the mode badge:

```
[ N / threshold ]   [ M ]      X audit-only · threshold reached YYYY-MM-DD
  signers / signed    verified
```

- **signers** — distinct attestors with complete buckets (Module 6.5
  metric for attestation); 0/1 for declaration.
- **verified** — DKIM-verified subset of those signers.
- **meta strip** — audit-only count + threshold-reached / completion
  date in a single right-aligned line.

Same shape across modes for at-a-glance consistency. Drops the
per-reply trust tile section (the trust ladder already conveys
posture; this is now the canonical metrics surface) and the
redundant "Counted signers" row from Event Details (promoted up
into the stat band).

### Crypto rework module 6.5 — strict attestation: re-signing doesn't double-count

Under strict mode, the reference-doc manifest is finite and frozen.
An attestor whose bucket is already complete has nothing further to
attest to — but until this fix, a second matching reply from the
same sender still ticked the count under accumulating dedup. So on
a 1-doc manifest, threshold-2 event, msn.com could send the right
file twice and consume two of the two threshold slots solo.

New rule: **under strict mode, a reply counts only if it adds at
least one new manifest hash to the attestor's bucket.** Re-signing
the same doc(s) is committed to the audit trail (with a friendly
`[gitdone] Already signed — "<title>"` ack explaining the audit
trail captured it but it doesn't move the count) but doesn't tick
the user-facing number. Same rule across all three dedup rules —
unique / latest / accumulating — because the manifest is the
load-bearing finite resource, not the dedup ledger.

Counter consequence: the dashboard count for strict-mode attestations
now reflects **distinct attestors with complete buckets** rather than
raw `replies.length`. The "Counted replies" row in Event details
renames to **"Counted signers"** under strict mode. The hero
headline switches its noun from "replies" to "signers" for the
strict-mode accumulating case. Loose attestation is unchanged.

Two new reject reasons:
- `strict_already_signed` — covered above.
- Existing `attachment_set_mismatch` / `strict_no_matching_attachments`
  unchanged.

Unit tests in completion.test.js: redundant re-sign on a complete
bucket rejects with `strict_already_signed`; partial-bucket case
where same-hash re-send rejects while new-hash advances works. 539
tests pass (+2 new).

### Crypto rework module 6 — dual count on attestation acks + manage list

Attestation surfaces now distinguish the **counted** number from the
**DKIM-verified** subset — important for vouching / petition / legal
use cases where "we have 100 signatures" is not the same statement
as "we have 100 DKIM-verified signatures." Two surfaces gained the
split:

- **Per-reply ack.** Body always shows both numbers when they
  diverge: `Replies so far: 5 (2 verified)/10`. Subject appends a
  `· N verified` qualifier only when verified ≠ counted (keeps the
  common case compact — under strict mode + unique/latest dedup the
  two are equal by construction): `[5/10 · 2 verified]` vs `[5/10]`.
- **/manage list row.** Attestation row gains a trailing `· N
  verified` suffix in the same divergence-only shape.

Workflow + declaration unchanged. Hero headline + dashboard receipt
block already carried this information via the trust tiles and
modal-trust pill, so no churn there. ~50 LOC including the test
update to existing integration tests that exercised unsigned-mail
flows.

### Activate flash — scrolls into view + brief attention pulse

The post-activate "Activated — your reply address is now live"
message sat between the back link and the metadata strip on the
per-event dashboard. Technically visible but easy to miss when the
user's eye was on the proof hero. Now: 1.6s soft-pulse animation
on first paint, scrollIntoView({behavior:'smooth'}) followed by a
24px upward nudge so the message sits a comfortable distance below
the viewport top. Font-size bumped 0.9em → 1em, weight 400 → 500
for independent visual weight. No test impact.

### Completion proof email — mode-aware bodies, role-aware splits, ref docs surfaced

The `[gitdone] proof —` durable receipt now reads correctly for each
of the five (mode × role) combinations, and the body carries enough
context that an organiser or signer reading the email three years
later can recover what kind of proof this was without opening the
per-event repo.

What changed:

- **`Reason: all steps completed`** no longer lies on crypto events.
  The label is now mode-aware: `threshold reached` for attestation,
  `the signer replied` for declaration, `all steps completed` for
  workflow, `closed early by the organiser` for an initiator-closed
  event in any mode.
- **Explicit `Mode:` line in every body** — `Workflow` /
  `Declaration (one signer, one record)` /
  `Attestation - <dedup-blurb> - threshold N`. The recipient never
  has to remember which kind of event they were on.
- **Reference URL + manifest echoed** when the event has them — the
  email now embeds the WHAT being signed (the URL plus per-doc
  `filename  sha256:head8…tail8` lines), so the proof carries the
  pointer to the document along with the cryptographic receipt.
- **Declaration is symmetric.** Initiator and signer now get the same
  body (modulo a one-line lede swap). Two-sided notary — both parties
  have equal stake in the record, neither has more right to it. The
  prior split rendered the signer a "participant" of their own
  declaration, which read oddly.
- **Attestation, organiser** keeps the aggregate (count, modal trust,
  per-trust-level breakdown) — that's why they ran the attestation.
- **Attestation, attestor (strict mode only)** is privacy-conservative
  by design: confirms their contribution is preserved and the event
  closed, surfaces their **own** DKIM+OTS receipt looked up by salted
  hash (tighter than the prior domain-match which collided across
  attestors at the same provider), and explicitly states *"The
  aggregate result is private to the organiser; this email is YOUR
  record only."* No count of others, no aggregate trust, no domains
  of co-signers. Loose attestation is unchanged — only salted hashes
  are ever stored, so there's no attestor recipient to address.
- **Subject counter for attestation** — `[gitdone] proof — "<title>"
  [N/threshold]` mirrors the workflow `[done/total]` shape. Same
  numbers the attestor's per-reply ack already carried, so no
  over-share.

The PRD §6.2 already promises proofs that outlive the service; this
brings the email body in line with that promise. `email-formats.md`
§11 fully rewritten to document the five (mode × role) splits.

### Crypto rework module 4e — attestor completion notification (strict only)

Until this module, the `[gitdone] proof — "<title>"` completion email
went only to the initiator and (for declarations) the named signer.
Loose attestations are anonymity-friendly by construction (gitdone
stores salted hashes, not plaintext) so there's no way to reach
counted attestors. Strict-mode attestation already has the same
hash-based ledger, but the signers are by definition non-anonymous —
they're attaching files whose hashes pin them to the manifest, and
their domain is in the proof.

Under **strict mode only**, gitdone now persists each attestor's
plaintext email on the reply that fills their bucket
(`attestor_progress[hash].email`), fires the proof email to every
counted attestor + the initiator when the threshold-tripping reply
lands, and then **immediately redacts** every stored email +
stamps `event.attestor_emails_redacted_at`. Post-redaction replies
(only possible under accumulating dedup) refuse to re-introduce PII.

The PII window is bounded by: bucket-completion → threshold reached →
proof email burst → redact. Typically seconds to days; never longer
than the threshold-reach delay. Loose attestation is untouched — no
emails stored, no attestor proof email.

### Crypto rework module 5 — prominent mode badge on the manage hero

Between the proof headline and the details block, every crypto manage
page now renders a colour-coded mode badge so the organiser sees at a
glance which side of the declaration/attestation split they're on:

- **Declaration** — green pill (`DECLARATION · one signer, one
  record`), CRT-green border.
- **Attestation** — amber pill (`ATTESTATION · unique · one count per
  sender` / `latest · only the most recent counts` / `accumulating ·
  every reply counts`), CRT-amber border. The dedup blurb adapts to
  the event's configured rule.

The form defaults (declaration mode, unique dedup) were already in
place from module 4d; this surfaces the resulting mode in the
existing-event view too, so an organiser sharing a screenshot of the
hero conveys the proof shape without writing a sentence about it.
CSS-only styling, no new state.

### Crypto rework module 4d — UX polish on the strict-signing flow

Module 4c shipped the engine; 4d closes the UX gaps around it. Six
changes plus two followup fixes:

- **Form default flipped to declaration.** Was attestation, which
  pushed every first-time user into the harder mode. Most asks are
  one-signer; declaration is the right default and the radio reflects
  that.
- **`/manage` status pill: `open` → `active`.** "Open" read as
  "anyone can join"; "active" reads as "running." Renamed in the
  per-event hero and on the manage-hub list view.
- **Activation email asks for the docs when URL set + no docs.** The
  organiser-facing activation mail now carries an IMPORTANT block
  telling them to forward / attach the reference doc(s) to
  `attach+<id>@`. The signer invite is held until the first attach+
  registers the set, so the signer never gets an empty manifest.
- **Confirm page expanded.** Title + details + ref URL + a 5-step
  roadmap showing what happens next (confirm → activation email →
  attach docs → signer invited → signed/anchored). One line each;
  the goal is reducing "what now?" friction at the point of highest
  organiser uncertainty.
- **Per-doc trust annotation on the manage hero.** Each ticked
  reference doc renders its DKIM trust pill and signer domain
  inline (`[x] doc.pdf · DKIM-VERIFIED · @gmail.com ·
  2026-05-12`) for declaration, or aggregate progress for
  attestation (`[2x] doc.pdf · 2 attestors signed`). One render
  pathway per mode (see followup #1 below).
- **Per-doc expandable proof receipts.** Replaces the single combined
  drawer with one expandable `<summary>` row per doc, each showing
  that doc's commit and DKIM/OTS state. Smaller drawers, easier to
  cite a specific doc.

Followups inside the same module:

- **Reverted a misguided per-sign initiator email.** A first pass
  emailed the initiator on every counted signer reply; the organiser
  already receives the forwarded original, so the extra mail was
  noise. Reverted and locked the behaviour with a regression test
  that asserts the signer gets the final `[gitdone] Signed —` ack on
  the completing reply (no leakage into the initiator inbox).
- **Render fix: attestation reference-docs row was never ticking.**
  The strict render assumed `reference_docs[i].signed_at`, which is
  declaration-only — attestation stores per-attestor sha256 sets in
  `event.attestor_progress[hash]`. Now branches on mode and aggregates
  per doc.

### Crypto rework module 4c — strict signing, signer attaches matching files

The big module of the rework. When a crypto event has both
`reference_url` set AND `reference_docs[]` registered (via the new
`attach+` channel from module 4a), the event enters **strict signing
mode**: the signer/attestor MUST attach files whose SHA-256 hashes
match the registered manifest before their reply counts. No file
bytes are stored — only the hashes are compared.

**Matching rule.** Exact hash set match. Partial signing is allowed
across multiple replies — matches accumulate per signer (declaration)
or per per-attestor-progress bucket (attestation). Filename match
with different bytes is rejected with a diff in the ack; extras
(unrelated attachments alongside the matching set) are ignored.

**New reject reasons.**

- `attachment_set_mismatch` — at least one filename matched a
  registered doc but the bytes differ. The ack lists the offending
  filename, the expected `sha256:head4…tail4`, and the received one.
  Encourages the signer to fix the file rather than re-send the wrong
  version blindly.
- `strict_no_matching_attachments` — no attached file matched any
  registered hash. The ack reproduces the manifest so the signer can
  attach the right thing without leaving their inbox.

**Per-doc signing state.**

- Declaration: each `reference_docs[i]` gains `signed_at`,
  `signed_trust_level`, `signed_sender_domain`,
  `signed_commit_sequence`. Completion fires when every entry has a
  `signed_at`.
- Attestation: per-attestor progress lives at
  `event.attestor_progress[salted_sender_hash].signed_doc_hashes` —
  the per-attestor map shares the same salted-hash key shape as the
  loose-attestation dedup ledger, so privacy posture is unchanged. An
  attestor counts toward the threshold only when their bucket covers
  every registered hash.

Partial-signing acks (`[gitdone] Signed in progress — "<title>"`)
carry a progress block listing which docs are ticked for that signer
and which remain. The final reply that closes the manifest gets the
normal `[gitdone] Signed — "<title>"` ack.

Tests: `app/tests/integration/strict-signing.test.js` (9 tests
covering the happy path, byte-mismatch with diff in ack, no-match
rejection, partial-signing across two replies for declaration,
attestation accumulation across distinct attestors, the unsigned-mail
+ `min_trust_level: unverified` accumulating path, and a final-ack
regression).

### Crypto rework module 4a — `attach+<id>@` channel and derived gating

A new initiator-only public address registers the canonical reference
documents for a crypto event. The flow:

- Organiser sends a regular email to `attach+<id>@git-done.com` with
  the doc(s) attached. DKIM-verified, envelope sender must match
  `event.initiator`.
- gitdone hashes every attachment (SHA-256 + filename + size), commits
  a `kind: 'attach'` record to the per-event git repo, OTS-stamps it,
  and discards the bytes. **No file content is stored** — same
  privacy posture as participant attachments (PRD §0.1).
- The doc set is **frozen on the first attach+ reply**. Subsequent
  attach+ emails bounce with `[gitdone] attach+ rejected — doc set
  frozen — "<title>"`. The "one-shot manifest" semantics let the
  signer trust that what they see at invite time is what they'll be
  asked to sign.
- The first attach+ email **triggers the held signer invite** for
  events that had `reference_url` set + no docs at activation. The
  invite body lists the manifest (filename + hash + size per row) so
  the signer can fetch + attach the exact bytes.
- **Derived gating, no separate flag.** If `reference_url` is set but
  no docs are registered, replies to `crypto+<id>@` bounce with a
  pointer to the attach+ channel — the organiser can't accidentally
  publish a "please sign" before the manifest exists.

Manage hero now surfaces the doc list and the `attach+<id>@` address
prominently. Every counted-reply ack lists the doc set so the signer
can verify what they just attested to (separate from the `verify+`
out-of-band path).

### Crypto rework module 3 — optional reference_url field

Crypto events (both modes) can now carry a single optional
`reference_url` — a public HTTPS link to the thing being signed
(contract, statement, position paper, etc.). Validation:

- HTTPS only (rejects `http://` and non-URL strings; whitespace-only
  rejected; bare strings without scheme rejected).
- Max 2048 chars.
- Round-trips correctly on form re-render (preview-before-create flow).

When set, the manage hero renders it as a linkified row with
`rel="noopener noreferrer"`. The field is the single toggle that
enters strict signing mode (module 4c) when combined with a
registered doc manifest (module 4a). On its own — URL set, no docs —
it's just a pointer with no behavioural change beyond the rendered
link.

### Link previews now show a real card (`og:image` wired)

Sharing a git-done.com link in WhatsApp, Slack, Signal, Discord,
iMessage, etc. used to render as a "compact" preview — chain icon
+ title only — because the head emitted the OpenGraph quintet
without `og:image`. The card was deferred as a design task in
`privacy-seo.md`; that's resolved now.

`/og.png` (1200×630, charcoal `#0d1117` bg, JetBrains Mono `g/`
mark — charcoal `g` + amber `/`, matching the favicon) is served
out of `app/src/web/og.png`. `templates.js:layout()` emits an
absolute `og:image` URL built from `GITDONE_PUBLIC_URL`, plus
`og:image:width/height/alt` and `twitter:image`; `twitter:card`
upgraded from `summary` → `summary_large_image`. Source SVG sits
next to the PNG (`og.svg`) so the asset can be regenerated with one
ImageMagick command. Once the deploy lands, scraper caches need
busting via developers.facebook.com/tools/debug/ (FB+WhatsApp) and
linkedin.com/post-inspector/.

### Self-reply now produces an explanatory ack (was silent)

When the initiator emailed their own event's reply address, the
engine returned `{ count: false, reason: 'sender is the event
initiator (self-reply)' }` and committed the reply to the audit
trail — but the participant-ack code only fired for `accepted` plus
a fixed list of rejections (`missing_attachment`, `event already
complete`, `event not activated`, `event archived`). Self-reply
wasn't in the list, so silence — the tester sat there wondering if
their email even reached gitdone.

Self-replies now produce a `[gitdone] Self-reply not counted —
"<title>"` ack with body explaining: "you're the initiator, a
self-signature has no third-party value, your reply is in the
audit trail but doesn't count, share the reply address with someone
else." The reply remains uncounted; only the silence is fixed.
New integration test in `proof-emails.test.js` locks the ack
behaviour for both crypto modes.

### Crypto events: `details` (the ask) is now required

Empty "please sign" was the recurring failure mode — recipients had
no idea what they were attesting to or declaring. Both crypto modes
(declaration and attestation) now require a `details` field at
creation, validated 1-4096 chars (same brevity rationale as workflow
step details). The crypto creation form gets a required textarea
labelled "Details — the ask"; whitespace-only submissions reject with
a 422 and a clear "details: the ask is required" message. Existing
events remain readable; only new creations are gated.

The per-event manage dashboard now surfaces the ask as an "Ask:" row
in the Event details block (declaration + attestation hero), so the
organiser sees what they wrote and the activated signer sees what
they're confirming. `whitespace:pre-wrap` so multi-line asks render
intact. Two new integration tests lock the validation in:
empty-details and whitespace-only-details both reject.

This is module 1 of a multi-module crypto rework — see the project
plan for upcoming modules (optional `reference_url`, dual count,
share buttons, revoke flow).

### Attestation reply ack: subject carries the [counted/threshold] tag

Workflow step acks have always shown `[stepIdx/totalSteps]` at the end
of the subject so the participant sees their position at a glance.
Crypto attestations now do the same — `[gitdone] Attestation reply
recorded — "<title>" [1/2]`. Locking dedups (unique/latest) cap at
threshold by construction; **accumulating dedup is allowed to
overshoot** by design (the audit trail keeps counting after the
threshold lands), and the subject reflects that — `[3/2]`, `[5/2]`,
etc — paired with the existing `Replies so far: 5 (threshold of 2
reached on …)` body tail. Test coverage added for the 1st and 2nd
ack and for the 5th-of-2 overshoot case.

### Attestation reply ack: off-by-one fix on the reply count

The participant ack returned to a counted attestation reply read
`event.replies` from the *pre-update* event snapshot, so the first
reply against threshold=2 said `Replies so far: 0/2` instead of
`1/2`, the second `1/2` instead of `2/2`, and so on — every ack
was off by one. The handler now hoists the post-update event from
`updateEventAtomic` into the outer `event` binding so the receipt
sees the just-applied reply. New regression test
(`attestation reply ack reflects the just-counted reply`) covers
both the first and second reply, with `assert.doesNotMatch` against
the off-by-one strings to lock the fix in. Workflow and declaration
ack paths were already correct (they don't read `event.replies`);
only attestation receipts were affected.

### OTS-anchored state surfaced on the manage page

The 6h OTS-upgrade worker has always upgraded calendar-pending proofs
to fully Bitcoin-anchored ones, and the resulting follow-up email has
always told the recipient so. But the per-event manage dashboard
silently kept showing **OTS · pending Bitcoin upgrade** indefinitely —
the renderer reads `commit.ots_anchored`, and nothing was writing it.
Three changes close the loop:

- **Worker patches the commit JSON.** When `ots upgrade` changes a
  `.ots` file, the sibling `commits/<basename>.json` is patched with
  `ots_anchored: true` + `ots_anchored_at`, then staged into the
  same git commit as the upgraded proof. The dashboard now flips to
  **anchored to Bitcoin** on the next 6h tick after Bitcoin
  confirmation.
- **One-time backfill for already-anchored proofs.** When
  `ots upgrade` exits 0 with no file change (the "already fully
  anchored" path), the worker still patches the JSON if it predates
  this fix. The fix backfills the flag on the very next timer tick —
  no manual ssh, no rerun. Backfill-only commits are messaged
  `ots upgrade: backfill anchored flag for N proof(s)` so they're
  distinguishable from mainline upgrades in `git log`.
- **Block height in the JSON, the dashboard, and the email.** The
  worker now runs `ots info` (local-only, no network) on each
  upgraded or already-anchored proof, parses the Bitcoin block
  height, and writes it to `commit.ots_block`. The renderer surfaces
  **anchored at block N**; the OTS-anchored follow-up email
  surfaces **Block height   N**. Replaces the stub
  `(anchored, height not parsed)` line. Falls back to the un-numbered
  "anchored to Bitcoin" gracefully when the local `opentimestamps-client`
  emits a format the parser doesn't recognise.

### Review-pass follow-up on attachment surfacing — a11y + edge cases

Code-review pass on the attachment surfacing landed two days ago
(workflow `📎 N` pill + crypto ledger sub-row + receipt drawer)
flagged a pair of accessibility gaps and a handful of minor
loose ends. All addressed:

- **Keyboard activation on the trust + attach pills.** The pills
  carry `role="button" tabindex="0" aria-expanded="false"` so screen
  readers announce them as toggles, but the dashboard listener was
  click-only — keyboard users tabbing to a pill couldn't open the
  proof drawer. Single dispatch handler now covers `click` and
  `keydown` (Enter / Space). WCAG 2.1.1.
- **`aria-expanded` synced across both pills sharing one drawer.**
  When a workflow row has both pills, opening the drawer via either
  pill now flips `aria-expanded` on every pill that targets that
  drawer — previously the un-clicked pill desynced.
- **`focus-visible` outline** on the togglable pills (2px solid
  currentColor, offset 2px) so keyboard focus is visible on the
  charcoal background.
- **`.attach-pill` CSS rule** tightens the paperclip pill (no
  letter-spacing, slightly tighter padding) — was a dead class
  before, now does shape work distinct from the trust pill.
- **File size on the crypto ledger sub-row.** The workflow drawer
  showed `filename · sha256 · 100.0 KB`; the crypto sub-row was
  missing the size. Both surfaces now render the same shape.
- **`formatBytes(0)`** returns empty string by design — comment in
  the helper documents the choice (callers short-circuit the row
  rather than rendering "0 B" which would just be noise).

Test coverage broadened (M-3 from the review):

- `attachments` is `undefined` (legacy commits before the field
  existed) — receipt renders no `Attachments` section.
- `null` filename + missing `sha256` — falls back to
  `attachment-N` and `—`; never renders `undefined`.
- Malicious filename like `<script>alert(1)</script>.pdf` — escaped
  to `&lt;script&gt;`; XSS defense locked in.
- Integration test for the workflow attach pill + filename + hash
  + size in the receipt drawer.
- Integration tests for the unified filter row (no prior coverage):
  one asserts non-zero buckets render with lifecycle colours wired,
  another asserts `?status=completed` activates the pill and
  filters the list.

474 tests pass (371 unit + 103 integration).

### Manage hub: unified filter row — type + status pills, all clickable

The `/manage` hub now renders a single row of pill-shaped filters
above the event list, replacing the previous split (clickable type
pills in the header + a separate read-only status legend strip).
Every pill — `events`, `crypto`, `active`, `completed`, `closed`,
`pending`, `archived` — is the same shape and clickable.

- **Two independent dimensions.** `?type=event|crypto` and
  `?status=active|completed|closed|pending|archived` filter the row
  list independently; you can combine them. Clicking the active
  pill in either dimension clears that dimension.
- **Active pill takes the lifecycle colour.** When inactive, every
  pill is outlined grey. When active, it fills with the matching
  status colour (blue for active, green for completed, amber for
  closed, CRT-amber for pending, grey for archived) — the row
  pills already use this palette, so the filter doubles as a
  legend.
- **Archived auto-includes the archived view.** Clicking the
  `archived` pill flips `showArchived = true` regardless of the
  `?show=archived` query string. The bottom show/hide toggle stays
  for users who want the unfiltered combined list.
- **Type pills hidden when only one type exists.** Status pills
  hidden when their count is zero. No filters that do nothing.
- **Counts are portfolio-wide, not per-filter** — they tell you
  what each filter would yield.
- Mobile-responsive (wraps below 480px; vertical separator hidden).
- Per-pill counts.

### QA deferred items — DKIM fixture, overrides smoke test, byte-strict pin, EADDRINUSE guard

Closing out the four deferred items from the QA review:

- **DKIM-signed test fixture.** New helper
  `app/tests/helpers/dkim-sign.js` produces a relaxed/relaxed
  rsa-sha256 DKIM-Signature for a raw `.eml`. New
  `app/tests/helpers/stub-dns.js` + a test-only seam in
  `bin/receive.js` (gated on `GITDONE_TEST_DNS_FILE`) stub
  `mailauth`'s authenticator and the DKIM-archive resolver so tests
  can produce `trust_level: 'verified'` replies without touching
  the network. Test-only RSA keypair under
  `app/tests/fixtures/dkim/` (gitignore exception added with a
  warning comment so a real prod key never lands there).
- **e2e test now strict.** `app/tests/integration/e2e-proof.test.js`
  builds a DKIM-signed reply, asserts `trust_level === 'verified'`,
  creates the event with `min_trust_level: 'verified'`, and runs
  `gitdone-verify --min-trust verified`. `Archived DKIM keys` line
  is now `PASS`, `Overall: PASS`.
- **npm overrides smoke test.**
  `app/tests/unit/dep-overrides.test.js` reads
  `require('fast-xml-parser/package.json').version` (and the other
  two pinned deps) and fails LOUDLY if any falls below the security
  floor. Catches the case where someone removes the overrides
  block before mailauth catches up.
- **`syncEventJson` byte-strict invariant pinned.** Comment in
  `app/src/gitrepo.js` documents the contract (every writer goes
  through `JSON.stringify(event, null, 2) + '\n'`) plus a unit test
  in `gitrepo.test.js` proves the no-diff detection skips
  byte-identical writes and commits otherwise.
- **EADDRINUSE guard on dev server.** `bin/server.js` now installs
  an `'error'` listener before `.listen()`. On `EADDRINUSE` it
  prints a clear "another gitdone-web is on this port — find it
  with `lsof -ti:<port>`" and exits 1, instead of failing silently.

506 tests pass (371 unit + 97 integration + 38 verify-tool).

### Attachment fingerprints surfaced + status legend on /manage hub

The dashboard already recorded `attachments[].sha256` per commit
(used by `gitdone-verify` to match forwarded `.eml` candidates), but
they were invisible in the UI. Now surfaced wherever they're useful:

- **Workflow steps** — completed step rows render a green `📎 N`
  pill immediately to the right of the trust pill (`DKIM-VERIFIED`
  etc.) when the counted reply carried files. Both pills carry the
  same `data-step` hook, so clicking either expands the proof
  drawer. The drawer's receipt block now lists every attachment as
  `<filename>  sha256:head4…tail4  (size)`.
- **Crypto per-reply ledger** — each row in the attestation
  ledger now shows the same `📎 N` indicator before the trust label
  when present, with an indented sub-row enumerating filenames +
  truncated hashes. Single-attachment replies stay one line; rows
  without attachments are unchanged.
- **Proof emails** — `plainReceipt` (used in completion + anchored
  proof emails) appends an ASCII `Attachments` section listing the
  same fields, so the durable email artifact shows what was
  fingerprinted without opening the bundle.
- **Privacy unchanged.** GitDone still does not store attachment
  bytes — only the SHA-256 fingerprint is in the commit JSON. The
  organiser's inbox remains the attachment archive (PRD §0.1.10);
  this surface is a verification index, not a download link. The
  proof bundle (`.tar.gz`) carries the fingerprints inside
  `commits/commit-NNN.json`; `gitdone-verify` matches against them
  when the user supplies the original file via `verify+`.

A short-lived intermediate `/manage` hub legend (count strip with
lifecycle-coloured pills) shipped alongside this work and was
superseded the same day by the unified filter row above —
see "Manage hub: unified filter row" entry. The lifecycle palette
introduced here carried forward.

Frozen design ref updated:
`docs/01-product/design/proof-surfacing-v1.md` documents the
`renderAttachmentPill` helper and the receipt-block format.
PRD §6.2 dashboard bullet describes the attachment surface.

Follow-up review pass added: keyboard activation (Enter/Space)
and `aria-expanded` sync on the trust + attach pills, focus-visible
outline, an `.attach-pill` CSS rule, attachment file size also shown
on the crypto ledger sub-row, and tests covering legacy
`attachments=undefined`, null filename, missing sha256, malicious
filename (XSS-defense), and integration coverage of the workflow
attach pill + filter-row rendering.

### QA review fixes — mutex parity, accumulating OTS email, click-to-copy a11y

A code review of the recent proof-surfacing + bundle-download work
surfaced three structural issues. All fixed:

- **Per-event mutex now shared.** `event-store.js`'s `_writeMutex`
  was only protecting `activateEvent` / `editEvent` /
  `recordStepSendErrors`. `completion.updateEventAtomic` (called by
  the reply commit + dashboard close + email-path close) and
  `sweep.atomicWriteEvent` (archive/unarchive) bypassed it. Two
  concurrent transitions on the same event could race the JSON
  write or collide on `simple-git`'s `index.lock`. Lifted the mutex
  into a new `app/src/event-mutex.js` module; every state-relevant
  writer goes through it.
- **OTS-anchored email now fires for accumulating attestation.**
  The predicate at `ots-upgrade.js:234` was gated on
  `event.completion.status === 'complete'`, but accumulating
  attestation by design stays `'open'` past `threshold_reached_at`.
  Result: the OTS-anchored follow-up never fired for accumulating
  events. Predicate broadened to fire on either completion OR
  `threshold_reached_at` set.
- **Mixed-signal `commits/completion.json` removed for accumulating.**
  Was being written on `firstCrossing` while `event.json` said
  `'open'`. Dropped — `event.threshold_reached_at` (synced into the
  repo's `event.json`) is the canonical milestone marker.
- **Click-to-copy keyboard accessibility.** `<code class="copyable">`
  elements now get `tabindex="0"`, `role="button"`, dynamic
  `aria-label`, an Enter/Space `keydown` handler, and a
  `:focus-visible` outline. The click handler also bails when the
  user has an active text selection so highlighting + copying
  partial text works.
- **End-to-end proof-flow integration test.** New
  `app/tests/integration/e2e-proof.test.js` exercises
  create → activate → reply → complete → bundle download →
  `gitdone-verify` round-trip. Would have caught the accumulating
  bug. Spawns the verifier as a subprocess and asserts
  `Overall: PASS`.
- **Cleanup:** stale `allow_anonymous` references removed from
  fixtures and `docs/00-context/assumptions.md`. Threshold cap
  retroactive audit on prod: zero events with `threshold > 50`.

497 tests pass (362 unit + 97 integration + 38 verify-tool).

### Repo `event.json` now reflects current state (offline-verifier fix)

The per-event git repo at `data/repos/<id>/` is the canonical proof
artifact (PRD §0.1 "proofs verify offline without the gitdone
service"). Until now its `event.json` was written **once** on repo
init and never updated — every state transition (activate, edit,
close, archive, complete-via-reply) updated only the master JSON at
`data/events/<id>.json`. The repo's copy was stale: it lacked
`completion`, `archived_at`, current step status, attestation
`replies[]`, etc. Offline verifiers reading the repo (correctly)
reported the wrong state.

- New helper `gitrepo.syncEventJson(id, event, message)` writes the
  current state into the repo's `event.json` and commits it as a
  separate audit-trail commit. No-op when there's no repo yet
  (pre-activation events) or when the file hasn't changed (idempotent
  via `git status` check).
- Wired through every state-relevant write site:
  `event-store.activateEvent`, `event-store.editEvent`,
  `completion.updateEventAtomic` (covers reply commits + dashboard
  close + email-path close), `sweep.archiveEvent` /
  `unarchiveEvent`. Operational bookkeeping (nudges, send errors,
  proof-email message-id) does NOT sync — keeps the proof ledger
  free of noise.
- Reply commits add `reply NNN counted: <step|declaration|attestation>`
  audit-trail commits to the repo so the per-event git history
  becomes a durable state log.
- New one-shot script `app/bin/backfill-event-json.js` to retrofit
  existing prod repos. Runs idempotently. Documented in
  `docs/04-process/deploy.md` under "One-time migrations".
- Bundle download (the `.tar.gz` of the repo) and `gitdone-verify`
  now both see the canonical state — no code changes there, just
  Working Correctly™ once the backfill runs.

### Dependency hygiene — knowless 1.1.3, npm audit clean

- **`knowless` bumped 1.1.1 → 1.1.3**. Two patch versions of the
  in-house auth lib released between deploys; pulled forward to keep
  app and lib aligned. No app-code changes required.
- **`npm audit` cleaned to zero advisories** via `overrides` in
  `app/package.json`. `mailauth 4.13.2` still ships old transitive
  versions (`fast-xml-parser 5.4.2`, `nodemailer 8.0.1`, `undici
  7.22.0`) flagged for entity-expansion bypass / SMTP CRLF injection
  / WebSocket length overflow respectively. Pinned to fixed
  versions: `fast-xml-parser ^5.7.3`, `nodemailer ^8.0.7`, `undici
  ^7.23.0`. Side benefit: `nodemailer` deduped to one copy (8.0.7)
  across `knowless`, `mailauth`, `mailparser`.
- **Maintenance note:** revisit the overrides whenever `mailauth`
  releases a version whose own transitives meet or exceed the pinned
  versions; remove the overrides then to stay aligned with upstream.
  Quarterly check: `npm view mailauth dependencies && npm outdated`.

### Proof bundle download + verify-tool covers crypto + README rewrite + attestation cap 50

- **Proof bundle download.** Every event's manage page now has a
  "Download proof bundle (.tar.gz)" action streaming the full per-
  event git repo (`event.json` + `commits/` + `dkim_keys/` +
  `ots_proofs/` + `.git/`). Email-path equivalent: `bundle+<id>@`
  from the initiator's address — DKIM + envelope-sender match —
  replies with the same tarball attached, threaded as a reply to the
  proof email. Pair with the proof emails (#20-21): emails carry the
  receipt + .ots file; the bundle carries the full repo for offline
  verifier replay.
- **`gitdone-verify` covers crypto events.** Phase 2 of the offline
  verifier — declaration completion (one commit, signer matches,
  trust ≥ min) and attestation completion (dedup-rule-derived count,
  initiator self-replies filtered, per-trust-level breakdown). The
  comment that said "Phase 2" now describes implementation. 38/38
  tool tests pass.
- **README rewrite.** Re-anchored on the two paths (workflow vs
  declaration/attestation), the four-tier verification table, the
  two proof emails, and the offline verifier as headline features.
  Tighter (180 vs 188 lines) and re-organized.
- **Attestation threshold capped at 50.** Form input enforces `max="50"`,
  validator rejects above. Label updated to "Threshold (N distinct
  signers, max 50)".
- New module: `app/src/bundle.js` (tar streaming + multipart reply
  composer, no new prod deps).

### Cryptographic proof surfaced on every dashboard + durable proof emails

The proof — DKIM verification, SPF/DMARC/ARC, raw email hash, OTS
anchor — is the headline feature, and we were hiding it. Closed by:

- **Crypto manage page (declaration + attestation)** now renders a
  4-tier trust ladder (`unverified · authorized · forwarded · verified`)
  with the achieved level filled and rungs below it outlined in their
  own trust color (gradient signals "those would have also passed").
  Below the ladder: a headline `DKIM-VERIFIED · @<domain> · <date>`,
  then the secondary event details, then a collapsible
  `Cryptographic proof ▾` receipt with DKIM/SPF/DMARC/ARC/OTS rows,
  truncated raw hash, and the offline-verify command.
- **Workflow manage page** now renders a trust strip and ladder above
  the steps table summarizing the weakest-link trust level across all
  completed steps; per-step trust pills sit inline next to each
  completed step's status. Click a pill → expands the step's full
  receipt as a drawer row.
- **Proof email on completion.** When an event completes, every
  participant who counted (initiator, declaration signer, workflow
  participants, counted attestation repliers) receives a durable
  proof email with the same receipt embedded as plain text. Subject
  `[gitdone] proof — "<title>"`. Body verifies offline via
  `gitdone-verify <id>` against the per-event git repo.
- **Proof email on OTS anchored.** When the 6-hour upgrade cron flips
  the *last* pending OTS proof for an event, every recipient of the
  completion email gets a follow-up `[gitdone] proof anchored —
  "<title>"` threaded as a reply. Body carries the Bitcoin block
  height, anchor timestamp, and proof file path.
- **New helper module** `app/src/web/proof-render.js` — `renderTrustLadder`,
  `renderTrustPill`, `renderProofReceipt`, `aggregateTrust`,
  `truncHash`. Used by both dashboards.
- **Frozen design reference** at
  `docs/01-product/design/proof-surfacing-v1.md`.
- **Email-formats catalog** updated with verbatim subject + body
  samples for the two new proof emails (entries #20 + #21).

### Attestation overhaul — dedup-derived trust, accumulating keeps counting, click-to-copy

Attestation simplified to match its actual purpose ("share the
address, anyone can sign, count to threshold").

- **`allow_anonymous` checkbox dropped from the form.** Trust policy
  is now derived from the dedup rule:
  - `unique` and `latest` require DKIM-verified replies.
  - `accumulating` counts both DKIM-verified and unverified; the
    proof archive marks each.
- **`min_trust_level` knob dropped from the attestation form**
  (workflow + declaration unchanged — they still expose it).
- **Send-reminders button removed from attestation dashboards.**
  Email-path `remind+<id>@` now replies with the reply address and a
  "share it however you like" prompt instead of fake-success.
- **Initiator self-replies don't count.** Replies whose verified
  DKIM sender matches the event initiator still commit to the audit
  trail but never push the threshold. Same spirit as declaration's
  create-time `signer ≠ initiator` check.
- **Accumulating events keep counting past threshold.** Crossing
  threshold stamps `event.threshold_reached_at` /
  `threshold_reached_count` / `threshold_reached_sequence` (the
  proof anchor); replies past that point still extend `replies[]`
  and the dashboard counter keeps growing. The event closes only on
  explicit `close+<id>@` or the dashboard button. Unique + latest
  retain the lock-at-threshold behaviour.
- **Click-to-copy on every email/address token across manage
  pages** — reply addresses, command addresses (`stats+`, `remind+`,
  `close+`), participant/signer/initiator emails. Click → clipboard,
  brief inline "copied" toast.
- **PRD §4.2.2 dedup table updated** to encode the trust policy.

### Pending events accessible to the signed-in initiator + crypto signer MX parity

Two related fixes to the activation flow.

- **Per-event magic-link click is no longer required when the
  initiator is already signed in.** Previously, GET
  `/manage/event/<id>` for a pending event with no
  `activation_link_clicked_at` rendered the check-your-inbox view
  even when the requester held a Mode-B session whose handle matched
  the event initiator. POST `/manage/event/<id>/activate` enforced
  the same gate server-side with `?activate_blocked=1`. Result: an
  initiator who created an event months ago (and never opened the
  per-event activation email) couldn't recover it from the
  dashboard. Since a Mode-B session is itself minted via a knowless
  magic-link click, it is already proof of email ownership — the
  per-event click was redundant. Both gates removed; the
  handle-matches-initiator check on every route stays as the
  security boundary. Sign in at `/manage` → click the pending event
  → Activate / Edit / Close work normally.
- **Crypto declaration signer is now MX-checked at create time.**
  Workflow events have always run an MX / null-MX / A-fallback check
  on every participant address (so a typo like `you@gmaicom`
  surfaces inline rather than silently bouncing on activation). POST
  `/crypto` was only running that check on the initiator, leaving
  the declaration signer (the recipient) unchecked. Now declaration
  mode runs `checkInitiatorMx` on the signer too — same helper, same
  rules. Attestation has no recipient at creation time so nothing
  changes there.
- **PRD §6.1 updated** to drop the stale "same-session shortcut"
  bullet (removed in an earlier change but never reflected in the
  spec) and document the Mode-B-pending-access behavior.

### Crypto reply acks — type-aware subject + body

Crypto event replies (`event+<id>@`) were going through the workflow
ack template, which expects a step name + `[N/M]` counter. Since
crypto events have no steps, the subject came out as
`[gitdone] Accepted — <title> — null` and the body opened with
`Your reply for "null" on event "<title>" was accepted.`. Five branches
(accepted, `missing_attachment`, `event archived`, `event not
activated`, `event closed`) all need to know whether they're handling
a workflow or crypto event.

- **Declaration accepted.** Subject `[gitdone] Signed — <title>`;
  body says "Your signature on Crypto Declaration "<title>" was
  accepted… The declaration is now final and the audit trail is
  sealed."
- **Attestation accepted (partial).** Subject `[gitdone] Attestation
  reply recorded — <title>`; body shows
  `Replies so far: <K>/<threshold>` so the signer knows where the
  count stands.
- **Attestation accepted (threshold).** Subject `[gitdone]
  Attestation complete — <title>`; body confirms
  `Threshold reached (<threshold>). The audit trail is sealed.`
- **Rejection paths** (`missing_attachment`, archived, not-activated,
  closed) drop the step + counter, swap "this event" / "the event"
  copy for the right Crypto Declaration / Crypto Attestation label,
  and use `Requester` instead of `Organiser` where appropriate.
- **`docs/01-product/email-formats.md`** entries 4–8 split into
  workflow / declaration / attestation tables with the new subject
  templates and a verbatim accepted-body sample for each crypto mode.

### Step delivery error resets on participant edit

A failed delivery (DSN bounce, sendmail error) pinned
`step.last_send_error` to the step. Editing the participant email is
the organiser's fix attempt, but the stale error stayed until the
renotify either succeeded (cleared it) or failed (rewrote the
timestamp). Either way the dashboard read "delivery failed" the whole
time, so "did my fix land?" was indistinguishable from "did the new
send fail too?". `editEvent` now drops `last_send_error` inline when
a participant field changes — the re-notify that fires next either
keeps it cleared (success) or records a fresh error with a new
timestamp (failure). Edits to other fields (deadline, attachment,
details) leave the error untouched: those don't change who's being
mailed.

### Crypto pending-activation parity, dated 72h auto-delete, typed manage title

Crypto events go through the same pending-activation pipeline as
workflow events (72h TTL, magic-link required even when signed in,
24h-before-deletion nudge — none of that changed in the sweep or
event-store), but the dashboard rendered them as if they were already
live. Three small surface changes close the gap:

- **Pending crypto bodies flag pending state inline.** Declaration
  now reads `Signer: <addr> — will be invited on Activate` and
  `Reply address (goes live on Activate): event+<id>@…`, with no
  `Status: awaiting signature` line until activation. Attestation
  reads `Reply address (goes live on Activate): …` with no
  `Replies received` line. Activated events render as before.
- **Dated auto-delete.** The pending-activation banner used to say
  "lapses on its own at 72h" — relative and easy to miss. Now
  computes `created_at + 72h` and shows `auto-deleted YYYY-MM-DD
  HH:MMZ if not activated` so the organiser knows the exact window.
  `renderCheckYourInboxPage` (post-create) gets the same treatment.
- **Typed `/manage/event/:id` title.** Was always `manage —
  <title>`; now `manage event — <title>` for workflows, `manage
  declaration — <title>` for declarations, `manage attestation —
  <title>` for attestations. Layout's auto-derived page-header
  picks this up so the breadcrumb at the top distinguishes types
  when multiple tabs are open.
- **Crypto declaration: signer must differ from initiator.** A
  declaration's whole purpose is third-party signing; the form
  used to allow self-signatures. `validateCryptoEvent` rejects
  case-insensitive matches with "signer must be different from
  the requester (you can't self-sign a declaration)". Attestation
  unaffected (anonymous-allowed mode is legitimate self-contribution).

### Mobile responsive pass — landing, create form, dashboard

Five fixes batched as one viewport-aware pass; all CSS-only with one
`data-label` markup tweak. Targets 375px and up.

- **Landing.** Decorative yellow corner badge clipped the kicker +
  wordmark on narrow viewports — hidden below 640px (pure chrome).
  "Manage your events & crypto ▸" was wrapping mid-link, leaking the
  arrow onto the next line — `white-space: nowrap` on the link.
- **Create event.** Step rows collapse into a 2-line grid card
  on ≤540px: row 1 is name (2fr) + email (3fr — full address visible
  for typo-checking) + remove ×; row 2 is date (matches name width)
  · deps + checkbox (share email's column). Inputs get visible borders
  on mobile so controls read as discrete fields. Submit centred via
  `display:block; margin: 1.1rem auto 0`.
- **Preview/confirmation.** "Confirm & send invites" + "← Go back to
  edit" share the row 50/50 on ≤540px instead of wrapping awkwardly.
- **Dashboard.** Action row (Activate / Edit / Close event)
  centred via `justify-content: center; flex-wrap: wrap`. JS
  `confirm()` popups for Activate and Close replaced with a
  full-width inline callout below the buttons row showing the
  warning + `Yes, …` submit + Cancel; opening one swaps which
  callout is visible. Steps table uses the standard responsive-
  table pattern: thead hides on mobile, each row stacks as a card
  with `data-label` attrs prefixing values (e.g. `DEADLINE:
  2026-06-06`); auxiliary rows (delivery-failed callout, rejection,
  details) span full card width.

### Email-formats catalog

`docs/01-product/email-formats.md` — single-page reference for every
email gitdone sends. Twenty entries covering sign-in, invitations,
reply acks, organiser receipts, sweep nudges, initiator commands,
verification reports — each with trigger, recipient, subject template
and body shape. A "Worked example" section walks an end-to-end 2-step
workflow (with attachment + deadline) showing verbatim subjects and
bodies for activation receipt → first invite → accepted ack →
step-progress update → cascaded second invite → completion notice,
plus the `remind+` and two-step `close+` scenarios. Subject grammar
conventions documented at the bottom.

Linked from `docs/README.md`.

### close+ two-step confirm

Closing an event is irreversible — it writes a final completion
commit and notifies every participant. A single DKIM-authenticated
reply was enough to trigger it, which leaves no margin for an
autoreply, stale forwarded message, filter rule that strips +-tags,
or one-off compromised send. The fix is to require a second
deliberate authenticated action.

- **Email path (`close+<id>@`)** is now a two-step confirm:
  - Reply 1 records `pending_close = { token, expires_at }` on the
    event (TTL 30 min, 8 hex chars) and replies with the token plus
    instructions. **No completion commit.**
  - Reply 2, within the TTL, with `CONFIRM <token>` anywhere in
    subject or body (case-insensitive), commits the close.
  - Outstanding intent + reply with no token → reminds with the
    *same* token (does NOT reissue, so a stray re-send can't refresh
    the window). Wrong token → `token mismatch, retry`. Expired
    intent → fresh token.
  - New subjects for the in-between states:
    `[gitdone] close pending "<title>" — reply to confirm`,
    `[gitdone] close pending "<title>" — still awaiting confirmation`,
    `[gitdone] close pending "<title>" — token mismatch, retry`.
- **Web path (`/manage/event/:id/close`) unchanged.** The dashboard
  click + active session is its own confirmation; an email-style
  two-step would be wrong UX. Kept `executeClose()` as the immediate
  primitive for the web route; new `executeCloseRequest()` handles
  the email flow.

### Subject grammar — `[N/M]` step-progress, status snapshots, reminder tag, RFC 7505 null MX

A consistent grammar across every gitdone-originated subject so
inbox glance reads like a status update instead of a tag dump.

- **Step-progress notifications** to the organiser used to grow
  unboundedly with step count (named the just-completed step plus
  every newly-active downstream step). Now bounded:
  `[gitdone] "wedding" [2/12] step done · next active`. The ` · next
  active` suffix drops on fan-in waiting on parallel branches.
- **Stats / remind / close receipts** to the initiator follow the
  same shape (replacing the opaque `[gitdone] stats · <id>` form):
  - workflow: `[gitdone] <verb> "<title>" [<done>/<total>] step done`
    (or `… complete` when finished).
  - crypto: `[gitdone] <verb> "<title>" — <mode> · <open|complete>`.
  - verb = `stats` | `reminded` | `closed`.
- **Participant reminders** carry a `"reminder"` tag so the MUA can
  distinguish a re-send from the original invite:
  - first invite: `[gitdone] wedding — audio [1/2] — your step`
  - re-send via `remind+`: `[gitdone] "reminder" wedding — audio [1/2] — your step`
- **RFC 7505 null MX rejection.** `checkInitiatorMx` only treated
  zero MX records as "no mail" — but a domain like `invmail.com`
  publishes a *null MX* (`0 .`) which Node returns as a single-
  element array, so the message went into the queue, no DSN came
  back, and the step sat forever. Pre-flight now detects null MX
  (priority 0, exchange "." or empty) and rejects with `domain
  refuses mail (null MX)`. Per RFC 7505 §3, no A-record fallback in
  this case. The existing zero-MX → A-record path is preserved.

### Deploy automation — `ops/deploy.sh` + `docs/04-process/deploy.md`

One script, no skip flags, runs every pre-flight check the runbook
spelled out by hand: clean tree, on `main`, pushed, lockfile tracked,
no `file:`/`link:`/`git:` deps, local Node major ≤ VPS Node major,
full test suite passes. Then loads the SSH key from `pass
gitdone/vps/ssh_key_federver` into `/tmp/gitdone-vps-key`, fetches +
checks out on the VPS, runs `npm ci --omit=dev` only when
`app/package*.json` changed, restarts `gitdone-web.service`, polls
`/health` and `/manage`, and appends one line to `ops/deploy-log.md`
(left uncommitted so it folds into the next functional change). Tests
are intentionally not skippable — there's no flag for that.

`docs/04-process/deploy.md` is the contract: every numbered step has
its actual shell command, why the check exists, what the failure
message looks like, and how to clear it. The expanded
`deployment.md §11` runbook stays for things the script deliberately
doesn't automate (initial install, Node major upgrades, DKIM rotation,
cert renewal). Linked from `docs/README.md` and `CLAUDE.md`.

### Discoverability — tier 1 head tags, robots.txt, sitemap.xml

Privacy-led SEO per `docs/04-process/privacy-seo.md`. The web is
declarative-machine-readable in its 1995 form; refusing the static
head tags and sitemap files is leaving signal on the table without
gaining any privacy.

- **Head tags via `layout()`** in `app/src/web/templates.js` — every
  page now emits `<meta name="description">`, `<meta name="theme-
  color">`, `<link rel="canonical">` (when supplied), the OpenGraph
  quintet (`og:type`, `og:site_name`, `og:title`, `og:description`,
  `og:url`), and `twitter:card`. Optional fields default safely so
  the 20 existing call sites are unchanged. Routes that should be
  indexed (`/`, `/events/new`, `/crypto/new`, `/manage`) pass a
  description and canonical; transactional routes inherit the
  default description. No JSON-LD (skipped on principle); no
  og-card.png yet (design task; unfurl falls back to title +
  description).
- **`/robots.txt`** — `User-agent: *`, `Allow: /`, `Disallow:` for
  the session-gated paths (`/manage/event/`, `/manage/callback`,
  `/manage/verify`, `/events/` — the per-event audit viewer), with
  `Allow: /events/new` to restore the create form since longest-
  match wins for Google. References the sitemap.
- **`/sitemap.xml`** — lists exactly the four indexable URLs with
  `<changefreq>weekly</changefreq>`. Per-event audit pages are
  deliberately absent.
- **Audit:** the page source has no analytics scripts (`gtag`,
  `plausible`, `fathom`, `umami` etc.), no third-party JS, no
  tracking cookies — verified by integration test.

### Organiser visibility — activation summary, per-step progress, MX pre-flight on participants

Three changes that close the "I can't tell from email tracking what's
actually live" gap. Until now, the only feedback after pressing
Activate was a green flash on the dashboard, and a participant typo
like `ahf@y.com` could sit on `○ pending` forever if the receiving
MTA black-holed the message without returning a DSN.

- **Activation confirmation email.** After `/activate` succeeds, the
  organiser receives `[gitdone] "<title>" — activated, N invitations
  sent` listing every step with a `▸` marker on the steps participants
  are currently waiting on (the DAG roots), plus per-recipient
  delivery status from the participant sends. Awaited inside the
  handler so the 303 doesn't race the SMTP submission.
- **Per-step progress email.** When a reply lands and unblocks a
  downstream step, the cascade in `receive.js` now also emails the
  organiser `[gitdone] "<title>" — step N done, step M now active`.
  When the *final* step completes the cascade is naturally short-
  circuited, so `notifyEventCompletion` was extended to surface
  `Final step: #N "<name>" by <participant>` in the organiser body —
  no transition is silent.
- **MX pre-flight on workflow participants.** `checkParticipantsMx`
  reuses the existing `checkInitiatorMx` (DNS MX → A/AAAA fallback per
  RFC 5321 §5.1) and runs it against every step's participant at
  confirm time. Failures merge into the same in-form error list as
  organiser MX failures. Honours `GITDONE_SKIP_MX_CHECK=1` for the
  offline integration suite. The DSN handler stays — it's still the
  right backstop for real bounces from real domains.

Smaller fixes alongside:

- **Subject-header CR/LF guard.** `outbound.buildRawMessage` now
  strips `[\r\n]` from Subject headers (`sanitizeSubject`). Title
  validation only trims whitespace, so this is the second line of
  defence at the boundary that emits the message.
- **Pending-activation banner readability.** The dashboard banner's
  `<strong>` rule was `display:block`, splitting "Activate" /
  "Close event" onto their own lines mid-paragraph. Heading moved to
  a `.title` span so inline emphasis stays inline.

### Bounce handling — synchronous send failures and DSN parsing surface on dashboard

The organiser used to find out a participant address was wrong only
when the step quietly stayed pending forever. Two paths now make
delivery problems visible:

- **Synchronous failures** — when `sendmail(8)` exits non-zero (bad
  pipe, MTA misconfig, etc.), `notifyWorkflowParticipants` records a
  per-step `last_send_error: { reason, code, at }` on the event. A
  successful retry clears it. Persistence runs under the same
  per-event mutex as activate / edit so it can't lose to a
  concurrent edit.
- **RFC 3464 DSN parsing in `receive.js`** — when a downstream MTA
  returns a multipart/report bounce, gitdone detects it before the
  prefilter rejects mailer-daemon, parses the delivery-status part,
  reads `Original-Recipient` to find the failed `event+id-step@` tag,
  and stamps `last_send_error: { reason: 'bounced', code, diagnostic,
  final_recipient, at }` on the bounced step. The organiser also gets
  a plain-text alert email summarising the bounce and linking back to
  the dashboard.
- **Dashboard surfacing** — open steps with `last_send_error` render a
  `⚠ delivery failed` row beneath the row, mirroring the existing
  `mg-reject-row` pattern. The organiser can use Edit to fix the
  address; once the fix re-notifies successfully, the flag clears.

New module `app/src/dsn.js` parses RFC 3464 multipart/report messages
(falls back to splitting the multipart body from raw bytes because
mailparser folds the delivery-status part into `parsed.text`). Tests:
unit coverage of the parser, integration coverage of the dashboard
surfacing, and end-to-end pipe tests that feed a Postfix-shaped DSN
through `receive.js`.

### Activation email — richer step preview and explicit two-stage wording

The Mode A magic-link email is now self-contained enough that the
organiser can decide whether to activate without leaving their inbox,
and explicit enough that "did clicking the link already activate?"
isn't a question anyone has to ask.

- **Per-step block** carries deadline, `attachment required`, and
  `after #N` dependency tags inline; a `brief:` line under each step
  shows the first 80 chars of the step's `details` when present. With
  50 steps × full metadata the body would blow knowless's 2048-char
  cap, so the builder caps the inline list at ~1200 chars and appends
  `… and N more steps (open the dashboard for the full list)` —
  truncation is rare in practice but the email never silently fails
  to send.
- **Two-stage wording** — "Clicking the link signs you in and opens
  the event dashboard. Review the steps below, then press Activate to
  send invitations. Nothing leaves the server until you press
  Activate; if you decide not to go ahead, just ignore this email."
  Replaces the older "click to sign in, you'll see a one-click
  confirmation" copy that left readers unsure whether they'd already
  fired anything off.

The crypto activation email got the same wording lift.

### Organiser email — pre-flight + in-form bolden + DSN cleanup

`EMAIL_RE` only checked syntax; typos like `you@gmaicom` (missing
`.com`) sailed through, the activation magic-link bounced silently,
the user got nothing, and the pending event sat for 72h before
auto-deletion. Three layers now close the silent-failure gap:

- **Pre-flight MX check** in POST `/events` and POST `/crypto`.
  `dns.resolveMx(domain)` runs after validation — falls through to
  an A/AAAA fallback per RFC 5321 §5.1, fail-soft on transient
  resolver errors. If the domain has nothing (no MX, no A record),
  re-renders the form with an inline error: *"organiser email
  'you@gmaicom' — domain does not resolve. Did you mean a different
  domain?"*. Catches every typo where the TLD or domain itself is
  fictional. Skipped in tests via `GITDONE_SKIP_MX_CHECK=1`.
- **Bold preview email + double-check hint.** The preview-before-
  confirm page now renders the organiser email in amber on dark
  with `font-weight:600` and a "double-check this; the activation
  link goes here" hint beside it. Catches the typo eyeball-class
  (real domain, wrong username) before the user presses Confirm.
- **DSN-driven cleanup of bounced initiators.** The Phase D bounce
  handler now does a second pass: any failed DSN recipient that
  doesn't match an `event+id-step@` tag is matched against pending
  events' initiator addresses. If found, the pending event is
  deleted on the spot — the activation link can never reach the
  user, no recovery is possible in Mode A, no point letting the
  corpse sit until 72h. Activated events keep their record (audit
  trail is permanent regardless of the initiator address state).

### Activation gate — dashboard sits behind the magic-link click

The same-session shortcut (PRD §6.1) used to skip the email
round-trip when the requester was already signed in as the initiator,
303-ing them straight to the dashboard with the Activate button live.
That turned the email-ownership receipt into something the same tab
could bypass — pressing Confirm and immediately pressing Activate
took zero email round-trips.

Closed by:

- **Removing the same-session shortcut.** POST `/events` and POST
  `/crypto` always render the check-your-inbox page after creation,
  regardless of session.
- **Per-event ack token.** Every new event carries a
  `activation_ack_token` (16 random bytes hex). knowless's
  `nextUrl` for the activation magic-link is
  `/manage/event/<id>/confirmed?t=<token>`. The new
  `confirmActivationLink` function validates the token (constant-time
  compare under the per-event mutex), flips
  `event.activation_link_clicked_at`, and clears the token (single-use).
- **Dashboard renders check-your-inbox until the click.** GET
  `/manage/event/<id>` for a pending event with no
  `activation_link_clicked_at` returns the inbox view (steps queued
  + numbered flow + 72h expiry note), not the dashboard. Even a
  signed-in initiator who types the URL directly sees this until the
  email is confirmed.
- **POST `/activate` refuses without the click.** Belt-and-braces with
  the dashboard hiding the button — a forged POST from a signed-in
  session 303s back with `?activate_blocked=1` and no participants
  are notified.

Activation tests now click `/confirmed?t=<token>` before posting
`/activate`, which exercises the real flow rather than the prior
shortcut.

### Pending dashboard — consolidated read-only create view; close = delete

The pending-activation dashboard used to be a hybrid: a separate
"pending activation" banner, a live steps table that had nothing live
to show, and an action row where Edit was the only enabled button.
Now it's one consolidated view: the same workflow form the organiser
filled in, rendered read-only via a new `viewOnly` mode in
`renderWorkflowForm`. Action row carries Activate / Edit / Close
event so the organiser can act without navigating.

`Close event` now also works on pending events, where it deletes the
event JSON and any per-event repo (the same operation the 72h sweep
would do later). No completion commit, no participant notifications —
nothing was ever sent. The active-event close path is unchanged
(writes a "closed early" completion commit). Confirmation prompts
distinguish the two cases.

`/manage` shows a transient flash on the dashboard hub when an event
was deleted: *Cancelled "<title>". The event was deleted; nothing was
sent.*

### Activation reminder — 24h before pending events lapse

Pending events get deleted at 72h by `sweepPendingActivation`. They
now get a one-shot reminder email 24h before that. The hourly sweep
runs a new `findPendingActivationNudge` pass first (before the
deletion pass so the event still exists), emails the organiser
(`[gitdone] "<title>" — activate within Nh or it expires`), and stamps
`event.nudged_pending_activation_at` so each event nudges exactly
once. No-op for already-activated events.

### Activation email body — single signature

knowless appends the configured `bodyFooter` (with the standard `-- `
delimiter) after a `bodyOverride` returns. The activation builders
were also calling `withSignature(...)` themselves, producing two
back-to-back signature blocks in every magic-link email. Fixed by
dropping the second wrap; knowless's append is the only signature now.

### Standard signature — drop redundant `Feedback:` label

Footer line 4 was `Feedback: feedback@git-done.com`. The address
already says it; lowercase `feedback@git-done.com` alone is enough.

### Identity alias — lowercase `gitdone` everywhere user-facing

Per PRD §"Findings from Phase 1" point 25 ("identity aliases are
lowercase `gitdone`, not `GitDone`"), but the `From:` display name was
still capitalised `GitDone`, the knowless factory subject said
`Sign in to GitDone`, and three subject prefixes in `receive.js`
(verify report / reverify report / initiator-command reply) carried
`[GitDone]` instead of `[gitdone]`. Mail clients (Gmail in particular)
treat `[gitdone]` and `[GitDone]` as separate sender aliases, so users
saw the same gitdone instance fragmented across multiple inbox
groups. Now consistently lowercase across:

- `From: gitdone <gitdone@git-done.com>` on every magic-link email
- `Subject: Sign in to gitdone` (knowless factory subject)
- `Subject: [gitdone] verification report …`
- `Subject: [gitdone] re-verification report …`
- `Subject: [gitdone] <command> · <event-id>` (initiator commands)
- `gitdone verification report` / `gitdone re-verification report`
  report-body headings
- "verified offline without contacting gitdone" outbound copy
- knowless `confirmationMessage` ("events on gitdone")

The activation subject also got reshaped from `[gitdone] activate
"<title>"` (verb before title) to `[gitdone] "<title>" - activate`
(verb after title) so it matches the same `[gitdone] "<title>" -
<verb>` shape that completion / bounce / please-sign etc. already use
— additional alias-grouping nicety in clients that key off subject
prefixes. ASCII hyphen because knowless's `validateSubject` is
ASCII-only.

`X-GitDone-*` HTTP-style header names stay PascalCase (header
convention, not user-facing identity).

### Sign-in page — back link

`GET /manage` (sign-in form when signed-out) now carries the same
`← back` link to `/` that every other secondary page has. Prior gap;
no functional change.

### Form — drop the dimmed-deadline visual hint

The workflow create / edit form used to render `step_deadline` at
opacity 0.55 when the row had a `depends_on` value, intending to
signal "soft cap on top of an implicit dep wait". In practice it
read as "field is disabled". The opacity is gone; the tooltip
("Optional — step already waits for its dependencies. Set only if
you need a wall-clock cap.") still carries the meaning for anyone
who hovers.

### Outbound email — unified `From`, standard signature, `feedback@` inbox

Every outbound message now has the same sender identity and a single,
truthful signature describing what gitdone does and does not store.

- **`From: gitdone@git-done.com` everywhere.** Knowless magic-link
  emails switch from `noreply@` and the operator-alert pipeline
  switches from `alerts@`. Notifications, sweep nudges, weekly
  digest, and completion emails were already on `gitdone@`.
  Per-event reply-routing addresses (`event+id-step@`,
  `verify+id@`, etc.) are unchanged — they're routing tags, not
  identity.
- **Standard signature on every gitdone-composed body.** Plain
  ASCII, RFC 3676 `-- ` delimiter, four lines:
  *"gitdone — we don't store email bodies or attachments; those
  go to the organiser. We keep DKIM proof, a SHA-256 hash of each
  message, and an OpenTimestamps anchor so the record is
  tamper-evident. Feedback: feedback@git-done.com"*.
  Wired via `outbound.js` `withSignature()` (auto-applied in
  `buildRawMessage`, `noSignature: true` opt-out for forwarded
  participant mail), via explicit wrap on the two activation
  builders in `server.js`, and via knowless's `bodyFooter` config
  for the Mode B sign-in email.
- **New alias `feedback@git-done.com` → operator inbox.** Tracked
  in `ops/postfix/virtual` and live in production. Published in
  the signature so recipients have a discoverable channel.
- Phrasing audit: the signature deliberately says **SHA-256** and
  **DKIM proof**, not "HMAC". gitdone uses unkeyed SHA-256 for
  content hashes and DKIM for sender-side signatures; calling that
  "HMAC-protected" would be inaccurate.

### Participant email body — surface attachment + aspirational date

Workflow-step invitations now render `Attachment: required` and
`Aspirational date: <weekday>, <YYYY-MM-DD>` in the metadata block
above the reply-to line, so participants see both before the fold.
Drops the verbose soft-deadline disclaimer; the friendlier wording
("aspirational") carries the meaning. Date renders in UTC so the
weekday matches the calendar date the organiser picked.

### UI — page-intro consistency

`/events/new` and `/manage` now carry the same "← back" + one-line
description pattern as `/crypto/new`. First-time visitors see a
statement of what the page is for before any form or list.

### Deployment runbook — pre-flight + Node-major upgrade

Codifies the lessons from the 1.H.6 ship: `app/package.json` had a
`file:` dependency that only resolved on the maintainer laptop,
`package-lock.json` was repo-wide gitignored, and the new dep
required a Node major (≥22.5 for `node:sqlite`) the VPS hadn't been
upgraded to. `docs/04-process/deployment.md` §11.1 adds three
pre-flight checks (no non-registry deps, lockfile is tracked,
`engines.node` ≤ VPS node major); §11.4 documents the AlmaLinux
module-stream switch with the NodeSource-conflict workaround.
Production was migrated Node 20 → 22.22.2 during this cycle.

### Auth — knowless Mode A integration; activation collapses into sign-in

GitDone's email-verification machinery is now provided by `knowless`
(MIT, the operator's own minimal magic-link library). The branch
deletes ~730 lines of bespoke auth code by replacing two parallel
systems — `app/src/activation-token.js` (72h activation tokens) and
`app/src/magic-token.js` / `app/src/magic-session.js` (legacy 30d
management URLs) — with one knowless flow.

- **One email per event creation, not two.** The old activation
  email + management-link email collapse into a single knowless
  magic link. Clicking it (a) verifies the initiator's email, (b)
  opens a 30-day session cookie, and (c) lands on the event's
  dashboard. The dashboard's first-visit handler activates the
  event server-side and fires participant notifications. Knowless's
  GUIDE.md calls this "Mode A — do the thing, confirm by email";
  see `docs/01-product/prd.md` §6.5.
- **No `/activate/:token` route any more.** Old links from in-flight
  pre-deploy emails 404; gracefully degraded since this branch
  hasn't shipped yet.
- **Self-serve dashboard at `/manage`.** Returns the session hub
  for signed-in initiators, otherwise the sign-in form. Magic-link
  callback is `/manage/callback`. Logout 303s back home. No more
  per-event `/manage/:token` URLs — old bookmarks redirect to the
  hub for graceful migration.
- **`auth.startLogin` is called with `bypassRateLimit: true`**
  (knowless AF-10) — gitdone is the trusted server-side caller.
  Per-IP new-handle limiting belongs at gitdone's POST /events
  layer, not at the magic-link send.
- **Dashboard activation is concurrent-safe.** A per-event
  in-process mutex in `event-store.activateEvent` guarantees that
  N parallel dashboard visits to a pending event activate exactly
  once and fire participant notifications exactly once
  (regression test in `tests/integration/web-notifications.test.js`).
- **Operator config:** `GITDONE_SESSION_SECRET` (64 hex chars) is
  required; `GITDONE_PUBLIC_URL` and `GITDONE_COOKIE_SECURE` must
  agree on scheme — boot fails loudly if `https` is paired with
  `GITDONE_COOKIE_SECURE=0` (or vice versa). Production is already
  provisioned per CLAUDE.md.
- **UI/UX:** every sub-page now carries a `g/ <page>` header,
  redundant `<h1>` titles dropped, sub-pages get a `← back` arrow
  to the parent. Dashboard footer adds `← back · home · sign out`.
- **Local dev:** `npm run dev` (in `app/`) starts the server with
  a persisted dev session secret, dev-mode magic-link printing to
  stderr, and a fake sendmail that captures emails to
  `app/data-dev/mail/`.

### Operator stats — counters, daily log, weekly digest

Privacy-safe aggregate counts of how gitdone is being used. Computed
on demand by walking `events/*.json`; no PII leaves the box.

- **`app/bin/stats.js`** — CLI prints unique organisers, unique
  recipients (named participants only — attestation senders are
  anonymous-by-design and excluded), events by type/status,
  completed-vs-incomplete, workflow step totals, attestation reply
  totals. JSON to stdout, human table to stderr.
- **`--diff` flag** reads the most recent line of
  `/var/log/gitdone/stats.log` and adds a Δ column showing how each
  counter has moved since.
- **Daily JSONL log** via `gitdone-stats.timer` (04:30 UTC) appends
  one snapshot per day to `/var/log/gitdone/stats.log`. JSONL so
  `tail | jq` works without ceremony.
- **Weekly digest email** via `gitdone-stats-weekly.timer` (Mondays
  06:00 UTC) groups daily snapshots by ISO week, takes the latest
  in each, and emails the last 4 weeks as a compact week-over-week
  table to `GITDONE_STATS_RECIPIENT` (default
  `avoidaccess@gmail.com`).
- Cleaned up `demo123` legacy debug fixture from prod data.

### Status taxonomy: split "complete" into `completed` vs `closed early`

Terminal state was previously a single bucket labelled "complete",
which hid a real distinction: events that ran their full course
(every step replied) vs. events the organiser cut short with work
still pending. Now:

| State               | Meaning                                              |
|---------------------|------------------------------------------------------|
| `completed`         | Every step ran its full course. Natural finish.      |
| `closed early`      | Organiser ended it (close-command or dashboard) with steps still pending. |
| `archived`          | Auto-archived after 45d idle. Reversible.            |
| `pending activation`| Never activated by the organiser.                    |
| `open`              | In flight.                                            |

Updated everywhere a status surfaced:

- **Session /manage hub:** pill + row-summary split (row reads
  "1 of 2 complete · closed early 2026-04-20" instead of the
  misleading "completed" label). Top counts strip grew a
  "N closed early" chip that only appears when there are any.
- **Completion notification email:** subject is
  `[gitdone] "<title>" — closed early` vs `… — completed`. Body
  greeting matches ("has been closed" vs "has completed"). Reason
  line kept readable ("closed early by the organiser").
- **Participant success ack:** the final-reply case now says
  *"the event is marked completed"* instead of *"the event is
  closed"* (which overloaded the new "closed early" meaning).

---

## [Phase 1 — lifecycle sweep: GC, nudge, auto-archive] — 2026-04-20 (night)

Events have a real lifecycle now. Before this, abandoned events sat on
disk forever and organisers had no feedback when a workflow went idle.
An hourly systemd-driven sweep runs three passes; all thresholds
env-tuneable.

### Shipped

- **72-hour pending-activation GC.** Events created but never activated
  are deleted after `GITDONE_ACTIVATION_TTL_HOURS` (default 72). Stale
  activation tokens are orphan-swept in the same pass. Keeps the
  impersonation-attempt surface from piling up as zombie records.
- **Day-14 overdue nudge.** Active events past their **reference clock**
  by `GITDONE_OVERDUE_NUDGE_DAYS` (default 14) get ONE email to the
  organiser — *"N days past deadline, still waiting on: X, Y; options
  are remind / close / ignore."* Idempotent via a new
  `event.nudged_overdue_at` field; we persist the flag **before** the
  send so a crash-mid-send doesn't cause a repeat nudge next tick.
- **Day-45 auto-archive.** Same cohort gets archived at
  `GITDONE_ARCHIVE_DAYS` (default 45). Archive is reversible:
  `event.archived_at` is set, repo + proofs untouched, replies still
  commit for the audit trail but stop counting. Organiser gets a
  heads-up email with a pointer to un-archive. Never auto-complete —
  completion writes a permanent commit we can't undo.
- **Reference clock.** The "how stale is this event?" measure is
  `max(deadline over pending steps)` when any step has a deadline,
  else `event.activated_at`. So deadline-less events still age out —
  counted from when they actually went live, not from when the form
  was filled.

### Dashboard

- Grey **"archived"** pill (distinct from amber "pending activation"
  and blue "open" and green "complete").
- Inline banner explaining the archive reason + date with an inline
  **Un-archive** button that `POST`s `/manage/:token/unarchive`.
- Send-reminders + Close-event disabled while archived.
- Completion takes priority over archive in the pill: closing an
  archived event cleanly shows "complete."
- **Session `/manage` hub hides archived by default.** The signed-in
  event list now shows only active events; archived ones are hidden
  behind a "show N archived" toggle (`?show=archived`). The empty
  state gets a direct link to the archived list when it exists. Each
  archived row shows its archive date inline.

### Completion engine + receive.js

- `shouldCountWorkflow / Declaration / Attestation` all gate on
  `!event.archived_at` with `reason: 'event archived'`.
- receive.js auto-reply grew a fifth branch: *"This event has been
  archived… Your reply is recorded in the audit trail but not counted.
  If this is unexpected, reach out to the organiser — they can
  un-archive from their dashboard."*

### Ops

- **New systemd units:** `ops/systemd/gitdone-sweep.{service,timer}`
  — hourly, `OnBootSec=10min`, `Nice=10`. Installed into
  `/etc/systemd/system/` on the VPS. Log line per tick goes to the
  journal alongside the rest of gitdone.
- **Dry-run support:** `node app/bin/sweep.js --dry-run` prints what
  would happen without persisting or sending.

### Principles

- **Never auto-complete.** Archive, not close. Completion is a commit
  we can't take back; archive is a toggle. Matches the soft-deadline
  stance (human deadlines are aspirational; enforcement stays manual).
- **Proofs outlive the dashboard record.** Sweep only touches
  `event.json` + bookkeeping tokens. Git repos and OTS proofs are
  never altered or deleted — a sweep-archived event still verifies
  offline exactly like an active one.

### Tests

- 348/348 passing (up from 340). New `tests/unit/sweep.test.js`
  covers all three passes plus the archive gate in the completion
  engine.

---

## [Phase 1 — activation gate + completion loop] — 2026-04-20 (late evening)

End-to-end flows are now closed: (a) event creation can no longer spam
strangers — the organiser must prove email ownership before any
invitation goes out; (b) every reply produces a signal back, whether
accepted or rejected; (c) events tell everyone who participated when
they complete.

### Shipped — security / spam

- **Activation gate.** Creating an event (workflow or crypto) persists
  it in `pending_activation` state with `activated_at: null`. No
  participant notifications fire and no replies count until the
  initiator clicks a 72-hour **single-use** activation magic link
  sent to their own inbox. Closes the impersonation/spam vector
  where anyone could type a victim's email as initiator and
  immediately blast notifications to named participants.
  - New token type: `activation_tokens/` (32-hex, 72h TTL, deleted
    on consume). Carries the 30-day management token so one click
    both activates and redirects into the management dashboard.
  - New route: `GET /activate/:token`. Single-use — clicking twice
    returns a clean 404.
  - Activation email unifies the two outbound-at-create messages
    into one: the activation URL (72h) AND the management URL (30d).
  - If the email send fails, the activation URL surfaces on the
    confirmation page so the organiser can still kick it off.
  - Receive path: replies to a pending-activation event still commit
    for the audit trail but don't count. Participant gets a
    DKIM-signed auto-reply explaining the event isn't live yet.
  - Dashboard visible state: amber "pending activation" pill, inline
    banner explaining what to do, `Send reminders` and `Close event`
    buttons disabled until the event is activated.

### Shipped — silence-is-a-bug symmetry

- **Participant success ack.** Every accepted step reply now gets a
  threaded DKIM-signed auto-reply: *"Your reply for 'X' on event 'Y'
  was accepted. The step is marked complete."* If the reply
  completed the whole event, the body changes to *"All steps are
  now complete; the event is closed."* Closes the "did my reply
  work?" anxiety loop. Threaded via In-Reply-To so it lands under
  the existing conversation rather than starting a new one.
- **Event completion notification.** On every transition to complete
  (all steps done, declaration signed, or organiser close via
  email-command OR dashboard), a plain-text DKIM-signed summary
  goes out to the organiser AND every distinct participant. Subject:
  `[gitdone] "<title>" — complete`. Body names the reason, lists the
  steps with statuses, and reminds readers that the repo outlives
  the service and verifies offline with `gitdone-verify`.

### Shipped — UI polish

- **Soft-deadline wording.** Participant invite emails now spell out
  *"(soft — replies after this date are still counted, but the
  organiser will be notified if your step is overdue.)"* Form hint
  and column tooltip match. No behaviour change — just closes the
  anxiety gap around whether a missed deadline invalidates a late
  reply. PRD §6.1 grew a matching "Deadline semantics (soft)"
  subsection.
- **Management dashboard header cleanup.** The stray `<span class=
  "num">1</span>` prefix on the single section heading was reading
  as "1 Steps 2 of 2 complete" — confusing when there's only one
  numbered section. Dropped on all three variants (Steps,
  Declaration, Attestation).

### PRD

- §5.2 explicitly documents Reply-To as the authoritative routing
  header on participant invites. The previous wording described it
  in the sample template; now it's a stated invariant the outbound
  code must preserve.
- §6.1 gains a **Deadline semantics (soft)** sub-section making the
  aspirational-vs-enforcement distinction explicit.
- (Still TODO for a later commit: §6.1 / §5 should also document
  the activation gate as a first-class creation step, and the
  completion notification as part of §8.)

### Tests

- 340/340 passing (up from 335). New `tests/unit/activation-token.test.js`
  covers create/peek/consume/single-use/expiry. Existing integration
  tests updated to simulate the click-to-activate step via a new
  `activateAll()` helper that reads the tokens dir and GETs every
  pending `/activate/:token` — matches the real UX. Fixture
  objects gained `activated_at: '2026-01-01T00:00:00Z'` so the
  `shouldCount*` gate doesn't reject them.

### Principles reinforced

- **Silence is a bug.** Every reply produces a signal back to its
  sender; every transition that affects more than one person is
  announced to all of them. No hidden state, no "you'll never know
  what happened" outcomes.
- **Capability URLs are equivalent to the email that carries them.**
  The activation URL is as powerful as the account-control email
  it arrived in — which means we DON'T flash it on the browser
  confirmation page on success (would bypass email ownership
  proof), but we DO surface it when the send fails (the user who
  just typed their email at the form is the one who needs it).

---

## [Phase 1 — post-deploy UX tightening] — 2026-04-20 (evening)

Six same-day follow-ups to the morning launch, driven by the first real
end-to-end test. One of these (the Reply-To fix) is a **functional
correctness bug** that was masking every inbound reply pressed from
Gmail's Reply button. The rest are UX sharpening the launch exposed.

### Fixed

- **Reply-To on participant invites.** Outbound notifications now set
  `Reply-To: event+<id>-<step>@git-done.com` so mail clients route a
  Reply back to the per-step tag address instead of the generic
  `gitdone@git-done.com` From header. Without this, Gmail's Reply
  button landed replies on `gitdone@` — receive.js logged them with
  `routing.matched=false` and silently dropped them (no commit, no
  auto-reply). This was the participant-side silent-failure the PRD
  §5.1 template already described; the implementation had drifted.
  Declaration-signer invites get the same treatment.

### Shipped

- **Dashboard surfaces rejected replies per step.** A reply that
  commits for the audit trail but doesn't count (missing attachment,
  sender not a named participant) now renders a muted amber row under
  the step: *"↳ reply received from @domain · missing attachment ·
  not counted · 2026-04-20 16:17"*. Previously the step just sat
  "pending" with no signal the participant had engaged. Pulled from the
  per-event commits via a new `listCommits()` helper in `gitrepo.js`.
- **Remove-step button on the workflow form.** Each row gets a
  trailing × that splices it out. Hidden on the last remaining row
  (validation requires ≥1). Same GET-round-trip pattern as the
  existing "+ add step" button — no client JS.
- **Validation error box rethemed** to match the retro-terminal
  palette (charcoal bg, red left-border, muted grey list items).
  Previous `#fee`/`#c99` inline styles rendered nearly white-on-
  charcoal — unreadable. Class now lives in both `WORKFLOW_FORM_CSS`
  and `CRYPTO_FORM_CSS`.
- **Deadline semantics made explicit.** Participant invite emails now
  spell out *"soft — replies after this date are still counted, but
  the organiser will be notified if your step is overdue."* Form
  column tooltip + step-section hint match. No behavioural change —
  just closing the anxiety gap around whether a missed deadline
  invalidates a late reply. (It doesn't, and never did.)

### Removed

- **"Read-only view" link** on the management dashboard. Became
  redundant after the dashboard itself started rendering full event
  metadata (steps, participants, deadlines, details) and after
  `/events/:id` got session-gated to stop leaking participant emails.
  The dashboard supersedes it.

### Design / product principles reinforced by this session

- **Silence is a bug.** A reply that arrives should never produce
  zero signal — to the participant, to the organiser, or in the audit
  trail. The Reply-To bug, the dashboard-no-reject-indicator gap, and
  the "deadline sounds like enforcement" confusion all traced to
  violations of this.

### Tests

- 335/335 passing. No new test files; the existing suite caught all
  regressions from the Reply-To change (11 integration tests exercise
  the full notify→reply→commit flow).

---

## [Phase 1 — production deploy + UX polish + self-serve auth] — 2026-04-20

First public deploy to **https://git-done.com**. The site is now live;
everything in this entry is observable in a browser today.

### Shipped (visible to users)

- **https://git-done.com is live.** Fedora/AlmaLinux VPS running
  vanilla Node behind nginx + Let's Encrypt; Postfix pipe-transport +
  opendkim for mail; systemd units for web, OTS upgrade, and health
  checks. Apex DNS record added.
- **Retro-terminal visual theme** site-wide — JetBrains Mono,
  charcoal background (`#0d1117`), phosphor green (`#3fb950`) for
  actions, amber (`#ffb000`) for emphasis/links. Replaces the prior
  Wikipedia-style form layout on all pages (landing, event form,
  crypto form, management dashboard, preview, success pages).
  Frozen at `docs/01-product/design/terminal-theme-v1.md` with five
  invariants and a palette token reference.
- **`g/` favicon** — minimal SVG wordmark, matches the landing
  wordmark at tab scale.
- **Self-serve sign-in** at `/manage` (PRD §6.2 Path B): enter email
  → 15-min single-use magic link → 30-day signed session cookie →
  dashboard listing every event and crypto record organized by that
  email. Per-event 30-day management tokens continue to work in
  parallel.
- **Preview-before-create** for workflow events (PRD §6.1):
  validated form submits to a server-rendered preview with flow prose,
  steps in topological order, confirm/edit buttons. No persistence
  until Confirm.
- **Flow prose renderer** — dependency graph → English on preview and
  success pages. Examples: *"Step 1 runs alone."* /
  *"All N steps run in parallel."* / *"Steps 1 and 2, then Step 3."*
- **Deadline-vs-dependency validation** — rejects deadlines that
  would make the DAG impossible (dependent step due before its
  dependency). Error names both step numbers and dates.
- **Friendlier crypto form** — header rewritten to "Create a signed
  record"; declaration/attestation modes each get plain-language
  subtitles; mode radio is a live-toggling pair of selectable tiles;
  "allow anonymous replies" gets an inline explanation.
- **Trust-level dropdown** labels expanded with plain-language
  explanations. Default stays `verified` — matches the product's
  core promise.
- **Landing page** copy leads with one-line purpose per mode
  (*"An auditable multi-party workflow."* / *"A cryptographically
  timestamped signature."*) before dropping into technical vocabulary.
  Dedicated "Manage your events & crypto" strip between header and
  CTAs.
- **Organizer email** shown on every success page (fixes prior
  missing-context gap on the post-create screen).
- **Date inputs** changed from `datetime-local` → `date` — users
  only need day-level granularity for workflow deadlines.

### Ops (invisible to users, critical to keep it running)

- **VPS health check** — systemd timer runs every 15 min; alerts
  `avoidaccess@gmail.com` on unit failure, API down, disk >80%,
  postfix deferred queue, journal errors, stale OTS stamps, TLS cert
  <14 days. Silent on green.
- **Home-server backup** — daily cron on federver (04:15 UTC) pulls
  from the VPS: `/var/lib/gitdone/{events,repos,magic_tokens}`,
  `/etc/letsencrypt/`, `/etc/opendkim/keys/` (irreplaceable), and
  `/etc/default/gitdone-web` (session secret). Rotates past 30 days.
  Pings a Kuma push monitor on success for heartbeat alerting.
- **Kuma monitors** — HTTP(s) on `https://git-done.com/health`
  (60s interval, external uptime watchdog) plus the backup push
  heartbeat (24h + 1h grace).
- **UptimeRobot-equivalent is Kuma on federver**, not a third party.
- **Installer** at `ops/homeserver/federver-install.sh` for
  one-shot setup on a new home server.
- **Deployment doc rewrite** (`docs/04-process/deployment.md`) for
  the actual stack (Fedora/AlmaLinux, vanilla node, Postfix pipe,
  nginx+certbot). Staging demoted to an appendix until we have real
  users.

### Security

- Session cookie: HMAC-SHA256 of `<b64url(email)>.<exp>`, verified in
  constant time. Self-contained; no server session store. Secret
  from `GITDONE_SESSION_SECRET` env (64 hex bytes in production,
  generated per-deploy and backed up in `pass gitdone/vps/session_secret`).
- Magic-link tokens are single-use: unlinked on first read, regardless
  of subsequent parse success. 32 hex chars = 128 bits entropy.
- `/manage` POST replies with the same "check your inbox" message
  whether or not the email has events — no account-existence oracle.

### Mail hygiene

- **RFC 2142 role addresses forwarded** — `postmaster@`, `abuse@`,
  `hostmaster@`, `security@` on both `git-done.com` and
  `mail.git-done.com` forward to `avoidaccess@gmail.com` via a
  Postfix `virtual_alias_maps` entry that runs BEFORE the `gitdone`
  pipe fallback. Required for deliverability-reputation services
  (Microsoft SNDS, Google Postmaster Tools) whose verification mail
  lands on these addresses. Config persisted at `ops/postfix/virtual`
  with installation steps in `docs/04-process/deployment.md` §6.1.
- **Microsoft SNDS active** — verified via `abuse@git-done.com`.
  Daily feedback on the VPS IP's reputation with Outlook/MSN/Hotmail
  recipients (complaint rate, spam-trap hits, throttling signals).
- **Google Postmaster Tools active** — monitors reputation with
  Gmail (spam rate, feedback loop, DKIM/SPF/DMARC pass rate, IP and
  domain reputation). Between the two services, deliverability to
  the major consumer inboxes is passively tracked.
- Both services are operator-side; no code change and no user-visible
  behaviour.

### PRD

- §6.1 rewritten: form mock-up reflects `depends_on` (not `flow`),
  preview-before-create documented, deadline-vs-dep validation rule
  stated.
- §6.2 rewritten: two-path management documented (per-event magic
  link + self-serve `/manage` sign-in), cookie details recorded.

### Tests

- 328 tests passing (up from 309 at Phase 1 feature-complete). Adds:
  8 for flow-prose, 8 for magic-session, 3 for deadline-vs-dep
  validation, integration helpers updated to exercise the two-step
  preview flow.

---

## [Phase 1 — 1.H.5 management dashboard] — 2026-04-19

Replaces the `GET /manage/:token` stub from 1.H.4 with the real
dashboard: progress view + two action buttons. Functionally a visual
mirror of the §6.4 email commands (email is still the primary
initiator UX per PRD §6.4; this is the fallback).

### Added
- Workflow dashboard: compact step table with #, step name,
  participant, depends_on list, per-step status (complete / pending /
  waiting-on-deps).
- Crypto dashboards: declaration shows signer + reply address +
  signed/awaiting; attestation shows threshold, dedup rule, anonymous
  policy, current reply count.
- "Send reminders" button → `POST /manage/:token/remind` calls
  `executeRemind` and 303-redirects back with `?reminded=1` flash.
- "Close event" button → `POST /manage/:token/close` with an
  in-browser confirm, calls `executeClose` + `commitCompletion`,
  writes `commits/completion.json` to the per-event repo, 303-
  redirects back with `?closed=1`. Buttons disable once complete.
- Email-fallback footer listing the `stats+/remind+/close+`
  addresses.
- 2 new integration tests (workflow dashboard render + step-table
  shape; full close-via-dashboard flow).

### PRD note
Added §9.1.1 documenting the dev/prod split on a single VPS:
`staging.git-done.com` gets its own systemd unit, data dir,
Postfix transport, and nginx server block. Local laptop `--dev`
stays for UI work.

---

## [Phase 1 — 1.H.2b dependency graph] — 2026-04-19

Collapses the three workflow "flow" modes (sequential, non-sequential,
hybrid) into a single primitive: each step has an optional `depends_on`
list. Empty = runs immediately. Populated = eligible when every named
dependency is complete. **The `flow` field is gone from the schema.**

### UI
- Event-creation form drops the "Flow" dropdown. The "How" section
  becomes "Trust" (just `min_trust_level`).
- Step table gains one new column: **Depends on**. Text input taking
  comma-separated 1-based step numbers: `1, 2`.
- Placeholder example: `e.g. 1`. Empty = runs immediately.

### Validator
- `parseDependsOn` resolves comma-separated step numbers to 0-based
  indices; rejects self-references, out-of-range, and non-numeric
  tokens.
- `detectDependencyCycles` runs a 3-color DFS over the dep graph.
- Resolved to step ids at store time, so each persisted step carries
  `depends_on: ["step-id-1", ...]`.

### Completion engine
- `shouldCountWorkflow`: a step is eligible iff every id in its
  `depends_on` is already complete. Replaces the old sequential /
  non-sequential branching.
- `eligibleSteps(event)` helper filters to steps that are both pending
  AND have deps met — used by remind+ and the cascade path.
- Cascade on step complete now notifies *every* newly-eligible
  downstream step (not just the "next one" in a linear chain).

### Notifications
- On create: notifies every step with empty `depends_on`. Everyone
  downstream waits for the cascade.
- `remind+`: notifies every currently-eligible step; tells the
  initiator when all pending steps are blocked on upstream deps.

### Migration
- Clean cut. No back-compat shim for events created before 1.H.2b
  (would have `flow` and no `depends_on`). Pre-launch = no real prod
  events affected. `data-dev/` fixtures get invalidated; tests
  updated.

---

## [Phase 1 — §6.4 initiator email commands] — 2026-04-19

The initiator's primary day-to-day surface, per PRD §6.4, is email —
not a web dashboard. Three commands ship today:

- **`stats+{id}@`** — reply with a plain-text progress report
  (workflow: step checklist; crypto: threshold / replies received).
- **`remind+{id}@`** — resend invitations to pending participants.
  Sequential workflow reminds step 1; non-sequential reminds every
  pending step; declaration reminds the signer; attestation is a no-op
  (no participant list).
- **`close+{id}@`** — mark the event complete immediately. Writes a
  `commits/completion.json` with `closed_by: initiator`, OTS-stamps it,
  and git-commits.

### Auth

All three require the incoming message to meet `event.min_trust_level`
**and** have envelope sender (or From, if envelope absent) matching
`event.initiator` (case-insensitive). Unauthenticated senders get a
plain-text rejection reply explaining why; no state changes, no reminders
sent.

### Added
- `app/src/email-commands.js` — pure composers for the three commands +
  auth check.
- `parseInitiatorCommand` in `app/src/router.js`.
- Short-circuit handler in `bin/receive.js` after the reverify+ block:
  runs classifyTrust, authenticates, executes, replies via the existing
  sendmail(1) path. Every outcome logged as `kind: "initiator_command"`.
- 14 new tests — 10 unit on the composers + auth, 4 integration driving
  real receive.js (authenticated stats, unauthenticated rejection,
  remind cascade, close→completion commit).

---

## [Phase 1 — 1.J completion engine] — 2026-04-19

gitdone events now actually *finish*. Until now, a reply would get
committed to the per-event git repo but the event JSON didn't track
progress — steps stayed `pending` forever and nothing computed
"we're done." 1.J closes that gap.

### Added
- `app/src/completion.js` — pure state machine with per-mode rules
  (trust gating, participant/signer matching, sequential ordering,
  attestation dedup unique/latest/accumulating). `applyReply` returns
  a new event object with transitioned state + a decision record;
  `updateEventAtomic` persists via temp+rename.
- `commitCompletion` in `app/src/gitrepo.js` — writes
  `commits/completion.json` to the per-event repo, OTS-stamps it,
  and commits. Idempotent: re-runs are no-ops once the file exists.
- `bin/receive.js` orchestration: after every successful reply commit,
  run the engine, persist, write a completion commit on the edge to
  done, and fire a cascade notification to the next sequential step's
  participant when one completes.
- 21 unit tests (exhaustive per-mode decision tree, dedup rules) + 6
  integration tests that drive the real `receive.js` binary with
  synthetic emails and verify event JSON, repo state, and the
  cascade notification capture.

### Behavioural notes

- **Trust gate.** Replies below `min_trust_level` still commit (audit
  trail, §7.4.x), but don't advance the event. Attestation with
  `allow_anonymous: true` is the one exception — sub-threshold replies
  count there.
- **Sequential out-of-order.** A reply to step N when step N-1 is still
  pending gets committed but does not advance state. The organiser
  sees it in the repo.
- **Attestation past completion.** Further replies commit (audit) but
  the event stays complete; they don't re-fire completion logic.
- **Declaration from wrong sender.** sender_hash is salted per-event
  and compared against `hashSender(event.signer, event.salt)`. The
  format matches `gitrepo.saltedSenderHash` byte-for-byte.

---

## [Phase 1 — 1.I participant notifications] — 2026-04-19

Creating an event now reaches the people who need to reply. Until now,
`POST /events` and `POST /crypto` only emailed the initiator with a
management link; participants were never told anything. 1.I closes that
gap.

### Added
- `app/src/notifications.js` composes per-participant plain-text email
  bodies and calls `sendmail(1)` via the existing outbound path. Two
  exports: `notifyWorkflowParticipants(event)` and
  `notifyDeclarationSigner(event)`.
- `POST /events` and `POST /crypto` now fire notifications in parallel
  with the management email. Per-recipient send failures are logged to
  stderr; the create flow still completes successfully.
- 3 unit tests on the body composers, 4 integration tests covering the
  per-flow/per-mode behaviour via a capturing fake sendmail.

### Flow & mode rules

| Event | Who gets notified on creation |
|---|---|
| workflow, sequential | step 1 participant only |
| workflow, non-sequential | every step's participant |
| workflow, hybrid | every step's participant (interim — real tree-aware notification lands with 1.H.2b) |
| crypto, declaration | the named signer |
| crypto, attestation | nobody — initiator shares the reply address manually per PRD §6.1 |

Cascading notifications (step 2 fires after step 1 completes, etc.)
are part of the completion engine (1.J), not 1.I.

---

## [Phase 1 — 1.H.3 landing + crypto events] — 2026-04-19

Landing page now uses a compact two-CTA block (Create Event / Create
Crypto) with a one-paragraph explainer. Crypto events can be created
at `/crypto/new` in either **declaration** mode (one DKIM-verified
signer → one permanent record) or **attestation** mode (N distinct
signers with a dedup rule). Winning design: Live Canvas variant F
(dense 2-col grid, no numbered section headers, fields dim in place
for the inactive mode). PRD §4.2 is now fully wired end-to-end.

### Added
- `validateCryptoEvent` in `app/src/web/validation.js` — branches per
  mode. Declaration requires `signer`. Attestation requires integer
  `threshold >= 1`, `dedup` ∈ `{unique, latest, accumulating}`,
  optional `allow_anonymous`.
- `GET /crypto/new` + `POST /crypto` in `app/bin/server.js`. Success
  page spells out the shareable reply address (`event+{id}@domain`)
  and, for attestation, includes a pre-filled `mailto:` helper for
  posting to channels.
- Crypto-specific management email body — explains mode, threshold,
  reply address, and the email-command namespace.
- Frozen design reference at
  `docs/01-product/design/landing-and-crypto-v1.md`. `DESIGN_MEMORY.md`
  gains the "dense-grid form" pattern (for ≤6-field forms).
- 8 integration tests covering GET landing, GET form, declaration
  success, attestation success, per-mode validation failures, and
  magic-token generation for crypto events.

### Changed
- Landing (`GET /`) no longer uses the `btn-big` placeholders from
  `templates.js`; it renders its own `.f-landing` block with the F
  palette.

---

## [Phase 1 — 1.H.4 magic-link management URL + email] — 2026-04-19

Creating an event now mints a 30-day opaque token (32 hex chars) and
emails the initiator a management URL at `/manage/{token}`. Both
workflow events and crypto events use the same token flow. Day-to-day
commands still happen by email (§6.4); the URL is the visual fallback.

### Added
- `app/src/magic-token.js` — one-file-per-token store under
  `data/magic_tokens/{token}.json`. File-per-token avoids RMW races
  and matches `data/events/{id}.json` layout. Malformed tokens never
  touch disk. Expired tokens read as null.
- `GET /manage/{token}` renders a minimal valid-link landing that
  points at the email commands; full dashboard is 1.H.5.
- Management email composed in `sendManagementEmail` — sent via the
  existing `sendmail(1)` path (opendkim milter signs it).
- 7 unit tests for magic-token, 3 integration tests for the full
  `POST /events` → email → `/manage/{token}` flow using a fake
  sendmail shell script.

### Design decision
- **Opaque token, not JWT.** PRD §4 originally said JWT; we use
  `crypto.randomBytes(16).toString('hex')` instead. Reasoning: single
  host, file-backed, revocation by file delete, no need for
  JWT-style statelessness. Every "real" JWT feature (one-time use,
  revocation, listing active links) re-introduces a server lookup.

---

## [Phase 1 — 1.H.2.1 event form redesign] — 2026-04-18

Event form at `/events/new` gets its v1 visual identity: Design Lab
synthesis winner **variant F2**. Numbered section headers, What+Who
on one row, How on a second, compact step table with datetime-local
deadlines, inline explained dropdowns (`sequential — one after
another`, `verified — strict DKIM + DMARC`).

### Added
- Frozen reference at `docs/01-product/design/event-form-v1.md`.
- `DESIGN_MEMORY.md` — locked-in patterns (palette, numbered
  headers, explained dropdowns, `datetime-local` for time-sensitive
  fields). `DESIGN_PLAN.md` — remaining UI surfaces and when to
  re-run Design Lab.

### Changed
- `renderWorkflowForm` in `app/bin/server.js` now emits the F2
  markup (`vf-form`, `vf-row`, `vf-steps-table`) replacing the
  scaffold from 1.H.2.
- "Add step" uses `formaction=/events/new formmethod=GET` so values
  round-trip in the query string — still no client JS.

### Removed
- The Design Lab route + loader (`/__design_lab`) added during 1.H.2.
  Lab is recreated on demand by the `design-lab` / `live-canvas`
  skills.

### Also this day
- Dev ergonomics (`bd52610`): `--dev` flag injects a
  fixed-position feedback HUD (`/dev/feedback`, appends to
  `dev-feedback.log` + stderr) and SSE live-reload (`/dev/stream`)
  that reloads the browser on server restart. Production pages are
  byte-identical.
- CLAUDE.md rewritten (`0eb820a`) to match the actual Phase 1 stack
  (vanilla `node:http` + tagged template literals, not the old
  Next.js / Express description).

---

## [Phase 1 — 1.H.2 workflow event creation] — 2026-04-18

Event initiators can now create workflow events via a plain-HTML form
at `/events/new`. Supports sequential or non-sequential flow, optional
deadlines per step, optional "requires attachment" per step, and the
configurable `min_trust_level` (from the 4 trust tiers in PRD §7.4).

### Added
- `app/src/web/validation.js` — shape + format validators for form
  input. Collects multiple errors per submission rather than failing
  on the first. Generates deterministic `step.id` via slug, dedupes
  collisions with numeric suffix.
- `app/src/event-store.js::createEvent` — atomic persistence with
  `generateEventId` (12-char base36) + `generateEventSalt` (32B hex
  per §0.1.10). Temp+rename write, refuses to overwrite, traversal
  guard on id.
- Routes in `app/bin/server.js`:
  - `GET /events/new` — workflow form (with "+ Add another step"
    via query-string round-trip; no client JS needed)
  - `POST /events` — validates + creates; 422 on errors with the
    form re-rendered and user values preserved; success page shows
    each step's `event+{id}-{stepId}@git-done.com` reply-to
  - `GET /events/:id` — read-only debug view (will be gated by
    magic-link in 1.H.5)
- 34 new tests: 22 unit tests for validation + createEvent, 8
  integration tests hitting the real HTTP server with a throwaway
  data dir.

### Non-goals (deliberate)
- No client-side JS. Dynamic step-count works via GET round-trip.
- No CSS framework. One inline `<style>` block in `layout()`.
- No hybrid flow yet — that's 1.H.2b (tree UI, UI-heaviest piece).

---

## [Phase 1 — 1.H.1 v1 deletion + web skeleton] — 2026-04-18

v1's Next.js + Express + Docker stack is retired. The whole v1
surface area is gone from the tree (~2,235 files across `backend/`,
`frontend/`, Dockerfiles, deploy scripts, test artefacts, and their
entire `node_modules/` that shouldn't have been committed). Git
history preserves v1 at commit `f9820ea` and before.

No archive dir kept — the PRD's rebuild (Path B) doesn't need v1
as a reuse source; any pattern that's genuinely useful can be
pulled via `git show <sha>:<path>` on demand.

### Added
- `app/bin/server.js` — HTTP server for the initiator web UI,
  vanilla Node `http` (no Express, stdlib only). Landing page +
  `/health` for now.
- `app/src/web/router.js` — tiny (method, path) router with
  `:param` support.
- `app/src/web/templates.js` — tagged-template `html\`...\``
  primitive with automatic HTML-escape on interpolation + `raw()`
  opt-out; shared `layout()` chrome.
- `app/src/web/body.js` — stdlib body parser for
  `application/x-www-form-urlencoded` and `application/json`,
  256KB cap.
- 34 new unit tests (router, templates, body-parse, end-to-end
  server response).
- On VPS: `/etc/systemd/system/gitdone-web.service` (runs as
  `gitdone` user, bound to `127.0.0.1:3001`, sandbox-hardened).
  Not yet publicly exposed — nginx + TLS will come at the end of
  1.H once all initiator routes are working locally.

### Removed
- `backend/` (v1 Express + JSON + SMTP)
- `frontend/` (v1 Next.js + React)
- `Dockerfile`, `docker-compose.yml`, `docker_compose.yml`,
  `deploy.sh`, `dev.sh`, `nginx.conf`, `playwright.config.ts`,
  `package.json` (root), `README.md`, `start.sh`, `tests/` (v1
  playwright), `test-results/`, `quick-start.sh`.
- `data/` (v1 runtime events + magic tokens). Clean slate for v2.
- `.env` (may have contained real credentials — shredded).
- All v1 `node_modules/` (should never have been in git).

### Changed
- `docs/04-process/phase1-plan.md` — 1.H decomposed into 1.H.1
  through 1.H.5 (and 1.H.2b for hybrid-flow tree UI). 1.H.1
  marked done.

---

## [Phase 1 — 1.E+ OTS upgrade scheduler] — 2026-04-18

Closes the operational gap identified in 1.L.3 finding 41: proofs
in the repo at commit time carry only calendar attestations, not
Bitcoin ones. `ots verify` used to paper over this by querying
calendars live. Now we periodically fold the Bitcoin attestations
into the `.ots` files themselves, so the repo is self-contained
against calendar-server outages.

### Added
- `app/bin/ots-upgrade.js` — worker that walks
  `$dataDir/repos/*/ots_proofs/*.ots`, runs `ots upgrade` on each,
  compares sha256 before/after to detect upgrades, and makes ONE
  git commit per event repo if ≥1 proof got Bitcoin-anchored
  (`ots upgrade: N proof(s) anchored to Bitcoin`). JSON-lines output
  for journalctl. Idempotent: no changes = no commit.
- `app/tests/unit/ots-upgrade.test.js` — 8 tests using a fake
  `ots` binary that simulates upgrades selectively, validating
  batched commit shape and idempotent re-runs.
- VPS systemd units:
  - `/etc/systemd/system/gitdone-ots-upgrade.service` — oneshot,
    runs as `gitdone` user.
  - `/etc/systemd/system/gitdone-ots-upgrade.timer` — 6h cadence,
    5min post-boot jitter, `Persistent=true` so missed runs fire
    on next boot.

### Changed
- `tools/gitdone-verify` OTS classifier now recognises an additional
  post-upgrade state: when a proof has Bitcoin attestations embedded
  and `ots verify` exits with "Could not connect to Bitcoin node"
  and no failure signal, the proof is classified as `anchored`
  (cryptographically valid; no Bitcoin node available for
  independent cross-check). Tamper is still reliably caught by
  `does not match`.

### Verified
- First production run on VPS upgraded 2 proofs (demo123
  commit-001 and commit-002) — file sizes grew ~550→2620 bytes
  and ~690→2760 bytes as Bitcoin Merkle-path attestations were
  folded in. One git commit `b30a48f: ots upgrade: 2 proof(s)
  anchored to Bitcoin`. Second run 30s later was a clean no-op.
  Systemd timer scheduled: next run in ~6h.

---

## [Phase 1 — 1.L.3 reverify+ handler] — 2026-04-18

Completes the verify trilogy (`event+` / `verify+` / `reverify+`). A
commit that failed to reach the initiator's required trust level at
reception can now be upgraded by supplying cryptographic evidence — a
raw `.eml` whose DKIM signature validates against the commit's
archived PEM. The original commit stays immutable; upgrades are
layered as new `reverify-NNN.json` audit records.

### Added
- `app/src/router.js::parseReverifyTag` — `reverify+{eventId}-{seq}@`
  parser with sequence bounds and traversal guards.
- `app/src/gitrepo.js::commitReverify` — writes `commits/reverify-NNN.json`
  (own sequence namespace, separate from `commit-NNN.json`), stamps with
  OTS, commits to git. Never touches the target commit.
- `app/src/gitrepo.js::loadCommit`, `nextReverifySequence` — helpers.
- `app/src/reverify.js` — orchestrator: load target commit, pick signer
  from its DKIM record, extract forwarded `.eml`, run DKIM re-verify
  against archived PEM, build upgrade record with policy (`unverified`
  / `authorized` / `forwarded` → `verified` on pass; already-verified
  is a no-op audit entry).
- `bin/receive.js` — handles `reverify+` before event routing. Writes
  the reverify commit, sends DKIM-signed ack reply via 1.L.1 path.
- `tools/gitdone-verify/gitdone-verify.js` — recognises `reverify-NNN.json`
  files, validates their schema separately from reply commits, and
  computes **effective trust** as `max(original, upgrade)` when
  evaluating completion. Summary now shows "4 reply + 2 reverify
  commit(s) conform to schema v2".
- 29 new unit tests across router (10), gitrepo (4), reverify (15).

### Verified
- Three E2E paths on the production VPS against the demo123 repo:
  1. `reverify+demo123-99@` (non-existent commit) → `not found`,
     `git_record: null`, DKIM-signed reply sent explaining why.
  2. `reverify+demo123-1@` (commit-001 was unsigned at reception) →
     `no archived DKIM key`, `upgraded: false`, still written as an
     audit entry (`reverify-001.json`).
  3. `reverify+demo123-2@` (commit-002 already verified) →
     `trust: verified → verified`, `upgraded: false` with policy note
     "already verified", audit entry `reverify-002.json`.
- Offline `gitdone-verify` re-run on the updated repo correctly
  summarises: `4 reply + 2 reverify commit(s) conform to schema v2`,
  OpenTimestamps passes all 6 proofs (2 anchored + 4 pending for the
  new reverify OTS stamps).

### Changed
- `gitdone-verify` OTS classifier now treats `Got N attestation(s)
  from cache` output as `anchored` (independent of exit code — `ots`
  exits 1 both on tamper AND on cache-without-local-bitcoin-node,
  so text signals are authoritative). Tamper detection still reliable
  via `does not match` regex.

### Known gap — tracked as module 1.E+
`ots upgrade` is not yet automated. `.ots` proofs in the repo start as
calendar-pending (attestations from 3-4 calendars, no Bitcoin tx yet).
`ots verify` papers over this by querying calendars live, but if all
calendars died before an upgrade, the proof would become unverifiable.
**Planned:** 6-hour cron running `ots upgrade` across all event repos,
making one idempotent git commit per upgraded event (`ots upgrade: N
proofs anchored to Bitcoin block X`). See `phase1-plan.md`.

---

## [Phase 1 — 1.G attachment forwarding] — 2026-04-18

Completes §0.1.10 privacy story: received attachments are hashed into
the git commit at reception, then handed to the event initiator's
mailbox byte-for-byte. GitDone's filesystem never stores attachments.

### Added
- `app/src/forward.js` — `buildForwardMessage` (prepends
  `X-GitDone-Event`, `-Step`, `-Commit`, `-Trust`, `-Received-At`,
  `-Forwarded-At` headers before the original message's header block)
  and `forwardToOwner` (byte-preserving resubmission via sendmail with
  envelope rewrite).
- `outbound.sendmail` positional-recipient mode: `to: [addr, ...]`
  switches from `-t` (header-derived recipients) to `-- addr1 addr2`
  (explicit positional). Used for forward-to-owner where we want to
  preserve the original `To: event+{id}-{step}@` for context but route
  to the initiator.
- 10 new unit tests covering header prepending (incl. the no-blank-line
  invariant), byte-preservation, the positional-recipient sendmail
  path, and end-to-end forward via a fake sendmail capturing stdin.

### Changed
- `receive.js` now calls `forwardToOwner` after a successful
  `commitReply` when `event.initiator` is set. Best-effort — forward
  failure logs `forward.ok: false` but does not reject the inbound.

### Verified
- End-to-end from Gmail: reply to `event+demo123-step1@git-done.com`
  → commit-003.json + commit-004.json in the event's git repo
  → both forwards delivered to `avoidaccess@msn.com` (Microsoft
  `250 Queued mail for delivery`, landed in inbox not junk).
  Original `braun-invoice.pdf` attachment byte-intact on the
  recipient side; `X-GitDone-*` tracking headers present.

---

## [Phase 1 — 1.L.2 offline verifier] — 2026-04-17

Principle §0.1.2 made executable: any cloned event repo can now be
verified on a disconnected machine with no call to any GitDone service.

### Added
- `tools/gitdone-verify/gitdone-verify.js` — single-file Node script
  (stdlib only, ~330 lines, MIT-licensed) with six check layers:
  structure, `git fsck`, schema v2 + plaintext discipline (§0.1.10),
  archived DKIM PEM parse, OpenTimestamps (catches tamper), workflow
  completion (incl. sequential-flow ordering).
- `tools/gitdone-verify/tests/verify.test.js` — 31 unit tests, all
  stdlib, including a fake-`ots` harness that simulates each OTS output
  state (anchored / in-bitcoin / pending / tampered).
- `tools/gitdone-verify/README.md` and `LICENSE` (MIT) — the script is
  intended to be forked, audited, or re-implemented; the principle
  matters more than this implementation.

### Verified
- Tamper detection end-to-end: cloned production demo123 repo, flipped
  one byte of `trust_level` in `commit-002.json`, `gitdone-verify`
  returned `OpenTimestamps FAIL (1 bad proof)` and exit code 1. Clean
  repo passes with exit 0.

---

## [Phase 1 — 1.L.1 send path] — 2026-04-17

`verify+{id}@` now replies to the forwarder with a DKIM-signed report
instead of just logging it (graduates 1.L.1 from log-only POC to
fully shipped).

### Added
- `app/src/outbound.js` — `sendmail(8)` wrapper + RFC-822 builder.
  stdlib `child_process.spawn` only; no new npm deps. Outbound is
  signed automatically via the opendkim non_smtpd milter (1.F).
- `app/src/verify.js::formatVerifyReportBody` — plain-text report
  covering MATCH / NO MATCH / empty-event / DKIM-reverify-limitation
  cases, CRLF-clean.
- 20 new unit tests covering outbound (rawMessage builder, sendmail
  spawn with stub binaries) and the report formatter.

### Changed
- Identity alias casing: `GitDone Verify` → `gitdone` in the From
  display name; `GitDone` → `gitdone` in the git commit author. Applies
  to all outbound email and all new git commits.
- `Auto-Submitted: auto-replied` (RFC 3834) on every verify reply —
  paired with the prefilter's system-sender rejection, this closes
  auto-responder loops cleanly.

---

## [Phase 1 — 1.F outbound DKIM signing] — 2026-04-17

Mail leaving `git-done.com` is cryptographically verifiable by
recipients: Gmail confirms dkim/spf/dmarc all `pass`.

### Added
- opendkim 2.11 on the VPS (Mode `sv`, TCP socket `inet:8891@127.0.0.1`),
  wired as Postfix `smtpd_milters` and `non_smtpd_milters` with
  `milter_default_action = accept` (mail still flows if opendkim dies).
- 2048-bit RSA DKIM keypair (selector `gd202604`) on the VPS at
  `/etc/opendkim/keys/git-done.com/gd202604.private`; public material
  and keypair stashed in `pass gitdone/opendkim/{selector,domain,
  private_key,public_key,public_record}`.
- DNS in Route 53: DKIM TXT at `gd202604._domainkey.git-done.com`,
  SPF at apex (`v=spf1 mx -all`), DMARC at `_dmarc.git-done.com`
  (`v=DMARC1; p=none; rua=mailto:postmaster@git-done.com`).
- `.gitignore` hardening: `*.private`, `*.pem`, DKIM artefacts blocked
  from accidental commits (a stray `default.private` from local
  `opendkim-genkey` experimentation was shredded before 1.F's commit).

### Verified
- End-to-end: `postmaster@git-done.com` → `avoidaccess@gmail.com`
  arrived with DKIM pass, SPF pass, DMARC pass, TLS 1.3.

### Known limitations
- Brand-new sending domain: first outbound lands in Gmail Spam despite
  perfect auth. This is reputation, not crypto — fixes itself with
  real traffic over time.

---

## [Phase 1 — 1.L.1 verify+ handler (POC)] — 2026-04-17

Anyone can forward a raw `.eml` or a file attachment to
`verify+{eventId}@git-done.com` and the handler identifies which commit
it corresponds to. At this point the handler **logs** the report; the
send path follows in a later commit the same day.

### Added
- `app/src/verify.js` — `buildVerificationReport`, `findMatch`
  (cascade: `raw_sha256` → `message_id_hash` → attachment
  `sha256`), `reverifyDkim` (against archived PEMs).
- `app/bin/receive.js` short-circuits `verify+` mail before the event
  routing / commit flow; no trust classifier, no git commit, no
  attachment storage — it's a pure read path.

### Findings recorded to PRD §10.5
- Raw-byte email match is unreliable across forward paths (every client
  normalises) — findings 11, 13.
- Message-ID is the only stable cross-client identifier per RFC 5322 —
  finding 12. Commit schema v2 adds `message_id_hash` to support this.
- `verify+` graduates on commit **identification**, not content
  re-verification; the trust guarantee never relied on repeated DKIM —
  finding 14.
- Direct-attachment hashing IS deterministic across providers
  (byte-identical SHA-256 from MSN and Gmail) — finding 15.
  **Attach-a-raw-file is therefore the primary verification UX**.

---

## [Phase 1 — 1.C+ principle §0.1.10 retrofit + OTS fix] — 2026-04-17

Plaintext discipline was added to PRD §0.1.10 this session; committed
JSON schemas were retrofitted to match, and a latent OTS bug was fixed.

### Changed
- Commit schema v1 → v2: drops plaintext `sender`, `subject`,
  `body_preview`, `message_id`; replaces with salted
  `sender_hash`, `message_id_hash`. Event `event.json` gains per-event
  public `salt` (32-byte hex) so verifiers can re-hash a claimed
  address but bulk correlation across events is infeasible.

### Fixed
- OpenTimestamps (1.E) was stamping a pre-final version of
  `commit-NNN.json` — `ots verify` then failed against the committed
  file. Finalise metadata **before** stamping; `ots verify` now
  succeeds on the committed content.

---

## [Phase 1 — 1.E OpenTimestamps anchoring] — 2026-04-17

### Added
- `app/src/ots.js` — wraps `/usr/local/bin/ots` via `child_process`;
  graceful degradation when the binary is missing.
- Each commit now has a paired `ots_proofs/commit-NNN.ots` proof,
  submitted to OTS calendar servers and eventually anchored in a
  Bitcoin block. Independent of GitDone — verifiable with any
  OpenTimestamps client.

---

## [Phase 1 — 1.D DKIM key archival] — 2026-04-17

### Added
- `app/src/dkim-archive.js` — fetches the DKIM DNS TXT record for a
  signature's (domain, selector) at reception time and writes a PEM to
  `dkim_keys/commit-NNN.pem`. Future DKIM verification no longer
  depends on DNS being intact; the archived key in the repo is the
  source of truth.

---

## [Phase 1 — 1.C per-event git repo + commit per reply] — 2026-04-17

First time an inbound reply becomes a permanent audit record.

### Added
- `app/src/gitrepo.js` — init repo + write `commit-NNN.json` per
  accepted reply; schema evolves in 1.C+ above.
- Repo layout at `/var/lib/gitdone/repos/{eventId}/` — `event.json`,
  `commits/commit-NNN.json`, `dkim_keys/`, `ots_proofs/`.
- Accept-with-flag: every reply commits regardless of
  `participant_match` or trust level; the initiator's policy is
  enforced at completion time, not at the door.

---

## [Phase 1 — 1.B plus-tag router + event lookup] — 2026-04-17

### Added
- `app/src/router.js` — `parseEventTag`, `parseVerifyTag`, traversal
  guards for `eventId`.
- `app/src/event-store.js` — `loadEvent`, `findStep`,
  `senderMatchesStep` (case-insensitive).
- Unknown tags are rejected and logged; routing never throws.

---

## [Phase 1 — 1.A production receive pipeline rewrite] — 2026-04-17

Graduated the Phase 0 POC into structured production code with the
findings from §10.5 baked in (PrivateTmp log location, pipe-transport
envelope args, dedicated `gitdone` user, etc.).

### Added
- `app/` — new Node project structure separate from the v1 `backend/`
  and `frontend/` (v1 never received mail, so nothing to reuse here).
- `app/src/{config,envelope,prefilter,classifier,logger}.js` — 12-factor
  config, argv parsing, RFC 3834 pre-filter (Auto-Submitted, List-Id,
  Precedence, system senders), 4-level trust classifier (PRD §7.4).
- Unit tests from day one (`node --test`, stdlib). 95 tests at end of
  1.A-1.L.1.
- VPS layout: `/opt/gitdone/bin/receive.sh` (Postfix pipe wrapper) →
  `/opt/gitdone/bin/receive.js` (entry), runs as dedicated `gitdone`
  system user.
- Postfix pipe(8) transport (not alias-pipe) so envelope args
  `${client_address} ${client_helo} ${sender} ${original_recipient}`
  reach the script — required for SPF and plus-tag.

### Removed
- Phase 0 POC code at `poc/phase0/` stays in-tree as a historical
  reference, but is no longer on the delivery path.

---

## [Phase 0 — POC graduation] — 2026-04-17

A weekend's worth of POC work validated every architectural bet in
PRD §1, §3, §7, §8. Graduated and started Phase 1 the same day.

### Added
- `poc/phase0/` — minimal `receive.js` that reads email from stdin,
  verifies DKIM via `mailauth`, logs sender and metadata.
- RackNerd VPS (AlmaLinux 8, Postfix 3.5.8, Node 20) configured as MX
  for `git-done.com`: MX + A + PTR + FCrDNS all clean.
- PRD §10.5 "Phase 0 Validation Results" — happy-path matrix (real mail
  from MSN and Gmail), pre-filter behaviour, findings 1–10.

### Verified
- Architectural bet "we are the MX, so no intermediary modifies the
  body" holds empirically: MSN and Gmail both produced DKIM pass +
  DMARC pass through direct SMTP.
- Attachment SHA-256 is deterministic across provider sessions.
- Plus-tag (`event+ID-step@git-done.com`) survives end-to-end through
  external SMTP.

---

## [v2.0 PRD Revival] — 2026-04-16

Structural rebuild of v1 into a universal coordination protocol.
v1's "vendor workflow management" framing is too narrow; v2 is any
cryptographically-verifiable multi-party action, with email as the
participant interface and git as the permanent record.

### Added
- PRD §0 design principles (10, non-negotiable) with historical
  context pointing at 60 years of identity-system failure modes.
- PRD §4 two-event-type taxonomy: **Event** (workflow) and **Crypto**
  (declaration / attestation).
- PRD §7 four-layer trust model with accept-with-flag policy: DKIM →
  ARC → SPF/DMARC → flag; initiator decides what counts toward
  completion.
- PRD §8 technical architecture for the new inbound pipeline.
- PRD §10 four-phase rollout plan (0 POC, 1 core rebuild, 2 crypto
  types, 3 polish + launch) + `gitdone-verify` as the load-bearing
  principle check.

### Deprecated
- v1's participant-facing web pages, per-participant magic link tokens,
  file upload endpoints, and server-side attachment storage — all
  scheduled for deletion in module 1.K.

---

## [v1 Archive] — 2025-10-03 to 2026-02-13

Original GitDone: Next.js 15 + Express + JSON storage multi-vendor
workflow coordinator. Reached ~80% on a single use case (wedding
vendor coordination) before being deemed structurally unsuitable
(PRD §2.5 — no moat, storage burden, privacy concern, tight
coupling, single use case).

What v1 can do today that still ships in v2 (per PRD §3.4):
- Event creation (sequential / non-sequential / hybrid flow types)
- Platform stats aggregation (6-hour cron)
- Management magic links for initiators
- Reminder email infrastructure
- One git repo per event

These components stay; the participant side gets rebuilt in Phase 1.
