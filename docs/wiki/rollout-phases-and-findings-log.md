---
title: Rollout phases and findings log
theme: Rollout phases and findings log
source: docs/archive/prd.md
summary: The phased rollout plan (Phase 0 to 4), the Phase 0 validation results, and the numbered findings log condensed in source order.
---

# Rollout phases and findings log

Section 10 of the PRD (docs/archive/prd.md:1315). Findings keep their original numbers and source order, which is not strictly numeric near the end.

## Rollout phases

### Phase 0 - POC (1 weekend), complete 2026-04-17

- Goal: prove the email-in pipeline. Install Postfix on a test VPS, write a minimal `receive.js` (stdin, DKIM via `mailauth`, log sender/body/attachments), send a test email, and build the independent verifier `gitdone-verify` (docs/archive/prd.md:1317-1327).
- Graduation: one real email DKIM-verified, metadata logged, and `gitdone-verify` validating a sample repo with no network call to gitdone, only public DNS and Bitcoin block headers (docs/archive/prd.md:1329).

### Phase 0 tail - `gitdone-verify`

- Principle 0.2: proofs must verify without gitdone alive. Without this, gitdone is "just another Keybase" (docs/archive/prd.md:1335).
- It is a single-file, open-source, zero-server-dependency verifier that takes a cloned event repo and outputs pass/fail (docs/archive/prd.md:1339).
- It checks, in order (docs/archive/prd.md:1345-1351):
  1. git integrity;
  2. DKIM signatures using the key archived in the repo (optional DNS cross-check);
  3. OpenTimestamps proofs against Bitcoin headers (local node or any OTS calendar);
  4. attachment hashes, if the owner produces the original emails;
  5. event-type rules (workflow order, declaration = one signer, attestation = distinct senders and threshold).
- Constraints: no call to any gitdone service, a single binary or Python/Node file, a permissive license (MIT or Apache-2.0), and deterministic output (docs/archive/prd.md:1353-1358).
- Deliverable: one file at `tools/gitdone-verify/` plus a worked example (docs/archive/prd.md:1360).
- Definition of done: disconnect the VPS, clone a real event repo to a machine that never talked to gitdone, run the verifier, and get a green pass (docs/archive/prd.md:1362-1369).

### Phase 1 - Core rebuild (2 weekends)

- Steps (docs/archive/prd.md:1373-1381):
  - hook `receive.js` into event routing;
  - add `mailparser`;
  - add OpenTimestamps anchoring and DKIM key archival;
  - forward attachments to the owner via SMTP;
  - remove participant magic-link routes and pages;
  - simplify the initiator UI to a plain HTML form.
- Deliverable: one workflow event with a participant email reply, a git commit with OTS proof and DKIM key, and the attachment forwarded to the initiator (docs/archive/prd.md:1383).

### Phase 2 - Crypto event type (1 weekend)

- Steps (docs/archive/prd.md:1387-1395):
  - add a crypto event type with `mode` (declaration | attestation);
  - declaration = single signer, 1-email completion; attestation = multi-signer, count-based completion;
  - dedup rules unique / latest / accumulating;
  - generic mailto: share link for attestation;
  - single-signer email flow for declaration;
  - test with a real declaration and a real attestation (3+ senders).
- Deliverable: a declaration closing after one DKIM-verified OTS-anchored email, and an attestation with 3+ people from different domains reaching the threshold with unique dedup (docs/archive/prd.md:1397-1399).

### Phase 3 - Polish and documentation (1 weekend)

- Steps (docs/archive/prd.md:1403-1407):
  - receipt emails with commit hash and OTS reference;
  - dashboard improvements;
  - user docs;
  - a small landing page on the two event types;
  - publish `gitdone-verify` as a standalone GitHub repo.
- Deliverable: public launch with documentation, standalone verifier and sample events (docs/archive/prd.md:1409).

### Phase 4 - Optional (deferred)

Federation across instances, bootstrap integration (GitHub age, domain ownership as pre-vouch signals), webhook notifications, an external-integration API, and a visual CAPTCHA layer for high-volume crypto events (docs/archive/prd.md:1593-1597).

