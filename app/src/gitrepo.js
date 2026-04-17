// Per-event git repo. One repo per event at {dataDir}/repos/{eventId}/.
// Each accepted reply becomes a commit whose tree contains
// commits/commit-NNN.json with the PRD §8.3 schema.
//
// Concurrency model: we rely on Postfix pipe transport serialization
// (maxproc=1) so only one delivery touches a repo at a time. No in-process
// locking needed for the v1 traffic rate.
//
// Non-bare repo: the working tree IS the inspectable state of the event.
// Users (initiator, auditors) can `git clone` and read the commits/* files
// directly without needing git plumbing commands.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const simpleGit = require('simple-git');

const config = require('./config');
const { stampFile, moveProofIntoTree } = require('./ots');

const EVENT_ID_RE = /^[a-zA-Z0-9]+$/;
const GIT_USER = { name: 'gitdone', email: `noreply@${config.domain}` };

function repoPath(eventId) {
  return path.join(config.dataDir, 'repos', eventId);
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

async function dirExists(p) {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch { return false; }
}

async function readFileSafe(p) {
  try { return await fs.readFile(p, 'utf8'); } catch { return null; }
}

async function initRepoIfNeeded(eventId, event) {
  if (!EVENT_ID_RE.test(eventId)) throw new Error(`invalid eventId: ${eventId}`);
  const root = repoPath(eventId);
  const gitDir = path.join(root, '.git');

  if (await dirExists(gitDir)) return { root, initialised: false };

  await fs.mkdir(path.join(root, 'commits'), { recursive: true });
  await fs.mkdir(path.join(root, 'dkim_keys'), { recursive: true });
  await fs.mkdir(path.join(root, 'ots_proofs'), { recursive: true });
  await fs.writeFile(path.join(root, 'event.json'), JSON.stringify(event, null, 2) + '\n');

  const git = simpleGit(root);
  await git.init(['--initial-branch=main']);
  await git.addConfig('user.name', GIT_USER.name, false, 'local');
  await git.addConfig('user.email', GIT_USER.email, false, 'local');
  await git.add(['event.json', 'commits', 'dkim_keys', 'ots_proofs']);
  // Can't commit empty dirs directly; add .gitkeep so structure is tracked.
  // Add .gitkeep files to empty dirs.
  await Promise.all(['commits', 'dkim_keys', 'ots_proofs'].map(
    (d) => fs.writeFile(path.join(root, d, '.gitkeep'), '')
  ));
  await git.add('.');
  await git.commit(`event created: ${event.title || eventId}`);

  return { root, initialised: true };
}

async function nextSequence(root) {
  const commitsDir = path.join(root, 'commits');
  let files;
  try {
    files = await fs.readdir(commitsDir);
  } catch { return 1; }
  let max = 0;
  for (const f of files) {
    const m = f.match(/^commit-(\d+)\.json$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return max + 1;
}

function padSeq(n) { return String(n).padStart(3, '0'); }

// Per PRD §0.1.10 (plaintext discipline): commit payloads record a salted
// hash of the sender address, never the plaintext. Salt is a per-event
// public random value stored in event.json — verifiers re-hash a claimed
// address with the event's salt and match; random observers can't bulk
// rainbow-table across events.
//
// Dropped from v2 schema (plaintext leaks): sender, subject, body_preview,
// message_id. Those live only in the forwarded email to the event owner.
function saltedSenderHash(sender, salt) {
  if (!sender) return null;
  const material = `${salt || ''}|${sender.toLowerCase()}`;
  return `sha256:${sha256Hex(material)}`;
}

// Normalise a Message-ID to a canonical form before hashing. RFC 5322
// defines it as an opaque value in angle brackets (`<local@domain>`).
// Treat case-insensitively for match stability across clients.
function normaliseMessageId(mid) {
  if (!mid) return null;
  const s = String(mid).trim();
  return s.replace(/^<|>$/g, '').toLowerCase();
}

function saltedMessageIdHash(mid, salt) {
  const n = normaliseMessageId(mid);
  if (!n) return null;
  return `sha256:${sha256Hex(`${salt || ''}|${n}`)}`;
}

function buildCommitMetadata(seq, ctx, event) {
  const sender = ctx.envelope && ctx.envelope.sender ? ctx.envelope.sender
              : (ctx.from || null);
  const senderDomain = sender && sender.includes('@') ? sender.split('@')[1] : null;
  const salt = (event && event.salt) || null;
  return {
    schema_version: 2,
    event_id: ctx.eventId,
    step_id: ctx.stepId || null,
    sequence: seq,
    received_at: ctx.receivedAt,
    sender_hash: saltedSenderHash(sender, salt),
    sender_domain: senderDomain,
    // Salted Message-ID hash enables re-matching a forwarded .eml even when
    // the forwarding client re-encoded the bytes. Message-ID is RFC-5322
    // required to be preserved verbatim across any mail path.
    message_id_hash: saltedMessageIdHash(ctx.messageId, salt),
    trust_level: ctx.trustLevel,
    participant_match: ctx.participantMatch,
    attachments: ctx.attachments || [],
    dkim: ctx.dkim || null,
    spf: ctx.spf || null,
    dmarc: ctx.dmarc || null,
    arc: ctx.arc || null,
    envelope: {
      client_ip: ctx.envelope && ctx.envelope.client_ip || null,
      client_helo: ctx.envelope && ctx.envelope.client_helo || null,
    },
    raw_sha256: ctx.rawSha256,
    raw_size: ctx.rawSize,
    // Populated after writing: dkim_key_file (1.D), ots_proof_file (1.E)
    dkim_key_file: null,
    ots_proof_file: null,
  };
}

async function commitReply(eventId, event, ctx) {
  const { root } = await initRepoIfNeeded(eventId, event);
  const seq = await nextSequence(root);
  const seqStr = padSeq(seq);
  const filename = `commit-${seqStr}.json`;
  const rel = path.join('commits', filename);
  const abs = path.join(root, rel);

  const metadata = buildCommitMetadata(seq, ctx, event);

  // 1.D: if caller supplied a DKIM key (PEM), archive it alongside the commit
  // so future verification works even after DNS rotation.
  const filesToAdd = [rel];
  if (ctx.dkimArchive && ctx.dkimArchive.pem) {
    const keyRel = path.join('dkim_keys', `commit-${seqStr}.pem`);
    await fs.writeFile(path.join(root, keyRel), ctx.dkimArchive.pem);
    metadata.dkim_key_file = keyRel;
    metadata.dkim_archive = {
      fetched_at: ctx.dkimArchive.fetched_at || null,
      lookup: ctx.dkimArchive.lookup || null,
    };
    filesToAdd.push(keyRel);
  } else if (ctx.dkimArchive && ctx.dkimArchive.error) {
    metadata.dkim_archive = { error: ctx.dkimArchive.error };
  }

  // 1.E pre-finalization: set the deterministic OTS proof path in metadata
  // BEFORE writing the JSON to disk, so the file we stamp matches the file
  // we commit. (Any post-stamp modification would break `ots verify`.)
  const expectedProofRel = path.join('ots_proofs', `commit-${seqStr}.ots`);
  metadata.ots_proof_file = expectedProofRel;
  await fs.writeFile(abs, JSON.stringify(metadata, null, 2) + '\n');

  // Stamp the FINALIZED JSON.
  const stampRes = await stampFile(abs);
  if (stampRes.proof_path) {
    await moveProofIntoTree(stampRes.proof_path, root, seqStr);
    filesToAdd.push(expectedProofRel);
  } else {
    // Stamp failed: roll back — null the path, record the error, rewrite.
    metadata.ots_proof_file = null;
    metadata.ots_archive = { error: stampRes.error || 'ots stamp failed' };
    await fs.writeFile(abs, JSON.stringify(metadata, null, 2) + '\n');
  }

  const git = simpleGit(root);
  await git.add(filesToAdd);
  const stepPart = ctx.stepId ? ` step ${ctx.stepId}` : '';
  const result = await git.commit(`reply ${seqStr}: ${eventId}${stepPart} from ${metadata.sender_domain || 'unknown'}`);

  return {
    sha: result.commit || null,
    sequence: seq,
    file: rel,
    dkim_key_file: metadata.dkim_key_file,
    ots_proof_file: metadata.ots_proof_file,
    repo_path: root,
  };
}

// Public random salt for a new event. 32 bytes of entropy, hex-encoded.
// Used by buildCommitMetadata to salt sender_hash so the same address
// hashes differently across events (prevents bulk correlation).
function generateEventSalt() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = {
  initRepoIfNeeded,
  nextSequence,
  commitReply,
  buildCommitMetadata,
  saltedSenderHash,
  saltedMessageIdHash,
  normaliseMessageId,
  generateEventSalt,
  repoPath,
};
