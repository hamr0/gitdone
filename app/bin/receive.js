#!/usr/bin/env node
// Entry point for inbound mail. Read raw email from stdin + envelope args
// from argv, verify with mailauth, parse MIME with mailparser, apply
// pre-filter and trust classifier, emit a structured JSON record.
//
// Called by Postfix pipe transport via bin/receive.sh.

'use strict';

const crypto = require('crypto');
const { authenticate } = require('mailauth');
const { simpleParser } = require('mailparser');

const config = require('../src/config');
const { parseEnvelope } = require('../src/envelope');
const { preFilter, extractHeaderBlock } = require('../src/prefilter');
const { classifyTrust } = require('../src/classifier');
const { parseEventTag, parseAddress, parseVerifyTag, parseReverifyTag, parseInitiatorCommand, parseAttachTag, parseRevokeTag } = require('../src/router');
const { loadEvent, findStep, senderMatchesStep, recordStepSendErrors } = require('../src/event-store');
const { commitReply, commitCompletion, commitAttach, commitRevoke, saltedSenderHash } = require('../src/gitrepo');
const { fetchDkimKey, pickSignatureToArchive } = require('../src/dkim-archive');
const { buildVerificationReport, formatVerifyReportBody } = require('../src/verify');
const { sendmail, buildRawMessage } = require('../src/outbound');
const { forwardToOwner } = require('../src/forward');
const { buildReverifyRecord, persistReverifyRecord, formatReverifyReportBody } = require('../src/reverify');
const { applyReply, applyRevoke, updateEventAtomic, hashSender, isClosedByInitiator } = require('../src/completion');
const { notifyLifecycleEdge, notifyWorkflowParticipants } = require('../src/notifications');
const { replyAck, cmd: cmdBodies } = require('../src/email-bodies');
const { authenticateInitiatorCommand, executeRemind, executeCloseRequest } = require('../src/email-commands');
const { bundleToBuffer, bundleFilename, buildAttachmentMessage } = require('../src/bundle');
const { extractDsn } = require('../src/dsn');
const logger = require('../src/logger');
const fs = require('node:fs/promises');
const path = require('node:path');

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', reject);
  });
}

// Test-only DNS stub. When GITDONE_TEST_DNS_FILE points at a JSON map
// of `{ "name": "TXT-record-string", ... }`, use that as the resolver
// for both mailauth's authenticate() and the DKIM key archiver. Lets
// integration tests produce DKIM-aligned + DMARC-passing replies
// without touching the network or wiring up a fake DNS server.
//
// In production GITDONE_TEST_DNS_FILE is unset and this returns null,
// so authenticate() and fetchDkimKey() use the real DNS resolver.
function loadTestDnsResolver() {
  const f = process.env.GITDONE_TEST_DNS_FILE;
  if (!f) return null;
  try {
    // Lazy-require so tests/helpers/ never gets loaded in production.
    const { buildStubResolver } = require(require('node:path').resolve(
      __dirname, '..', 'tests', 'helpers', 'stub-dns.js'
    ));
    return buildStubResolver(f);
  } catch (err) {
    process.stderr.write(`receive: failed to load test DNS stub from ${f}: ${err.message}\n`);
    return null;
  }
}

function sha256(buf) {
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

function summariseDkim(auth) {
  const results = (auth.dkim && auth.dkim.results) || [];
  if (results.length === 0) return { result: 'none' };
  return {
    signatures: results.map((r) => ({
      result: r.status && r.status.result,
      comment: (r.status && r.status.comment) || null,
      domain: r.signingDomain || null,
      selector: r.selector || null,
      aligned: (r.status && r.status.aligned) || null,
      algorithm: r.algo || null,
      info: r.info || null,
    })),
  };
}

// Reduce a repo's full commit list to the commits that COUNTED toward
// completion. Used by the proof email to embed receipts only for the
// signal-bearing replies (no audit-trail commits, no edits, no
// completion-marker commit).
function filterCountingCommits(event, commits) {
  const out = [];
  if (!event || !Array.isArray(commits)) return out;
  if (event.type === 'event') {
    const wantedSeqs = new Set();
    for (const s of (event.steps || [])) {
      if (s && s.status === 'complete' && s.commit_sequence != null) wantedSeqs.add(s.commit_sequence);
    }
    for (const c of commits) {
      if (!c.kind && c.sequence && wantedSeqs.has(c.sequence)) out.push(c);
    }
  } else if (event.type === 'crypto' && event.mode === 'declaration') {
    const seq = event.completion && event.completion.commit_sequence;
    for (const c of commits) {
      if (!c.kind && c.sequence === seq) { out.push(c); break; }
    }
  } else if (event.type === 'crypto' && event.mode === 'attestation') {
    const wantedHashes = new Set();
    for (const r of (event.replies || [])) {
      if (r && r.sender_hash) wantedHashes.add(r.sender_hash);
    }
    for (const c of commits) {
      if (!c.kind && c.sender_hash && wantedHashes.has(c.sender_hash)) out.push(c);
    }
  }
  return out;
}

function summariseAttachments(parsed) {
  return (parsed.attachments || []).map((a) => ({
    filename: a.filename || null,
    content_type: a.contentType || null,
    size: a.size || (a.content && a.content.length) || 0,
    sha256: a.content ? sha256(a.content) : null,
  }));
}

// Module 4a + 4c: reference doc set is frozen
//   - in strict mode (event.reference_url + any reference_docs): frozen
//     immediately, so the first attach+ email is the canonical one-shot
//     manifest. Signer was held until this point, so adding docs later
//     would change what they were asked to sign.
//   - in loose mode (no reference_url): frozen at first counted reply.
// Once frozen, attach+ emails bounce.
function isReferenceDocSetFrozen(event) {
  if (!event || event.type !== 'crypto') return false;
  const hasDocs = Array.isArray(event.reference_docs) && event.reference_docs.length > 0;
  if (event.reference_url && hasDocs) return true;
  if (event.mode === 'attestation') return (event.replies || []).length > 0;
  if (event.mode === 'declaration') return !!(event.completion && event.completion.status === 'complete');
  return false;
}

// All composed ack body text lives in email-bodies.js: the reply-ack
// builders (replyAck.*) and the initiator-command builders (cmd.*),
// both imported above. receive.js owns the dispatch + persistence and
// calls the catalogue for body text.

// Module 8 — parse a revoke+ email body. One email per line; optional
// final/standalone `reason: <free-form>` line captured separately.
// Quoted-reply lines (leading `>`) and signature delimiters (`-- `)
// are skipped. We scan at most the first 80 non-quoted lines to keep
// pathological bodies bounded.
//
// Strict line shape: the trimmed line must consist of ONLY the email
// (with optional `<>` wrap and optional leading `revoke:` prefix).
// This rejects gmail/apple-mail attribution lines like
// `On Tue, bob <bob@ex.com> wrote:` that clients sometimes flatten
// without the `>` quote prefix — those would otherwise revoke bob.
// Common forms accepted:
//   bob@example.com
//   <bob@example.com>
//   revoke: bob@example.com
// Returns { emails: string[], reason: string|null } with emails
// deduped (case-insensitive), in first-seen order.
const REVOKE_LINE_RE = /^(?:revoke\s*[:=]\s*)?<?\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\s*>?\s*$/i;
function parseRevokeBody(text) {
  const out = { emails: [], reason: null };
  if (!text || typeof text !== 'string') return out;
  const seen = new Set();
  const lines = text.split(/\r?\n/);
  let scanned = 0;
  for (const rawLine of lines) {
    if (scanned >= 80) break;
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('>')) continue;
    if (line === '--' || line === '-- ') break;
    scanned += 1;
    const reasonMatch = /^reason\s*[:=]\s*(.+)$/i.exec(line);
    if (reasonMatch) {
      if (!out.reason) out.reason = reasonMatch[1].trim();
      continue;
    }
    const emailMatch = REVOKE_LINE_RE.exec(line);
    if (emailMatch) {
      const lower = emailMatch[1].toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        out.emails.push(lower);
      }
    }
  }
  return out;
}

