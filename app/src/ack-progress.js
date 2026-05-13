'use strict';

// Render a "matched / missing" block for the strict-signing ack body.
// Source of truth depends on event mode:
//   - declaration: event.reference_docs[i].signed_at (single signer)
//   - attestation: event.attestor_progress[senderHash].signed_doc_hashes
//     (per-attestor). Without senderHash we have no per-attestor view
//     and fall back to "all open" — but callers in the attestation path
//     should always pass it.
function formatProgressBlock(event, { senderHash = null } = {}) {
  const docs = Array.isArray(event && event.reference_docs) ? event.reference_docs : [];
  const isAttestation = event && event.type === 'crypto' && event.mode === 'attestation';
  let isSigned;
  if (isAttestation) {
    const progress = (event && event.attestor_progress) || {};
    const bucket = senderHash ? progress[senderHash] : null;
    const signedSet = new Set((bucket && bucket.signed_doc_hashes) || []);
    isSigned = (d) => !!(d && d.sha256 && signedSet.has(d.sha256));
  } else {
    isSigned = (d) => !!(d && d.signed_at);
  }
  const signed = docs.filter(isSigned);
  const pending = docs.filter((d) => !isSigned(d));
  const lines = [`Progress: ${signed.length} of ${docs.length} signed.`, ''];
  if (signed.length) {
    lines.push(`Matched:`);
    for (const d of signed) {
      lines.push(`  [x] ${d.filename || '(unnamed)'}`);
    }
  }
  if (pending.length) {
    if (signed.length) lines.push('');
    lines.push(`Still needed:`);
    for (const d of pending) {
      const hashShort = d.sha256 ? d.sha256.replace(/^sha256:/, '').slice(0, 16) + '…' : '?';
      lines.push(`  [ ] ${d.filename || '(unnamed)'}   sha256: ${hashShort}`);
    }
  }
  return lines.join('\n');
}

module.exports = { formatProgressBlock };
