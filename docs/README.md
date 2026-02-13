# GitDone Documentation

## Structure

```
docs/
├── 00-context/          # WHY and WHAT EXISTS
├── 01-product/          # WHAT the product must do
├── 02-features/         # HOW features are designed & built
├── 03-logs/             # MEMORY (what changed over time)
├── 04-process/          # HOW to work with this system
└── archive/             # Old/completed docs preserved
```

## Quick Links

### 00-context/ — Project Context
- [vision.md](00-context/vision.md) — Product purpose, target users, tech stack
- [assumptions.md](00-context/assumptions.md) — Constraints, risks, scaling path
- [system-state.md](00-context/system-state.md) — Architecture, data flows, design patterns

### 01-product/ — Product Requirements
- [prd.md](01-product/prd.md) — Event Aggregation Dashboard PRD

### 02-features/ — Feature Documentation
- [api-reference.md](02-features/api-reference.md) — Complete REST API documentation
- [email-setup.md](02-features/email-setup.md) — SMTP configuration guide
- [environment.md](02-features/environment.md) — Environment variable management
- [test-plan.md](02-features/test-plan.md) — Playwright E2E test plan

### 03-logs/ — Project History
- [implementation-log.md](03-logs/implementation-log.md) — Feature milestones
- [decisions-log.md](03-logs/decisions-log.md) — Architectural decisions with rationale
- [bug-log.md](03-logs/bug-log.md) — Bugs found and resolutions
- [validation-log.md](03-logs/validation-log.md) — Test runs and QA results
- [insights.md](03-logs/insights.md) — Lessons learned

### 04-process/ — Development Process
- [dev-workflow.md](04-process/dev-workflow.md) — Development workflow, testing strategy, principles
- [deployment.md](04-process/deployment.md) — VPS deployment guide (PM2, Nginx, SSL)
- [development.md](04-process/development.md) — Local development setup and scripts
- [testing-quickstart.md](04-process/testing-quickstart.md) — Get Playwright tests running in 5 minutes
- [definition-of-done.md](04-process/definition-of-done.md) — Completion criteria checklist
- [llm-prompts.md](04-process/llm-prompts.md) — AI agent guidelines for this project

### archive/ — Historical Documents
Contains completed task summaries, one-time fix logs, deployment announcements, and other temporal documents preserved for reference.
