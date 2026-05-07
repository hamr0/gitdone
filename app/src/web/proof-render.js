// Proof-surfacing helpers: trust ladder, trust pills, receipt details.
// Pure HTML rendering (no I/O). Consumed by the management dashboard
// (server.js) and by the proof-email composers (notifications.js).
//
// Trust ladder model — 4 rungs ascending:
//   unverified | authorized | forwarded | verified
//
//   - The "achieved" rung is filled with its trust colour.
//   - Every rung BELOW achieved is outlined in its own trust colour
//     (gradient: signals "those checks would also pass").
//   - Every rung ABOVE achieved is dim grey (out of reach).
//
// Visual reference: docs/01-product/design/proof-surfacing-v1.md.

'use strict';

const { html, raw, escapeHTML } = require('./templates');

const TRUST_LEVELS = ['unverified', 'authorized', 'forwarded', 'verified'];

const TRUST_COLOR = {
  verified: '#3fb950',
  forwarded: '#58a6ff',
  authorized: '#ffb000',
  unverified: '#6e7681',
};

const TRUST_LABEL = {
  verified: 'DKIM-VERIFIED',
  forwarded: 'ARC-FORWARDED',
  authorized: 'SPF-AUTHORIZED',
  unverified: 'UNVERIFIED',
};

function trustRank(level) {
  const i = TRUST_LEVELS.indexOf(level);
  return i < 0 ? -1 : i;
}

// Truncate a sha256 hex / "sha256:..." to head4...tail4. Used by the
// receipt + proof emails so the hash stays glanceable.
function truncHash(sha) {
  if (!sha) return '';
  const noPrefix = String(sha).replace(/^sha256:/, '');
  if (noPrefix.length <= 10) return noPrefix;
  return `sha256:${noPrefix.slice(0, 4)}…${noPrefix.slice(-4)}`;
}

// Returns empty string for 0 / negative / non-numeric so callers can
// short-circuit "· N B" output without a separate guard. A 0-byte
// attachment is uninteresting noise — caller decides whether to show
// a placeholder (we don't, since the dashboard already distinguishes
// "no size data" from "empty file" by the absence of the row).
function formatBytes(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x <= 0) return '';
  if (x < 1024) return `${x} B`;
  if (x < 1024 * 1024) return `${(x / 1024).toFixed(1)} KB`;
  return `${(x / 1024 / 1024).toFixed(1)} MB`;
}

// Aggregate trust-level signal from a list of {trust_level} items
// (commits / replies). Returns counts per level + the modal level
// (most common; ties break high) and the weakest level present.
function aggregateTrust(items) {
  const counts = { verified: 0, forwarded: 0, authorized: 0, unverified: 0 };
  for (const it of items || []) {
    const lv = it && it.trust_level;
    if (lv && counts[lv] != null) counts[lv]++;
  }
  // Modal: highest count; tie-break to the highest trust level.
  let modal = null;
  let modalCount = -1;
  for (const lv of TRUST_LEVELS) { // ascending order
    if (counts[lv] >= modalCount) {
      // Equal-count case picks the LATER (higher) level — TRUST_LEVELS
      // is ascending so the last winner stands.
      if (counts[lv] > 0) { modal = lv; modalCount = counts[lv]; }
    }
  }
  // Weakest = lowest level with at least one item. null if no items.
  let weakest = null;
  for (const lv of TRUST_LEVELS) {
    if (counts[lv] > 0) { weakest = lv; break; }
  }
  return { counts, modal, weakest };
}

// Inline pill: `[ DKIM-VERIFIED ]` etc., coloured by level.
function renderTrustPill({ level }) {
  if (!level || !TRUST_COLOR[level]) return raw('');
  const c = TRUST_COLOR[level];
  return raw(
    `<span class="trust-pill trust-${escapeHTML(level)}" `
    + `style="color:${c};border-color:${c}">${escapeHTML(TRUST_LABEL[level])}</span>`
  );
}

