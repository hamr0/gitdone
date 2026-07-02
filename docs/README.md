# Documentation

Structured per the 5-tier model. Everything here is about GitDone
*as a product*; code-level docs live in `app/src/` alongside the
code.

```
docs/
├── 00-context/      WHY and WHAT EXISTS NOW
│   ├── vision.md            product purpose + what it isn't
│   └── assumptions.md       constraints, risks, deferred items
├── 01-product/      WHAT the product must do
│   ├── prd.md               authoritative spec
│   ├── emails.md            every email gitdone sends — taxonomy tree, trigger, subject, body
│   └── design/              frozen UI references
│       ├── terminal-theme-v1.md
│       ├── event-form-v1.md
│       └── landing-and-crypto-v1.md
├── 02-features/     HOW specific features are built
│   └── README.md            (empty until Phase 2 features land)
├── 03-logs/         MEMORY
│   ├── decisions-log.md     architectural decisions + rationale
│   └── insights.md          lessons learned
├── 04-process/      HOW to work with the system
│   ├── deploy.md            ops/deploy.sh contract — every check, why
│   └── deployment.md        VPS install + ops runbook
```

> The day-to-day work log lives in `.claude/memory/` + `.claude/stash/`
> and `CHANGELOG.md`, not in `03-logs/` — the empty milestone/bug/
> validation scaffolds were removed. `03-logs/` keeps only the two
> docs that carry real content (decisions + insights). Pre-rewrite
> (v1) and pre-terminal-theme docs are no longer kept in-tree;
> recover them from git history if ever needed.

## Quick links

- Want to **understand the product**: `00-context/vision.md` →
  `01-product/prd.md` (architecture + current state live here; prod/ops
  specifics in the root `CLAUDE.md`).
- Want to **deploy**: `../ops/deploy.sh` (script) +
  `04-process/deploy.md` (its contract).
- Want to **operate the host**: `04-process/deployment.md` +
  `../ops/homeserver/README.md`.
- Want to **contribute**: `../CLAUDE.md` (agent rules) +
  `.claude/memory/AGENT_RULES.md` (full standards).
- Want to **see what shipped**: `../CHANGELOG.md`.
