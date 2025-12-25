# GitDone Knowledge Base

Quick index to detailed documentation.

---

## Architecture
Next.js 15 + Node.js/Express platform with Git-backed audit trails, magic link auth, and multi-vendor workflow coordination.
→ docs/ARCHITECTURE.md

## Development
Local development setup, scripts (dev.sh, quick-start.sh), debugging workflows, and common troubleshooting.
→ docs/DEVELOPMENT.md

## Deployment
VPS deployment with PM2, Nginx, SSL configuration, and production setup steps.
→ docs/DEPLOYMENT.md

## Email Configuration
SMTP provider setup (Gmail, SendGrid), app passwords, environment variables, and email testing.
→ docs/EMAIL_SETUP.md

## Environment Variables
Complete list of environment variables for backend, frontend, and deployment configurations.
→ docs/ENVIRONMENT.md

## API Reference
REST endpoints for events, magic links, step completion, health checks, and file uploads.
→ docs/API_REFERENCE.md

## Workflows
Agent-based development workflows, task generation patterns, and project management processes.
→ docs/WORKFLOWS.md

---

## Quick Reference

**Core Concept**: Event planners create workflows (sequential/non-sequential), vendors receive magic links, complete steps with file uploads, each completion creates Git commit for immutable audit trail.

**Key Endpoints**: POST /api/events (create), POST /api/magic/send (send link), POST /api/complete/:token (complete step)

**Common Commands**: ./dev.sh (interactive dev), ./quick-start.sh (first-time setup), ./deploy.sh (production deploy)

**Critical Files**: data/magic_tokens.json (tokens), data/events/{eventId}.json (event data), data/git_repos/{eventId}/ (audit trail)

**Gotchas**: Gmail needs app password not regular password, clear shell SMTP_* vars before testing, frontend API URL must match backend port
