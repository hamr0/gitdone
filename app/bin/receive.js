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
const { parseEventTag, parseAddress } = require('../src/router');
const { loadEvent, findStep, senderMatchesStep } = require('../src/event-store');
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

  // Routing: resolve plus-tag → event/step, look up event JSON, check
  // sender-vs-participant match. Accept-with-flag: never reject on routing
  // failure. Initiator policy decides.
  const addr = parseAddress(envelope.recipient);
  const tag = parseEventTag(envelope.recipient);
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
      const event = await loadEvent(tag.eventId);
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

  logger.emit({
    accepted: true,
    trust_level: classifyTrust(auth),
    received_at: new Date().toISOString(),
    envelope: {
      client_ip: envelope.clientIp,
      client_helo: envelope.clientHelo,
      sender: envelope.sender,
      recipient: envelope.recipient,
    },
    routing,
    from: from.address || null,
    from_domain: from.address ? from.address.split('@')[1] : null,
    to: (parsed.to && parsed.to.text) || null,
    subject: parsed.subject || null,
    message_id: parsed.messageId || null,
    body_preview: (parsed.text || '').slice(0, 200),
    dkim: summariseDkim(auth),
    spf: auth.spf ? { result: auth.spf.status && auth.spf.status.result } : null,
    dmarc: auth.dmarc ? { result: auth.dmarc.status && auth.dmarc.status.result } : null,
    arc: auth.arc ? {
      result: auth.arc.status && auth.arc.status.result,
      comment: (auth.arc.status && auth.arc.status.comment) || null,
      chain_length: (auth.arc.authResults && auth.arc.authResults.length) || 0,
    } : null,
    attachments: summariseAttachments(parsed),
    raw_size: raw.length,
    raw_sha256: sha256(raw),
  });
}

main().catch((err) => {
  process.stderr.write(`receive: ${err && err.stack || err}\n`);
  process.exit(1);
});
