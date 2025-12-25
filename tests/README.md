# GitDone E2E Testing with Playwright

This directory contains comprehensive end-to-end tests for GitDone using Playwright.

## Overview

The test suite covers:
- ✅ Event creation (all flow types: sequential, non-sequential, hybrid)
- ✅ Magic link workflows and vendor completion
- ✅ Flow progression logic
- ✅ Error handling and edge cases
- ✅ File uploads and processing
- ✅ Email delivery
- ✅ Statistics aggregation
- ✅ Git integration

## Prerequisites

### Required Software
- Node.js 18+ and npm
- Git
- Chrome/Chromium, Firefox, or Safari (Playwright will install browser binaries)

### Environment Setup
1. Ensure backend and frontend dependencies are installed:
   ```bash
   cd backend && npm install
   cd ../frontend && npm install
   ```

2. Set up environment variables in `.env`:
   ```env
   JWT_SECRET=test-secret-for-playwright
   BASE_URL=http://localhost:3000
   SMTP_HOST=smtp.ethereal.email  # For test email delivery
   SMTP_PORT=587
   SMTP_USER=your-test-email@ethereal.email
   SMTP_PASS=your-test-password
   ```

3. Install Playwright:
   ```bash
   npm install --save-dev @playwright/test
   npx playwright install  # Installs browser binaries
   ```

## Running Tests

### Run All Tests
```bash
npx playwright test
```

### Run Specific Test File
```bash
npx playwright test tests/e2e/01-event-creation-sequential.spec.ts
```

### Run Tests in UI Mode (Interactive)
```bash
npx playwright test --ui
```

### Run Tests in Headed Mode (See Browser)
```bash
npx playwright test --headed
```

### Run Tests on Specific Browser
```bash
npx playwright test --project=chromium
npx playwright test --project=firefox
npx playwright test --project=webkit
```

### Run Tests in Debug Mode
```bash
npx playwright test --debug
```

### Run Specific Test by Name
```bash
npx playwright test -g "should create sequential event"
```

## Test Organization

```
tests/
├── e2e/                                    # Test files
│   ├── 01-event-creation-sequential.spec.ts
│   ├── 02-sequential-flow-progression.spec.ts
│   ├── 03-non-sequential-flow.spec.ts
│   ├── 04-hybrid-flow.spec.ts
│   └── 05-magic-link-errors.spec.ts
├── fixtures/                               # Test data
│   ├── events/                            # Event JSON fixtures
│   │   ├── sequential-wedding.json
│   │   ├── non-sequential-conference.json
│   │   └── hybrid-festival.json
│   ├── users/                             # User test data
│   └── files/                             # Test upload files
└── helpers/                                # Test utilities
    └── test-utils.ts                      # Helper functions
```

## Test Reports

### View HTML Report
After running tests, view the HTML report:
```bash
npx playwright show-report
```

The report includes:
- Test results summary
- Screenshots of failures
- Videos of failed tests (if enabled)
- Detailed test logs

### Report Location
- HTML: `playwright-report/index.html`
- JSON: `playwright-report/results.json`

## Writing New Tests

### Test Template
```typescript
import { test, expect } from '@playwright/test';
import { TestUtils } from '../helpers/test-utils';

test.describe('Your Test Suite', () => {
  let utils: TestUtils;
  let createdEventId: string;

  test.beforeEach(async ({ page }) => {
    utils = new TestUtils(page);
  });

  test.afterEach(async () => {
    if (createdEventId) {
      await TestUtils.cleanupTestData(createdEventId);
    }
  });

  test('should do something', async ({ page }) => {
    // Your test code
  });
});
```

### Helper Methods

The `TestUtils` class provides helpful methods:

```typescript
// Load event fixtures
const eventData = TestUtils.loadEventFixture('sequential-wedding');

// Create event via UI
const eventId = await utils.createEventViaUI(eventData);

// Create event via API (faster)
const result = await utils.createEventViaAPI(eventData);

// Get magic link token
const token = await utils.getMagicToken(eventId, 0);

// Complete step
await utils.completeStepWithMagicLink(token, [], 'Comments');

// Verify step status
await utils.verifyStepStatus(eventId, 0, 'completed');

// Verify event complete
await utils.verifyEventComplete(eventId);

// Navigate to event page
await utils.navigateToEventPage(eventId);

// Verify stats updated
await utils.verifyStatsUpdated(1, 1);

// Clean up test data
await TestUtils.cleanupTestData(eventId);
```

## CI/CD Integration

### GitHub Actions Example
```yaml
name: E2E Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install dependencies
        run: |
          npm install
          cd backend && npm install
          cd ../frontend && npm install

      - name: Install Playwright browsers
        run: npx playwright install --with-deps

      - name: Run E2E tests
        run: npx playwright test

      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 30
```

