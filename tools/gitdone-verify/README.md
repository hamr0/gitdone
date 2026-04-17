# gitdone-verify

Offline verifier for GitDone event repositories.

**The point of this tool:** GitDone's core promise is that its proofs
verify *without GitDone being alive*. If GitDone the service dies
tomorrow, every proof ever issued should still work, forever. That's
impossible to claim — and easy to quietly lie about — without a tool
you can actually run on a disconnected machine.

This is that tool. One file, Node stdlib only, no calls to any
GitDone-operated service. Fork it, audit it, rewrite it in a different
language. The principle is the point; the implementation is disposable.

## Usage

```sh
gitdone-verify <repo-path>
gitdone-verify <repo-path> --json            # machine-readable
gitdone-verify <repo-path> --no-ots          # skip OTS (truly offline)
gitdone-verify <repo-path> --min-trust verified
```

### Exit codes

- `0` — all checks pass (or only warn)
- `1` — one or more hard failures
- `2` — usage error

## What it verifies

| # | Check | How | Offline? |
|---|---|---|---|
| 1 | Structure | `event.json` + `commits/` + `dkim_keys/` + `ots_proofs/` all exist | yes |
| 2 | Git integrity | `git fsck --full --strict` | yes |
| 3 | Schema (v2) | every commit JSON has required fields, plaintext discipline (§0.1.10), sequence matches filename | yes |
| 4 | Archived DKIM keys | every `dkim_keys/commit-N.pem` parses as RSA public key via Node `crypto` | yes |
| 5 | OpenTimestamps | `ots verify` each proof against its paired commit JSON. Catches tamper (text: "File does not match original!"). Classifies pending/in-mempool/anchored | calendars, not gitdone |
| 6 | Event completion | for workflow events: every step has an accepted reply (participant_match + min trust); sequential flow is in order | yes |

## Dependencies

- **Node ≥ 18** (no npm packages needed)
- **git** — required for Check 2
- **ots** (`opentimestamps-client`) — required for Check 5, unless
  `--no-ots`. Install with `pip install opentimestamps-client`.

No GitDone servers are ever contacted. OpenTimestamps calendar servers
are public infrastructure (`bob.btc.calendar.opentimestamps.org`,
`finney.calendar.eternitywall.com`, etc.) — they prove the repo's
anchoring to Bitcoin but are not run by GitDone.

## Tamper-detection example

```sh
# clean repo passes
$ gitdone-verify ./my-event-repo
Overall: PASS
$ echo $?
0

# flip a byte in any commit-N.json
$ sed -i 's/"trust_level": "verified"/"trust_level": "unverified"/' \
    ./my-event-repo/commits/commit-002.json

# OTS catches the change; now fails
$ gitdone-verify ./my-event-repo
  OpenTimestamps         FAIL  1 bad proof(s)
Overall: FAIL
$ echo $?
1
```

## Running the tests

```sh
node --test tests/verify.test.js
```

The tests use stdlib only and build throwaway fixture repos in
`os.tmpdir()`. No network access required.

## License

MIT. See [LICENSE](./LICENSE).
