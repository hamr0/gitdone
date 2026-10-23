---
title: Participant and initiator email experience
theme: Participant and initiator email experience
source: docs/archive/prd.md
summary: What participants and initiators see and do by email and in the web dashboard, including event activation, email commands and the lifecycle state machine.
---

# Participant and initiator email experience

## 5. The Participant Experience

### 5.1 What participants receive

- The invitation is an email with a `Reply-To` of `event+<id>-<step>@<domain>` (example `event+abc123-step1@gitdone.yourdomain`), a subject such as `[Action needed] Legal review for Q2 Contract`, a plain-language request (what to reply with, attach redlines if needed), the due date, and the line "Your reply is cryptographically recorded via git + OpenTimestamps." (docs/archive/prd.md:465-483)
- The From is described as the initiator's email or gitdone-on-behalf-of. (docs/archive/prd.md:466)

### 5.2 What they do

- Hit Reply, type, attach files if needed, send. Total effort: reply to an email. (docs/archive/prd.md:487-489)
- `Reply-To` is authoritative: invitations set `Reply-To: event+<id>-<step>@<domain>` so Gmail, Outlook, iOS Mail, Apple Mail and Thunderbird route Reply to the per-step tag address regardless of From. Nothing relies on the participant typing an address. (docs/archive/prd.md:491-496)
- No magic-link clicks, web forms, accounts or app installs. (docs/archive/prd.md:498)

### 5.3 What happens next

1. Reply arrives at `event+abc123-step1@...`. (docs/archive/prd.md:502)
2. Postfix pipes to `receive.js`. (docs/archive/prd.md:503)
3. `receive.js` (docs/archive/prd.md:504-519):
   - verifies DKIM via `mailauth`;
   - parses MIME via `mailparser`;
   - extracts sender, body, attachment hashes;
   - forwards the original email (with attachments) to the initiator's inbox;
   - commits metadata JSON to the event's git repo;
   - archives the DKIM public key alongside the commit;
   - submits the commit hash to OpenTimestamps;
   - sends the participant a threaded auto-reply, **always**;
   - checks for completion and, if complete, emails every distinct contributor plus the organiser a `[signedreply] '<title>' — complete` summary with steps and reason.
4. Auto-reply outcomes (docs/archive/prd.md:512-516):
   - Accepted: "Your reply for '<step>' was accepted; step complete".
   - Missing attachment: resend with file.
   - Event already complete/closed: your reply is on the audit trail.
   - Event not activated: organiser hasn't confirmed yet; wait for invite.
5. The git repo then holds a cryptographically verifiable record. (docs/archive/prd.md:520)

**Silence is a bug.** Every reply produces exactly one signal back to its sender, threaded via In-Reply-To. Every transition affecting multiple people (cascade to next step, event completion) is announced to everyone affected. (docs/archive/prd.md:522-526)

### 5.4 What they DO NOT see

- The git repo (unless the initiator shares it), other participants' replies, the initiator's dashboard, any gitdone web UI. (docs/archive/prd.md:530-533)

## 6. The Initiator Experience

### 6.1 Event creation (web UI, simplified)

The initiator visits `signedreply.com`; the landing page has two entry points plus a self-serve sign-in strip for returning organisers. (docs/archive/prd.md:541-543)

**Workflow form (`/events/new`)** (docs/archive/prd.md:545-559)

- Fields: Title, Your email, Min trust (`verified | forwarded | authorized | unverified`; default `verified`, "cryptographic proof the sender wrote it").
- Steps table columns: `#`, Name, Participant, Deadline, Depends on, Att (attachment required); "+ add step".
- `Depends on` is a comma-separated list of 1-based step numbers the step waits for; empty = runs immediately. It replaces the v2-era `flow: sequential | non-sequential | hybrid` enum, since a DAG is strictly more expressive. (docs/archive/prd.md:561-564)

**Crypto form (`/crypto/new`)** (docs/archive/prd.md:566-582)