## 10.5 Phase 0 validation results (2026-04-17)

Phase 0 ran on a RackNerd VPS (AlmaLinux 8, Postfix 3.5.8, Node 20). The architectural assumptions in sections 1, 3, 7 and 8 were validated with real external mail (docs/archive/prd.md:1413).

**Happy-path matrix.** Both senders reached `verified` trust (docs/archive/prd.md:1417-1420):

| Sender | DKIM | SPF | DMARC | ARC |
|---|---|---|---|---|
| MSN (`avoidaccess@msn.com`) | pass (aligned) | pass | pass | pass (M365 chain) |
| Gmail (`avoidaccess@gmail.com`) | pass (aligned) | pass | pass | none (direct, expected) |

**Pre-filter classifier (7.4).** 4 of 4 cases matched spec. `Precedence: bulk` was rejected without touching DKIM, a body-hash failure was `unverified`, Gmail self-delivery with no DKIM was `unverified`, and MSN to Gmail was `verified` (docs/archive/prd.md:1422).

## Findings log

### Phase 0 findings (1-5)

1. **Direct MX gives untampered DKIM.** The bet "we are the MX, so no intermediary modifies the body" held, with clean DKIM and DMARC pass from both providers (docs/archive/prd.md:1426).
2. **Attachment hashing is deterministic.** The same PDF and DOCX from MSN and Gmail gave byte-identical SHA-256 hashes, which validates the hash-only privacy model (docs/archive/prd.md:1428).
3. **Plus-tag survives external SMTP.** `event+ID-step@git-done.com` reached `${original_recipient}` in `receive.js`, so plus-tag routing is viable (docs/archive/prd.md:1430).
4. **ARC matches theory.** M365 mail carries an ARC chain and passes. Direct Gmail has none and is `verified` on DKIM and DMARC alone (docs/archive/prd.md:1432).
5. **DMARC pass from DKIM alignment alone.** SPF was unavailable without envelope data (see 7), but DMARC stays a reliable `verified` anchor (docs/archive/prd.md:1434).

### Architectural lessons for Phase 1 (6-10)

6. **Postfix `PrivateTmp=yes` on RHEL/AlmaLinux.** Postfix gets an isolated `/tmp`, so a pipe script's `/tmp` log looked empty from a login shell. Log to `/var/log/gitdone/` (docs/archive/prd.md:1438).
7. **Alias-pipe loses envelope metadata.** `local(8)` runs the pipe under `/bin/sh -c` with no client address, HELO, sender or original recipient. SPF and plus-tags both need those (docs/archive/prd.md:1440).
8. **Use the Postfix `pipe(8)` transport.** A `gitdone` entry in master.cf passes `${client_address} ${client_helo} ${sender} ${original_recipient}` to `receive.sh`. main.cf needs `virtual_mailbox_domains`, `virtual_mailbox_maps = static:nothing`, `virtual_transport = gitdone` and `transport_maps`. `mydestination` must not contain the domain, and `luser_relay` must be unset (docs/archive/prd.md:1442-1459).
9. **`receive.js` must accept envelope args** and pass `{ip, helo, sender, mta}` to `mailauth.authenticate()`. Otherwise SPF is `none` or `neutral` (docs/archive/prd.md:1461).
10. **Run as a dedicated user.** The POC ran as `nobody`. Production needs a `gitdone` system user with a restricted home (docs/archive/prd.md:1463).

The spec delta: sections 3.3, 7.4 and 8.1 stand, 8.2 needs the pipe(8) config, and 9.2 needs PrivateTmp and pipe guidance (docs/archive/prd.md:1465).

### Phase 1.L.1: verify+{id}@ handler (2026-04-17) (11-15)

