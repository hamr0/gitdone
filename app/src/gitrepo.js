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
const GIT_USER = { name: 'GitDone', email: `noreply@${config.domain}` };

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

function buildCommitMetadata(seq, ctx) {
  // ctx shape — keep this schema aligned with PRD §8.3.
  const sender = ctx.envelope && ctx.envelope.sender ? ctx.envelope.sender
              : (ctx.from || null);
  const senderDomain = sender && sender.includes('@') ? sender.split('@')[1] : null;
  return {
    event_id: ctx.eventId,
    step_id: ctx.stepId || null,
    sequence: seq,
    received_at: ctx.receivedAt,
    sender: sender,                                   // plaintext (internal)
    sender_hash: sender ? `sha256:${sha256Hex(sender.toLowerCase())}` : null,
    sender_domain: senderDomain,
    trust_level: ctx.trustLevel,
    participant_match: ctx.participantMatch,
    subject: ctx.subject || null,
    body_preview: ctx.bodyPreview || null,
    message_id: ctx.messageId || null,
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
    // Reserved for later modules:
    dkim_key_file: null,      // populated by 1.D
    ots_proof_file: null,     // populated by 1.E
  };
}

async function commitReply(eventId, event, ctx) {
  const { root } = await initRepoIfNeeded(eventId, event);
  const seq = await nextSequence(root);
  const seqStr = padSeq(seq);
  const filename = `commit-${seqStr}.json`;
  const rel = path.join('commits', filename);
  const abs = path.join(root, rel);

  const metadata = buildCommitMetadata(seq, ctx);

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

  // Write metadata first so the file exists on disk and ots can stamp it.
  await fs.writeFile(abs, JSON.stringify(metadata, null, 2) + '\n');

  // 1.E: OpenTimestamps stamp the commit JSON. Pending proof returns
  // immediately; auditors upgrade later for the full Bitcoin anchor.
  const stampRes = await stampFile(abs);
  if (stampRes.proof_path) {
    const proofRel = await moveProofIntoTree(stampRes.proof_path, root, seqStr);
    metadata.ots_proof_file = proofRel;
    filesToAdd.push(proofRel);
  } else if (stampRes.error) {
    metadata.ots_archive = { error: stampRes.error };
  }
  // Rewrite metadata now that ots_proof_file is known (idempotent pass).
  await fs.writeFile(abs, JSON.stringify(metadata, null, 2) + '\n');

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

module.exports = {
  initRepoIfNeeded,
  nextSequence,
  commitReply,
  buildCommitMetadata,
  repoPath,
};
