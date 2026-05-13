# Deploy log

One line per successful production deploy. Newest first.

- 2026-05-13T10:37Z · `9b639ec` · docs: bump 0.20.0 -> 0.21.0; PRD + README catch up on proof-email split
- 2026-05-13T10:16Z · `a482086` · proof email: mode-aware bodies, role-aware splits, ref docs echoed
- 2026-05-13T09:19Z · `5d9ba64` · ux: signer-field disable in attestation mode + mode-badge + counts clarity
- 2026-05-12T21:39Z · `7de26e1` · revert: drop the 4e diagnostic — missing email was gmail spam, not a bug
- 2026-05-12T20:48Z · `8a085d6` · crypto rework module 4e: attestor completion notification (strict only)
- 2026-05-12T19:24Z · `a8db6f3` · fix: strict attestation never flipped event.completion to complete
- 2026-05-12T16:33Z · `f541be5` · crypto rework module 5: prominent mode badge on manage hero
- 2026-05-12T16:17Z · `09f843f` · fix: attestation reference docs row was never ticking — read attestor_progress
- 2026-05-12T14:36Z · `b77ce9a` · fix(4d-followup): revert misguided per-sign initiator email + add final-ack regression test
- 2026-05-12T14:29Z · `3ad8644` · crypto rework module 4d (followup): three more UX fixes
- 2026-05-12T13:50Z · `640e178` · crypto rework module 4d: UX polish on strict-signing flow
- 2026-05-12T12:35Z · `c208fdb` · crypto rework module 4c: strict signing — signer attaches matching files
- 2026-05-11T21:45Z · `6ade39d` · crypto rework module 4a: attach+<id>@ reference-doc channel + derived gating
- 2026-05-11T21:09Z · `0a0b3c3` · crypto rework module 3: optional reference_url field
- 2026-05-10T11:32Z · `7ce73a0` · og card: wire og:image so link previews render a banner
- 2026-05-08T10:23Z · `ea243b3` · crypto rework module 2: self-reply now produces an explanatory ack
- 2026-05-08T09:15Z · `de5a8d2` · crypto rework module 1: require details (the ask) on creation
- 2026-05-07T20:47Z · `d5b9b9b` · attestation reply ack: counter tag on the subject ([1/2], [5/2] etc)
- 2026-05-07T20:44Z · `e9e9b6c` · attestation reply ack: fix off-by-one on reply count
- 2026-05-07T07:33Z · `c6d8a95` · ots upgrade: surface anchored state on the manage page (+ block height)
- 2026-05-07T06:49Z · `556c628` · deploy-log: fold prior d503b87 deploy entry
- 2026-05-07T06:20Z · `d503b87` · PRD §6.2: document the unified filter row on the manage hub
- 2026-05-07T06:18Z · `1611ad7` · manage hub: unified filter row — type + status pills, all clickable
- 2026-05-06T21:33Z · `584a4b5` · manage hub: events/crypto type-filter pills (top-right)
- 2026-05-06T21:03Z · `53961f3` · QA deferred items: DKIM test fixture + overrides smoke + byte-strict pin + EADDRINUSE guard
- 2026-05-06T20:46Z · `5f54827` · Tests + frozen design ref for the QA-fix render changes
- 2026-05-06T20:09Z · `1b2df94` · Sync repo event.json on every state transition (offline-verifier fix)
- 2026-05-06T19:51Z · `8f1e1ac` · deploy.md: periodic hygiene + active-overrides table
- 2026-05-06T19:49Z · `1376d3e` · CHANGELOG: knowless bump + npm audit cleanup notes
- 2026-05-06T19:47Z · `f19a297` · Fold deploy-log entries from e12744b + 0d8611c
- 2026-05-06T19:34Z · `e12744b` · Bump knowless 1.1.1 -> 1.1.3
- 2026-05-06T19:30Z · `6c776c3` · Proof bundle download + verify-tool crypto support + README rewrite + attestation cap 50
- 2026-05-06T19:01Z · `900bf79` · Surface cryptographic proof on dashboards + durable proof emails
- 2026-05-06T17:52Z · `492b707` · Attestation overhaul: dedup-derived trust, accumulating keeps counting, click-to-copy
- 2026-05-06T14:22Z · `12bd825` · Pending events accessible to signed-in initiator + crypto signer MX parity
- 2026-05-06T12:42Z · `8f65bb9` · Crypto reply acks: type-aware subject + body, no "null" leak
- 2026-05-06T12:36Z · `0e30e9f` · CHANGELOG: step delivery error resets on participant edit
- 2026-05-06T12:35Z · `ccf7000` · editEvent: clear step.last_send_error on participant change
- 2026-05-06T12:32Z · `431b0b5` · Docs: CHANGELOG sweep + PRD close-2step + README links
- 2026-05-06T12:26Z · `61e12cf` · Crypto pending-activation parity + dated 72h warning + typed manage title
- 2026-05-06T12:20Z · `2bde554` · Crypto declaration: reject signer == initiator (no self-sign)
- 2026-05-06T12:04Z · `ba36413` · Mobile responsive pass: landing, create form, dashboard
- 2026-05-04T20:37Z · `792f9b8` · close+: two-step confirm with 30-min token (email path only)
- 2026-05-04T20:21Z · `dae9348` · remind+: tag participant subject as reminder, unify command receipts
- 2026-05-04T20:17Z · `9230c3f` · Stats command: [N/M] step-done subject + email-formats.md catalog
- 2026-05-04T19:12Z · `cca6c87` · Layout header (home): tight wordmark, bold, bumped one size
- 2026-05-04T19:07Z · `0aef4fb` · Layout header: split "gitdone — <tagline>" titles onto two lines
- 2026-05-04T19:01Z · `7a2ff0b` · Landing: add two-line page title above the hero, restore old hero
<<<<<<< Updated upstream
=======
- 2026-05-04T18:57Z · `2098755` · Landing tag: drop 44ch max-width cap so the one-liner stays one line
- 2026-05-04T18:54Z · `1ba1ab4` · Landing: replace kicker + long tag with bare wordmark + one-liner
- 2026-05-04T18:50Z · `ce32254` · deploy-log: 9216f8d (deploy.md step expansion)
>>>>>>> Stashed changes
- 2026-05-04T18:40Z · `9216f8d` · deploy.md: expand each of the 14 steps with command + rationale
- 2026-05-04T18:38Z · `7d47a5a` · docs: link ops/deploy.sh + deploy.md from index and CLAUDE.md
- 2026-05-04T18:36Z · `6a83a55` · deploy: silence transient 502 stderr during health polling
- 2026-05-04T18:34Z · `53ffaaa` · deploy: ignore untracked files in clean-tree check
