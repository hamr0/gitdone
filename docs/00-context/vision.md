# Vision

## What GitDone is

A free tool for running multi-party workflows and gathering signatures
entirely over email. Every reply is cryptographically verified, stamped
against Bitcoin via OpenTimestamps, and committed to a per-event git
repository. That repository is the final artifact: anyone who has it
(the organizer, a participant, an auditor) can verify every signature
offline, forever, with no gitdone server involved.

## Core bet

> Coordination tools lose their records when the company dies.
> gitdone produces cryptographically-verifiable git repos as a *side
> effect* of coordination. If the service dies, the records still work.

## Who it's for

- Organizers who need several people to say "yes" in order — contract
  approvals, vendor sign-offs, release gates, campaign launches.
- Legal / compliance / audit-adjacent work where the evidence has to
  survive the tool that collected it.
- Petitions and attestations — gathering N real people's names with
  cryptographic proof they're real.

## Who it isn't for

- Structured data collection — gitdone asks for short replies, not forms.
- Chat.
- Audiences that can't receive DKIM-signed email.

## Design stance (full list: PRD §0.1)

1. **No accounts, ever.** Participants reply to emails. No sign-up, no
   passwords, no app.
2. **Proofs verify without gitdone being alive.** The `gitdone-verify`
   tool is MIT-licensed and takes a cloned repo. That's all.
3. **No public API in Phase 1.** The git repo IS the API. Integrators
   clone and parse.
4. **Invisible beats correct.** If a feature makes a participant think,
   reject it.
5. **No analytics.** No cross-event aggregation. No "my gitdone." The
   business model is that there isn't one.
6. **Name the trust deposits.** We don't pretend trust is eliminated;
   we pin it to four visible places: mail providers (DKIM), Bitcoin
   miners (OTS anchor), git collision resistance, and the verifier
   tool maintainers.

## Status

Phase 1 shipped to production (https://git-done.com) on 2026-04-20.
See `CHANGELOG.md` for what landed; see `docs/01-product/prd.md` for
the authoritative specification.