// 4-rung trust ladder. `achieved` is the trust level the event/step
// reached. Rungs below achieved are outlined in their own colour;
// rungs above are dim grey.
function renderTrustLadder({ achieved }) {
  const idx = trustRank(achieved);
  const rungs = TRUST_LEVELS.map((lv, i) => {
    const isActive = i === idx;
    const isPassed = i < idx && idx >= 0;
    const c = TRUST_COLOR[lv];
    let style;
    let cls = 'trust-rung';
    if (isActive) {
      style = `background:${c};border-color:${c};color:#0d1117;font-weight:600`;
      cls += ' is-active';
    } else if (isPassed) {
      style = `border-color:${c};color:${c}`;
      cls += ' is-passed';
    } else {
      style = 'border-color:#30363d;color:#6e7681';
    }
    return `<div class="${cls}" data-level="${escapeHTML(lv)}" style="${style}">${escapeHTML(TRUST_LABEL[lv])}</div>`;
  }).join('');
  return raw(`<div class="trust-ladder">${rungs}</div>`);
}

// Full key/value receipt for one commit JSON. eventId is rendered into
// the offline-verify command, made `.copyable` so the dashboard's
// copy-on-click handler picks it up.
function renderProofReceipt(commit, eventId) {
  if (!commit) return raw('');
  const dkimSig = commit.dkim && Array.isArray(commit.dkim.signatures) && commit.dkim.signatures[0];
  const dkimResult = dkimSig ? dkimSig.result : (commit.dkim && commit.dkim.result) || 'none';
  const dkimLine = dkimSig
    ? `${dkimSig.result || '?'} · header.i=@${dkimSig.domain || '?'} · selector ${dkimSig.selector || '?'} · ${dkimSig.algorithm || '?'}${dkimSig.aligned ? ' · aligned' : ''}`
    : dkimResult;
  const spfResult = (commit.spf && commit.spf.result) || 'none';
  const dmarcResult = (commit.dmarc && commit.dmarc.result) || 'none';
  const arcLine = commit.arc
    ? `${commit.arc.result || 'none'}${commit.arc.chain_length ? ` · chain ${commit.arc.chain_length}` : ''}`
    : 'none';
  const otsState = otsStatusLabel(commit);
  const hash = truncHash(commit.raw_sha256);
  const cmd = `gitdone-verify ${eventId}`;
  return html`
    <div class="mg-receipt">
      <div class="mg-receipt-row"><div class="mg-receipt-key">DKIM</div><div>${dkimLine}</div></div>
      <div class="mg-receipt-row"><div class="mg-receipt-key">SPF</div><div>${spfResult}</div></div>
      <div class="mg-receipt-row"><div class="mg-receipt-key">DMARC</div><div>${dmarcResult}</div></div>
      <div class="mg-receipt-row"><div class="mg-receipt-key">ARC</div><div>${arcLine}</div></div>
      <div class="mg-receipt-row"><div class="mg-receipt-key">OTS</div><div>${otsState}</div></div>
      <div class="mg-receipt-row"><div class="mg-receipt-key">Raw hash</div><div class="mg-receipt-mono">${hash || '—'}</div></div>
      <div class="mg-receipt-row"><div class="mg-receipt-key">Trust</div><div style="color:${raw(TRUST_COLOR[commit.trust_level] || '#c9d1d9')}">${commit.trust_level || 'unknown'}</div></div>
      ${renderAttachmentsBlock(commit.attachments)}
      <div class="mg-receipt-cmd"><code class="copyable">$ ${cmd}</code></div>
    </div>
  `;
}

// Per-attachment rows inside an mg-receipt block. Renders nothing when
// the commit has no recorded attachments (most replies). Filename +
// truncated sha256 + size; bytes are NOT stored, only the hash —
// enough to verify against the owner's forwarded copy offline.
function renderAttachmentsBlock(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return raw('');
  const rows = attachments.map((a, i) => {
    const name = a.filename || `attachment-${i + 1}`;
    const hash = truncHash(a.sha256) || '—';
    const sz = formatBytes(a.size);
    return html`
      <div class="mg-receipt-row">
        <div class="mg-receipt-key">${i === 0 ? raw('Attachments') : raw('')}</div>
        <div><code>${name}</code><span class="mg-receipt-mono" style="margin-left:0.5rem;color:#8b949e">${hash}</span>${sz ? html`<span style="margin-left:0.5rem;color:#6e7681">· ${sz}</span>` : raw('')}</div>
      </div>
    `;
  });
  return html`${rows}`;
}

