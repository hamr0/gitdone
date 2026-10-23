---
title: GitDone — Product Requirements Document
theme: Email-native cryptographic proof of coordination
source: docs/archive/prd.md
summary: GitDone is a universal coordination protocol that turns DKIM-verified email replies into independently verifiable, git-backed proof of multi-party actions.
---

# GitDone — Product Requirements Document

## What GitDone is

GitDone is a universal coordination protocol for getting cryptographically verifiable multi-party actions, using email as the participant interface and git as the permanent record. (docs/archive/prd.md:69-69)

An initiator defines what needs to happen, who needs to do it, and when it is done. Participants receive emails and reply. Their replies are DKIM-verified, timestamped via OpenTimestamps, and committed to a per-event git repository. When the completion criteria are met, the event closes and the repository becomes the permanent, independently verifiable proof. (docs/archive/prd.md:71-71)

## Two event types

Two event types cover every use case. (docs/archive/prd.md:73-73)

- **Event (workflow):** named steps with ordering (sequential, non-sequential or hybrid). Completion means all steps are done. Examples: wedding vendor coordination, multi-signer contracts, release approval chains. (docs/archive/prd.md:75-75)
- **Crypto:** one of two sub-modes. (docs/archive/prd.md:77-77)
  - **Declaration:** exactly one DKIM-verified email, one signer, one cryptographic record. Examples: personal declaration, timestamped statement, whistleblower submission, single-party consent. (docs/archive/prd.md:78-78)
  - **Attestation:** multiple DKIM-verified emails from distinct signers, with count-based completion. Examples: vouching, petitions, peer review quorums, multi-witness statements, supply chain checkpoints. (docs/archive/prd.md:79-79)

Attestation also carries a dedup rule: `unique`, `latest` or `accumulating`. (docs/archive/prd.md:81-92)

## Why it is novel

- Cryptographic proof of a human action normally requires account systems or blockchains. GitDone uses DKIM, which every major mail provider already deploys. (docs/archive/prd.md:96-96)
- Third-party verifiability normally requires trusted CAs or consensus. GitDone uses git plus OpenTimestamps, which is Bitcoin-anchored. (docs/archive/prd.md:97-97)
- One-click participation is normally impossible with the above. GitDone uses email reply, which has been universal since 1982. (docs/archive/prd.md:98-98)

## One-paragraph summary

GitDone v2 lets an initiator define any cryptographically verifiable action and receive immutable proof of completion. That action can be a multi-step workflow (Event), a single-signer record (Declaration) or a multi-signer attestation with N distinct signers (Attestation). Participants act by replying to emails. Their mail providers DKIM-verify the replies, attachments are forwarded to the event owner and never stored on the server, and metadata is committed to a per-event git repository with OpenTimestamps anchors to Bitcoin. (docs/archive/prd.md:1687-1687)

The result is independently verifiable proof built on infrastructure already deployed globally (DKIM, email, git). It needs no accounts, blockchains, vendor services or user-managed cryptography. The initiator uses a minimal web UI, and participants never touch anything except their email client. (docs/archive/prd.md:1687-1687)

## PRD pages

- [Principles, scope and risks](/docs/wiki/principles-scope-and-risks.md): design principles, success criteria, out of scope, risks
- [Event and crypto type models](/docs/wiki/event-and-crypto-type-models.md): workflow DAG, declaration and attestation, dedup, strict signing
- [Participant and initiator email experience](/docs/wiki/participant-and-initiator-email-experien.md): what participants and initiators see and do
- [Cryptographic proof and trust levels](/docs/wiki/cryptographic-proof-and-trust-levels.md): what the proof guarantees and doesn't, the trust ladder
- [Architecture, v1-to-v2 and deployment](/docs/wiki/architecture-v1-to-v2-and-deployment.md): v1, v2 changes, architecture, infrastructure
- [Rollout phases and findings log](/docs/wiki/rollout-phases-and-findings-log.md): phase plan, Phase 0 results, numbered findings
