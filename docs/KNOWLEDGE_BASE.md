# GitDone Knowledge Base

## Architecture
Event-driven workflow engine: planners create events with ordered steps, vendors complete steps via magic links, each completion triggers Git commit as audit proof.
-> docs/00-context/system-state.md

## Product Vision
Target users, problem space, product goals, and tech stack rationale.
-> docs/00-context/vision.md

## Assumptions and Constraints
Scaling path, risk factors, single-server deployment model.
-> docs/00-context/assumptions.md

## Product Requirements
Event Aggregation Dashboard PRD with acceptance criteria.
-> docs/01-product/prd.md

## API Reference
REST endpoints for events, steps, vendors, magic links, file uploads, dashboard stats.
-> docs/02-features/api-reference.md

## Email and SMTP
Gmail app password setup, Nodemailer config, magic link delivery.
-> docs/02-features/email-setup.md

## Environment Variables
All env vars for frontend and backend, .env file locations.
-> docs/02-features/environment.md

## Testing
Playwright E2E test plan and quickstart guide.
-> docs/02-features/test-plan.md | docs/04-process/testing-quickstart.md

## Development Workflow
Local setup, scripts, dev principles, branching strategy.
-> docs/04-process/dev-workflow.md | docs/04-process/development.md

## Deployment
VPS deployment with PM2, Nginx, SSL. Docker compose available.
-> docs/04-process/deployment.md

## Project History
Implementation milestones, architectural decisions, bug resolutions, lessons learned.
-> docs/03-logs/
