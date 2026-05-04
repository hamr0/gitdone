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
| 11 | Completion notice | Event reaches terminal state | Initiator + every contributor |
| 12 | Bounce alert | DSN arrives for a participant invite | Organiser |
| 13 | Pending-activation reminder | Event sat unactivated >48h | Organiser |
| 14 | Overdue nudge | Event past deadline with open steps | Organiser |
| 15 | Auto-archive notice | Inactive event auto-archived | Organiser |
| 16 | Initiator command — stats | Inbound to `stats+<id>@` | Sender (initiator) |
| 17 | Initiator command — remind | Inbound to `remind+<id>@` | Sender (initiator) |
| 18 | Initiator command — close | Inbound to `close+<id>@` | Sender (initiator) |
| 19 | Verify report | Inbound to `verify+<id>@` | Sender |
| 20 | Re-verify report | Inbound to `reverify+<id>-<seq>@` | Sender |

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
Reply-To is the same per-step address the inbound was sent to so the
participant's MUA threads correctly.

| # | Reason | Subject |
|---|--------|---------|
| 4 | accepted | `[gitdone] Accepted — <title> — <step> [<idx>/<total>]` |
| 5 | `missing_attachment` | `[gitdone] Attachment required — <title> — <step> [<idx>/<total>]` |
| 6 | `event archived` | `[gitdone] Event archived — <title>` |
| 7 | `event not activated` | `[gitdone] Event not yet activated — <title>` |
| 8 | event closed | `[gitdone] Event closed — <title>` |

Bodies all open with "Thanks — we received your reply for "<step>" on
event "<title>".", then explain the specific outcome and the audit
trail guarantee.

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

## 18. Initiator command — close

- **Trigger.** DKIM-authenticated reply to `close+<id>@<domain>`.
- **Sent by.** `app/bin/receive.js`.
- **Subject.**
  - workflow: `[gitdone] closed "<title>" [<done>/<total>] step done`
    (or `… complete` if it had already finished naturally).
  - crypto: `[gitdone] closed "<title>" — <mode> · <open|complete>`.
- **Body.** Confirmation that the event is now closed, plus the
  completion timestamp. The event itself also fans out a
  **completion notice** (#11) to participants.

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