11. **Raw-byte match is unreliable across forwards.** Five real forwards (2 MSN, 1 Gmail web) each produced a different SHA-256 from the stored `raw_sha256`, because clients normalise headers, line endings and MIME. `raw_sha256` is a reception-time integrity anchor only (docs/archive/prd.md:1469).
12. **Message-ID is the stable cross-client identifier.** Adding a salted `message_id_hash` (commit schema v2) gave reliable matching. The verify cascade is `raw_sha256`, then `message_id_hash`, then attachment `sha256` (docs/archive/prd.md:1471).
13. **DKIM cannot be re-verified from a forwarded .eml.** Gmail and MSN strip the DKIM-Signature header when forwarding as attachment. DKIM is verified once at reception and stored with the archived key and OTS anchor. The guarantee relies on that one-shot result being immutable, so nothing is weakened (docs/archive/prd.md:1473-1475).
14. **`verify+` graduates on commit identification.** It reports which commit a forward corresponds to and what was recorded at reception, which is the practical upper bound given 13 (docs/archive/prd.md:1477).
15. **Direct-attachment hashing is deterministic.** `braun-invoice.pdf` sent from MSN and Gmail matched `attachments[0]` of commit-002, and a random PNG returned `match_type: none`. Attaching the raw file is therefore the primary verification UX (docs/archive/prd.md:1479).

### Phase 1.F: outbound DKIM signing (2026-04-17) (16-20)

16. **opendkim defaults to `Mode v`** on RHEL/AlmaLinux and silently does not sign. Set `Mode sv` (docs/archive/prd.md:1483).
17. **A TCP milter socket beats a unix one.** Postfix is chrooted at `/var/spool/postfix`, so use `Socket inet:8891@127.0.0.1` with `smtpd_milters = inet:127.0.0.1:8891` (docs/archive/prd.md:1485).
18. **`milter_default_action = accept`, not `tempfail`.** If opendkim dies, mail flows unsigned rather than blocking. Monitoring notices because unsigned mail lands in spam (docs/archive/prd.md:1487).
19. **New domains land in Gmail Spam even with DKIM, SPF and DMARC all `pass`.** This is reputation and needs time and volume. Possible future steps are unspam guidance, TLS-RPT or MTA-STS (docs/archive/prd.md:1489).
20. **Keep `OversignHeaders From`.** It signs From twice, so a From-rewrite invalidates the signature (docs/archive/prd.md:1491).

### Phase 1.L.1 send path (2026-04-17) (21-25)

21. **`sendmail(8)` plus `non_smtpd_milters` is the minimal outbound plumbing.** Node pipes raw RFC-822 to `/usr/sbin/sendmail -t -i -f <env>`, and opendkim signs it. `outbound.js` is about 40 lines on stdlib `child_process.spawn` (docs/archive/prd.md:1495).
22. **Swallow EPIPE on child stdin.** Use a no-op `child.stdin.on('error')`. The exit-code handler is the authoritative delivery signal (docs/archive/prd.md:1497).
23. **Use `Auto-Submitted: auto-replied` (RFC 3834) for direct responses.** The prefilter drops inbound `Auto-Submitted`, which closes OOO loops. Use `auto-generated` for standalone notifications (docs/archive/prd.md:1499).
24. **Envelope sender `verify+{id}@` is fine.** Bounces arrive with envelope `<>` or MAILER-DAEMON and the prefilter's system-sender pattern rejects them. An empty envelope sender would weaken SPF alignment (docs/archive/prd.md:1501).
25. **Identity aliases are lowercase** (`gitdone`) for the From display name and git commit author, as a cosmetic convention (docs/archive/prd.md:1503).

### Phase 1.L.2: offline verifier (2026-04-17) (26-30)

26. **`ots verify` exit code is ambiguous, so parse the text.** Exit 1 covers both tamper and unconfirmed-pending proofs. `does not match` means invalid, `success!|bitcoin block #\d` means anchored, `timestamped by transaction|waiting for N confirmation` means in-bitcoin, and `pending confirmation` means calendar-only. Use `/bitcoin block #?\d/` because `/bitcoin block/` false-matches (docs/archive/prd.md:1507).
27. **Plaintext discipline is enforceable.** The verifier fails the schema check if committed JSON contains `sender`, `subject`, `body_preview` or `message_id`, which turns 0.1.10 into a regression test (docs/archive/prd.md:1509).
28. **Tamper detection validated.** Flipping one byte of `trust_level` in `commit-002.json` after anchoring gave `OpenTimestamps FAIL (1 bad proof)` and `Overall: FAIL (exit 1)` (docs/archive/prd.md:1511).
29. **Sequential ordering is checked.** For `flow: sequential`, step N must have a lower `sequence` than step N+1. A violation is a WARN, not a FAIL, since commits remain cryptographically valid (docs/archive/prd.md:1513).
30. **Node stdlib suffices.** The verifier has no npm deps, uses `crypto.createPublicKey`, `spawnSync`, `fs` and `path`, and is a single file `tools/gitdone-verify/gitdone-verify.js` of about 330 lines (docs/archive/prd.md:1515).

