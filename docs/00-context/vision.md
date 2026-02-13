# Vision & Product Purpose

## What Is GitDone?

GitDone is a multi-vendor workflow coordination platform with cryptographic proof of work sequence. It enables event planners to coordinate vendors through magic link authentication with Git-backed audit trails.

**Tagline**: "Git-like sequence proof for physical world workflows"

## Core Value Proposition

Event workflows are tracked using Git commits as immutable proof of completion. Each vendor step creates a commit with uploaded files, creating a verifiable timeline of work completion.

## Target Users

- **Event Planners**: Create events, assign vendor steps, track progress
- **Vendors**: Receive magic links, upload proof of work, mark steps complete
- **Clients/Stakeholders**: View read-only progress via public links

## Core User Stories

**As an Event Planner:**
- I can create an event with steps
- I can invite vendors via email
- I can see real-time progress

**As a Vendor:**
- I receive a magic link via email
- I can upload photos/docs
- I can mark my step complete

**As a Client:**
- I can view progress via read-only link

## Workflow Types

- **Sequential** (A -> B -> C): Steps must complete in order
- **Non-Sequential** (A, B, C): Steps can complete in any order
- **Hybrid**: Custom sequence levels (1, 1, 2, 2, 3)

## Product Boundaries

### In Scope (MVP)
- Event creation with sequential/non-sequential/hybrid flows
- Magic link authentication (JWT, 30-day expiry)
- File upload with image compression (Sharp) and video processing (ffmpeg)
- Git-backed audit trail per event
- SMTP email notifications
- Platform statistics dashboard

### Deferred
- Payment integration
- GDPR compliance tooling
- Mobile app (React Native)
- Real-time notifications (WebSockets)
- Multi-language support
- Team collaboration features

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15, TypeScript, Tailwind CSS |
| Backend | Node.js, Express |
| Storage | JSON files, Git repositories |
| Email | SMTP via Nodemailer |
| Auth | JWT magic links |
| File Processing | Sharp (images), fluent-ffmpeg (videos) |
