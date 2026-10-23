---
title: Principles, scope and risks
theme: Principles, scope and risks
source: docs/archive/prd.md
summary: The ten non-negotiable design principles, per-phase success criteria, deliberate out-of-scope items, known risks and open questions, and alignment with the project's dev rules.
---

# Principles, scope and risks

## 0. Design Principles (non-negotiable)

Identity and authentication systems have drifted toward centralization, surveillance or extraction for 60 years. The principles are structural defenses against that drift, each a lesson from a failed or captured predecessor (docs/archive/prd.md:12-12).

### 0.1 Principles

1. **No user accounts. Ever.** Every URL is event-scoped or public stats. There are no cross-event profile pages, no "my gitdone" and no "sign in". Participants never register; they reply to emails (docs/archive/prd.md:16-16).
2. **Proofs must verify without gitdone being alive.** A cloned repo plus the open-source `gitdone-verify` script must validate every proof (DKIM signatures, OpenTimestamps anchors, content hashes) offline, without calling any gitdone server. If the service dies, issued proofs still work (docs/archive/prd.md:18-18).
3. **Don't become a standard.** Stay a tool: no RFC, no W3C, no foundation, no committee. Other implementations are welcome; endorsement-chasing is not (docs/archive/prd.md:20-20).
4. **Invisible beats correct.** The participant's action is "reply to email" or "tap mailto: link". A feature that makes the participant think is rejected (docs/archive/prd.md:22-22).
5. **No analytics, no tracking, no cross-event aggregation.** Only public per-event stats and platform totals; no user-level views, behavioral data or telemetry. "The business model is that there is no business model" (docs/archive/prd.md:24-24).
6. **No public API in Phase 1.** The git repo IS the API; integrators clone and parse. APIs attract integrations that lock in the current schema (docs/archive/prd.md:26-26).
7. **Federation is portability of proofs, not federation of service.** Anyone can run their own verifier. Proofs from verifier-A validate at verifier-B because DKIM and OpenTimestamps are independently verifiable. No cross-verifier trust protocol is needed, and none should be built (docs/archive/prd.md:28-28).
8. **Resist identity unification.** A person can have many `.vou` files across many addresses, events and contexts. Forcing them together is the "Facebook wave collapse", harmful by design (docs/archive/prd.md:30-30).
9. **Name the trust deposits explicitly.** Trust is concentrated in mail providers (DKIM), Bitcoin miners (OpenTimestamps), git collision resistance, and the maintainer council. These are named and unavoidable; reducing them further would need new cryptography and is out of scope (docs/archive/prd.md:32-32).
10. **Plaintext discipline.** Sender addresses are hashed with a public salt. Attachments are never stored on the server (forwarded to the event owner, only content hashes committed). Every commit payload is audited for "plaintext equivalents" (docs/archive/prd.md:34-34).

### 0.2 What these principles protect against (historical context)

The principles derive from the 5-part history of digital identity by Sar at Synthetic Auth, from CTSS (1961) through OAuth/OpenID Connect (2014) (docs/archive/prd.md:38-38). Failure modes gitdone must avoid, per article (docs/archive/prd.md:40-46):

| Article | Failure mode |
|---|---|
| Part 1, The Birth of Digital Authentication | Plaintext storage, "whoever knows the secret IS the person" |
| Part 2, The Cryptographic Solution | Solving the wrong puzzle: identity isn't just secret-knowledge |
| Part 3, The Network Era | The boundary problem: trust concentration when verifying strangers |
| Part 4, The Web Identity Crisis | Account proliferation, shadow profiles, user as product |
| Part 5, The Federation Wars | Federation becoming oligopoly, identity merged with surveillance, OpenID losing to FB Connect on UX |

### 0.3 The cumulative lessons (60+ years)

- Scale breaks trust: systems for known communities fail at stranger-scale (docs/archive/prd.md:50-50).
- Trust always gets deposited somewhere. "Trustless" is marketing; name who you trust (docs/archive/prd.md:51-51).
- Mathematical purity loses to convenience: OpenID (correct, hard) lost to Facebook Connect (dirty, easy) (docs/archive/prd.md:52-52).
- Commerce drives architecture; frictionless paths win even when technically wrong (docs/archive/prd.md:53-53).
- Each solution breeds the next problem: passwords, hashing, federation, oligopoly, surveillance (docs/archive/prd.md:54-54).
- The user becomes the product whenever identity and business merge (docs/archive/prd.md:55-55).
- Identity fragmentation is natural; forced unification is harmful (docs/archive/prd.md:56-56).
- Plaintext is the original sin and still lurks in every stack (docs/archive/prd.md:57-57).

GitDone's core bet: as a *coordination* tool that produces cryptographically verifiable git repos as a side effect, rather than an *identity* product, it can avoid the drift that captured every predecessor (docs/archive/prd.md:59-59).

### 0.4 The filter

Every future feature request is tested with "Does it violate a principle in §0.1?" If yes, reject it, however clever, requested or commercially tempting. "The principles are the moat" (docs/archive/prd.md:63-63).

## 11. Success Criteria

**Phase 0** (docs/archive/prd.md:1603-1605)
- Postfix receives mail and `receive.js` verifies DKIM on the happy path (see §10.5).
- `gitdone-verify` validates a sample repo on a disconnected machine that never contacted gitdone: DKIM, OpenTimestamps and attachment hashes all pass offline (principle §0.1.2).

**Phase 1** (docs/archive/prd.md:1607-1611)
- Postfix receives email, `receive.js` verifies DKIM, commits to git and forwards the attachment to the owner.
- Zero server-side attachment storage.
- The OpenTimestamps anchor validates via `gitdone-verify` with no network call to gitdone.
- The initiator UI creates a workflow event in under 30 seconds.