### Phase 1.G: attachment forwarding (2026-04-18) (31-35)

31. **Use positional sendmail recipients for forwarding.** `sendmail -i -f envelope -- initiator@addr` leaves the original `To: event+...` header intact. The `--` terminator is load-bearing against recipients starting with `-` (docs/archive/prd.md:1519).
32. **Byte-preserving forward beats MIME-wrapping.** Prepending `X-GitDone-*` headers keeps the original DKIM-Signature verifiable, and opendkim adds a second `d=git-done.com` signature. `message/rfc822` wrapping would break inline display for no cryptographic gain (docs/archive/prd.md:1521).
33. **Prepend headers without a trailing blank line.** A `\r\n\r\n` would end the header block and push the original From/Subject into the body. A unit test checks that `X-GitDone-Event` and `Subject:` share the header block (docs/archive/prd.md:1523).
34. **MSN accepts forwards with SPF mismatch when DMARC passes via DKIM alignment.** Both Gmail-From forwards through `104.129.2.254` reached the inbox, and outbound reputation looked to be warming (docs/archive/prd.md:1525).
35. **Attachments never touch disk on the server.** `mailparser` keeps them as in-memory Buffers and they are hashed then dropped. Only `commit-NNN.json` and transient Postfix spool files appear, which can be checked via `ls /var/lib/gitdone/repos/*/` (docs/archive/prd.md:1527).

### Phase 1.L.3: reverify handler (2026-04-18) (36-41)

36. **Reverify is append-only.** An upgrade is a new `reverify-NNN.json` with `target_commit`, `trust_level_before` and `trust_level_after`. Effective trust is `max(commit.trust_level, upgrade.trust_level_after)`, so audit history is preserved (docs/archive/prd.md:1531).
37. **Auth is cryptographic.** Anyone can submit to `reverify+{id}-{commitN}@` if they hold a raw email whose DKIM validates against the archived PEM. No token, identity check or rate limit is needed. Failed attempts are recorded as `upgraded: false` with `dkim_reverify.reason` (docs/archive/prd.md:1533).
38. **Separate sequence namespace.** `commit-NNN` and `reverify-NNN` are independent counters, and `target_commit` cross-references (docs/archive/prd.md:1535).
39. **Add a `kind` field.** The verifier needs `kind: 'reverify'` to tell the schemas apart, and absence of `kind` means `'reply'` for backward compatibility (docs/archive/prd.md:1537).
40. **`ots verify` without a Bitcoin node is not failure.** With cached attestations it prints "Got N attestation(s) from cache" and exits 1. The classifier treats `/got \d+ attestation/` as `anchored`, and tamper is still caught by `/does not match/` (docs/archive/prd.md:1539).
41. **`ots upgrade` automation shipped.** Proofs are calendar-pending at commit time, and if all calendars died before upgrade they would become unverifiable. `app/bin/ots-upgrade.js` runs every 6 hours via `gitdone-ots-upgrade.timer`, upgrades `*.ots` across repos and makes one idempotent commit per repo that changed (docs/archive/prd.md:1541).

### 2026-05-28 security audit (0.26.0) (42)

42. **Edge concerns belong at nginx.** The audit's no-rate-limit and no-security-header findings were fixed at the proxy. `POST /events` and `/crypto` get a per-IP `limit_req` (12 req/min, burst 6). Every response carries `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, HSTS and a baseline CSP (`frame-ancestors`, `object-src`, `base-uri`, `form-action` locked; inline script/style still allowed). A nonce'd `script-src` is the tracked next step and the only M3 part needing app work. The vhost is now at `ops/nginx/gitdone.conf`. App-layer fixes (forged-DSN deletion, session-secret validation, Origin checks) shipped in `receive.js`, `auth.js` and `server.js` (docs/archive/prd.md:1545).

