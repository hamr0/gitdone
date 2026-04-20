# gitdone

**Multi-party actions coordinated by email. Proved by git.**

Live at **https://git-done.com**.

---

## What it is

A free tool for running workflows and gathering signatures entirely
over email. Every reply is cryptographically verified, stamped against
Bitcoin, and committed to a permanent public record. No accounts. No
passwords. No apps to install. If gitdone disappears tomorrow, every
record still verifies — forever.

## What you can do with it

### Coordinate a workflow with several people

"Legal reviews the contract, then design mocks it up, then the exec
team signs off." Create an event with those three steps, put each
person's email in, add deadlines if you want, decide who waits for
whom. Each person gets a reply address they respond to from their
normal inbox. gitdone watches for their replies, verifies they really
came from the person they claim to come from, and moves the workflow
forward. You see progress in your own inbox and on a dashboard.

Works for any order — ordered chain, parallel, or a mix ("step 3
happens after both step 1 and step 2 are in"). Deadlines are optional
per step. Reminders are one email away.

### Gather a signature — or many signatures

Two modes, depending on what you need:

- **A single signed record.** One person you name replies, and that
  reply becomes a permanent cryptographic record you can point anyone
  at. Good for: witness statements, sign-offs, single approvals.
- **A crowd-sourced attestation.** Share one reply address publicly
  (social post, QR code, mass email). Anyone who replies counts toward
  a threshold you set. Good for: petitions, polls of known signers,
  witness lists, community statements. You choose whether duplicates
  count as one or many.

## How people participate

They get an email. They reply. That's the whole experience.

No account to make. No link to click. No app to install. No password.
If they reply from their own email address, gitdone can cryptographically
prove it came from them. You (the organizer) get a copy in your inbox
with every attachment intact.

## How it's different

- **It outlives the service.** Every record is a git repository plus
  an offline verifier tool. If gitdone-the-website dies, the records
  still exist on your disk, and anyone can check they're real without
  any gitdone server. Most online tools go away with the company; these
  don't.
- **You own the evidence.** The full audit trail — every reply, every
  cryptographic signature, every timestamp — lands in your inbox and
  in a repository you control.
- **Nothing to install.** Participants never sign up for anything,
  never install anything, never read terms of service. They reply to
  an email.
- **No tracking.** gitdone doesn't watch your activity, doesn't build
  a profile, doesn't sell anything. No ads. No analytics. No up-sell.
  The business model is that there is no business model.

## When you'd use it

- Vendor sign-offs, contract approvals, campaign launches — anything
  where several people have to say "yes" in order, and you want proof.
- Petitions and attestations — when you need N real people to put
  their names to something, with proof it was them.
- Release gates, change requests, board resolutions — anywhere a paper
  trail would be useful but a full CRM is overkill.
- Legal, compliance, or audit-adjacent work where the evidence has to
  survive the tool that collected it.

## When you wouldn't

- Anything that needs a rich form — gitdone asks for short replies,
  not structured data.
- Chat. It's not a chat app.
- Anything that needs recipients who can't receive verified email
  (SMS-only, address-book-only, etc.).

## Start one

1. Open **https://git-done.com**
2. Pick **Event** (workflow) or **Crypto** (signature).
3. Fill in names, emails, deadlines.
4. Review the preview. Confirm.
5. Invites go out. A management link arrives in your inbox.

Or skip the link and sign in at **https://git-done.com/manage** —
enter your email, receive a one-time link, see every event you've
ever organized. No password involved.

## Verifying a record

Every completed event leaves behind a small git repository. Anyone
who has it (you, the participants, an auditor) can verify it offline
with the open-source `gitdone-verify` tool. No network calls, no
gitdone service, no trust in us. Works from a USB stick on an
airgapped laptop ten years from now.

## The fine print

- gitdone never stores attachments — they're forwarded to the
  organizer and hashed into the record. The hash lives forever; the
  attachment lives in your inbox.
- Email addresses in the record are hashed with a per-event salt, not
  stored in plaintext. Anyone with the original email can confirm a
  match; no one can scrape the repository for a contact list.
- The service concentrates trust in four places, all named up front:
  the participants' mail providers (who sign their replies with DKIM),
  Bitcoin miners (who anchor the OpenTimestamps stamps), git (which
  uses SHA-1 for commit hashes), and whoever maintains the verifier
  tool. We don't pretend there's no trust; we try to make it visible.

## Docs

- [Product requirements (PRD)](docs/01-product/prd.md) — what it is,
  what it isn't, why.
- [Changelog](CHANGELOG.md) — what shipped, newest first.
- Source: <https://github.com/hamr0/gitdone>.

## Licensing

The `gitdone-verify` tool is and will remain MIT-licensed — every
record must stay independently verifiable, forever.
