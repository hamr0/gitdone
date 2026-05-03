// Phase D — RFC 3464 Delivery Status Notification (DSN) parser.
//
// When an outbound notification fails permanently at a downstream MTA
// (mailbox doesn't exist, domain rejects us, etc.), the original MTA
// posts a multipart/report message-of-type=delivery-status back to the
// envelope sender. We sign our outbound mail as gitdone@<domain>, so
// these reports land in the same Postfix pipe as everything else.
//
// This module recognises and parses such reports. It does NOT itself
// route or persist; receive.js wires the parsed shape into
// recordStepSendErrors + an organiser alert.
//
// Wire format (RFC 3464 §2):
//
//   Content-Type: multipart/report; report-type=delivery-status; boundary=...
//
//   --boundary
//   Content-Type: text/plain
//   <human-readable summary>
//
//   --boundary
//   Content-Type: message/delivery-status
//
//   Reporting-MTA: dns; mta.example.com
//   <blank line>
//   Original-Recipient: rfc822;event+abc-step1@git-done.com
//   Final-Recipient: rfc822;real@example.com
//   Action: failed
//   Status: 5.1.1
//   Diagnostic-Code: smtp; 550 5.1.1 user unknown
//   <blank line>
//   <next recipient block, if any>
//
//   --boundary
//   Content-Type: message/rfc822 (or message/rfc822-headers)
//   <original message echoed back>
//
// We only care about the delivery-status part. The text/plain summary
// varies wildly between MTAs and isn't worth surfacing verbatim — the
// machine-readable Status + Diagnostic-Code are what the organiser
// needs to act on.

'use strict';

// Identify a DSN from the parsed top-level Content-Type.
function isDeliveryStatusReport(parsed) {
  if (!parsed) return false;
  const ct = parsed.headers && parsed.headers.get
    ? parsed.headers.get('content-type')
    : null;
  if (!ct) return false;
  // mailparser returns either a string or { value, params } depending on
  // header type. content-type is parsed → object with .value and .params.
  if (typeof ct === 'string') {
    return /multipart\/report/i.test(ct) && /report-type\s*=\s*"?delivery-status"?/i.test(ct);
  }
  if (typeof ct === 'object') {
    const value = String(ct.value || '').toLowerCase();
    if (value !== 'multipart/report') return false;
    const params = ct.params || {};
    const reportType = String(params['report-type'] || '').toLowerCase();
    return reportType === 'delivery-status';
  }
  return false;
}

// Strip the "rfc822;" / "smtp;" / similar address-type prefix per RFC 3464
// §2.3.2 (Original-Recipient/Final-Recipient address-type "rfc822;<addr>").
function stripAddressType(value) {
  if (!value) return null;
  const m = String(value).match(/^[a-zA-Z0-9-]+\s*;\s*(.+)$/);
  return (m ? m[1] : String(value)).trim();
}

// Parse a single delivery-status field group. Per RFC 3464 each group is
// a sequence of "Field: value" lines with possible folded continuations,
// separated from other groups by a blank line. We don't care about the
// per-message group (Reporting-MTA, Arrival-Date) for routing; only the
// per-recipient groups carry Original-Recipient + Action + Status.
function parseFieldGroup(text) {
  const lines = String(text || '').split(/\r?\n/);
  const fields = {};
  let curName = null;
  let curValue = '';
  const flush = () => {
    if (curName) fields[curName] = curValue.trim();
    curName = null;
    curValue = '';
  };
  for (const line of lines) {
    if (line === '') { flush(); continue; }
    if (/^[ \t]/.test(line) && curName) {
      // RFC 5322 folded continuation — append after a single space.
      curValue += ' ' + line.trim();
      continue;
    }
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    flush();
    curName = line.slice(0, idx).trim().toLowerCase();
    curValue = line.slice(idx + 1).trim();
  }
  flush();
  return fields;
}

// Parse the body of a message/delivery-status part into:
//   { reporting: { mta, ... }, recipients: [{ originalRecipient,
//     finalRecipient, action, status, diagnostic }, ...] }
//
// Robust to MTA-specific quirks: unknown fields are ignored, missing
// per-recipient blocks return an empty array, lines with no colon are
// skipped silently.
function parseDeliveryStatusBody(text) {
  // Split on blank lines, but tolerate trailing whitespace on the blank.
  const groups = String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((g) => g.trim())
    .filter(Boolean);
  if (groups.length === 0) {
    return { reporting: {}, recipients: [] };
  }
  const [first, ...rest] = groups;
  const reporting = parseFieldGroup(first);
  const recipients = rest.map((g) => {
    const f = parseFieldGroup(g);
    return {
      originalRecipient: stripAddressType(f['original-recipient']),
      finalRecipient: stripAddressType(f['final-recipient']),
      action: f['action'] ? f['action'].toLowerCase() : null,
      status: f['status'] || null,
      diagnostic: f['diagnostic-code'] || null,
    };
  });
  return { reporting, recipients };
}

