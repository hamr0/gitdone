# GitDone - Knowledge Base

Master documentation index for the GitDone project.

---

## Quick Links

| Document | Purpose | When to Reference |
|----------|---------|-------------------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Tech stack, design patterns, system architecture | Understanding system design, making architectural decisions |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | Development workflow, scripts, troubleshooting | Daily development, running the app locally |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | VPS deployment, PM2, Nginx, SSL setup | Deploying to production, server configuration |
| [EMAIL_SETUP.md](./EMAIL_SETUP.md) | Email provider configuration (Gmail, SendGrid, etc.) | Setting up email, troubleshooting email issues |
| [ENVIRONMENT.md](./ENVIRONMENT.md) | Environment variables and configuration | Configuring local or production environments |
| [API_REFERENCE.md](./API_REFERENCE.md) | API endpoints, request/response formats | Integrating with backend, understanding API behavior |
| [WORKFLOWS.md](./WORKFLOWS.md) | Agent rules, task generation, development processes | Understanding project workflows and processes |

---

## Project Overview

**GitDone** is a multi-vendor workflow coordination platform with cryptographic proof of work sequence. Event planners coordinate vendors through magic link authentication with Git-backed audit trails.

### Core Features
- Event creation with sequential/non-sequential workflows
- Magic link authentication for vendors
- File upload with image/video processing
- Git-backed audit trail (one commit per step completion)
- Real-time status tracking

### Technology Stack
- **Frontend**: Next.js 15, TypeScript, Tailwind CSS
- **Backend**: Node.js, Express
- **Storage**: JSON files + Git repositories
- **Email**: SMTP via Nodemailer
- **Auth**: JWT magic links (30-day expiry)
- **File Processing**: Sharp (images), fluent-ffmpeg (videos)

---

## Common Tasks

### Starting Development
```bash
# Quick start (first time setup)
./quick-start.sh

# Interactive development menu
./dev.sh

# Manual start
cd backend && npm start    # Port 3001
cd frontend && npm run dev # Port 3000
```

### Testing Email
```bash
cd backend
node test-email.js
```

### Deploying to Production
```bash
./deploy.sh  # VPS deployment with PM2 + Nginx + SSL
```

---

## Critical File Locations

```
/home/hamr/PycharmProjects/gitdone/
├── backend/
│   ├── routes/           # API endpoints
│   ├── utils/            # Git manager, file processing
│   └── server.js         # Main server
├── frontend/
│   └── src/app/          # Next.js pages
├── data/
│   ├── events/           # Event JSON storage
│   ├── magic_tokens.json # Magic link tokens
│   ├── git_repos/        # Event Git repositories
│   └── uploads/          # Uploaded files
└── .env                  # Environment configuration
```

---

## Key Concepts

### Magic Link Flow
1. Event planner creates event with workflow steps
2. System sends magic link to vendor email
3. Vendor clicks link, authenticates via JWT token
4. Vendor completes step and uploads files
5. System creates Git commit with uploaded files
6. Status updates in real-time

### Workflow Types
- **Sequential**: Steps must be completed in order
- **Non-sequential**: Steps can be completed in any order

### Git Integration
- Each event gets its own Git repository in `data/git_repos/{eventId}/`
- Step completion triggers automatic Git commit
- Commit includes uploaded files and metadata
- Provides immutable audit trail

---

## Troubleshooting

### Common Issues

**Email not sending**:
- See [EMAIL_SETUP.md](./EMAIL_SETUP.md) for provider-specific configuration
- Gmail requires app password (not regular password)
- Clear shell environment variables: `unset SMTP_*`

**Port already in use**:
```bash
# Kill processes on ports 3000 and 3001
lsof -ti:3000 | xargs kill -9
lsof -ti:3001 | xargs kill -9
```

**Frontend/Backend not connecting**:
- Check CORS settings in `backend/server.js`
- Verify NEXT_PUBLIC_API_URL in frontend `.env.local`

---

## Development Workflow

1. **Feature Development**:
   - Create branch from `main`
   - Develop feature
   - Test locally
   - Create PR
   - Merge to `main`

2. **Testing**:
   - Backend tests: `cd backend && npm test`
   - Frontend dev server: `cd frontend && npm run dev`
   - Email test: `cd backend && node test-email.js`

3. **Deployment**:
   - Push to `main` branch
   - Run `./deploy.sh` on VPS
   - Verify with health check: `curl https://yourdomain.com/api/health`

---

## API Overview

Full API documentation: [API_REFERENCE.md](./API_REFERENCE.md)

### Key Endpoints
- `POST /api/events` - Create event
- `POST /api/magic/send` - Send magic link
- `POST /api/complete/:token` - Complete step via magic link
- `GET /api/events/:id` - Get event details
- `GET /api/health` - Health check

---

## Architecture Patterns

Full architecture documentation: [ARCHITECTURE.md](./ARCHITECTURE.md)

### Design Patterns
- JWT-based authentication (magic links)
- Git-as-audit-trail
- JSON file storage with Git versioning
- Async file processing pipeline
- Event-driven workflow state management

---

## Historical Documentation

Archived documentation in [ARCHIVE/](./ARCHIVE/):
- `building_plan.md` - Original detailed implementation plan
- `MIGRATION_SUMMARY.md` - Migration notes from earlier versions

---

## Need Help?

1. Check relevant documentation above
2. Search for error messages in troubleshooting sections
3. Review recent commits for context: `git log --oneline -10`
4. Check environment configuration: [ENVIRONMENT.md](./ENVIRONMENT.md)
