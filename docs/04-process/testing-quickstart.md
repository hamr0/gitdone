# GitDone Testing Quick Start Guide

Get up and running with Playwright E2E tests in 5 minutes.

## 🚀 Quick Setup

### 1. Install Playwright
```bash
npm install
npx playwright install
```

### 2. Run Tests
```bash
npm test
```

That's it! Playwright will automatically:
- Start the backend server (port 3001)
- Start the frontend server (port 3000)
- Run all tests
- Generate a report

## 📊 View Results

### See HTML Report
```bash
npm run test:report
```

This opens an interactive report in your browser showing:
- ✅ Passed tests
- ❌ Failed tests (with screenshots & videos)
- ⏱️ Test execution times
- 📸 Visual diff comparisons

## 🎯 Common Commands

### Run all tests
```bash
npm test
```

### Run tests interactively (recommended for development)
```bash
npm run test:ui
```

### Run tests in browser (see what's happening)
```bash
npm run test:headed
```

### Debug a specific test
```bash
npm run test:debug -- tests/e2e/01-event-creation-sequential.spec.ts
```

### Run only on Chrome
```bash
npm run test:chromium
```

## 📁 Test Structure

```
tests/
├── e2e/                      # Test files
│   ├── 01-event-creation-sequential.spec.ts
│   ├── 02-sequential-flow-progression.spec.ts
│   ├── 03-non-sequential-flow.spec.ts
│   ├── 04-hybrid-flow.spec.ts
│   └── 05-magic-link-errors.spec.ts
│
├── fixtures/                 # Test data
│   └── events/
│       ├── sequential-wedding.json
│       ├── non-sequential-conference.json
│       └── hybrid-festival.json
│
└── helpers/                  # Utilities
    └── test-utils.ts
```

## 🧪 What's Tested?

### ✅ Core Workflows
- Event creation (sequential, non-sequential, hybrid)
- Magic link completion
- File uploads
- Progress tracking
- Git commit creation

### ✅ Error Scenarios
- Invalid magic links
- Form validation
- Network errors
- File size limits
- Double submissions

### ✅ Flow Types
- **Sequential**: Steps must complete in order (A → B → C)
- **Non-Sequential**: Steps can complete in any order
- **Hybrid**: Custom sequence levels (1, 1, 2, 3...)

## 🐛 Troubleshooting

### Servers don't start
Kill any existing processes:
```bash
lsof -ti:3001 | xargs kill -9
lsof -ti:3000 | xargs kill -9
npm test
```

### Tests are flaky
Run in UI mode to see what's happening:
```bash
npm run test:ui
```

### Need to debug
Add `await page.pause()` in your test code, then:
```bash
npm run test:debug
```

## 📖 Full Documentation

For detailed information:
- Full test plan: `docs/PLAYWRIGHT_TEST_PLAN.md`
- Test README: `tests/README.md`
- Playwright config: `playwright.config.ts`

## 🔧 Advanced Usage

### Run specific test file
```bash
npx playwright test tests/e2e/01-event-creation-sequential.spec.ts
```

### Run tests matching pattern
```bash
npx playwright test -g "sequential"
```

### Run with different browsers
```bash
npm run test:firefox
npm run test:webkit
```

### Generate test code (record interactions)
```bash
npx playwright codegen http://localhost:3000
```

## 📝 Writing Your First Test

1. Create a new file: `tests/e2e/06-my-test.spec.ts`

2. Use this template:
```typescript
import { test, expect } from '@playwright/test';
import { TestUtils } from '../helpers/test-utils';

test.describe('My Feature', () => {
  let utils: TestUtils;

  test.beforeEach(async ({ page }) => {
    utils = new TestUtils(page);
  });

  test('should do something', async ({ page }) => {
    // Load test data
    const eventData = TestUtils.loadEventFixture('sequential-wedding');

    // Create event
    const eventId = await utils.createEventViaUI(eventData);

    // Make assertions
    await expect(page).toHaveURL(`/event/${eventId}`);

    // Clean up
    await TestUtils.cleanupTestData(eventId);
  });
});
```

3. Run your test:
```bash
npx playwright test tests/e2e/06-my-test.spec.ts --headed
```

## 🎓 Learning Resources

- [Playwright Docs](https://playwright.dev/)
- [Writing Tests](https://playwright.dev/docs/writing-tests)
- [Debugging](https://playwright.dev/docs/debug)
- [Best Practices](https://playwright.dev/docs/best-practices)

## ✅ Pre-commit Checklist

Before committing code changes:
1. ✅ Run full test suite: `npm test`
2. ✅ All tests pass
3. ✅ No `test.only` in code
4. ✅ Added tests for new features
5. ✅ Reviewed HTML report for any flaky tests

## 🚦 CI/CD

Tests run automatically in CI/CD:
- On every push
- On every pull request
- Generate artifacts (reports, screenshots, videos)

See `.github/workflows/` for configuration.

## 💡 Tips

### Speed up tests
- Use API instead of UI for setup: `utils.createEventViaAPI()`
- Run only changed tests during development
- Use `--workers` flag for parallel execution

### Debug failing tests
1. Run in UI mode: `npm run test:ui`
2. Or use headed mode: `npm run test:headed`
3. Or add `page.pause()` in test code
4. Check screenshots in `test-results/` folder

### Test data
- All fixtures are in `tests/fixtures/events/`
- Tests automatically clean up after themselves
- Manual cleanup: Delete `data/events/*.json`

## 📞 Get Help

- Check `tests/README.md` for detailed docs
- Review `docs/PLAYWRIGHT_TEST_PLAN.md` for test coverage
- Open an issue if tests fail unexpectedly

---

**Happy Testing! 🎉**
