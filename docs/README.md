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
│   ├── implementation-log.md milestones
│   ├── bug-log.md
│   ├── validation-log.md
│   └── insights.md          lessons learned
├── 04-process/      HOW to work with the system
│   ├── phase1-plan.md       Phase 1 execution plan
│   ├── deploy.md            ops/deploy.sh contract — every check, why
│   ├── deployment.md        VPS install + ops runbook
│   ├── dev-workflow.md
│   ├── definition-of-done.md
│   └── llm-prompts.md       guidelines for AI agents
└── archive/         v1-era docs preserved for reference
    └── v1-*.md              (pre-rewrite product shape)
```

## Quick links

- Want to **understand the product**: `00-context/vision.md` →
  `01-product/prd.md` (architecture + current state live here; prod/ops
  specifics in the root `CLAUDE.md`).
- Want to **deploy**: `../ops/deploy.sh` (script) +
  `04-process/deploy.md` (its contract).
- Want to **operate the host**: `04-process/deployment.md` +
  `../ops/homeserver/README.md`.
- Want to **contribute**: `../CLAUDE.md` (agent rules) +
  `04-process/definition-of-done.md`.
- Want to **see what shipped**: `../CHANGELOG.md`.

## About the archive

Files under `archive/v1-*` describe GitDone *before* the Phase 1
rewrite (magic-link-per-participant auth, Postgres, SMTP client,
Playwright, React/Vite frontend). None of that is in the current
product — the rewrite replaced it with email-native + DKIM + git +
OTS. Archived rather than deleted so the history is recoverable if
we ever re-explore one of those directions.
