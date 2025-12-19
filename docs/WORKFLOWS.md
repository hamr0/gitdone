# Development Workflows

Project workflows, agent collaboration rules, and task generation processes.

---

## Table of Contents

1. [AI Agent Collaboration Guide](#ai-agent-collaboration-guide)
2. [PRD to Task List Generation](#prd-to-task-list-generation)
3. [Testing Strategy](#testing-strategy)
4. [Development Process](#development-process)

---

## AI Agent Collaboration Guide

### Communication Protocol

**Core Principles:**
- **Clarity First**: Always ask clarifying questions when requirements are ambiguous
- **Fact-Based Responses**: Base all recommendations on verified, current information
- **Simplicity Advocate**: Call out overcomplications and suggest simpler alternatives
- **Technical Translation**: Explain complex concepts in clear, actionable terms
- **Safety First**: Never modify critical systems without explicit understanding and approval

**User Profile:**
- **Technical Level**: Non-coder but technically savvy
- **Learning Style**: Understands concepts, needs executable instructions
- **Preference**: Step-by-step guidance with clear explanations
- **Tools**: Comfortable with command-line operations and scripts

**Required Safeguards:**
- **File Impact Analysis**: Always identify affected files before making changes
- **Authentication Protection**: Never modify authentication systems without explicit permission
- **Database Safety**: Never alter database schema without proper migration files
- **Change Documentation**: Explain what changes will be made and why

---

## PRD to Task List Generation

### Goal

Generate a detailed, step-by-step task list in Markdown format based on an existing Product Requirements Document (PRD).

### Output Format

- **Format**: Markdown (`.md`)
- **Location**: `/tasks/`
- **Filename**: `tasks-[prd-file-name].md`

### Process

1. **Receive PRD Reference**: User points to specific PRD file
2. **Analyze PRD**: Read functional requirements, user stories, and specifications
3. **Assess Current State**: Review existing codebase for:
   - Existing infrastructure and architectural patterns
   - Components or features that already exist
   - Related files, components, and utilities to leverage
4. **Phase 1 - Generate Parent Tasks**:
   - Create main, high-level tasks (typically ~5 tasks)
   - Present to user without sub-tasks
   - Wait for "Go" confirmation
5. **Phase 2 - Generate Sub-Tasks**:
   - Break down each parent task into actionable sub-tasks
   - Consider existing codebase patterns
   - Cover implementation details from PRD
6. **Identify Relevant Files**: List files to create/modify
7. **Generate Final Output**: Combine into Markdown structure
8. **Save Task List**: Save to `/tasks/tasks-[prd-file-name].md`

### Task List Structure

```markdown
## Relevant Files

- `path/to/file.ts` - Description of relevance
- `path/to/file.test.ts` - Unit tests for file.ts

### Notes

- Unit tests placed alongside code files
- Run tests: `npx jest [optional/path/to/test/file]`

## Tasks

- [ ] 1.0 Parent Task Title
  - [ ] 1.1 Sub-task description
  - [ ] 1.2 Sub-task description
- [ ] 2.0 Parent Task Title
  - [ ] 2.1 Sub-task description
```

**Target Audience**: Junior developer implementing feature with codebase context

---

## Testing Strategy

### Testing Types Framework

| Test Type | When to Use | Tools |
|-----------|-------------|-------|
| **Unit Tests** | Individual functions, component logic | Jest, Vitest, Mocha + Chai |
| **Integration Tests** | API endpoints, database interactions | Jest + Supertest, Postman/Newman |
| **End-to-End Tests** | User journeys, critical workflows | Playwright, Cypress, Selenium |
| **Performance Tests** | Scaling decisions, load capacity | Artillery, k6, JMeter |
| **Security Tests** | Production deployment, auth changes | OWASP ZAP, Burp Suite |
| **Regression Tests** | After code changes, before merging | CI/CD pipelines, automated runners |

### Testing Commands

```bash
# Unit Testing (Jest)
npm test                    # Run all tests
npm test --watch           # Watch mode
npm test --coverage        # Coverage report

# E2E Testing (Playwright)
npx playwright test         # Run E2E tests
npx playwright test --ui    # Interactive mode
npx playwright test --headed # Run with browser UI

# API Testing (Newman)
newman run collection.json  # Run API tests
```

### Critical Focus Areas

- **Silent Failures**: Error handling and edge cases
- **Edge Cases**: Boundary conditions and unexpected inputs
- **Regression Prevention**: Automated testing for existing features
- **Data Integrity**: Database operations and validation
- **API Reliability**: External service integration testing
- **User Experience**: UI/UX consistency and accessibility

---

## Development Process

### Environments

- **Development**: Local machines + testing tools
- **Staging**: VPS with isolated database
- **Production**: VPS with containerized setup

### Deployment Strategy

**Simple Projects:**
```
Local → GitHub → VPS (direct deployment)
```

**Complex Projects:**
```
Local → GitHub → GHCR → VPS (containerized)
```

### Development Workflow

1. **Feature Development**:
   - Create branch from `main`
   - Develop feature
   - Test locally
   - Create PR
   - Merge to `main`

2. **Testing Process**:
   - Backend tests: `cd backend && npm test`
   - Frontend dev: `cd frontend && npm run dev`
   - Email test: `cd backend && node test-email.js`

3. **Deployment**:
   - Push to `main` branch
   - Run `./deploy.sh` on VPS
   - Verify health: `curl https://yourdomain.com/api/health`

---

## Core Development Principles

### Technology Choices

- Always prefer open-source solutions
- Avoid vendor lock-in whenever possible
- Use free/generous tiers for initial development
- Simplicity wins over complexity
- Every piece of code must have a purpose

### Architecture Guidelines

- Keep it simple - don't introduce complexity without clear need
- Containerize only when necessary - start simple, scale as needed
- Use established patterns - don't reinvent the wheel
- Focus on maintainability - clean, documented code

### Solution Guidelines

**Always Consider:**
- Is this the simplest approach?
- Can this be done with existing tools?
- What's the maintenance burden?
- Is there vendor lock-in?
- Does this align with project tech preferences?

**Red Flags to Call Out:**
- Over-engineering simple problems
- Adding unnecessary dependencies
- Complex solutions for straightforward tasks
- Vendor-specific implementations when open alternatives exist

---

## Common Commands Reference

### Database
```bash
npx drizzle-kit generate
npx drizzle-kit push
```

### Development
```bash
npm run dev
npm run build
```

### Docker
```bash
docker-compose up -d
docker-compose down
```

### Default Ports

- **Frontend**: 3000
- **Backend API**: 3001
- **PostgreSQL**: 5432

---

## AI Agent Instructions

When working on this project:

1. **Always verify** you understand requirements before proceeding
2. **Provide step-by-step** instructions with clear explanations
3. **Include ready-to-run** scripts and commands
4. **Explain the "why"** behind technical recommendations
5. **Flag potential issues** before they become problems
6. **Suggest simpler alternatives** when appropriate
7. **Never modify** authentication or database schema without explicit permission
8. **Always identify** which files will be affected by changes
