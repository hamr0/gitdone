# GitDone

## Agent System
Global agents: ~/.claude/CLAUDE.md
Orchestrator-first routing

---

## Quick Context
Multi-vendor workflow coordination platform with cryptographic proof of work sequence. Event planners coordinate vendors through magic link authentication with Git-backed audit trails.

## Tech Stack
Next.js 15, TypeScript, Tailwind CSS, Node.js, Express, JSON storage, Git audit trails, SMTP (Nodemailer), JWT magic links, Sharp, fluent-ffmpeg

## Commands
Dev: `./dev.sh` | Backend: `cd backend && npm start` | Frontend: `cd frontend && npm run dev` | Deploy: `./deploy.sh`

## Key Patterns
- Sequential/non-sequential workflow types with Git-backed audit trail
- Magic link authentication (JWT, 30-day expiry)
- Each step completion creates Git commit with uploaded files
- Magic tokens: data/magic_tokens.json | Events: data/events/{eventId}.json

## Critical Gotchas
- Gmail SMTP requires app password (enable 2FA first)
- Clear shell env vars before email testing: `unset SMTP_*`
- Frontend API URL must match backend port (3001)

## Documentation
Index: docs/KNOWLEDGE_BASE.md
