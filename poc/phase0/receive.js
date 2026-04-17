#!/usr/bin/env node
// Phase 0 POC. Reads raw email from stdin, applies humans-only pre-filter,
// verifies DKIM/ARC/SPF/DMARC, classifies trust level per PRD §7.4, logs
// metadata JSON to stdout. Throwaway.
//
// Usage:   cat sample.eml | node receive.js

const { authenticate } = require('mailauth');
const { simpleParser } = require('mailparser');
const crypto = require('crypto');

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

function extractHeaderBlock(raw) {
  const s = raw.slice(0, Math.min(raw.length, 64 * 1024)).toString('utf8');
  const endIdx = s.search(/\r?\n\r?\n/);
  return endIdx > 0 ? s.slice(0, endIdx) : s;
}

function rawHeader(headerBlock, name) {
  const re = new RegExp('^' + name + '\\s*:\\s*(.+(?:\\r?\\n[ \\t].+)*)', 'im');
  const m = headerBlock.match(re);
  return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : null;
}

function preFilter(headerBlock, fromAddr) {
  const autoSubmitted = rawHeader(headerBlock, 'Auto-Submitted');
  if (autoSubmitted && autoSubmitted.toLowerCase() !== 'no') {
    return { rejected: true, reason: `auto-submitted: ${autoSubmitted}` };
  }

  if (rawHeader(headerBlock, 'List-Id')
      || rawHeader(headerBlock, 'List-Post')
      || rawHeader(headerBlock, 'List-Unsubscribe')) {
    return { rejected: true, reason: 'mailing list headers present' };
  }

  const prec = (rawHeader(headerBlock, 'Precedence') || '').toLowerCase();
  if (/^(bulk|list|junk)$/.test(prec)) {
    return { rejected: true, reason: `precedence: ${prec}` };
  }

  const addr = (fromAddr || '').toLowerCase();
  const local = addr.split('@')[0] || '';
  if (/^(noreply|no-reply|mailer-daemon|postmaster|bounces)$/.test(local)) {
    return { rejected: true, reason: `system sender: ${addr}` };
  }

  return { rejected: false, reason: null };
}

function classifyTrust(auth) {
  const dkimResults = (auth.dkim && auth.dkim.results) || [];
  const dkimPassAligned = dkimResults.some(
    (r) => r.status && r.status.result === 'pass' && r.status.aligned
  );
  const dmarcPass = !!(auth.dmarc && auth.dmarc.status && auth.dmarc.status.result === 'pass');
  const arcPass = !!(auth.arc && auth.arc.status && auth.arc.status.result === 'pass');
  const spfPass = !!(auth.spf && auth.spf.status && auth.spf.status.result === 'pass');

  if (dkimPassAligned && dmarcPass) return 'verified';
  if (arcPass) return 'forwarded';
  if (spfPass && dmarcPass) return 'authorized';
  return 'unverified';
}

async function main() {
  const raw = await readStdin();
  if (raw.length === 0) {
    console.error('no input on stdin');
    process.exit(2);
  }

  // Envelope metadata from Postfix pipe transport:
  // argv[2]=client_address argv[3]=client_helo argv[4]=sender argv[5]=original_recipient
  const [clientIp, clientHelo, envSender, envRecipient] = process.argv.slice(2);

  const [auth, parsed] = await Promise.all([
    authenticate(raw, {
      trustReceived: false,
      ip: clientIp && clientIp !== 'unknown' ? clientIp : undefined,
      helo: clientHelo && clientHelo !== 'unknown' ? clientHelo : undefined,
      mta: 'mail.git-done.com',
      sender: envSender || undefined,
    }),
    simpleParser(raw),
  ]);

  const from = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
  const headerBlock = extractHeaderBlock(raw);
  const filter = preFilter(headerBlock, from.address);

  if (filter.rejected) {
    process.stdout.write(JSON.stringify({
      accepted: false,
      rejection_reason: filter.reason,
      from: from.address || null,
      subject: parsed.subject || null,
      raw_sha256: sha256(raw),
    }, null, 2) + '\n');
    return;
  }

  const dkimResults = (auth.dkim && auth.dkim.results) || [];
  const trustLevel = classifyTrust(auth);

  const out = {
    accepted: true,
    trust_level: trustLevel,
    received_at: new Date().toISOString(),
    envelope: {
      client_ip: clientIp || null,
      client_helo: clientHelo || null,
      sender: envSender || null,
      recipient: envRecipient || null,
    },
    from: from.address || null,
    from_domain: from.address ? from.address.split('@')[1] : null,
    to: (parsed.to && parsed.to.text) || null,
    subject: parsed.subject || null,
    message_id: parsed.messageId || null,
    body_preview: (parsed.text || '').slice(0, 200),
    dkim: dkimResults.length === 0 ? { result: 'none' } : {
      signatures: dkimResults.map((r) => ({
        result: r.status && r.status.result,
        comment: (r.status && r.status.comment) || null,
        domain: r.signingDomain || null,
        selector: r.selector || null,
        aligned: (r.status && r.status.aligned) || null,
        algorithm: r.algo || null,
        info: r.info || null,
      })),
    },
    spf: auth.spf ? { result: auth.spf.status && auth.spf.status.result } : null,
    dmarc: auth.dmarc ? { result: auth.dmarc.status && auth.dmarc.status.result } : null,
    arc: auth.arc ? {
      result: auth.arc.status && auth.arc.status.result,
      comment: (auth.arc.status && auth.arc.status.comment) || null,
      chain_length: (auth.arc.authResults && auth.arc.authResults.length) || 0,
    } : null,
    attachments: (parsed.attachments || []).map((a) => ({
      filename: a.filename || null,
      content_type: a.contentType || null,
      size: a.size || (a.content && a.content.length) || 0,
      sha256: a.content ? sha256(a.content) : null,
    })),
    raw_size: raw.length,
    raw_sha256: sha256(raw),
  };

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main().catch((err) => {
  console.error('receive.js error:', err && err.stack || err);
  process.exit(1);
});
