# Email formats

Every email gitdone sends, indexed by trigger. For each: who sends it,
who receives it, the subject template, the body shape, and the source
file. Subjects follow a consistent grammar:

- **Tag** — every gitdone-originated subject starts with `[gitdone]`.
- **Title quoted** — the event title is wrapped in double quotes when
  present, so subjects that survive auto-quoting in mail clients still
  read clearly.
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
| 4d | accepted | `[gitdone] Signed — <title>` |
| 5d | `missing_attachment` | `[gitdone] Attachment required — <title>` |
| 6d | `event archived` | `[gitdone] Crypto Declaration archived — <title>` |
| 7d | `event not activated` | `[gitdone] Crypto Declaration not yet activated — <title>` |
| 8d | `event closed` | `[gitdone] Crypto Declaration closed — <title>` |

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
| 4a-partial | accepted, threshold not yet reached | `[gitdone] Attestation reply recorded — <title>` |
| 4a-final | accepted, this reply hits the threshold | `[gitdone] Attestation complete — <title>` |
| 5a | `missing_attachment` | `[gitdone] Attachment required — <title>` |
| 6a | `event archived` | `[gitdone] Crypto Attestation archived — <title>` |
| 7a | `event not activated` | `[gitdone] Crypto Attestation not yet activated — <title>` |
| 8a | `event closed` | `[gitdone] Crypto Attestation closed — <title>` |

Accepted body (partial):

```
Your reply to Crypto Attestation "<title>" was recorded.
It's DKIM-verified, OpenTimestamped, and committed to the event's
git audit trail.

Replies so far: <K>/<threshold>. The attestation stays open until the
threshold is met.

Requester: <initiator>
```

When the reply that lands tips the count to threshold, the body
swaps to:

```
…
Threshold reached (<threshold>). The audit trail is sealed.
…
```

## 9. Activation receipt

- **Trigger.** Organiser POSTs `/manage/event/<id>/activate`.
- **Sent by.** `notifyOrganiserOfActivation`.
- **Recipient.** `event.initiator`.
- **Subject.** `[gitdone] "<title>" — activated, <K> invitation(s) sent`
- **Body.** Confirms what just left, lists every step with `▸` next to
  the ones currently waiting on a participant, and a per-recipient
  `sent`/`FAILED` delivery line so synchronous send errors are visible
  immediately.

## 10. Step-progress update

- **Trigger.** A step transitions to `complete` and the cascade unblocks
  zero-or-more downstream steps.
- **Sent by.** `notifyOrganiserOfStepProgress`.
- **Recipient.** `event.initiator`.
- **Subject.** `[gitdone] "<title>" [<N>/<M>] step done · next active`
  (the ` · next active` suffix is dropped when no downstream steps
  unblocked — i.e. fan-in waiting on parallel branches).
- **Body.** Which step finished and by whom, what's now active, and
  the step list with `▸` markers.

## 11. Completion notice

- **Trigger.** Event reaches `complete` (all steps done, declaration
  signed, attestation threshold met, or `close+` initiator command).
- **Sent by.** `notifyEventCompletion`.
- **Recipient.** Initiator + every distinct contributor (one email per
  address).
- **Subject.** `[gitdone] "<title>" — completed [<done>/<total>]` or
  `[gitdone] "<title>" — closed early [<done>/<total>]`. Crypto events
  drop the `[N/M]` since they have no step counter.
- **Body.** Two variants:
  - **Organiser.** Title, ID, completion timestamp, reason label, the
    final-step pointer (which step closed it), the full step table,
    and a paragraph on the offline-verifiable audit trail.
  - **Participant.** Slim version — no step table (private to the
    organiser); just title, reason, and the audit-trail guarantee.

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
- **Subject.** `[gitdone] "<title>" - activate within <H>h or it expires`
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
- **Sent by.** `app/bin/receive.js` (composer in `app/src/email-commands.js`).
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
2. Quote the event title with `"…"` when present.
3. Use `[N/M]` for workflow progress; drop it for crypto.
4. Separate clauses with ` — ` (em dash) or ` · ` (middle dot for
   tighter pairs like `complete` / `next active`).
5. Keep subjects bounded — if the natural form grows with step count,
   move detail into the body and surface only the counter.
6. Set `Auto-Submitted: auto-replied` (acks) or `auto-generated`
   (alerts) so loops are killed by the inbound prefilter.
