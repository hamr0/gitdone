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
const { parseEventTag, parseAddress, parseVerifyTag } = require('../src/router');
const { loadEvent, findStep, senderMatchesStep } = require('../src/event-store');
const { commitReply } = require('../src/gitrepo');
const { fetchDkimKey, pickSignatureToArchive } = require('../src/dkim-archive');
const { buildVerificationReport, formatVerifyReportBody } = require('../src/verify');
const { sendmail, buildRawMessage } = require('../src/outbound');
const { forwardToOwner } = require('../src/forward');
const logger = require('../src/logger');

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', reject);
  });
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

function summariseAttachments(parsed) {
  return (parsed.attachments || []).map((a) => ({
    filename: a.filename || null,
    content_type: a.contentType || null,
    size: a.size || (a.content && a.content.length) || 0,
    sha256: a.content ? sha256(a.content) : null,
  }));
}

async function main() {
  const raw = await readStdin();
  if (raw.length === 0) {
    process.stderr.write('receive: empty stdin\n');
    process.exit(2);
  }

  const envelope = parseEnvelope(process.argv);

  const [auth, parsed] = await Promise.all([
    authenticate(raw, {
      trustReceived: false,
      ip: envelope.clientIp || undefined,
      helo: envelope.clientHelo || undefined,
      mta: config.mtaHostname,
      sender: envelope.sender || undefined,
    }),
    simpleParser(raw),
  ]);

  const from = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
  const headerBlock = extractHeaderBlock(raw, config.maxHeaderBytes);
  const filter = preFilter(headerBlock, from.address);

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
        subject: `[GitDone] Verification report for event ${verifyTag.eventId}`,
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
    chain_length: (auth.arc.authResults && auth.arc.authResults.length) || 0,
  } : null;
  const attachments = summariseAttachments(parsed);
  const rawHash = sha256(raw);

  // 1.D: for accepted mail with a DKIM signature, fetch the DKIM public key
  // from DNS right now. Archive alongside the commit so verification works
  // even after the signer rotates their DNS key.
  let dkimArchive = null;
  const sigToArchive = pickSignatureToArchive(auth);
  if (sigToArchive && sigToArchive.signingDomain && sigToArchive.selector) {
    dkimArchive = await fetchDkimKey(sigToArchive.signingDomain, sigToArchive.selector);
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