## Test Data Management

### Fixtures
Event fixtures are JSON files in `tests/fixtures/events/`:
- `sequential-wedding.json` - 3-step sequential event
- `non-sequential-conference.json` - 4-step parallel event
- `hybrid-festival.json` - 6-step hybrid event with sequences

### Cleanup
Tests automatically clean up:
- Event JSON files in `data/events/`
- Magic tokens in `data/magic_tokens.json`
- Git repositories in `data/repos/`
- Uploaded files (where possible)

### Manual Cleanup
If tests crash or are interrupted:
```bash
# Remove all test events
rm -f data/events/*.json
rm -f data/magic_tokens.json
rm -rf data/repos/*

# Regenerate stats
curl -X POST http://localhost:3001/api/stats/refresh
```

## Troubleshooting

### Tests Fail to Start Servers
**Issue**: Servers don't start before tests run
**Solution**: Increase timeout in `playwright.config.ts`:
```typescript
webServer: {
  timeout: 180000, // 3 minutes
}
```

### Port Already in Use
**Issue**: Backend/frontend ports (3001/3000) already occupied
**Solution**: Kill existing processes:
```bash
lsof -ti:3001 | xargs kill -9
lsof -ti:3000 | xargs kill -9
```

### Tests Are Flaky
**Issue**: Tests pass/fail inconsistently
**Solutions**:
- Increase timeouts in test code
- Use `page.waitForLoadState('networkidle')` before assertions
- Add explicit waits: `await page.waitForTimeout(1000)`
- Check for race conditions in application code

### Can't Find Elements
**Issue**: Playwright can't locate elements
**Solutions**:
- Use `page.pause()` to inspect page state
- Run in headed mode: `--headed`
- Check selector specificity
- Wait for element: `await page.waitForSelector('text=My Text')`

### Email Tests Failing
**Issue**: Email delivery tests don't work
**Solution**: Use Ethereal Email (fake SMTP) for testing:
1. Create account: https://ethereal.email/
2. Add credentials to `.env`
3. No real emails sent, but delivery is tested

### Permission Errors on Data Files
**Issue**: Tests can't clean up data files
**Solution**: Ensure test user has write permissions:
```bash
chmod -R 755 data/
```

## Performance Optimization

### Run Tests in Parallel
```bash
npx playwright test --workers=4
```

### Run Only on One Browser (Faster)
```bash
npx playwright test --project=chromium
```

### Use API for Setup (Faster than UI)
```typescript
// Slower - via UI
const eventId = await utils.createEventViaUI(eventData);

// Faster - via API
const result = await utils.createEventViaAPI(eventData);
const eventId = result.eventId;
```

## Test Coverage

Current test coverage:

### ✅ Implemented
- Event creation (all flow types)
- Sequential flow progression
- Non-sequential flow progression
- Hybrid flow with custom sequences
- Magic link error scenarios
- Form validation errors
- Progress tracking
- Git commit creation

### ⏳ Pending (Future)
- File upload with actual files (JPG, PNG, PDF, MP4)
- File size limit enforcement (>25MB)
- Management link workflows
- Event editing via management page
- Email content verification
- Time limit expiration
- Performance tests (large events)
- Security tests (token tampering)
- Cross-browser compatibility
- Mobile responsiveness

## Best Practices

### DO ✅
- Clean up test data in `afterEach` hooks
- Use fixtures for consistent test data
- Use helper methods from `TestUtils`
- Add meaningful test descriptions
- Wait for elements before assertions
- Take screenshots on failure (automatic)

### DON'T ❌
- Rely on timing with `setTimeout` (use Playwright waits)
- Hard-code URLs (use `baseURL` from config)
- Leave test data behind (clean up in hooks)
- Test implementation details (test user workflows)
- Use `test.only` in committed code (CI will fail)

## Resources

- [Playwright Documentation](https://playwright.dev/)
- [Best Practices](https://playwright.dev/docs/best-practices)
- [Debugging Tests](https://playwright.dev/docs/debug)
- [Test Reporters](https://playwright.dev/docs/test-reporters)
- [CI Configuration](https://playwright.dev/docs/ci)

## Getting Help

If tests fail or you need help:
1. Check test output for error messages
2. Run in debug mode: `--debug`
3. View HTML report: `npx playwright show-report`
4. Check application logs (backend/frontend consoles)
5. Review test plan: `docs/PLAYWRIGHT_TEST_PLAN.md`

## Contributing

When adding new tests:
1. Follow naming convention: `XX-feature-name.spec.ts`
2. Add test description to `PLAYWRIGHT_TEST_PLAN.md`
3. Use existing fixtures or create new ones in `fixtures/`
4. Add helper methods to `test-utils.ts` if reusable
5. Ensure tests clean up after themselves
6. Run full suite before committing: `npx playwright test`
