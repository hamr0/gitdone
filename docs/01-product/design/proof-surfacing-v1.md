# Proof Surfacing v1 — trust ladder + receipts on every dashboard

**Frozen:** 2026-05-06. Updated 2026-05-06 with optional attachment surfacing
(per-row 📎 indicators on both layouts; filenames + truncated `sha256` inside
the receipt block).

**Origin:** Design Lab winners — variant C3 ("proof headline") for crypto
events, variant W2 ("trust strip") for workflow events. Tokens shared
with [`terminal-theme-v1.md`](terminal-theme-v1.md).

The dashboard surfaces the cryptographic proof — DKIM verification,
SPF/DMARC/ARC, raw email hash, OpenTimestamps anchor — as the headline
content. PRD §0.1.4 ("invisible beats correct") flips: the proof comes
to the user, not the user to the proof.

## Trust ladder — 4 rungs

Ascending order, left to right: `unverified · authorized · forwarded ·
verified`. The "achieved" rung is the trust level the event reached.

| Rung | Color | Style |
|---|---|---|
| `verified`   | `#3fb950` (green) | DKIM-VERIFIED |
| `forwarded`  | `#58a6ff` (blue)  | ARC-FORWARDED |
| `authorized` | `#ffb000` (amber) | SPF-AUTHORIZED |
| `unverified` | `#6e7681` (grey)  | UNVERIFIED |

Render rules:

- **Achieved rung** — solid fill in its trust color, dark text (`#0d1117`).
- **Rungs below achieved** — outlined in *their own* trust color (border
  + matching text), no fill. Reads as "those checks would also pass."
- **Rungs above achieved** — dim grey: border `#30363d`, text `#6e7681`.
- **No achievement (no commit yet)** — every rung dimmed.

CSS class: `.trust-ladder` (4-column grid). Each rung carries
`data-level="<level>"` for QA + tests.

## Crypto layout (C3)

Render at the top of `/manage/event/:id` for `event.type === 'crypto'`,
both modes.

```
┌──────────────────────────────────────────────────┐
│  [unverified] [authorized] [forwarded] [VERIFIED]│  ← ladder
├──────────────────────────────────────────────────┤
│  DKIM-VERIFIED · @example.com · 2026-04-15       │  ← headline
│  "Witness statement" · id 3gq6gdkp9jxh           │  ← sub
├──────────────────────────────────────────────────┤
│  Type        declaration                         │
│  Initiator   journo@example.com                  │  ← secondary
│  Signer      witness@example.com                 │
│  Reply addr  event+...@signedreply.com              │
│  Status      signed on 2026-04-15                │
├──────────────────────────────────────────────────┤
│  ▸ Cryptographic proof                           │  ← <details>
│    DKIM    pass · header.i=@... · selector...    │
│    SPF / DMARC                                   │
│    ARC                                           │
│    OTS     pending Bitcoin upgrade               │
│    Raw hash sha256:2a30…c4c0                     │
│    Attachments (only if present)                 │
│      contract.pdf  sha256:aaaa…0000  · 100.0 KB  │
│      photo.jpg     sha256:1111…ffff  · 512.0 KB  │
│    $ gitdone-verify <event-id>                   │
└──────────────────────────────────────────────────┘
```

- **Declaration** — ladder uses the single counting commit's
  `trust_level`. Headline is `<TRUST_LABEL> · @<sender_domain> · <date>`.
- **Attestation** — ladder uses the modal trust level across counted
  replies (ties → highest). Headline reads either:
  - `<MODAL> · <count> replies · threshold reached <date>`
    (accumulating, threshold crossed), or
  - `<MODAL> · <count> of <threshold>` (in flight, locking).
  - `<MODAL> · <count> of <threshold> · complete <date>` (locking,
    completed).
  Trust tiles below the headline show non-zero counts per class.
- **Per-reply ledger rows** — each row shows `domain · date · TRUST`. When
  the reply carried attachments, a green `📎 N` pill renders before the
  trust label and a sub-row lists `<filename>  sha256:head…tail` for each
  attachment. Rows without attachments stay single-line.
- **Pre-completion** — no commit yet → ladder dimmed, headline reads
  `PENDING SIGNATURE` (declaration) / `PENDING REPLIES` (attestation).
  The receipt `<details>` is omitted.

The receipt `<details>` is collapsed by default. The `gitdone-verify`
line carries `.copyable` for click-to-copy.

## Workflow layout (W2)