// Find the boundary= parameter on a multipart Content-Type header. RFC 2046
// allows quoting; we accept either form.
function extractBoundary(contentTypeHeader) {
  if (!contentTypeHeader) return null;
  const m = String(contentTypeHeader).match(/boundary\s*=\s*("([^"]+)"|([^;\s]+))/i);
  if (!m) return null;
  return m[2] || m[3] || null;
}

// Split a raw multipart body into the buffers of each part. Boundaries
// per RFC 2046 §5.1.1 are "--<boundary>" on their own line; the closing
// boundary is "--<boundary>--". Anything before the first boundary
// (preamble) and after the closing one (epilogue) is discarded.
//
// We deliberately do not parse part headers here — callers want either
// the headers or the body, depending on the part. We return raw parts
// (each a string starting with the part's headers, then a blank line,
// then the part's body).
function splitMultipart(rawBody, boundary) {
  if (!rawBody || !boundary) return [];
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const marker = `--${boundary}`;
  const parts = [];
  let i = text.indexOf(marker);
  while (i !== -1) {
    const after = i + marker.length;
    // Closing boundary ends the message.
    if (text.slice(after, after + 2) === '--') break;
    // Find the start of this part's content (skip the trailing CRLF on
    // the boundary line itself).
    const nl = text.indexOf('\n', after);
    if (nl === -1) break;
    const partStart = nl + 1;
    const next = text.indexOf(marker, partStart);
    if (next === -1) break;
    // Trim the trailing CRLF that precedes the next boundary line.
    let partEnd = next;
    if (text[partEnd - 1] === '\n') partEnd -= 1;
    if (text[partEnd - 1] === '\r') partEnd -= 1;
    parts.push(text.slice(partStart, partEnd));
    i = next;
  }
  return parts;
}

// Split a single MIME part into { headers, body } strings on the first
// blank line. Headers retain their original CRLF folding so the caller
// can apply RFC 5322 unfolding if needed; for our use-case (looking up
// Content-Type) a simple regex on the raw header block suffices.
function splitPart(part) {
  const m = String(part || '').match(/^([\s\S]*?)\r?\n\r?\n([\s\S]*)$/);
  if (!m) return { headers: part || '', body: '' };
  return { headers: m[1], body: m[2] };
}

// Top-level helper. Takes the parsed (mailparser) object plus the raw
// message buffer and returns the DSN report or null if the message
// isn't a DSN. mailparser silently folds message/delivery-status into
// `parsed.text`, so we re-parse the multipart structure from raw bytes
// to find the part untouched.
function extractDsn(parsed, raw) {
  if (!isDeliveryStatusReport(parsed)) return null;
  const ct = parsed.headers && parsed.headers.get
    ? parsed.headers.get('content-type')
    : null;
  const ctString = typeof ct === 'string'
    ? ct
    : (ct && ct.value
        ? `${ct.value}; ${Object.entries(ct.params || {}).map(([k, v]) => `${k}="${v}"`).join('; ')}`
        : null);
  const boundary = extractBoundary(ctString);
  if (!boundary || !raw) {
    return { reporting: {}, recipients: [], note: 'no boundary or raw available' };
  }
  // Split off the top-level message body — everything after the first
  // blank line in the raw bytes.
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  const blank = text.match(/\r?\n\r?\n/);
  if (!blank) return { reporting: {}, recipients: [], note: 'no top-level body' };
  const body = text.slice(blank.index + blank[0].length);
  const parts = splitMultipart(body, boundary);
  const dsPart = parts
    .map(splitPart)
    .find((p) => /content-type\s*:\s*message\/delivery-status/i.test(p.headers));
  if (!dsPart) {
    return { reporting: {}, recipients: [], note: 'no delivery-status part found' };
  }
  const { reporting, recipients } = parseDeliveryStatusBody(dsPart.body);
  return { reporting, recipients };
}

module.exports = {
  isDeliveryStatusReport,
  extractDsn,
  parseDeliveryStatusBody,
  parseFieldGroup,
  stripAddressType,
};