**Phase 2** (docs/archive/prd.md:1613-1616)
- Declaration mode: single signer, 1 email, commits with an OTS anchor, event closes.
- Attestation mode: 3+ real external senders, DKIM-verified, threshold reached, event closes.
- Duplicate senders are correctly ignored under the `unique` dedup rule.

**Phase 3 (launch)** (docs/archive/prd.md:1618-1621)
- One real user (not the developer) creates and completes an event.
- A third party runs `gitdone-verify` on a cloned event repo and it passes without access to gitdone.example.
- Documentation is clear enough that a non-technical user understands what GitDone provides.

**Ongoing** (docs/archive/prd.md:1623-1627)
- Storage stays minimal: under 1 MB per 100 events, excluding git objects.
- DKIM verification pass rate above 95% for major mail providers.
- No vendor dependencies beyond open-source libraries and Bitcoin.
- `gitdone-verify` passes on every released event repo (regression test); a schema change that breaks offline verification is a bug.

## 12. Out of Scope (Deliberately)

- End-to-end encryption of emails (not needed, since attachments don't live on the server) (docs/archive/prd.md:1633-1633)
- Identity verification beyond DKIM: mail authentication is proved, not human identity (docs/archive/prd.md:1634-1634)
- Legal document validity: proofs are records, not legal signatures; legal weight depends on jurisdiction and use (docs/archive/prd.md:1635-1635)
- Real-time notifications (email is asynchronous by design) (docs/archive/prd.md:1636-1636)
- Mobile apps (web plus email works everywhere) (docs/archive/prd.md:1637-1637)
- Authentication beyond magic links (initiator convenience only) (docs/archive/prd.md:1638-1638)
- Built-in document editor (users attach what they already have) (docs/archive/prd.md:1639-1639)
- Blockchain anchoring beyond OpenTimestamps (docs/archive/prd.md:1640-1640)
- Zero-knowledge proofs or advanced cryptography (docs/archive/prd.md:1641-1641)
- Federation in v2 (deferred to Phase 4) (docs/archive/prd.md:1642-1642)
- Inbuilt template library for the 9+ use cases: users describe what they need and GitDone routes it (docs/archive/prd.md:1643-1643)

## 13. Risks and Open Questions

### 13.1 Risks

| Risk | Mitigation |
|---|---|
| Postfix operational complexity | Document setup thoroughly; provide a `setup.sh` script (docs/archive/prd.md:1653-1653) |
| DKIM breakage by intermediaries (mailing lists, corporate gateways, forwarders) | Four-method verification per §7.4: DKIM, ARC fallback, SPF/DMARC, accept-with-flag. Trust level is recorded per reply and the initiator sets policy (docs/archive/prd.md:1654-1654) |
| Operator tampering window before cryptographic seal | Between Phase 1.C landing and Phase 1.D+1.E completing, the event repo is only as trustworthy as the operator; a root user on the VPS could technically forge or delete commits. 1.D (DKIM key archival per commit) and 1.E (OpenTimestamps anchoring) close the window by making backdated rewrites cryptographically detectable. Interim: runs on infrastructure the maintainers control, and auditors should expect lower assurance from repos of this era (docs/archive/prd.md:1655-1655) |
| DKIM verification failures on edge providers | Accept-with-flag model; the user can upgrade to a verified provider (docs/archive/prd.md:1656-1656) |
| OpenTimestamps calendar server downtime | OTS is async; the proof completes within 24h with no blocking (docs/archive/prd.md:1657-1657) |
| Email spam filtering of our outbound | Proper SPF/DKIM/DMARC setup from day one (docs/archive/prd.md:1658-1658) |
| Deliverability of receipts to participants | Test with the top 10 mail providers before launch (docs/archive/prd.md:1659-1659) |
| Attachment size limits from Postfix defaults | Configure `message_size_limit`; document user expectations (docs/archive/prd.md:1660-1660) |

### 13.2 Open questions

- Should the initiator's email be hashed or plaintext in event JSON? Leaning: hashed for public view, plaintext for management (docs/archive/prd.md:1664-1664).
- How long to retain DKIM key archives? Proposal: forever, since they're tiny (docs/archive/prd.md:1665-1665).
- How to handle legal discovery requests for event data? Standard response: gitdone holds hashes and DKIM proofs, while content is with event owners (docs/archive/prd.md:1666-1666).
- Should an opt-in "keep attachments for 30 days" mode be offered? Leaning: no, which keeps the privacy story clean (docs/archive/prd.md:1667-1667).
- What is the migration path from v1 data? Proposal: none; v2 starts fresh (docs/archive/prd.md:1668-1668).

## 14. Alignment with Dev Rules

The PRD adheres to the project's dev standards (docs/archive/prd.md:1674-1674):

- **POC first:** Phase 0 is explicitly a POC before any production code (docs/archive/prd.md:1676-1676).
- **Build incrementally:** 4 phases, each independently useful (docs/archive/prd.md:1677-1677).
- **Dependency hierarchy:** Postfix (system), Node stdlib where possible, and only 3 libraries added (mailauth, mailparser, opentimestamps-client), all passing the checklist (docs/archive/prd.md:1678-1678).
- **Lightweight over complex:** no new frameworks, no database migration, no vendor services (docs/archive/prd.md:1679-1679).
- **Open-source only:** every dependency is MIT/Apache/BSD licensed (docs/archive/prd.md:1680-1680).
- **Every line has a purpose:** the refactor deletes more code than it adds (docs/archive/prd.md:1681-1681).