- Fields: Title, Your email, Mode (`declaration` = one signer, one record; `attestation` = gather signatures from a group).
- Declaration: Signer email. Attestation: Threshold (distinct signers), Dedup (`unique | latest | accumulating`), Allow anonymous replies.
- The mode radio is a pair of selectable tiles; non-applicable fields dim live on mode change.

**Preview before create.** Submit goes to a server-rendered preview, not directly to creation. (docs/archive/prd.md:584-596)

- Shows title, organiser email, min trust level in plain language; **flow prose** (the DAG as English, e.g. "Steps 1 and 2, then Step 3."); steps in topological execution order with participant, deadline, dependency chips and an "attachment required" chip; buttons **Confirm & send invites** and **← Go back to edit**.
- Nothing persists until Confirm. Edit re-renders the form with values preserved. No server-side state between the two POSTs; fields carry through hidden inputs.

**Validation before confirm.** (docs/archive/prd.md:598-604)

- Cycle-free DAG (3-color DFS).
- `depends_on` references must be in range (1..N) and not self.
- Deadline-vs-dependency ordering: a dependent step's deadline must be >= every dependency's deadline, otherwise the workflow is impossible.

**Deadline semantics (soft).** (docs/archive/prd.md:606-614)

- A deadline is a target, not an enforcement gate. Late replies are still DKIM-verified, committed and counted toward step completion.
- The organiser is notified when a deadline passes without a reply: one nudge email per step, not a reminder storm.
- Principle: cooperative coordination, not deadline enforcement. The invite email states the soft semantics explicitly.

**On confirm, the initiator receives** (docs/archive/prd.md:616-621):

- The event ID, displayed inline on the confirmation page.
- A single knowless magic-link email: 15-minute TTL, single-use; clicking it verifies email ownership and opens a 30-day session.
- Nothing else; participants are NOT notified yet.

**Activation (email-ownership proof).** (docs/archive/prd.md:623-631)

- Events are created `pending_activation` (`event.activated_at === null`). Until the initiator presses Activate (after the magic link or signing in via `/manage`), no invitations go out, and replies to any step's reply-to address commit for the audit trail but do not count toward completion.
- This closes the impersonation vector of typing a victim's address as initiator and blasting real participants.

Activation rules (docs/archive/prd.md:633-673):

- **Mechanism:** knowless (MIT, in-house). The POST `/events` / POST `/crypto` handler calls `auth.startLogin({ email: initiator, nextUrl: '/manage/event/<id>', subjectOverride, bodyOverride, bypassRateLimit: true })`. This is knowless's "Mode A — do the thing, confirm by email" pattern. (docs/archive/prd.md:633-638)
- **Opt-in via dashboard button:** the magic link 303s to `/manage/event/<id>`, which shows a pending banner with an `Activate` button. POST `/manage/event/<id>/activate` calls `event-store.activateEvent(id)` (idempotent, mutex-guarded) and, on null to activated, fires `notifyWorkflowParticipants` / `notifyDeclarationSigner`. The activation email previews each step's deadline, dependencies and one-line brief. (docs/archive/prd.md:639-648)
- **No same-session shortcut:** POST `/events` and `/crypto` always send the activation email, even if the requester already holds a matching session; the email is part of the gate. (docs/archive/prd.md:649-652)
- **Pending events stay accessible:** a Mode-B session suffices as proof of email ownership, so GET `/manage/event/<id>` and POST `.../activate` are not gated on a per-event link click. The initiator can return weeks later, sign in via `/manage`, and Activate / Edit / Close any pending event. The `handle === auth.deriveHandle(initiator)` check on every route is the security boundary. (docs/archive/prd.md:653-660)
- **Completion engine gate:** `shouldCountWorkflow / Declaration / Attestation` short-circuit with `reason: 'event not activated'` when `activated_at` is null; `receive.js` sends the replier a threaded "event isn't live yet" auto-reply. (docs/archive/prd.md:661-664)
- **Concurrency:** `activateEvent` uses a per-event in-process Promise mutex, so N parallel dashboard visits activate exactly once and notify exactly once. (docs/archive/prd.md:665-667)
- **Fail-open for the organiser:** knowless `startLogin` is silent at every layer (FR-6). On SMTP failure in local dev the magic link prints to stderr (`devLogMagicLinks`); in prod, transport failures surface on stderr via knowless's default `onTransportFailure` (gitdone doesn't override it; knowless >= 1.1.4). (docs/archive/prd.md:668-673)

