# gitdone

<p align="center">
  <img src="https://img.shields.io/github/package-json/v/hamr0/gitdone?label=version&color=2a4f8c" alt="version (auto from package.json)">
  <img src="https://img.shields.io/badge/license-Apache%202.0-2a4f8c" alt="license: Apache 2.0">
</p>

**Email-native multi-party coordination. Cryptographic proof on every reply.**

Live at **https://git-done.com**.

---

## What it is

A tool for two things, both done entirely over email, both proved
cryptographically, both verifiable offline forever — even if gitdone
the service disappears.

### Path 1 — Track a multi-party workflow

"Legal reviews, then Finance approves, then the CEO signs." Pick the
people, pick the order (linear, parallel, mixed). Each step gets its
own reply address. Participants reply from their normal inbox; gitdone
verifies the reply is really from them, commits it to a per-event git
repository, anchors it to the Bitcoin blockchain via OpenTimestamps,
and moves the workflow forward. You see progress in your inbox and on
a dashboard.

### Path 2 — Get a digital declaration or attestation

- **Declaration** — one named person replies, that reply becomes a
  permanent cryptographic record. Witness statements, single
  approvals, sign-offs.
- **Attestation** — share one reply address publicly. Anyone who
  replies counts toward a threshold you set. Petitions, vouches,
  community statements. Three counting modes: unique (one per signer),
  latest (replaceable), accumulating (every reply counts).

---

## How participation works

Recipients **get an email**. They **reply**. That's it.

No account. No app. No magic link to click. No password. They reply
from their own inbox; gitdone uses DKIM to prove the reply really came
from them.

You (the organiser) sign in once via a one-time link to
`https://git-done.com/manage` — magic-link only, no password ever.

---

## Four-tier verification (always shown)

Every reply gets a trust level based on how strong its cryptographic
provenance is:

| Level | Meaning |
|---|---|
| **verified** | DKIM passes, signature aligned with the sender's domain. The strongest proof. |
| **forwarded** | DKIM failed but the ARC chain validates — legitimately forwarded mail. |
| **authorized** | SPF passed but DKIM didn't. Rarer; envelope-aligned. |
| **unverified** | None of the above. Recorded in the audit trail but doesn't count toward completion at default settings. |

Both the dashboard and the two proof emails (see below) show the
trust ladder: the achieved level filled in its color, weaker levels
outlined, stronger levels dimmed. You can require a minimum trust
level per event.

---

## Proof, delivered

Two emails carry the cryptographic receipt outside the dashboard, so
your proof outlives the service:

- **`[gitdone] proof — "<title>"`** — fires once when the event
  completes. Embedded receipt: DKIM result + selector + algorithm,
  SPF, DMARC, ARC, raw email hash, OpenTimestamps state, offline
  verify command. One per recipient who counted; their own
  perspective.
- **`[gitdone] proof anchored — "<title>"`** — fires once per event
  when the OpenTimestamps proof anchors to Bitcoin (every 6 hours).
  Threaded as a reply to the completion email. Carries the block
  height and the `.ots` proof file.

Keep the emails. Together with the per-event git repository they're
your evidence — no gitdone service required to verify them.

---

## Offline verification

Every event leaves behind a small git repository: every reply, every
DKIM key archived at the moment of receipt, every OTS proof, every
hash. Anyone holding a copy can verify it on a disconnected machine
with the open-source [`gitdone-verify`](tools/gitdone-verify/) tool.
One file, Node stdlib only, no calls to any gitdone service:

```sh
gitdone-verify <repo-path>
gitdone-verify <repo-path> --no-ots         # truly offline
gitdone-verify <repo-path> --min-trust verified
```

The bundle is one click away on every event's manage page, or by
emailing `bundle+<id>@git-done.com` from the organiser address.

---

## Start one

1. Open **https://git-done.com**.
2. Pick **Event** (workflow) or **Crypto** (declaration / attestation).
3. Fill in titles, emails, deadlines. Review the preview. Confirm.
4. A magic-link arrives in your inbox. Click it, press **Activate**.
5. Invites go out. Replies start landing.

Or sign in at **https://git-done.com/manage** to see every event
you've ever organised.

---

## Why it's different

- **No accounts.** Participants never sign up, never install
  anything, never read terms.
- **No tracking.** No analytics, no ads, no profile-building.
- **It outlives the service.** If gitdone disappears, the per-event
  repos, the proofs, and the verifier tool all keep working.
- **Hashes, not bodies.** gitdone never stores email content or
  attachments — both are forwarded to the organiser intact; only
  SHA-256 hashes go into the record.
- **Salted, not plaintext.** Email addresses are hashed with a
  per-event salt; the repo can't be scraped for a contact list.

---

## Event lifecycle (for workflow events)

- **Pending activation** — nothing leaves the server until the
  organiser presses Activate. Auto-deleted at 72h if not activated.
- **Open** — replies come in, steps complete, the dashboard updates.
  Deadlines are aspirational; late replies still count.
- **Day 14 past deadline → nudge** ("remind, close, or ignore"); no
  cascade.
- **Day 45 past deadline → auto-archive** (greyed out, replies stop
  counting, one-click un-archive); nothing is deleted.
- **Terminal states are written by the organiser**: complete (every
  step done) or closed (organiser ends it early). Both write a
  permanent commit.

---

## Trust concentration (named, not hidden)

Trust ultimately rests on four pieces gitdone doesn't own:

1. **Sender mail providers** that sign replies with DKIM.
2. **Bitcoin miners** who anchor OpenTimestamps stamps.
3. **Git** (whose commit hashes use SHA-1).
4. **The verifier tool maintainer** — currently us, but the tool is
   MIT-licensed and self-contained, so anyone can fork it.

We don't pretend there's zero trust; we try to make it visible.

---

## Docs

- [PRD](docs/01-product/prd.md) — what it is, what it isn't, why.
- [Email formats](docs/01-product/email-formats.md) — every email
  gitdone sends, end-to-end.
- [Design references](docs/01-product/design/) — terminal theme,
  proof surfacing, frozen UI specs.
- [Deploy](docs/04-process/deploy.md) — `ops/deploy.sh` contract.
- [Changelog](CHANGELOG.md) — what shipped, newest first.
- Source: <https://github.com/hamr0/gitdone>.

---

## Licensing

`gitdone-verify` is and will remain MIT-licensed — every record must
stay independently verifiable, forever. Contact:
**feedback@git-done.com** (real human).
