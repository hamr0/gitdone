# GitDone

## Agent System

**IMPORTANT**: Global agentic agent system is active (from `~/.claude/CLAUDE.md`).
- All requests route through **orchestrator** first (unless you specify `@agent-id` or `As agent-id, ...`)
- Orchestrator analyzes intent and matches to optimal workflow pattern
- You'll be asked conditional questions at each workflow step (e.g., "Research first?")
- See `~/.claude/CLAUDE.md` for 9 pre-defined workflow patterns
- Available agents: orchestrator, 1-create-prd, 2-generate-tasks, business-analyst, holistic-architect, full-stack-dev, qa-test-architect, ux-expert, product-owner, product-manager, scrum-master, master, context-initializer

---

## Quick Context

Multi-vendor workflow coordination platform with cryptographic proof of work sequence. Event planners coordinate vendors through magic link authentication with Git-backed audit trails.

## Architecture

**Tech Stack**:
- Frontend: Next.js 15 + TypeScript + Tailwind CSS
- Backend: Node.js + Express
- Storage: JSON files + Git repositories per event
- Email: SMTP via Nodemailer (Gmail/SendGrid)
- Auth: JWT magic links (30-day expiry)
- File Processing: Sharp (images), fluent-ffmpeg (videos)

**Key Patterns**:
- Sequential/non-sequential workflow types
- Each step completion = Git commit with files
- Magic tokens stored in data/magic_tokens.json
- Events stored as JSON in data/events/{eventId}.json

## Common Commands

**Development**:
- Quick start: `./quick-start.sh`
- Interactive dev: `./dev.sh`
- Backend only: `cd backend && npm start` (port 3001)
- Frontend only: `cd frontend && npm run dev` (port 3000)

**Testing**:
- Email test: `cd backend && node test-email.js`
- Health check: `curl http://localhost:3001/api/health`

**Deployment**:
- VPS deploy: `./deploy.sh` (PM2 + Nginx + SSL)

## File Locations

**Critical Paths**:
- Backend routes: `/home/hamr/PycharmProjects/gitdone/backend/routes/`
- Frontend pages: `/home/hamr/PycharmProjects/gitdone/frontend/src/app/`
- Data storage: `/home/hamr/PycharmProjects/gitdone/data/`
- Environment: `/home/hamr/PycharmProjects/gitdone/.env`

## Key Patterns

**Magic Link Flow**:
1. Create event with steps → POST /api/events
2. Send magic link → POST /api/magic/send
3. Vendor completes via token → POST /api/complete/:token
4. Git commit auto-created with uploaded files

**Email Configuration Gotcha**:
- Gmail requires app password (NOT regular password)
- Must enable 2FA first
- Clear shell env vars before testing: `unset SMTP_*`

**Recent Changes** (from git log):
- Fixed email functionality (SMTP nodemailer migration)
- Major UI changes
- Updated PRDs

## Documentation

Full documentation available in `/home/hamr/PycharmProjects/gitdone/docs/`:
- KNOWLEDGE_BASE.md - Master documentation index
- ARCHITECTURE.md - Tech stack and design decisions
- DEVELOPMENT.md - Development workflow
- DEPLOYMENT.md - Production deployment guide
- EMAIL_SETUP.md - Email provider configuration
- API_REFERENCE.md - API endpoints reference