### Email-taxonomy reconciliation (2026-05-28) (43)

43. **Lifecycle-edge re-fire is prevented by existing state, not a stamp.** There is deliberately no `${edge}_notified_at`, since it would write a non-semantic commit into the proof repo. `completed` and `closed` rely on `proof_email_sent_at` versus `completion.completed_at`. `activated` relies on the `activateEvent` mutex and `alreadyActive` guard. `progressed` relies on idempotent reply application. The realistic failure is a missed notice on a mid-send crash, not a duplicate. Do not add a notified-at stamp. If observability needs one, make it non-gating and written alongside an existing semantic commit (docs/archive/prd.md:1549).

### 0.26.2 regression fix (2026-05-29) (44)

44. **A CSRF Origin check must fail OPEN on `Origin: null`.** Under `Referrer-Policy: no-referrer`, browsers send `Origin: null` on same-origin form POSTs, so the M5 check rejected every legitimate create and dashboard mutation. Reject only a parseable Origin/Referer with a differing host, treat missing, null or unparseable as no-signal, and lean on `SameSite=Lax`. An attacker's own origin is still a parseable mismatch, and a forced `null` has already lost the cookie. The unit test missed it by never testing `null`. Lesson: test empty, null and malformed headers, and verify in a real browser, not just `curl`. The deploy runbook now has a browser smoke (`docs/wiki/deploy.md` section 13b) (docs/archive/prd.md:1553).

### Live attestation testing (2026-05-30)

The source has a heading for this group but no finding text under it (docs/archive/prd.md:1555).

### git-done.com to signedreply.com rename (2026-06-01) (50)

50. **A rename is only as clean as its least-obvious config path, and "is it live?" must be checked from the public internet.** (a) The inbound pipe is spawned by Postfix as `gitdone`, not systemd, so it missed the unit's `EnvironmentFile` and regenerated `git-done.com` addresses. Only an end-to-end mail test showed which DKIM domain signed. The fix was for `receive.sh` to source `/etc/default/gitdone-web`. Both long-lived and short-lived entry points must share one config source. (b) `git-done.com` answered from its Cloudflare nameservers but returned NXDOMAIN from the `.com` registry, so webroot cert issuance failed. Check external resolvers and the registry. Smaller points: enumerate every public name (the `www` gap was fixed with DNS, cert SAN and an nginx 301). Cutover order is PTR before the Postfix `myhostname` switch, apex grey for http-01, and one auto-renewing multi-SAN cert (docs/archive/prd.md:1559).

### Brand rename gitdone to signed/reply (2026-06-01) (51)