**On activation, the deferred fan-out fires** (docs/archive/prd.md:675-679):

- Workflow: one notification email per eligible root step.
- Crypto declaration: emails the signer. Crypto attestation: no auto-invite; the organiser shares the reply address.

**Organiser receipt and progress emails (workflow only).** (docs/archive/prd.md:681-691)

- After fan-out, the organiser gets one summary email (the `activated` edge) listing every step, with a `▸` marker on DAG roots and per-recipient delivery status.
- As replies land and downstream steps unblock, `receive.js` emails the organiser a per-transition note (the `progressed` edge) naming the completer and newly-active step(s).
- The final transition is short-circuited by `!applied.completedEvent`; the `completed` edge carries the final-step name in the organiser body, so no transition is silent.

**Lifecycle email architecture.** (docs/archive/prd.md:693-704)

- All per-event lifecycle emails route through `notifyLifecycleEdge(event, edge, payload)` (`app/src/notifications.js`) over edges `activated | progressed | completed | closed | anchored`.
- Recipients resolve through `getRecipients(event, edge)` (`app/src/email-recipients.js`).
- Subject/body text comes from `app/src/email-bodies.js`, which by 0.25.3 holds every composed outbound body/subject (lifecycle, invite, reply acks, command acks, sweep notices, bounce alert); no transactional text is inline in `receive.js` / `sweep.js` / `email-commands.js`. See `docs/product/emails.md` ("Architecture").

**Pre-flight MX on every recipient.** (docs/archive/prd.md:706-714)

- Initiator and every participant address are checked at confirm time (`checkInitiatorMx` / `checkParticipantsMx`): `dns.resolveMx` with A/AAAA fallback per RFC 5321 §5.1, fail-soft on resolver hiccups.
- Catches typos at no-such-domain TLDs (`@y.c`, `@gmaicom.invalid`) that DSN bounces miss because the receiving MTA never returns one. The DSN handler in `receive.js` remains the backstop for real bounces.

### 6.2 Management

Single self-serve path: knowless-backed sessions. `/manage` shows the sign-in form without a session, otherwise a dashboard of every event/crypto record the user has organised. (docs/archive/prd.md:718-720)

**Filter row** (docs/archive/prd.md:722-737)

- **Type:** `events` / `crypto` (`?type=event|crypto`); hidden when the user has only one type.
- **Status:** `active` / `completed` / `closed` / `pending` / `archived` (`?status=...`); buckets at zero count are hidden.
- Active pill fills with its lifecycle colour (`active` blue, `completed` green, `closed` amber, `pending` CRT-amber, `archived` grey; same palette as §6.5), so the row doubles as a legend.
- Clicking the active pill in a dimension clears it; dimensions combine freely. Clicking `archived` auto-includes archived events. Per-pill counts stay portfolio-wide.

**Sign-in flow** (docs/archive/prd.md:739-747)

