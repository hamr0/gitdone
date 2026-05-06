// Per-event in-process write mutex.
//
// Every code path that writes events/{id}.json AND/OR commits to the
// per-event git repo must run inside withEventMutex(eventId, fn) so:
//   - two concurrent activations can't both observe !activated_at
//   - an edit can't race with first-visit activation
//   - completion's updateEventAtomic + syncEventJson can't race with
//     archive/unarchive in sweep, or each other
//   - simple-git's `index.lock` doesn't get hit by concurrent `git add`
//     against the same .git dir from different writers
//
// gitdone-web is a single Node process today (`gitdone-web.service`);
// if it ever sharded across workers, this guard would need to move to
// filesystem-level (O_EXCL on a sentinel) — but in-process serialisation
// is correct for the current deployment shape.
//
// receive.js runs as a Postfix pipe transport (one process per inbound
// message), so its callers DO go through this mutex inside that
// process — but the mutex doesn't protect across processes. Postfix's
// own delivery serialisation (one transport invocation per message)
// plus simple-git's retries on `index.lock` is what carries us between
// processes today.

'use strict';

const _writeMutex = new Map();

async function withEventMutex(eventId, work) {
  const prev = _writeMutex.get(eventId);
  const p = (async () => {
    if (prev) { try { await prev; } catch { /* ignore prior failure */ } }
    return work();
  })();
  _writeMutex.set(eventId, p);
  try { return await p; }
  finally {
    // Only clear if we're still the latest entry — a follow-up call may
    // have already chained itself behind us.
    if (_writeMutex.get(eventId) === p) _writeMutex.delete(eventId);
  }
}

module.exports = { withEventMutex };