51. **A brand rename is two disjoint sweeps, and the no-reply sender must keep routing to the catch-all pipe.** Customer-visible surfaces flipped to signedreply: wordmark, favicon, og image, titles, subject prefixes (`[gitdone]` to `[signedreply]`), body prose, signature and emailed reports. Internal identifiers stay `gitdone` on purpose: the `gitdone-verify` CLI and repo, `GITDONE_*` env, systemd units, `/opt/gitdone`, the proof-bundle filename, the git commit author and log tags. A protected-token replace (`s/gitdone(?!-verify)/signedreply/g`) was driven by the test suite, where 18 assertions pinned old brand strings. (a) Centralise the sender in `outbound.js` `senderHeader`/`senderAddress`, splitting the From display name from the bare envelope MAIL FROM. Four send paths (`notifications`, `auth`, `receive`, `sweep`) built From by hand, and `sweep` was missed until a `grep gitdone@` caught it. (b) `noreply@signedreply.com` falls through `virtual_transport = gitdone` into the receive pipe with no Postfix change. Bounce DSNs return there and must reach bounce processing (#24). A stray human reply is accepted and dropped (`receive.js` exits 0, `routing.matched=false`, no commit). A `discard:` transport would have severed bounce handling. Lesson: trace where an envelope sender's bounces land before adding routing (docs/archive/prd.md:1563).

### 2026-06-02 security review (52)

52. **An app-only audit finds infra gaps the edge already closes, so scope the audit to the whole request path including `ops/`.** Unauthenticated creation was flagged as an unbounded disk and mail-amplification vector, but nginx already limits it (`limit_req zone=gitdone_create rate=12r/m burst=6`, #42) and knowless's sham-work keeps activation silent. An app-layer limiter with `GITDONE_MAX_CREATES_PER_IP_PER_HOUR` was prototyped and reverted. It was redundant, added a new knob where a structural bound existed, and was less stealthy because its 429 leaked the window via `Retry-After`. If the cap feels loose, tighten the nginx zone. Two real fixes landed: CR/LF stripping on every outbound header value in `outbound.js` `buildRawMessage` (From, To, Reply-To, In-Reply-To/References, Message-Id, `extraHeaders`), and pinning Postfix `maxproc=1`, since `receive.sh` and `deployment.md` showed `-`/100 while lock-free per-event git writes depend on serialized delivery. Dropped as non-issues: `/manage/logout` delegates to knowless `auth.logout`, which does its own Origin/Referer check, and the login limiter gets the real IP via `determineSourceIp` (knowless 1.3.0 or later). A host sweep removed four stale `.bak` vhost backups from `/etc/nginx/conf.d/`. They were inert but carried the retired `git-done.com` and the insecure append-XFF `$proxy_add_x_forwarded_for`. This is the same class as the 2026-06-01 plato `/etc/cron.d` incident. Lesson: a fix belongs in the layer that already owns the concern (docs/archive/prd.md:1567).

### Privacy-respecting discoverability pass (2026-06-02) (53)

53. **Findability by search engines and AI agents is consistent with "no telemetry".** The line is declarative machine-readability versus extractive growth-hacking, and the real PII control is auth-gating, not `robots.txt`. Five declarative additions with no trackers or client JS were made: JSON-LD (`SoftwareApplication` and `FAQPage`, with a `</script>`-breakout guard in `layout()`), an AI-crawler `robots.txt` naming and allowing retrieval bots (`Claude-User`, `Claude-SearchBot`, `OAI-SearchBot`, `ChatGPT-User`, `PerplexityBot`) and training bots (`ClaudeBot`, `GPTBot`, `CCBot`), `/llms.txt`, `/.well-known/security.txt` (RFC 9116) and a `sitemap.xml` using `<lastmod>`. Lessons: (a) allowing named crawlers, including training bots, is right for PII-free copy, and `ClaudeBot` is a training crawler, not a cite-live one. (b) `Disallow` is not a privacy control, and `Disallow` plus `noindex` cancels. PII surfaces (`/manage/event/:id`, `/events/:id`) 303-redirect anonymous requests to `/manage`, so `noindex` is wired into `layout()` but unused. (c) `FAQPage` answers must be grounded in visible copy. A literal on-page FAQ was not built because it would restructure the frozen landing (variant F). Being cited depends on distribution (Show HN, `awesome-selfhosted`, Privacy Guides), which is out of code scope. Tests: +5 in `app/tests/integration/web-events.test.js`, 632 green (docs/archive/prd.md:1571).

### pulselog first-adopter integration (2026-06-01) (49)

49. **A monitoring tool earns its keep by what it observes, so adopt the modes that fit natively.** gitdone is the first adopter of `pulselog`. It replaced the 100-line `health-check.sh` and `stats-weekly.js` with a `pulselog.config.json` (9 checks: 4 native, 3 `command`, 2 `service`) on the 15-minute timer, plus `pulselog --digest` fed by `stats.js --metrics-json`. The daily snapshot job was retired. Backup was deliberately not migrated, because the off-host pull from federver already gives disaster recovery, so pulselog watches freshness via a `file-age` check and federver owns the pull. Lessons: fit beats coverage, and pull-from-the-safe-host beats push-from-the-exposed-host. The one upstream change (B1) was `metricsCommand`, a flat JSON of named integers, shipped in pulselog 0.3.0. A `sweep.test.js` fixture using real `Date.now()` in shared tmp became a date-triggered failure, and was pinned and isolated. Follow-on (0.26.9, pulselog 0.4.1): the first scheduled runs as `User=gitdone` false-paged every 15 minutes for about 2.5h on the shared 1 vCPU / 1 GB VPS. The `unknown` and `unreachable: 23` (`DOMException.TIMEOUT_ERR`) reasons were timeouts, not an outage (`/health` answered in 39ms). Policy fix: pulselog 0.4.0 added per-check `timeoutMs` and in-run `retries`/`retryDelayMs`, with gitdone configuring one retry and 10s on contention-sensitive checks. Cross-run debounce was declined upstream and belongs in the JSONL-consuming layer. The config-ownership gate was relaxed in 0.4.1 to owner equals running user OR root, which fits gitdone's root-owned tree. Lesson: validate a watcher under the identity and scheduler it will run as (docs/archive/prd.md:1575).

### Per-IP rate-limit hardening (2026-05-31) (48)

48. **A per-IP limit behind a proxy is only as real as the source IP the app feeds it.** `auth.startLogin` passed `req.socket.remoteAddress`, always `127.0.0.1` behind nginx, so limiting was a silent no-op. On a co-tenant app the same defect let bots get the shared sending IP blocklisted (Barracuda). The fix uses knowless's `determineSourceIp(req, trustedProxies)` (added in knowless 1.1.9 to 1.3.0), with gitdone owning `config.trustedProxies` (default loopback). The trap is that the resolver trusts the leftmost `X-Forwarded-For`, which is safe only if nginx overwrites XFF with `$remote_addr`. The runbook (`deployment.md` section 9) had that, but the live host had drifted to `$proxy_add_x_forwarded_for`, which would have made spoofing easier. Lessons: a limit that cannot see the real IP is theatre, the app and proxy changes must land together, and runbook-versus-live drift is itself the vulnerability. The blast radius crossed app boundaries via the shared IP (docs/archive/prd.md:1579).

### Adopting `flightlog` (2026-05-31) (47)

47. **Local error capture is consistent with "no telemetry", and short-lived processes need synchronous capture.** flightlog is a zero-dependency local JSONL recorder wired into all three entry points, with no upload (0.1.5 intact). `receive.js` and `ots-upgrade.js` use `captureSync()` plus `exitOnRejection`, because an async write is lost on `process.exit()` and a silent exit-0 would make Postfix treat a failed receive as delivered. `server.js` logs a stray rejection and stays up. The boot writability probe is fatal by default, so an unwritable `logs/` makes every inbound message exit non-zero and Postfix defers it. On the live host it self-heals because the data dir is `gitdone`-owned. flightlog 0.3.0 added a `bootCheck: false` knob, but gitdone keeps the default for the mail pipe because deferred mail is queued, not lost, whereas the knob would deliver blind (docs/archive/prd.md:1583).

### Attestation count unit (46)

46. **Every attestation count surface must use the same threshold unit.** Strict attestation compares complete attestor buckets (`attestor_progress[hash].complete`, revoke-filtered, `completion.js#countCompleteAttestors`) to the threshold. The per-reply ack counted distinct repliers instead, so a partial signer ticked `[N/T]` and showed `[2/2]` while other surfaces showed `1/2`. The ack now uses the shared complete-bucket count. Lesson: derive repeated values from one helper (cf. #45). Loose attestation was correct. Regression test: `app/tests/unit/reply-ack-attestation.test.js` (docs/archive/prd.md:1585).

### Revoke and communication (45)

45. **Revoke must remove an attestor from communication, not just from the count.** `countCompleteAttestors` filtered `revoked_senders`, but `addStrictAttestors` in `app/src/email-recipients.js` emailed every attestor with a stored address. Live (event `3dryizzzu4pi`): a revoked attestor still received the recompletion proof email, which contradicted the count. The resolver, the single owner of `revoked_senders` reading, now skips revoked `sender_hash`es for the `completed` and `closed` proof edges. Earlier replies stay in the audit trail, and a proof sent before the revoke stays sent. The per-reply ack path is unchanged: a revoked sender who replies again still gets the explicit `revokedSender` ack (docs/archive/prd.md:1587).