- GET `/manage` without session: email form.
- POST `/manage`: knowless `auth.login` mints a 15-minute single-use magic link and emails it.
- GET `/manage/callback?t=...`: knowless verifies and sets a 30-day signed session cookie.
- POST `/manage/logout`: clears it and redirects home.
- The response is identical whether or not the address has events: no account-existence oracle (knowless's 12-step sham-work flow).

**Per-event dashboard `/manage/event/<id>`** (docs/archive/prd.md:749-757)

- Session-gated; unauthenticated visitors bounce through `/manage?next=...`.
- Ownership check derives the handle of `event.initiator` and compares to the session handle (`auth.handleFromRequest`); foreign sessions get 403.
- The activation magic link is the same machinery: one click verifies the email, opens the session, lands on the dashboard, where the first-visit handler activates the event.

**Session cookie** (docs/archive/prd.md:759-764)

- HMAC-SHA256, signed by knowless with `GITDONE_SESSION_SECRET` (64 hex, persisted per-deploy).
- Session record lives in `{dataDir}/knowless.db` (single SQLite file managed by knowless).
- `HttpOnly; SameSite=Lax; Secure`; boot rejects mismatch between `cookieSecure` and the `GITDONE_PUBLIC_URL` scheme. 30-day Max-Age. Sign-out deletes the session row.

**Dashboard (per-event) shows** (docs/archive/prd.md:766-787)

- Progress: X of Y steps done; for attestation, X of N distinct signers.
- Step table: step name, participant, `depends_on`, per-step status (complete / pending / waiting-on-deps).
- Timeline: commits with Message-ID, DKIM status, OTS anchor state.
- Attachment fingerprints (filename + truncated SHA-256) whenever a counted reply carried files. Workflow rows show a green `📎 N` pill at row level next to the DKIM-VERIFIED trust pill; clicking either expands the proof drawer listing filename, truncated hash and size. Crypto attestation ledger rows show the same pill, with the per-attachment list as a sub-row. PDFs are not stored, only hashes: a verification index, not a download link (use the proof bundle + `verify+` for byte-level recovery).
- "Send reminders" button: `executeRemind`.
- "Close event" button: `executeClose` + `commitCompletion`.
- Email-fallback footer listing `stats+/remind+/close+` addresses, plus `revoke+` on crypto attestation events (initiator-only, inline in the event-details section).

### 6.3 Receipt

- Every reply forwards to the initiator's inbox with the original attachments; the initiator's email is the attachment archive and GitDone stores only hashes. (docs/archive/prd.md:791)
- On completion the initiator has: a git repo with all metadata, DKIM keys and OpenTimestamps proofs; an inbox of forwarded emails with attachments; a permanent verifiable record. (docs/archive/prd.md:793-796)

### 6.4 Initiator email commands (primary interaction)

Per the moat (§0.1.4, "invisible beats correct"), day-to-day interaction happens by email, not web forms. The magic-link management URL is a fallback for initiators whose outbound DKIM is broken (corporate gateways) or who prefer a visual view. (docs/archive/prd.md:800)

**Address namespace** (docs/archive/prd.md:802-813)

| Address | Purpose | Authentication |
|---|---|---|
| `event+{id}-{step}@` | participant reply to commit | DKIM + §7.4 trust classifier |
| `verify+{id}@` | anyone forwards a raw `.eml` or attachment; gets a verification report back | none (public op) |
| `stats+{id}@` | initiator: current event state + progress | DKIM + envelope sender == `event.initiator` |
| `remind+{id}@` | initiator: resend reminders to pending-step participants | same |
| `close+{id}@` | initiator: close early, **two-step confirm**: first reply returns a 30-min token, second reply quoting `CONFIRM <token>` closes | same |
| `attach+{id}@` | initiator: register canonical reference doc(s) on a crypto event with `reference_url` set; first reply freezes the manifest (§4.2.3) | same |
| `revoke+{id}@` | initiator: revoke attestor(s) on a crypto attestation event; body lists emails, optional `reason: ...` line; audit trail preserved, counter drops, locking dedup can flip completion back to open | same |
| `reverify+{id}-{commitN}@` | initiator or auditor: re-run verification on a specific commit with supplied evidence (raw `.eml`, attachment) | none |

**Initiator authentication via DKIM.** A DKIM-verified inbound message whose envelope sender matches `event.initiator` is cryptographic proof the initiator authorised the command; the source calls it as strong as (often stronger than) a magic link, since DKIM can't be spoofed while magic links can be forwarded. (docs/archive/prd.md:815)

**Standard signature.** Every outbound email carries an RFC 3676 `-- ` delimited signature of four ASCII lines: the no-storage claim, the integrity primitives used (DKIM verification, SHA-256 hash, OpenTimestamps anchor), and `feedback@signedreply.com` as the feedback channel. Magic-link activation bodies also publish the per-event `stats+{id}@`, `remind+{id}@`, `close+{id}@` addresses. (docs/archive/prd.md:817)

**Two UX paths for `verify+{id}@`** (docs/archive/prd.md:819-825)

1. **Attach a raw file** (most common, primary UX for attachment-heavy events): GitDone hashes every attachment and reports which commit(s) match. Works identically across MSN, Gmail, Proton etc. because clients transmit raw bytes (MIME base64).
2. **Forward an email as attachment**: GitDone matches via Message-ID (stable per RFC 5322), identifies the commit and reports the reception-time trust level. **DKIM cannot be re-run** on forwarded content (see §10.5 finding 13).

Attachment verification is strictly stronger than body verification, because attachments are bit-preserved across forward paths and bodies are not. (docs/archive/prd.md:825)

### 6.5 Event lifecycle

A small explicit state machine. Nothing auto-completes: completion writes a permanent commit, so the system nudges and archives, leaving the decision to the organiser. (docs/archive/prd.md:829-832)

| State | Dashboard visibility | Replies count? | Transition in | Transition out |
|---|---|---|---|---|
| `pending_activation` | amber pill, always visible | no | `POST /events` or `/crypto` | first owner visit to `/manage/event/:id` to `open`, OR 72h GC to deleted |
| `open` | default visible (blue pill) | yes | first owner dashboard visit | all steps complete to `complete`; organiser close to `complete`; 45d idle to `archived` |
| `completed` | default visible (green pill) | no | every step's `status === 'complete'` | terminal; `completion.completed_at` is a git commit, not reversible |
| `closed early` | default visible (amber pill) | no | `close+` email / dashboard Close with steps still pending (workflow), OR `close+` / dashboard Close on any crypto event regardless of threshold (Module 9, gated on `completion.closed_by === 'initiator'`) | terminal; also written as `completion.completed_at`; distinguished from `completed` by whether the natural path was taken (workflow: all steps done; crypto: threshold reached without initiator close) |
| `archived` | **hidden by default**; `?show=archived` toggle (grey pill) | no (still commit for audit trail) | 45d past reference clock, or future manual archive | `POST /manage/event/:id/unarchive` to `open` |

(docs/archive/prd.md:834-840)

**Reference clock.** Staleness is `max(deadline across pending steps)` when any pending step has a deadline, else `event.activated_at`, so deadline-less events age from going live. (docs/archive/prd.md:842-846)

**Hourly sweep.** `app/bin/sweep.js` runs hourly via `gitdone-sweep.timer`, three passes in order (docs/archive/prd.md:848-870):

1. **Pending-activation GC.** Delete events with `activated_at === null` and `age > GITDONE_ACTIVATION_TTL_HOURS` (default 72h), removing impersonation-attempt residue. The 15-min knowless link TTL is independent: an unused link expires first and the user can request a fresh one from `/manage` until the 72h GC. (docs/archive/prd.md:851-858)
2. **Overdue nudge.** For every active event with `(now - referenceClock) > GITDONE_OVERDUE_NUDGE_DAYS` (default 14) and no `nudged_overdue_at`, email the organiser once ("N days past deadline, still waiting on X / Y — remind, close, or ignore") and persist `nudged_overdue_at`. The write happens BEFORE the send so a mid-send crash prefers one email not sent over N emails sent. (docs/archive/prd.md:859-865)
3. **Auto-archive.** For every active event with `(now - referenceClock) > GITDONE_ARCHIVE_DAYS` (default 45), set `archived_at` and `archive_reason: 'auto_stale'`, and email the organiser with a reversal pointer; reversible via `POST /manage/event/:id/unarchive`. (docs/archive/prd.md:866-870)

**Archive semantics.** An archived event is not complete; it is reversibly off-stage. Replies to its reply addresses still commit to git (audit trail wins) but do not count toward completion, and the sender gets a threaded auto-reply saying so. Sweep touches only `event.json` + tokens; git repos and OTS proofs are never altered or deleted (§0.1 "proofs outlive the service"). (docs/archive/prd.md:872-878)

**Session `/manage` hub filtering.** The dashboard lists only active events by default; `?show=archived` surfaces archived records (still verifiable and reachable via their per-event management link), and the toggle appears only when the signed-in email actually has archived events. (docs/archive/prd.md:880-884)
