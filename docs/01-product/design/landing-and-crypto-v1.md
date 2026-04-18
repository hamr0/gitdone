# Landing page + crypto form — v1 (Design Lab winner: variant F)

**Shipped:** 2026-04-19 as commit 1.H.3 — Live Canvas variant F.
**Routes:** `GET /`, `GET /crypto/new`, `POST /crypto` in `app/bin/server.js`.

Frozen reference for the v1 shape so future Design Lab runs can diff
against it.

## Decisions locked in

1. **Two-CTA landing.** Not three. Declaration and attestation are
   *modes* of the crypto event, not separate products. The third CTA
   would have been a false split (PRD §4.3: shared engine).
2. **Progressive disclosure inside the form.** Mode picker is part of
   the crypto form, not a pre-form step. Landing sends users to one
   URL (`/crypto/new`); the form picks the mode.
3. **Dense one-page grid, no numbered sections** for the crypto form.
   Five alternatives tested (big cards, segmented control, pill toggle,
   stacked cards, F2-sectioned grid). The non-sectioned flat grid won
   on density and consistency with the "fields dim in place" pattern.
4. **Segmented mode row** at the top — `[ declaration | attestation ]`
   — with an inline hint explaining what the current mode means.
   Fields below dim (opacity 0.42, pointer-events none) with a small
   per-mode label suffix ("· declaration only" / "· attestation only")
   when they don't apply to the picked mode.
5. **Attestation explainer near the title:** `anyone you share the
   reply address with can sign`. Flagged by user during Live Canvas —
   without it, the form left ambiguous whether the initiator enters a
   list of emails.

## Why F, not E

E also used a compact grid but kept numbered section headers. F dropped
them entirely: with only ~6 fields, sections added noise. Numbered
headers remain the canonical pattern on the event form (`v1 event-form`)
where ~8 fields + a step table genuinely warrant grouping.

## Landing shape

```
┌──────────────────────────────────────────────┐
│ gitdone                                      │
│ Multi-party actions coordinated by email,    │
│ proved by git.                               │
│                                              │
│ [ Create Event ]  [ Create Crypto ]          │
│ ────────────────────────────────────         │
│ Event — workflow with ordered or parallel    │
│ steps. Crypto — one declaration or an        │
│ attestation. Proofs verify offline via       │
│ gitdone-verify.                              │
└──────────────────────────────────────────────┘
```

- Primary button filled `#0645ad`, secondary outlined.
- Dashed-top `<p class="how">` block explains both types in a single
  paragraph with inline emphasis.

## Crypto form shape

```
New crypto event            attestation · anyone you share...

┌ Mode: ( ) declaration  (•) attestation    N distinct signers... ┐

 Title  ───────────────────────────────────────
 Your email ───────────   Signer's email · dec only (dim) ─────
 Threshold (N) ────        Dedup rule ▾
 ☐ Allow anonymous replies

                                          [ Create → ]
```

## Patterns to reuse

- `[data-variant-root="X"]` CSS scoping is a lab-only idiom; production
  form uses plain classnames.
- Dim-in-place for conditional fields: `.dim { opacity: 0.42;
  pointer-events: none; }` + `::after` suffix on the label span.
- Mode-aware server-side rendering: `values.mode === 'declaration'`
  decides which class (`dim` vs not) is applied to signer/threshold/
  dedup/anonymous fields on re-render.
