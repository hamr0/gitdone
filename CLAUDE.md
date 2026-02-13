# GitDone

Multi-vendor workflow coordination platform with cryptographic proof of work sequence. Event planners coordinate vendors through magic link authentication with Git-backed audit trails.

build a clean claude.md according to instructions

## Dev Rules

**POC first.** Always validate logic with a ~15min proof-of-concept before building. Cover happy path + common edges. POC works → design properly → build with tests. Never ship the POC.

**Build incrementally.** Break work into small independent modules. One piece at a time, each must work on its own before integrating.

**Dependency hierarchy — follow strictly:** vanilla language → standard library → external (only when stdlib can't do it in <100 lines). External deps must be maintained, lightweight, and widely adopted. Exception: always use vetted libraries for security-critical code (crypto, auth, sanitization).

**Lightweight over complex.** Fewer moving parts, fewer deps, less config. Express over NestJS, Flask over Django, unless the project genuinely needs the framework. Simple > clever. Readable > elegant.

**Open-source only.** No vendor lock-in. Every line of code must have a purpose — no speculative code, no premature abstractions.

For full development and testing standards, see `.claude/memory/AGENT_RULES.md`.

## Tech Stack
Next.js 15, TypeScript, Tailwind CSS, Node.js, Express, JSON storage, Git audit trails, SMTP (Nodemailer), JWT magic links, Sharp, fluent-ffmpeg

## Commands
Dev: `./dev.sh` | Backend: `cd backend && npm start` | Frontend: `cd frontend && npm run dev` | Deploy: `./deploy.sh`

## Key Patterns
- Sequential/non-sequential workflow types with Git-backed audit trail
- Magic link auth: JWT tokens, 30-day expiry
- Step completion creates Git commit with uploaded files
- Data: magic_tokens.json, events/{eventId}.json in data/

## Critical Gotchas
- Gmail SMTP requires app password (enable 2FA first)
- Clear shell env vars before email testing: `unset SMTP_*`
- Frontend API URL must match backend port (3001)

## Documentation
Index: docs/KNOWLEDGE_BASE.md
Full docs structure: docs/README.md
Memory: .claude/memory/MEMORY.md
