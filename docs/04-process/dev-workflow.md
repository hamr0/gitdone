# Development Workflow

## Communication Protocol

**Core Principles:**
- **Clarity First**: Ask clarifying questions when requirements are ambiguous
- **Fact-Based Responses**: Base recommendations on verified, current information
- **Simplicity Advocate**: Call out overcomplications; suggest simpler alternatives
- **Safety First**: Never modify critical systems without explicit approval

**User Profile:**
- Technical level: Non-coder but technically savvy
- Learning style: Understands concepts, needs executable instructions
- Preference: Step-by-step guidance with clear explanations
- Tools: Comfortable with command-line operations and scripts

**Required Safeguards:**
- Always identify affected files before making changes
- Never modify authentication systems without explicit permission
- Never alter database schema without proper migration files
- Explain what changes will be made and why

## Development Process

### Environments

- **Development**: Local machines + testing tools
- **Staging**: VPS with isolated database
- **Production**: VPS with containerized setup

### Deployment Strategy

**Simple Projects:**
```
Local -> GitHub -> VPS (direct deployment)
```

**Complex Projects:**
```
Local -> GitHub -> GHCR -> VPS (containerized)
```

### Feature Development Workflow

1. Create branch from `main`
2. Develop feature
3. Test locally
4. Create PR
5. Merge to `main`

### Testing Process

```bash
# Backend tests
cd backend && npm test

# Frontend dev
cd frontend && npm run dev

# Email test
cd backend && node test-email.js

# E2E tests (Playwright)
npx playwright test
npx playwright test --ui    # Interactive mode
npx playwright test --headed # Run with browser UI
```

## PRD to Task List Generation

### Goal
Generate detailed, step-by-step task lists from Product Requirements Documents.

### Output Format
- **Format**: Markdown (`.md`)
- **Location**: `/tasks/`
- **Filename**: `tasks-[prd-file-name].md`

### Process
1. Receive PRD reference
2. Analyze PRD: functional requirements, user stories, specifications
3. Assess current state: existing infrastructure, patterns, components
4. Phase 1: Generate ~5 high-level parent tasks, present for approval
5. Phase 2: Break down into sub-tasks with implementation details
6. Identify relevant files to create/modify
7. Save to `/tasks/tasks-[prd-file-name].md`

**Target Audience**: Junior developer implementing feature with codebase context

## Testing Strategy

| Test Type | When to Use | Tools |
|-----------|-------------|-------|
| Unit Tests | Individual functions, component logic | Jest, Vitest |
| Integration Tests | API endpoints, database interactions | Jest + Supertest |
| End-to-End Tests | User journeys, critical workflows | Playwright |
| Performance Tests | Scaling decisions, load capacity | Artillery, k6 |
| Security Tests | Production deployment, auth changes | OWASP ZAP |

### Critical Focus Areas
- Silent failures: error handling and edge cases
- Edge cases: boundary conditions and unexpected inputs
- Regression prevention: automated testing for existing features
- Data integrity: database operations and validation

## Core Principles

### Technology Choices
- Always prefer open-source solutions
- Avoid vendor lock-in whenever possible
- Use free/generous tiers for initial development
- Simplicity wins over complexity
- Every piece of code must have a purpose

### Architecture Guidelines
- Keep it simple; don't introduce complexity without clear need
- Containerize only when necessary
- Use established patterns; don't reinvent the wheel
- Focus on maintainability: clean, documented code

### Solution Red Flags
- Over-engineering simple problems
- Adding unnecessary dependencies
- Complex solutions for straightforward tasks
- Vendor-specific implementations when open alternatives exist

## Common Commands

### Development
```bash
npm run dev     # Start dev server
npm run build   # Build for production
```

### Docker
```bash
docker-compose up -d
docker-compose down
```

### Default Ports
- Frontend: 3000
- Backend API: 3001
- PostgreSQL: 5432
