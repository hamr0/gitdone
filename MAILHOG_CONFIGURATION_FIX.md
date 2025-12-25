# MailHog Configuration Fix

## Problem Discovered

After implementing MailHog email interception, test results showed:
- **25 passing tests** (out of 135 total)
- **110 unexpected failures**
- **0 emails captured by MailHog** during test run

## Root Cause Analysis

### Issue 1: Backend Not Loading .env.test

**Problem**: Backend `server.js` was hardcoded to load `.env`:
```javascript
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
```

This meant during test runs, the backend was still using production email config (Gmail SMTP) instead of MailHog SMTP.

**Solution**: Updated `backend/server.js:7-10` to conditionally load `.env.test`:
```javascript
// Load environment variables from .env file in project root
// Use .env.test when running tests
const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
require('dotenv').config({ path: path.resolve(__dirname, '..', envFile) });
```

### Issue 2: NODE_ENV Not Set for Backend Server

**Problem**: Playwright config started backend with:
```typescript
command: 'cd backend && npm start',
```

This didn't set `NODE_ENV=test`, so the backend couldn't detect test mode.

**Solution**: Updated `playwright.config.ts:93` to set environment:
```typescript
command: 'cd backend && NODE_ENV=test npm start',
```

### Issue 3: Tests Not Using MailHog Helpers

**Problem**: Tests still use old approach:
- Create event via API
- Check API response for `magic_links_sent`
- Never actually read emails from MailHog

**Impact**: Even though MailHog is running, no emails are being captured because tests don't trigger the email flow.

**Future Work Needed**: Update tests to use the MailHog helpers we created:
```typescript
// Example usage (not yet implemented in tests):
const email = await getLatestEmail(vendorEmail);
const token = await getMagicTokenFromEmail(email);
```

## Current Test Failures

The 110 failures are **not related to email**. They're mostly:
- **Locator strict mode violations** - Multiple elements matching selectors
- **UI assertion failures** - Elements not visible or text not matching

Example error:
```
strict mode violation: locator('text=event name') resolved to 2 elements:
  1) <label>Event Name *</label>
  2) <p>Please fill in event name and your email</p>
```

## What's Fixed Now

✅ Backend loads `.env.test` when `NODE_ENV=test`
✅ Playwright sets `NODE_ENV=test` when starting backend
✅ MailHog will capture emails when backend sends them

## What Still Needs Work

❌ Tests need to be updated to use MailHog email helpers
❌ Test locators need to be more specific (use data-testid)
❌ UI assertions need to handle multiple matching elements

## Next Steps

1. **Run tests again** to verify MailHog now captures emails
2. **Update test locators** to use data-testid attributes
3. **Implement email flow tests** using the MailHog helpers
4. **Fix UI assertion failures** with better selectors

## Expected Impact After These Fixes

Current baseline: 25/135 tests passing (18.5%)

After MailHog config fix:
- Emails should flow through MailHog
- Backend SMTP should work in tests

After test locator fixes:
- **Target: 67-81/135 tests (50-60%)**
- Major improvement in test stability

## Verification Commands

Check if MailHog captures emails:
```bash
curl http://localhost:8025/api/v2/messages
```

Check backend environment:
```bash
cd backend && NODE_ENV=test node -e "require('dotenv').config({ path: require('path').resolve(__dirname, '..', process.env.NODE_ENV === 'test' ? '.env.test' : '.env') }); console.log('SMTP_HOST:', process.env.SMTP_HOST);"
```

Run single test with email:
```bash
NODE_ENV=test npx playwright test tests/e2e/01-event-creation-sequential.spec.ts --project=chromium --grep "should send magic link"
```

---

**Created**: 2025-12-23
**Status**: Backend configuration fixed, tests still need updates
