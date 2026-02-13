# Definition of Done

A feature or task is considered "done" when all applicable criteria are met.

## Code Quality
- [ ] Code follows existing project patterns and conventions
- [ ] No console errors or warnings in development
- [ ] Error messages are clear and actionable
- [ ] No hardcoded configuration (use .env)

## Testing
- [ ] Feature tested manually in development environment
- [ ] E2E tests added/updated for user-facing changes (Playwright)
- [ ] API endpoints tested with curl or Postman
- [ ] Error scenarios handled and tested

## Documentation
- [ ] Code changes are self-documenting (clear naming, minimal comments)
- [ ] API changes reflected in `docs/02-features/api-reference.md`
- [ ] Architecture changes reflected in `docs/00-context/system-state.md`
- [ ] Decision logged in `docs/03-logs/decisions-log.md` if applicable

## Deployment
- [ ] Works on both local dev and production environments
- [ ] No new system dependencies without documentation
- [ ] Environment variables documented if added
