#!/usr/bin/env node
// One-shot migration: walk every per-event git repo under
// data/repos/<id>/ and sync its working-tree event.json with the
// current master at data/events/<id>.json.
//
// Why: pre-fix, event.json inside the repo was written ONCE on repo
// init and never touched again. Master JSON, by contrast, mutates on
// every state transition (activate, edit, close, archive, reply).
// Result: the proof artifact (the repo) carried a stale snapshot
// that the offline verifier read as ground truth.
//
// This script writes a single backfill commit per repo whose
// event.json drifted, leaving idempotent no-ops on already-synced
// repos. Safe to re-run.
//
// Run on prod once after this commit lands:
//   sudo -u gitdone node /opt/gitdone/app/bin/backfill-event-json.js

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('../src/config');
const { loadEvent } = require('../src/event-store');
const { syncEventJson } = require('../src/gitrepo');

const EVENT_ID_RE = /^[a-zA-Z0-9]+$/;

async function main() {
  const reposDir = path.join(config.dataDir, 'repos');
  let entries;
  try {
    entries = await fs.readdir(reposDir);
  } catch (err) {
    if (err.code === 'ENOENT') {
      process.stdout.write('no repos/ dir — nothing to backfill\n');
      return;
    }
    throw err;
  }

  const stats = { synced: 0, upToDate: 0, noMaster: 0, noRepo: 0, error: 0 };
  for (const id of entries) {
    if (!EVENT_ID_RE.test(id)) continue;
    const gitDir = path.join(reposDir, id, '.git');
    let isRepo = false;
    try { isRepo = (await fs.stat(gitDir)).isDirectory(); } catch { isRepo = false; }
    if (!isRepo) {
      stats.noRepo += 1;
      process.stdout.write(`${id}\tno repo (skipped)\n`);
      continue;
    }
    const event = await loadEvent(id);
    if (!event) {
      stats.noMaster += 1;
      process.stdout.write(`${id}\tno master JSON (skipped)\n`);
      continue;
    }
    try {
      const r = await syncEventJson(id, event,
        'backfill: sync repo event.json with master');
      if (r.synced) {
        stats.synced += 1;
        process.stdout.write(`${id}\tsynced (sha=${r.sha || '?'})\n`);
      } else {
        stats.upToDate += 1;
        process.stdout.write(`${id}\tup-to-date\n`);
      }
    } catch (err) {
      stats.error += 1;
      process.stderr.write(`${id}\tERROR ${err.message || err}\n`);
    }
  }

  process.stdout.write(
    `\nsummary: synced=${stats.synced} up-to-date=${stats.upToDate} ` +
    `no-master=${stats.noMaster} no-repo=${stats.noRepo} errors=${stats.error}\n`
  );
  process.exit(stats.error > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`backfill failed: ${err.stack || err.message || err}\n`);
  process.exit(2);
});