// OTS status text for a commit JSON. The commit JSON's
// ots_proof_file points at <repo>/ots_proofs/commit-NNN.ots; we never
// parse the binary proof here. "anchored" vs "pending" is recorded by
// the OTS-upgrade worker as commit.ots_anchored / commit.ots_block
// (set when present), with sane fallbacks for older commits.
function otsStatusLabel(commit) {
  if (!commit || !commit.ots_proof_file) {
    if (commit && commit.ots_archive && commit.ots_archive.error) {
      return `error: ${commit.ots_archive.error}`;
    }
    return 'no proof';
  }
  if (commit.ots_anchored) {
    return commit.ots_block
      ? `anchored at block ${commit.ots_block}`
      : 'anchored to Bitcoin';
  }
  return 'pending Bitcoin upgrade';
}

// Plain-text receipt block for ASCII email bodies. Returns a string,
// not HTML. ≤ ~14 lines, no URLs in the receipt itself.
function plainReceipt(commit) {
  if (!commit) return '';
  const dkimSig = commit.dkim && Array.isArray(commit.dkim.signatures) && commit.dkim.signatures[0];
  const dkimLine = dkimSig
    ? `${dkimSig.result || '?'} · header.i=@${dkimSig.domain || '?'} · ${dkimSig.selector || '?'} · ${dkimSig.algorithm || '?'}${dkimSig.aligned ? ' · aligned' : ''}`
    : (commit.dkim && commit.dkim.result) || 'none';
  const spfResult = (commit.spf && commit.spf.result) || 'none';
  const dmarcResult = (commit.dmarc && commit.dmarc.result) || 'none';
  const arcLine = commit.arc
    ? `${commit.arc.result || 'none'}${commit.arc.chain_length ? ` · chain length ${commit.arc.chain_length}` : ''}`
    : 'none';
  const otsLine = otsStatusLabel(commit);
  const hashLine = truncHash(commit.raw_sha256) || 'none';
  const trustLine = commit.trust_level || 'unknown';
  // ASCII-only — replace the U+00B7 middle dot with hyphen.
  const sanitize = (s) => String(s).replace(/·/g, '-');
  const lines = [
    `DKIM       ${sanitize(dkimLine)}`,
    `SPF        ${spfResult}`,
    `DMARC      ${dmarcResult}`,
    `ARC        ${sanitize(arcLine)}`,
    `OTS        ${sanitize(otsLine)}`,
    `Raw hash   ${hashLine}`,
    `Trust      ${trustLine}`,
  ];
  const atts = Array.isArray(commit.attachments) ? commit.attachments : [];
  if (atts.length) {
    lines.push(`Attachments`);
    for (const a of atts) {
      const name = a.filename || '(unnamed)';
      const h = truncHash(a.sha256) || 'no-hash';
      const sz = formatBytes(a.size);
      lines.push(`  ${name}  ${h}${sz ? ` (${sz})` : ''}`);
    }
  }
  return lines.join('\n');
}

// Inline attachment pill — green paperclip + count. Same data-step
// hook as the trust pill so clicking either toggles the proof drawer.
function renderAttachmentPill({ count, stepId }) {
  if (!count) return raw('');
  const c = TRUST_COLOR.verified;
  const dataStep = stepId ? ` data-step="${escapeHTML(stepId)}"` : '';
  const role = stepId ? ' role="button" tabindex="0" aria-expanded="false"' : '';
  return raw(
    `<span class="trust-pill attach-pill"${dataStep}${role} `
    + `style="color:${c};border-color:${c}">📎 ${escapeHTML(String(count))}</span>`
  );
}

module.exports = {
  TRUST_LEVELS,
  TRUST_COLOR,
  TRUST_LABEL,
  trustRank,
  truncHash,
  formatBytes,
  aggregateTrust,
  renderTrustPill,
  renderAttachmentPill,
  renderAttachmentsBlock,
  renderTrustLadder,
  renderProofReceipt,
  otsStatusLabel,
  plainReceipt,
};