Render above the steps table for `event.type === 'event'` when at least
one step is complete.

```
┌──────────────────────────────────────────────────┐
│  3 of 5 steps complete · 2 verified · 1 forwarded│  ← strip line
├──────────────────────────────────────────────────┤
│  [unverified][authorized][FORWARDED][verified]   │  ← ladder
│  CHAIN OF TRUST — LADDER CAPS AT THE WEAKEST     │
└──────────────────────────────────────────────────┘
```

- **Strip line** — `<K> of <N>` complete + per-class trust pills
  (`<n> verified`, `<n> forwarded`, `<n> authorized`, `<n> unverified`).
  Skip zero-count classes.
- **Ladder achieved level** — the WEAKEST trust level present across
  completed steps. Communicates the chain-of-trust property: a workflow
  is only as trusted as its least-trusted commit.

The steps table below renders unchanged, with one addition: completed
steps carry an inline trust pill next to the status cell. Clicking the
pill expands an inline `<tr class="mg-proof-row">` showing that step's
proof receipt (DKIM/SPF/DMARC/ARC/OTS/hash). Toggle is JS-only; the
HTML server-renders both the pill and the (initially hidden) drawer
row, so JS-disabled clients still see the trust pill colour.

When the step's reply carried attachments, a second pill `📎 N` renders
in CRT green (`#3fb950`) immediately to the right of the trust pill.
It carries the same `data-step` hook, so clicking either pill toggles
the same drawer. The drawer's receipt block now also lists each
attachment's filename + truncated `sha256` (humans glance, verifiers
clone the bundle). Step rows without attachments only show the trust
pill — the attach pill is purely additive.

## Helper module — `app/src/web/proof-render.js`

Pure HTML helpers; no I/O. Consumed by both the management dashboard
and the proof-email composers.

| Export | Purpose |
|---|---|
| `renderTrustLadder({ achieved })` | 4-rung HTML ladder with the gradient rules above. |
| `renderTrustPill({ level })` | Inline pill `[ <TRUST_LABEL> ]` coloured by level. |
| `renderAttachmentPill({ count, stepId })` | Green `📎 N` pill; same `data-step` hook as the trust pill. |
| `renderProofReceipt(commit, eventId)` | Full key/value receipt + offline-verify command (includes attachments when present). |
| `aggregateTrust(items)` | Returns `{ counts, modal, weakest }` for a list of commits/replies. |
| `truncHash(sha)` | `sha256:head4…tail4` shorthand. |
| `plainReceipt(commit)` | ASCII-only receipt block for proof emails. |
| `otsStatusLabel(commit)` | "anchored at block N" / "pending Bitcoin upgrade" / "no proof". |

All HTML helpers return `templates.raw`-tagged values — safe to
interpolate into `html\`\`` template literals.

## Proof emails

Two durable artefacts ship the proof outside the dashboard. Both are
ASCII-only (per outbound rule) and verify offline against the per-event
git repo.

### 1. Completion proof (`[signedreply] proof — "<title>"`)

Sent when an event flips to `completion.status === 'complete'`. Triggers:

- Workflow: a counting reply lands the final step, OR the organiser
  closes early.
- Declaration: the signer replies.
- Attestation (locking dedup): the threshold is crossed.
- Attestation (accumulating): the organiser closes explicitly.

Recipient list:

- Initiator (always).
- Workflow: every step participant.
- Declaration: the signer.
- Attestation: only the initiator (replies may be anonymous; salted
  hashes can't be reversed).

The body opens with "this email is your durable proof of completion",
embeds the per-step / per-commit cryptographic receipts, and closes
with the offline `gitdone-verify <event-id>` command. The
`Message-Id` is persisted on `event.proof_email_message_id` so the
follow-up email can thread to it.

For workflow events the subject keeps `[N/M]`; crypto subjects drop the
counter.

### 2. Anchored proof (`[signedreply] proof anchored — "<title>"`)

Sent when the OTS-upgrade worker upgrades the LAST pending proof for an
already-completed event (i.e. zero pending `.ots` files remain). Once
per event — the sentinel `<repo>/ots_proofs/.anchored-notified`
suppresses re-sends.

Body lists the Bitcoin block height (when parsed), the anchor timestamp,
and the proof-file path inside the repo. `In-Reply-To` and
`References` headers point at the completion proof's Message-Id, so
mail clients group the two emails in one thread.

Recipient list mirrors the completion-proof list, but only step
participants whose step is `complete` are included (a participant who
never replied has nothing to anchor).