async function main() {
  const raw = await readStdin();
  if (raw.length === 0) {
    process.stderr.write('receive: empty stdin\n');
    process.exit(2);
  }

  const envelope = parseEnvelope(process.argv);

  const testDnsResolver = loadTestDnsResolver();

  const [auth, parsed] = await Promise.all([
    authenticate(raw, {
      trustReceived: false,
      ip: envelope.clientIp || undefined,
      helo: envelope.clientHelo || undefined,
      mta: config.mtaHostname,
      sender: envelope.sender || undefined,
      resolver: testDnsResolver || undefined,
    }),
    simpleParser(raw),
  ]);

  const from = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
  const headerBlock = extractHeaderBlock(raw, config.maxHeaderBytes);
  const filter = preFilter(headerBlock, from.address);

  // Phase D — RFC 3464 bounce handling. Postfix forwards bounces from
  // downstream MTAs back to the envelope sender, which for our outbound
  // notifications is gitdone@<domain>; the catch-all pipe drops them
  // into this script. We detect by Content-Type before the prefilter
  // rejects on system-sender (mailer-daemon), parse the
  // delivery-status part, and persist a per-step last_send_error so the
  // organiser sees a "delivery failed" row on the dashboard.
  //
  // Trust model: anyone can fabricate a DSN body. The blast radius is
  // an attacker who knows an event+step tag triggering a misleading
  // alert that the organiser then verifies and clears via Edit. Worth
  // the cost — the alternative is silent failures on real bounces.
  const dsn = extractDsn(parsed, raw);
  if (dsn) {
    const receivedAtDsn = new Date().toISOString();
    const failed = (dsn.recipients || []).filter((r) => r.action === 'failed');
    const perEvent = new Map(); // eventId → { errors: {stepId: {...}}, recipients: [...] }
    for (const r of failed) {
      const tagDsn = parseEventTag(r.originalRecipient || '');
      if (!tagDsn || !tagDsn.stepId) continue;
      let bucket = perEvent.get(tagDsn.eventId);
      if (!bucket) {
        bucket = { errors: {}, recipients: [] };
        perEvent.set(tagDsn.eventId, bucket);
      }
      bucket.errors[tagDsn.stepId] = {
        reason: 'bounced',
        code: r.status || null,
        diagnostic: r.diagnostic || null,
        final_recipient: r.finalRecipient || null,
        at: receivedAtDsn,
      };
      bucket.recipients.push({ stepId: tagDsn.stepId, ...r });
    }

    // Initiator-bounce sweep: any failed recipient that DIDN'T match an
    // event+id-step@ tag might be the activation magic-link bouncing
    // back. Scan pending events; if an address matches a pending event's
    // initiator, delete the event (no recovery possible — the address
    // can't receive the link in Mode A, and we can't reach the user any
    // other way). Activated events are left alone: their initiator
    // bounce still shouldn't lose audit history.
    const initiatorBouncesDeleted = [];
    const unmatched = failed.filter((r) => {
      const tag = parseEventTag(r.originalRecipient || '');
      return !tag || !tag.stepId;
    });
    if (unmatched.length) {
      const addresses = new Set(unmatched.map((r) => {
        const orig = (r.originalRecipient || r.finalRecipient || '').toLowerCase().trim();
        return orig;
      }).filter(Boolean));
      const eventsDir = path.join(config.dataDir, 'events');
      let files = [];
      try { files = await fs.readdir(eventsDir); } catch { files = []; }
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const id = f.slice(0, -5);
        const ev = await loadEvent(id).catch(() => null);
        if (!ev) continue;
        if (ev.activated_at) continue; // activated events keep their record
        const initiator = String(ev.initiator || '').toLowerCase();
        if (!initiator || !addresses.has(initiator)) continue;
        try {
          await fs.unlink(path.join(eventsDir, f));
          await fs.rm(path.join(config.dataDir, 'repos', id), { recursive: true, force: true })
            .catch(() => {});
          initiatorBouncesDeleted.push({ id, initiator, title: ev.title });
        } catch (err) {
          if (err.code !== 'ENOENT') {
            process.stderr.write(`dsn-initiator-cleanup: ${err.message || err}\n`);
          }
        }
      }
    }

    const persisted = [];
    for (const [eventId, bucket] of perEvent) {
      let alertEvent = null;
      try {
        alertEvent = await recordStepSendErrors(eventId, bucket.errors);
      } catch (err) {
        persisted.push({ event_id: eventId, error: err.message || String(err) });
        continue;
      }
      persisted.push({ event_id: eventId, steps: Object.keys(bucket.errors), persisted: !!alertEvent });
      // Email the organiser so they see the bounce out-of-band, not just
      // on the dashboard. Best-effort — a send failure here doesn't undo
      // the persist.
      if (alertEvent && alertEvent.initiator) {
        const lines = [
          `One or more invitations for your event bounced and were not delivered.`,
          ``,
          `Event: ${alertEvent.title}`,
          `Event ID: ${eventId}`,
          ``,
          `Bounced steps:`,
        ];
        for (const r of bucket.recipients) {
          const step = (alertEvent.steps || []).find((s) => s.id === r.stepId);
          const name = step ? step.name : r.stepId;
          const addr = step ? step.participant : (r.finalRecipient || '?');
          lines.push(`  - ${name} → <${addr}>`);
          if (r.status) lines.push(`      status: ${r.status}`);
          if (r.diagnostic) lines.push(`      diagnostic: ${r.diagnostic}`);
        }
        lines.push(
          ``,
          `Open the dashboard to fix the address(es) — once edited, the`,
          `participant gets a fresh invitation:`,
          `  ${process.env.GITDONE_PUBLIC_URL || `https://${config.domain}`}/manage/event/${eventId}`,
        );
        const body = lines.join('\n');
        const fromAddr = `gitdone@${config.domain}`;
        try {
          const rawMessage = buildRawMessage({
            from: fromAddr,
            to: alertEvent.initiator,
            subject: `[gitdone] "${alertEvent.title}" — invitation bounced`,
            body,
            domain: config.domain,
            autoSubmitted: 'auto-generated',
            extraHeaders: { 'X-GitDone-Event': eventId },
          });
          await sendmail({ from: fromAddr, rawMessage, to: [alertEvent.initiator] });
        } catch (err) {
          process.stderr.write(`dsn-alert: ${err.message || err}\n`);
        }
      }
    }

    logger.emit({
      kind: 'dsn',
      accepted: true,
      received_at: receivedAtDsn,
      initiator_bounces_deleted: initiatorBouncesDeleted,
      envelope: {
        client_ip: envelope.clientIp,
        client_helo: envelope.clientHelo,
        sender: envelope.sender,
        recipient: envelope.recipient,
      },
      reporting_mta: (dsn.reporting && dsn.reporting['reporting-mta']) || null,
      failed_recipients: failed.map((r) => ({
        original: r.originalRecipient,
        final: r.finalRecipient,
        status: r.status,
      })),
      persisted,
    });
    return;
  }

  // 1.L.1: verify+{id}@ — short-circuit before event routing / commit flow.
  // Public verification endpoint: anyone can forward a raw .eml or attachment
  // and get a report. No commit. No trust classifier. Just check and log.
  const verifyTag = parseVerifyTag(envelope.recipient);
  if (verifyTag && !filter.rejected) {
    const report = await buildVerificationReport(verifyTag.eventId, parsed);
    logger.emit({
      kind: 'verify_report',
      accepted: true,
      verify_event_id: verifyTag.eventId,
      received_at: new Date().toISOString(),
      envelope: {
        client_ip: envelope.clientIp,
        client_helo: envelope.clientHelo,
        sender: envelope.sender,
        recipient: envelope.recipient,
      },
      from: from.address || null,
      report,
    });

    // 1.L.1 send path: DKIM-signed report back to the forwarder.
    // Recipient priority: envelope sender (what the MTA handed us) over
    // the From header (which could be spoofed in a non-authed context).
    // Either way, Auto-Submitted blocks loops via our own prefilter.
    const to = envelope.sender || from.address || null;
    if (to) {
      const fromAddr = `verify+${verifyTag.eventId}@${config.domain}`;
      const rawMessage = buildRawMessage({
        from: `gitdone <${fromAddr}>`,
        to,
        subject: `[gitdone] verification report for event ${verifyTag.eventId}`,
        inReplyTo: parsed.messageId || null,
        references: parsed.messageId || null,
        body: formatVerifyReportBody(report),
        domain: config.domain,
      });
      const sendResult = await sendmail({ from: fromAddr, rawMessage });
      logger.emit({
        kind: 'verify_reply_sent',
        verify_event_id: verifyTag.eventId,
        to,
        from: fromAddr,
        ok: sendResult.ok,
        code: sendResult.code || null,
        stderr: sendResult.stderr || null,
        reason: sendResult.reason || null,
      });
    }
    return;
  }

  // 1.L.3: reverify+{eventId}-{commitN}@ — contested-commit upgrade path.
  // Auth is cryptographic (the submitter must supply a raw .eml that
  // validates against the archived PEM). Writes an immutable
  // reverify-NNN.json audit record; never modifies the original commit.
  const reverifyTag = parseReverifyTag(envelope.recipient);
  if (reverifyTag && !filter.rejected) {
    const rEvent = await loadEvent(reverifyTag.eventId);
    let record;
    if (!rEvent) {
      record = { found: false, reason: `event ${reverifyTag.eventId} not found` };
    } else {
      record = await buildReverifyRecord(
        reverifyTag.eventId,
        reverifyTag.commitSequence,
        parsed,
        {
          readPem: async (rel) => {
            try {
              return await fs.readFile(
                path.join(config.dataDir, 'repos', reverifyTag.eventId, rel),
                'utf8',
              );
            } catch { return null; }
          },
        },
      );
    }

    let gitRecord = null;
    if (record.found) {
      try {
        gitRecord = await persistReverifyRecord(
          reverifyTag.eventId, rEvent, reverifyTag.commitSequence, record,
          new Date().toISOString(),
        );
      } catch (err) {
        gitRecord = { error: err.message || String(err) };
      }
    }

    logger.emit({
      kind: 'reverify_report',
      accepted: true,
      reverify_event_id: reverifyTag.eventId,
      target_commit_sequence: reverifyTag.commitSequence,
      received_at: new Date().toISOString(),
      envelope: {
        client_ip: envelope.clientIp,
        client_helo: envelope.clientHelo,
        sender: envelope.sender,
        recipient: envelope.recipient,
      },
      from: from.address || null,
      upgraded: Boolean(record.upgraded),
      trust_before: record.trust_level_before || null,
      trust_after: record.trust_level_after || null,
      git_record: gitRecord,
    });

    // DKIM-signed ack back to the submitter (reuse 1.L.1 send path)
    const to = envelope.sender || from.address || null;
    if (to) {
      const fromAddr = `reverify+${reverifyTag.eventId}-${reverifyTag.commitSequence}@${config.domain}`;
      const body = formatReverifyReportBody(reverifyTag.eventId, reverifyTag.commitSequence, record);
      const rawMessage = buildRawMessage({
        from: `gitdone <${fromAddr}>`,
        to,
        subject: `[gitdone] re-verification report for ${reverifyTag.eventId} commit-${String(reverifyTag.commitSequence).padStart(3, '0')}`,
        inReplyTo: parsed.messageId || null,
        references: parsed.messageId || null,
        body,
        domain: config.domain,
      });
      const sendResult = await sendmail({ from: fromAddr, rawMessage });
      logger.emit({
        kind: 'reverify_reply_sent',
        reverify_event_id: reverifyTag.eventId,
        to,
        from: fromAddr,
        ok: sendResult.ok,
        code: sendResult.code || null,
        reason: sendResult.reason || null,
      });
    }
    return;
  }

  // §6.4 initiator email commands — stats+{id}@, remind+{id}@, close+{id}@.
  // Short-circuits before the reply-commit path; no git commit is written
  // (except close+, which writes a completion commit).
  const cmdTag = parseInitiatorCommand(envelope.recipient);
  if (cmdTag && !filter.rejected) {
    const cmdEvent = await loadEvent(cmdTag.eventId).catch(() => null);
    const receivedAtCmd = new Date().toISOString();
    // Classify trust here because we need it for auth.
    const trustCmd = classifyTrust(auth);
    const auth1 = authenticateInitiatorCommand(cmdEvent, {
      sender: envelope.sender || (from.address || null),
      trustLevel: trustCmd,
    });
    let replyBody;
    let cmdOutcome = { command: cmdTag.command, event_id: cmdTag.eventId, authenticated: auth1.ok };
    let closeOutcome = null;
    let bundleOutcome = null;  // { ok, buffer? , filename, reason? } when command === 'bundle' and auth passed
    if (!auth1.ok) {
      replyBody = cmdBodies.rejected(cmdTag.command, auth1.reason);
      cmdOutcome.reason = auth1.reason;
    } else if (cmdTag.command === 'bundle') {
      // Pack the per-event git repo into a tar.gz and reply with it as
      // an attachment. The event has no commits if no replies have been
      // received yet (pending-activation events, or activated events
      // with no inbound mail). In that case, send a plain-text "no proof
      // yet" reply rather than a 0-byte archive.
      const filename = bundleFilename(cmdTag.eventId);
      const result = await bundleToBuffer(cmdTag.eventId);
      bundleOutcome = { ...result, filename };
      cmdOutcome.bundle_ok = result.ok;
      if (result.ok) {
        cmdOutcome.bundle_size = result.buffer.length;
        replyBody = cmdBodies.bundle.ready(cmdEvent);
      } else {
        cmdOutcome.bundle_reason = result.reason || null;
        replyBody = cmdBodies.bundle.empty(cmdEvent);
      }
    } else if (cmdTag.command === 'stats') {
      replyBody = cmdBodies.stats(cmdEvent);
    } else if (cmdTag.command === 'remind') {
      const r = await executeRemind(cmdEvent);
      replyBody = r.body;
      cmdOutcome.sent_to = r.sentTo.map((x) => ({ to: x.to, ok: x.ok }));
    } else if (cmdTag.command === 'close') {
      const r = executeCloseRequest(cmdEvent, {
        receivedAt: receivedAtCmd,
        replySubject: parsed.subject || '',
        replyText: parsed.text || '',
      });
      replyBody = r.body;
      cmdOutcome.close_kind = r.kind;
      cmdOutcome.already_complete = r.kind === 'already_complete';
      closeOutcome = r;
      if (r.kind === 'committed') {
        try {
          await updateEventAtomic(cmdTag.eventId, () => r.newEvent, { syncMessage: 'event closed by initiator' });
          const cc = await commitCompletion(cmdTag.eventId, r.newEvent, {
            completedAt: receivedAtCmd,
            triggeringSequence: null,
            summary: { closed_by: 'initiator', reason: 'close-command' },
          });
          cmdOutcome.completion_commit = cc;
          try {
            const { listCommits } = require('../src/gitrepo');
            const allCommitsClose = await listCommits(cmdTag.eventId).catch(() => []);
            const countingClose = filterCountingCommits(r.newEvent, allCommitsClose);
            // notifyLifecycleEdge owns the close-by-initiator side
            // effect: strict-attestation email redaction fires
            // post-notify inside the dispatcher (see notifications.js).
            const results = await notifyLifecycleEdge(r.newEvent, 'closed', {
              commits: countingClose,
              now: receivedAtCmd,
            });
            cmdOutcome.completion_notified = results.map((x) => ({ to: x.to, ok: x.ok }));
            const firstOk = results.find((rr) => rr.ok && rr.message_id);
            if (firstOk) {
              try {
                const { recordProofEmailMessageId } = require('../src/event-store');
                await recordProofEmailMessageId(cmdTag.eventId, firstOk.message_id);
              } catch {}
            }
          } catch (err) {
            cmdOutcome.completion_notify_error = err.message || String(err);
          }
        } catch (err) {
          cmdOutcome.close_error = err.message || String(err);
        }
      } else if (r.kind === 'pending_started') {
        // First-stage: persist the pending intent so the second reply
        // can verify it. No completion commit yet.
        try {
          await updateEventAtomic(cmdTag.eventId, () => r.newEvent, { syncMessage: 'close request: awaiting confirmation' });
          cmdOutcome.pending_close_expires_at = r.expiresAt;
        } catch (err) {
          cmdOutcome.close_error = err.message || String(err);
        }
      }
      // pending_remind / token_mismatch / already_complete: no persistence.
    }

    // Reply to the initiator.
    const to = envelope.sender || from.address || null;
    if (to) {
      const fromAddr = `${cmdTag.command}+${cmdTag.eventId}@${config.domain}`;
      // Mirror the [N/M] step-progress notification shape so command
      // replies read like a status snapshot rather than a tag dump.
      // Falls back to the bare command·id form when the event isn't
      // loaded (rejected commands, unknown ids).
      let subjectStr = `[gitdone] ${cmdTag.command} · ${cmdTag.eventId}`;
      // bundle+ has its own subject shape (proof bundle with .tar.gz
      // attachment) and threads to the proof email if there is one.
      // Build it before the verb-based subject for the other commands.
      if (cmdTag.command === 'bundle' && cmdEvent && bundleOutcome) {
        subjectStr = bundleOutcome.ok
          ? `[gitdone] proof bundle — "${cmdEvent.title}"`
          : `[gitdone] no proof yet — "${cmdEvent.title}"`;
      } else if (cmdEvent) {
        // Attestation has no participant list, so remind+ doesn't actually
        // remind anyone — the body explains how to share the reply
        // address. Use a different verb so the subject doesn't pretend
        // reminders were sent.
        const isAttestationRemind = cmdTag.command === 'remind'
          && cmdEvent.type === 'crypto' && cmdEvent.mode === 'attestation';
        const verb = isAttestationRemind
          ? 'share'
          : (cmdTag.command === 'remind'
              ? 'reminded'
              : (cmdTag.command === 'close' ? 'closed' : 'stats'));
        if (cmdEvent.type === 'event') {
          const total = (cmdEvent.steps || []).length;
          const done = (cmdEvent.steps || []).filter((s) => s.status === 'complete').length;
          const phrase = cmdEvent.completion && cmdEvent.completion.status === 'complete' ? 'complete' : 'step done';
          subjectStr = `[gitdone] ${verb} "${cmdEvent.title}" [${done}/${total}] ${phrase}`;
        } else if (cmdEvent.type === 'crypto') {
          const status = cmdEvent.completion && cmdEvent.completion.status === 'complete' ? 'complete' : 'open';
          subjectStr = `[gitdone] ${verb} "${cmdEvent.title}" — ${cmdEvent.mode} · ${status}`;
        }
        // Pending-close intermediate states get their own subject so the
        // initiator's MUA shows them as pending rather than closed.
        if (cmdTag.command === 'close' && closeOutcome) {
          if (closeOutcome.kind === 'pending_started') {
            subjectStr = `[gitdone] close pending "${cmdEvent.title}" — reply to confirm`;
          } else if (closeOutcome.kind === 'pending_remind') {
            subjectStr = `[gitdone] close pending "${cmdEvent.title}" — still awaiting confirmation`;
          } else if (closeOutcome.kind === 'token_mismatch') {
            subjectStr = `[gitdone] close pending "${cmdEvent.title}" — token mismatch, retry`;
          }
        }
      }
      // bundle+ with a real archive: send a multipart/mixed message with
      // the .tar.gz attached and thread to the proof email if one exists
      // (so the bundle lands under the same conversation as the receipt).
      // No-archive bundle+: fall through to the plain-text reply path.
      let rawMessage;
      if (cmdTag.command === 'bundle' && bundleOutcome && bundleOutcome.ok) {
        const proofMid = (cmdEvent && cmdEvent.proof_email_message_id) || null;
        rawMessage = buildAttachmentMessage({
          from: `gitdone <${fromAddr}>`,
          to,
          subject: subjectStr,
          body: replyBody,
          attachment: {
            filename: bundleOutcome.filename,
            contentType: 'application/gzip',
            content: bundleOutcome.buffer,
          },
          inReplyTo: proofMid || parsed.messageId || null,
          references: proofMid || parsed.messageId || null,
          domain: config.domain,
        });
      } else {
        rawMessage = buildRawMessage({
          from: `gitdone <${fromAddr}>`,
          to,
          subject: subjectStr,
          inReplyTo: parsed.messageId || null,
          references: parsed.messageId || null,
          body: replyBody,
          domain: config.domain,
        });
      }
      const sendRes = await sendmail({ from: fromAddr, rawMessage, to: [to] });
      cmdOutcome.reply = { to, ok: sendRes.ok, reason: sendRes.reason || null, code: sendRes.code || null };
    }

    logger.emit({
      kind: 'initiator_command',
      accepted: true,
      received_at: receivedAtCmd,
      envelope: {
        client_ip: envelope.clientIp,
        client_helo: envelope.clientHelo,
        sender: envelope.sender,
        recipient: envelope.recipient,
      },
      from: from.address || null,
      trust_level: trustCmd,
      command: cmdOutcome,
    });
    return;
  }

  // Module 4a — attach+{id}@: reference-doc registration channel.
  // Initiator-only, DKIM-gated. Hashes each attachment (SHA-256 + filename
  // + size), appends to event.reference_docs[], discards the bytes, writes
  // a kind:'attach' commit, OTS-stamps. Frozen at first counted reply.
  const attachTag = parseAttachTag(envelope.recipient);
  if (attachTag && !filter.rejected) {
    const attachEvent = await loadEvent(attachTag.eventId).catch(() => null);
    const receivedAtAtt = new Date().toISOString();
    const trustAtt = classifyTrust(auth);
    const senderAtt = envelope.sender || (from.address || null);
    const fromAddrAtt = `attach+${attachTag.eventId}@${config.domain}`;
    const to = senderAtt;

    let replyBody;
    const attachOutcome = {
      event_id: attachTag.eventId,
      accepted: false,
      reason: null,
      added: 0,
    };

    if (!attachEvent) {
      attachOutcome.reason = 'unknown event';
      replyBody = cmdBodies.attach.unknownEvent(attachTag.eventId);
    } else if (attachEvent.type !== 'crypto') {
      attachOutcome.reason = 'not a crypto event';
      replyBody = cmdBodies.attach.notCrypto(attachEvent);
    } else {
      const auth1 = authenticateInitiatorCommand(attachEvent, { sender: senderAtt, trustLevel: trustAtt });
      if (!auth1.ok) {
        attachOutcome.reason = auth1.reason;
        replyBody = cmdBodies.attach.rejected(attachTag.eventId, auth1.reason);
      } else if (isReferenceDocSetFrozen(attachEvent)) {
        attachOutcome.reason = 'doc set frozen';
        replyBody = cmdBodies.attach.frozen(attachEvent);
      } else if (!parsed.attachments || parsed.attachments.length === 0) {
        attachOutcome.reason = 'no attachments';
        replyBody = cmdBodies.attach.noAttachments(fromAddrAtt);
      } else {
        const newEntries = parsed.attachments.map((a) => ({
          filename: a.filename || null,
          content_type: a.contentType || null,
          size: a.size || (a.content && a.content.length) || 0,
          sha256: a.content ? sha256(a.content) : null,
          registered_at: receivedAtAtt,
        }));
        const updRes = await updateEventAtomic(attachTag.eventId, (ev) => ({
          ...ev,
          reference_docs: [...(ev.reference_docs || []), ...newEntries],
        }), { syncMessage: `reference_docs +${newEntries.length}` });
        const updated = updRes.event;
        let gitRes = null;
        try {
          gitRes = await commitAttach(attachTag.eventId, updated, {
            receivedAt: receivedAtAtt,
            sender_domain: from.address ? from.address.split('@')[1] : (senderAtt ? senderAtt.split('@')[1] : null),
            sender: senderAtt,
            attachments: newEntries,
          });
        } catch (err) {
          attachOutcome.commit_error = err.message || String(err);
        }
        attachOutcome.accepted = true;
        attachOutcome.added = newEntries.length;
        attachOutcome.commit_sequence = gitRes ? gitRes.sequence : null;

        // Module 4c: strict mode — if this is the first batch (event had
        // no reference_docs before) AND the event cites a reference_url,
        // the declaration signer's invite was held at activation. Fire it
        // now that the signer can know what to attach.
        const wasEmpty = !((attachEvent.reference_docs || []).length);
        const strictNow = !!updated.reference_url
          && !!(updated.reference_docs && updated.reference_docs.length);
        if (wasEmpty && strictNow && updated.mode === 'declaration') {
          try {
            const { notifyDeclarationSigner } = require('../src/notifications');
            const sendResults = await notifyDeclarationSigner(updated);
            attachOutcome.signer_invited = sendResults.map((s) => ({ to: s.to, ok: s.ok }));
          } catch (err) {
            attachOutcome.signer_invite_error = err.message || String(err);
          }
        }

        replyBody = cmdBodies.attach.registered(updated, { added: newEntries.length, strictNow });
      }
    }

    if (to && replyBody) {
      const subject = attachEvent
        ? `[gitdone] attach+ — ${attachEvent.title}`
        : `[gitdone] attach+ — ${attachTag.eventId}`;
      const rawMessage = buildRawMessage({
        from: `gitdone <${fromAddrAtt}>`,
        to, subject, body: replyBody,
        inReplyTo: parsed.messageId || null,
        references: parsed.messageId || null,
        domain: config.domain,
        autoSubmitted: 'auto-replied',
      });
      const sendRes = await sendmail({ from: fromAddrAtt, rawMessage, to: [to] });
      attachOutcome.reply = { to, ok: sendRes.ok, reason: sendRes.reason || null };
    }

    logger.emit({
      kind: 'attach_command',
      received_at: receivedAtAtt,
      envelope: {
        client_ip: envelope.clientIp,
        client_helo: envelope.clientHelo,
        sender: envelope.sender,
        recipient: envelope.recipient,
      },
      from: from.address || null,
      trust_level: trustAtt,
      attach: attachOutcome,
    });
    return;
  }

  // Module 8 — revoke+{id}@: initiator-only attestation revocation
  // channel. Body lists one attestor email per line plus optional
  // `reason: ...`; we hash each against event.salt, find matches in
  // attestor_progress / replies, append to event.revoked_senders[],
  // and re-run completion (locking dedup can flip back to open). The
  // original signature commits stay in the audit trail untouched.
  const revokeTag = parseRevokeTag(envelope.recipient);
  if (revokeTag && !filter.rejected) {
    const revokeEvent = await loadEvent(revokeTag.eventId).catch(() => null);
    const receivedAtRev = new Date().toISOString();
    const trustRev = classifyTrust(auth);
    const senderRev = envelope.sender || (from.address || null);
    const fromAddrRev = `revoke+${revokeTag.eventId}@${config.domain}`;
    const to = senderRev;

    const revokeOutcome = {
      event_id: revokeTag.eventId,
      accepted: false,
      reason: null,
      revoked: 0,
      not_found: [],
    };
    let replyBody;

    if (!revokeEvent) {
      revokeOutcome.reason = 'unknown event';
      replyBody = cmdBodies.revoke.unknownEvent(revokeTag.eventId);
    } else if (revokeEvent.type !== 'crypto' || revokeEvent.mode !== 'attestation') {
      revokeOutcome.reason = 'not an attestation event';
      replyBody = cmdBodies.revoke.notAttestation(revokeEvent);
    } else {
      const authR = authenticateInitiatorCommand(revokeEvent, { sender: senderRev, trustLevel: trustRev });
      if (!authR.ok) {
        revokeOutcome.reason = authR.reason;
        replyBody = cmdBodies.revoke.rejected(fromAddrRev, authR.reason);
      } else {
        const parsedBody = parseRevokeBody(parsed.text || '');
        revokeOutcome.parsed_emails = parsedBody.emails;
        revokeOutcome.parsed_reason = parsedBody.reason;
        if (parsedBody.emails.length === 0) {
          revokeOutcome.reason = 'no targets';
          replyBody = cmdBodies.revoke.noTargets();
        } else {
          // Resolve each target email to its sender_hash INSIDE the
          // atomic block so the resolution uses the freshly-loaded
          // event.salt / attestor_progress / replies (not the outer
          // snapshot, which could be stale if an inbound reply landed
          // between loadEvent and the mutex acquisition). The ack
          // body then uses the resolution actually applied.
          let resolved = [];
          let notFound = [];
          let appliedResult = null;
          let updatedEvent = revokeEvent;
          const updRes = await updateEventAtomic(revokeTag.eventId, (current) => {
            const knownHashes = new Set();
            for (const k of Object.keys(current.attestor_progress || {})) knownHashes.add(k);
            for (const r of (current.replies || [])) {
              if (r && r.sender_hash) knownHashes.add(r.sender_hash);
            }
            resolved = [];
            notFound = [];
            for (const email of parsedBody.emails) {
              const h = hashSender(email, current.salt);
              if (h && knownHashes.has(h)) {
                resolved.push({ email, sender_hash: h });
              } else {
                notFound.push(email);
              }
            }
            if (resolved.length === 0) {
              appliedResult = { applied: false, countAfter: null };
              return null;
            }
            appliedResult = applyRevoke(current, resolved.map((r) => r.sender_hash), {
              reason: parsedBody.reason,
              now: receivedAtRev,
            });
            if (!appliedResult.applied) return null;
            updatedEvent = appliedResult.event;
            return updatedEvent;
          }, { syncMessage: `revoke -${parsedBody.emails.length}` });
          revokeOutcome.not_found = notFound;
          if (resolved.length === 0) {
            revokeOutcome.reason = 'no matching attestors';
            replyBody = cmdBodies.revoke.noMatching(revokeEvent, parsedBody.emails);
          } else {
            updatedEvent = updRes.event;
            let gitRes = null;
            try {
              gitRes = await commitRevoke(revokeTag.eventId, updatedEvent, {
                receivedAt: receivedAtRev,
                sender_domain: from.address ? from.address.split('@')[1] : (senderRev ? senderRev.split('@')[1] : null),
                sender: senderRev,
                revoked: resolved.map((r) => ({ sender_hash: r.sender_hash })),
                reason: parsedBody.reason || null,
              });
            } catch (err) {
              revokeOutcome.commit_error = err.message || String(err);
            }
            revokeOutcome.accepted = true;
            revokeOutcome.revoked = resolved.length;
            revokeOutcome.commit_sequence = gitRes ? gitRes.sequence : null;
            revokeOutcome.count_after = appliedResult ? appliedResult.countAfter : null;
            revokeOutcome.reopened = !!(updatedEvent.completion
              && updatedEvent.completion.status === 'open'
              && updatedEvent.completion.reopened_at === receivedAtRev);

            replyBody = cmdBodies.revoke.done(updatedEvent, {
              resolved,
              notFound: revokeOutcome.not_found,
              reason: parsedBody.reason,
              countAfter: revokeOutcome.count_after,
              reopened: revokeOutcome.reopened,
            });
          }
        }
      }
    }

    if (to && replyBody) {
      // Counter + closed-early infix mirror the proof-email subject so
      // the initiator's triage view shows the impact of the revoke
      // (effective/threshold) and whether the event is still terminal.
      // Read from revokeEvent (pre-revoke snapshot, in scope here);
      // threshold is immutable, and the closed-early check is gated
      // on `!revokedOutcome.reopened` so a revoke that re-opens the
      // event doesn't claim "closed early" in the subject.
      const counterTag = (typeof revokeOutcome.count_after === 'number' && revokeEvent && revokeEvent.threshold)
        ? ` [${revokeOutcome.count_after}/${revokeEvent.threshold}]`
        : '';
      const stillClosedEarly = revokeEvent && isClosedByInitiator(revokeEvent) && !revokeOutcome.reopened;
      const closedInfix = stillClosedEarly ? ' — closed early' : '';
      const subject = revokeEvent
        ? `[gitdone] revoke+ — ${revokeEvent.title}${counterTag}${closedInfix}`
        : `[gitdone] revoke+ — ${revokeTag.eventId}${counterTag}${closedInfix}`;
      const rawMessage = buildRawMessage({
        from: `gitdone <${fromAddrRev}>`,
        to, subject, body: replyBody,
        inReplyTo: parsed.messageId || null,
        references: parsed.messageId || null,
        domain: config.domain,
        autoSubmitted: 'auto-replied',
      });
      const sendRes = await sendmail({ from: fromAddrRev, rawMessage, to: [to] });
      revokeOutcome.reply = { to, ok: sendRes.ok, reason: sendRes.reason || null };
    }

    logger.emit({
      kind: 'revoke_command',
      received_at: receivedAtRev,
      envelope: {
        client_ip: envelope.clientIp,
        client_helo: envelope.clientHelo,
        sender: envelope.sender,
        recipient: envelope.recipient,
      },
      from: from.address || null,
      trust_level: trustRev,
      revoke: revokeOutcome,
    });
    return;
  }

  // Routing: resolve plus-tag → event/step, look up event JSON, check
  // sender-vs-participant match. Accept-with-flag: never reject on routing
  // failure. Initiator policy decides.
  const addr = parseAddress(envelope.recipient);
  const tag = parseEventTag(envelope.recipient);
  let event = null;
  let routing = {
    matched: false,
    address_kind: addr ? addr.kind : null,
    event_id: tag ? tag.eventId : null,
    step_id: tag ? tag.stepId : null,
    step_found: null,
    participant_match: null,
  };
  if (tag) {
    try {
      event = await loadEvent(tag.eventId);
      if (event) {
        routing.matched = true;
        const step = findStep(event, tag.stepId);
        routing.step_found = !!step;
        if (step) {
          routing.participant_match = senderMatchesStep(envelope.sender || (from.address || null), step);
        }
      }
    } catch (err) {
      // Don't fail delivery on routing lookup error; record and continue.
      routing.error = err.message || String(err);
    }
  }

  if (filter.rejected) {
    logger.emit({
      accepted: false,
      rejection_reason: filter.reason,
      received_at: new Date().toISOString(),
      envelope: {
        client_ip: envelope.clientIp,
        client_helo: envelope.clientHelo,
        sender: envelope.sender,
        recipient: envelope.recipient,
      },
      from: from.address || null,
      subject: parsed.subject || null,
      raw_sha256: sha256(raw),
    });
    return;
  }

  const trustLevel = classifyTrust(auth);
  const receivedAt = new Date().toISOString();
  const bodyPreview = (parsed.text || '').slice(0, 200);
  const dkimSummary = summariseDkim(auth);
  const spfSummary = auth.spf ? { result: auth.spf.status && auth.spf.status.result } : null;
  const dmarcSummary = auth.dmarc ? { result: auth.dmarc.status && auth.dmarc.status.result } : null;
  const arcSummary = auth.arc ? {
    result: auth.arc.status && auth.arc.status.result,
    comment: (auth.arc.status && auth.arc.status.comment) || null,
    // ARC chain depth = the highest ARC instance number on the message
    // (i=N for the last seal). mailauth exposes this as `arc.i`. The
    // earlier read of `arc.authResults.length` was wrong: that field is
    // the rendered Authentication-Results header *string*, so .length
    // was the character count (~476 for a single msn→us hop), not a
    // chain depth. `arc.i` is 0 when no chain exists.
    chain_length: (auth.arc.i && Number.isFinite(auth.arc.i)) ? auth.arc.i : 0,
  } : null;
  const attachments = summariseAttachments(parsed);
  const rawHash = sha256(raw);

  // 1.D: for accepted mail with a DKIM signature, fetch the DKIM public key
  // from DNS right now. Archive alongside the commit so verification works
  // even after the signer rotates their DNS key.
  let dkimArchive = null;
  const sigToArchive = pickSignatureToArchive(auth);
  if (sigToArchive && sigToArchive.signingDomain && sigToArchive.selector) {
    dkimArchive = await fetchDkimKey(
      sigToArchive.signingDomain,
      sigToArchive.selector,
      testDnsResolver ? { resolver: testDnsResolver } : {}
    );
  }

  // 1.C: write per-event git commit for accepted replies that resolved to
  // a known event. Accept-with-flag: we commit regardless of
  // participant_match (that's a flag inside the commit, not a gate).
  let gitCommit = null;
  if (routing.matched && event && tag) {
    try {
      gitCommit = await commitReply(tag.eventId, event, {
        eventId: tag.eventId,
        stepId: tag.stepId,
        receivedAt,
        envelope: {
          sender: envelope.sender,
          client_ip: envelope.clientIp,
          client_helo: envelope.clientHelo,
        },
        from: from.address,
        trustLevel,
        participantMatch: routing.participant_match,
        messageId: parsed.messageId,
        attachments,
        dkim: dkimSummary,
        spf: spfSummary,
        dmarc: dmarcSummary,
        arc: arcSummary,
        rawSha256: rawHash,
        rawSize: raw.length,
        dkimArchive,
      });
    } catch (err) {
      gitCommit = { error: err.message || String(err) };
    }
  }

  // 1.J: run the completion engine. Load the fresh event JSON (reply
  // logic needs current step statuses + attestation replies[]), apply
  // the transition, and persist. Completion commit and cascade
  // notifications fire only on the edge where the event newly completes
  // or (for sequential workflows) a step transitions so the next one
  // should be notified.
  let completion = null;
  if (gitCommit && !gitCommit.error && event && tag) {
    try {
      const commitSummary = {
        event_id: tag.eventId,
        step_id: tag.stepId,
        sequence: gitCommit.sequence,
        trust_level: trustLevel,
        participant_match: routing.participant_match,
        sender_hash: saltedSenderHash(envelope.sender || from.address, event.salt),
        sender_domain: from.address ? from.address.split('@')[1] : null,
        received_at: receivedAt,
        has_attachment: (attachments || []).length > 0,
        // Module 4c: strict-signing match needs the full attachment list
        attachments: attachments || [],
        // Module 4e: strict-attestation persists this on the reply
        // that fills the attestor's bucket so the completion email can
        // reach them. completion.js gates storage behind strict mode +
        // attestor_emails_redacted_at; this field is otherwise ignored.
        sender_email: envelope.sender || from.address || null,
      };
      let applied = null;
      let didCascade = false;
      const seqStr = String(gitCommit.sequence).padStart(3, '0');
      const stepLabel = tag.stepId ? ` step ${tag.stepId}` : '';
      const { event: nextEvent, changed } = await updateEventAtomic(tag.eventId, (current) => {
        applied = applyReply(current, commitSummary, { now: receivedAt });
        return applied && applied.applied ? applied.event : null;
      }, { syncMessage: `reply ${seqStr} counted:${stepLabel || ' attestation'}` });
      // Hoist the post-update state to the outer `event` binding so the
      // participant receipt below reads the just-counted reply. Without
      // this the attestation ack rendered "Replies so far: 0/N" because
      // it was reading the pre-update snapshot loaded at the top of the
      // handler. updateEventAtomic always returns a defined event
      // (the original on changed=false, the updated copy on changed=true).
      event = nextEvent;
      completion = {
        applied: applied ? applied.applied : false,
        decision: applied ? applied.decision : null,
        completed_event: Boolean(applied && applied.completedEvent),
        completed_step: applied && applied.completedStep ? applied.completedStep : null,
      };

      // Once the proof email fires, we record `proof_email_sent_at` so
      // a same-completion re-trigger doesn't re-fire. BUT a revoke
      // that drops count below threshold reopens completion (status →
      // 'open', completed_at → null); a fresh attestor then closes it
      // again, stamping a NEW completion.completed_at. That's a
      // legitimately new event-state and a new proof should fire —
      // the prior stamp is stale. Gate: fire when no prior stamp, OR
      // when current completion.completed_at post-dates the stamp.
      // Accumulating gates on threshold_reached_at (durable) instead;
      // this gate only matters for locking dedup (unique/latest).
      const priorStamp = nextEvent.proof_email_sent_at || null;
      const currentCompleteAt = nextEvent.completion && nextEvent.completion.completed_at;
      const proofStale = !!(priorStamp && currentCompleteAt && currentCompleteAt > priorStamp);
      const shouldFireProof = !priorStamp || proofStale;
      if (changed && applied.completedEvent && shouldFireProof) {
        const summary = nextEvent.type === 'event'
          ? { steps_completed: nextEvent.steps.length }
          : nextEvent.mode === 'declaration'
            ? { signer: nextEvent.signer }
            : { threshold: nextEvent.threshold, counted: applied.countedReplies, dedup: nextEvent.dedup };
        // Accumulating attestation: completedEvent here signals the
        // first threshold crossing, but completion.status is still
        // 'open' by design (organiser closes explicitly). Writing
        // commits/completion.json would be a lie — repo says "complete",
        // event.json says "open". Skip the file entirely; the repo's
        // event.json (synced via syncEventJson above) carries
        // threshold_reached_at, which is sufficient signal for the
        // proof-email pipeline and the offline verifier.
        const isAccumulatingThreshold =
          nextEvent.type === 'crypto'
          && nextEvent.mode === 'attestation'
          && nextEvent.dedup === 'accumulating';
        if (!isAccumulatingThreshold) {
          try {
            const cc = await commitCompletion(tag.eventId, nextEvent, {
              completedAt: receivedAt,
              triggeringSequence: gitCommit.sequence,
              summary,
            });
            completion.completion_commit = cc;
          } catch (err) {
            completion.completion_commit_error = err.message || String(err);
          }
        }
        // Notify the organiser + every contributing participant that
        // the event has completed. Best-effort; a send failure here
        // doesn't undo the completion commit that was just written.
        // Pass the counted commits so the email body embeds the
        // cryptographic receipt(s) — this is the durable PROOF email
        // promised in PRD §0.1.4 ("invisible beats correct"; the proof
        // comes to the user, not the user to the proof).
        try {
          const reason = nextEvent.type === 'crypto' && nextEvent.mode === 'declaration'
            ? 'declaration_signed'
            : 'all_steps_done';
          const { listCommits } = require('../src/gitrepo');
          const allCommits = await listCommits(tag.eventId).catch(() => []);
          const countingCommits = filterCountingCommits(nextEvent, allCommits);
          // Module 4e — strict-attestation attestor emails are
          // resolved inside the dispatcher via getRecipients(event,
          // 'completed') in email-recipients.js. The 'completed' edge
          // does NOT redact (see below); redaction is the 'closed'
          // edge's side effect only.
          const results = await notifyLifecycleEdge(nextEvent, 'completed', {
            reason,
            completedStepId: applied.completedStep,
            commits: countingCommits,
          });
          completion.completion_notified = results.map((r) => ({ to: r.to, ok: r.ok }));
          // Redaction deliberately does NOT fire here. The original
          // Module 4e behaviour redacted on first proof-email send,
          // which broke two flows in practice:
          //   1. Revoke → reopen → recomplete: the new completion
          //      can't reach the freshly-completing attestor because
          //      their email is never stored (alreadyRedacted gate).
          //   2. Oversubscribe (more attestors complete after the
          //      threshold-reach reply): post-reach completions
          //      notify only the initiator because emails were
          //      redacted at the moment of first reach.
          // Redaction now fires on close-by-initiator (the explicit
          // terminal signal). Until close, attestor emails persist
          // in attestor_progress so every completion event reaches
          // everyone eligible. See close+ command handler above and
          // the dashboard-close path in server.js.
          // Stamp proof_email_sent_at to current trigger time. Always
          // overwrites — on a reopen-then-recomplete cycle we WANT
          // the stamp to advance so the gate above (compares stamp
          // vs completion.completed_at) correctly recognises the
          // next state. Best-effort: failure means a re-complete
          // could re-fire, but the completion ledger itself is correct.
          try {
            await updateEventAtomic(
              tag.eventId,
              (ev) => ({ ...ev, proof_email_sent_at: receivedAt }),
              { syncMessage: 'proof email sent' }
            );
          } catch (err) {
            process.stderr.write(`proof-email-stamp: ${err.message || err}\n`);
          }
          // Persist the FIRST recipient's Message-Id so the OTS-anchored
          // follow-up can thread to the proof email.
          const firstOk = results.find((r) => r.ok && r.message_id);
          if (firstOk) {
            try {
              const { recordProofEmailMessageId } = require('../src/event-store');
              await recordProofEmailMessageId(tag.eventId, firstOk.message_id);
            } catch (err) {
              process.stderr.write(`proof-msgid-record: ${err.message || err}\n`);
            }
          }
        } catch (err) {
          completion.completion_notify_error = err.message || String(err);
        }
      }

      // Cascade: a step just completed → notify every newly-eligible
      // downstream step (one whose depends_on lists the now-complete step
      // AND whose other deps are all complete). 1.H.2b: this is how the
      // dependency graph fires reminders.
      if (changed && nextEvent.type === 'event'
          && !applied.completedEvent
          && applied.completedStep) {
        const { eligibleSteps } = require('../src/completion');
        const newlyEligible = eligibleSteps(nextEvent)
          .filter((s) => (s.depends_on || []).includes(applied.completedStep));
        if (newlyEligible.length) {
          const results = await notifyWorkflowParticipants(nextEvent, {
            stepsOverride: newlyEligible,
          }).catch((e) => newlyEligible.map((s) => ({ to: s.participant, ok: false, reason: e.message || String(e) })));
          completion.cascade = {
            triggered_by: applied.completedStep,
            notified: newlyEligible.map((s) => s.id),
            results,
          };
        }
        // Tell the organiser a step completed and which participant(s)
        // are now active. Awaited so receive.js (a Postfix pipe
        // transport) doesn't exit before the SMTP submission finishes.
        try {
          await notifyLifecycleEdge(nextEvent, 'progressed', {
            completedStepId: applied.completedStep,
            newlyActiveSteps: newlyEligible,
          });
        } catch (err) {
          process.stderr.write(`progress-notify: ${err.message || err}\n`);
        }
      }
    } catch (err) {
      completion = { error: err.message || String(err) };
    }
  }

  // Auto-reply to the participant so every reply gets a signal back:
  //   - ACCEPTED: "your step is marked complete" (closes the "did my
  //     reply work?" loop; symmetric with the rejection paths below).
  //   - missing_attachment: please resend with a file.
  //   - event already complete / not activated: reply is in the audit
  //     trail but didn't count; say why.
  // Threaded via In-Reply-To so clients group the ack under the same
  // conversation thread and it doesn't clutter the inbox.
  let participantReply = null;
  if (completion && completion.decision && tag && event) {
    const reason = completion.decision.reason;
    const accepted = completion.applied === true;
    const isSelfReply = typeof reason === 'string' && reason.includes('self-reply');
    const handled = accepted
      || reason === 'missing_attachment'
      || reason === 'awaiting_reference_docs'
      || reason === 'attachment_set_mismatch'
      || reason === 'strict_no_matching_attachments'
      || reason === 'strict_already_signed'
      || reason === 'revoked_sender'
      || reason === 'event already complete'
      || reason === 'event not activated'
      || reason === 'event archived'
      || isSelfReply;
    const to = handled ? (envelope.sender || from.address || null) : null;
    if (to) {
      // Crypto reply addresses are event+<id>@ (no step suffix); workflow
      // is event+<id>-<step>@. Synthesise the right reply-back address.
      const isCrypto = event.type === 'crypto';
      // Per-attestor progress lookup key — needed by formatProgressBlock
      // so the ack reflects cumulative state for THIS sender (not a
      // declaration-only view that always reads "all open" for attestation).
      const ackSenderHash = isCrypto && event.mode === 'attestation' && event.salt
        ? saltedSenderHash(envelope.sender || from.address, event.salt)
        : null;
      const fromAddr = isCrypto
        ? `event+${tag.eventId}@${config.domain}`
        : `event+${tag.eventId}-${tag.stepId}@${config.domain}`;
      // Workflow-only step labels — undefined for crypto. Avoids the
      // "null" leak that surfaced in subjects/bodies when crypto events
      // went through the workflow ack template.
      const step = !isCrypto ? (completion.decision.step || (event.steps || []).find((s) => s.id === tag.stepId)) : null;
      const stepName = step ? step.name : null;
      const stepIdx = !isCrypto ? (event.steps || []).findIndex((s) => s.id === tag.stepId) : -1;
      const stepCounter = stepIdx >= 0 && (event.steps || []).length
        ? ` [${stepIdx + 1}/${event.steps.length}]`
        : '';
      const cryptoLabel = isCrypto
        ? (event.mode === 'declaration' ? 'Crypto Declaration' : 'Crypto Attestation')
        : null;
      // All ack TEXT lives in email-bodies.js (replyAck.*); this block
      // stays the dispatch (decision.reason → which builder). ackCtx
      // carries the shared precomputed primitives every builder draws on.
      const ackCtx = { isCrypto, fromAddr, cryptoLabel, stepName, stepCounter, ackSenderHash, completion };
      let subject;
      let body;
      if (accepted && isCrypto && event.mode === 'declaration') {
        ({ subject, body } = replyAck.acceptedDeclaration(event, ackCtx));
      } else if (accepted && isCrypto && event.mode === 'attestation') {
        ({ subject, body } = replyAck.acceptedAttestation(event, ackCtx));
      } else if (accepted) {
        ({ subject, body } = replyAck.acceptedWorkflow(event, ackCtx));
      } else if (isSelfReply) {
        ({ subject, body } = replyAck.selfReply(event, ackCtx));
      } else if (reason === 'attachment_set_mismatch') {
        ({ subject, body } = replyAck.attachmentSetMismatch(event, ackCtx));
      } else if (reason === 'strict_no_matching_attachments') {
        ({ subject, body } = replyAck.strictNoMatchingAttachments(event, ackCtx));
      } else if (reason === 'revoked_sender') {
        ({ subject, body } = replyAck.revokedSender(event, ackCtx));
      } else if (reason === 'strict_already_signed') {
        ({ subject, body } = replyAck.strictAlreadySigned(event, ackCtx));
      } else if (reason === 'awaiting_reference_docs') {
        ({ subject, body } = replyAck.awaitingReferenceDocs(event, ackCtx));
      } else if (reason === 'missing_attachment') {
        ({ subject, body } = replyAck.missingAttachment(event, ackCtx));
      } else if (reason === 'event archived') {
        ({ subject, body } = replyAck.eventArchived(event, ackCtx));
      } else if (reason === 'event not activated') {
        ({ subject, body } = replyAck.eventNotActivated(event, ackCtx));
      } else {
        ({ subject, body } = replyAck.eventClosed(event, ackCtx));
      }
      const rawMessage = buildRawMessage({
        from: `gitdone <${fromAddr}>`,
        to,
        subject,
        inReplyTo: parsed.messageId || null,
        references: parsed.messageId || null,
        body,
        domain: config.domain,
        autoSubmitted: 'auto-replied',
      });
      const sendResult = await sendmail({ from: fromAddr, rawMessage });
      participantReply = {
        kind: accepted ? 'accepted' : reason,
        to,
        from: fromAddr,
        ok: sendResult.ok,
        reason: sendResult.reason || null,
        code: sendResult.code || null,
      };
      // Separate log line only for rejection paths; the accepted-case
      // ack is already visible via completion.applied=true in the main
      // output, and emitting two stdout JSON objects breaks tests that
      // parse stdout as a single record.
      if (!accepted) {
        logger.emit({
          kind: 'participant_auto_reply',
          reason,
          event_id: tag.eventId,
          step_id: tag.stepId,
          to,
          ok: sendResult.ok,
        });
      }
    }
  }

  // 1.G: forward the original email (with attachments) to the event
  // initiator. Best-effort — a forward failure does NOT reject the
  // reply. The commit is authoritative; the forward is convenience.
  let forward = null;
  if (gitCommit && !gitCommit.error && event && event.initiator) {
    try {
      const result = await forwardToOwner({
        rawEmail: raw,
        initiator: event.initiator,
        eventId: tag.eventId,
        stepId: tag.stepId,
        commitFile: gitCommit.file || null,
        trustLevel,
        receivedAt,
      });
      forward = {
        attempted: true,
        to: event.initiator,
        ok: result.ok,
        code: result.code || null,
        reason: result.reason || null,
      };
    } catch (err) {
      forward = { attempted: true, ok: false, reason: err.message || String(err) };
    }
  }

  logger.emit({
    accepted: true,
    trust_level: trustLevel,
    received_at: receivedAt,
    envelope: {
      client_ip: envelope.clientIp,
      client_helo: envelope.clientHelo,
      sender: envelope.sender,
      recipient: envelope.recipient,
    },
    routing,
    git_commit: gitCommit,
    completion,
    forward,
    from: from.address || null,
    from_domain: from.address ? from.address.split('@')[1] : null,
    to: (parsed.to && parsed.to.text) || null,
    subject: parsed.subject || null,
    message_id: parsed.messageId || null,
    body_preview: bodyPreview,
    dkim: dkimSummary,
    spf: spfSummary,
    dmarc: dmarcSummary,
    arc: arcSummary,
    attachments,
    raw_size: raw.length,
    raw_sha256: rawHash,
  });
}

main().catch((err) => {
  process.stderr.write(`receive: ${err && err.stack || err}\n`);
  process.exit(1);
});
