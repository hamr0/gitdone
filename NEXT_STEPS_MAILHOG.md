# Next Steps: MailHog Email Interception Testing

## Current Status

### What We've Fixed ✅

1. **Backend Configuration** (`backend/server.js:7-10`)
   - Now loads `.env.test` when `NODE_ENV=test`
   - Uses MailHog SMTP (localhost:1025) during tests

2. **Playwright Configuration** (`playwright.config.ts:93`)
   - Backend starts with `NODE_ENV=test`
   - Ensures `.env.test` is loaded

3. **Verification**
   - Confirmed backend loads correct SMTP config:
     ```
     Environment: test
     SMTP_HOST: localhost
     SMTP_PORT: 1025
     ```

### What Still Needs Testing ❌

The fixes haven't been validated yet because:
- Previous test run used old configuration
- MailHog captured 0 emails (expected behavior with old config)
- Tests need to be re-run with new configuration

## Immediate Action Required

### Step 1: Run Tests with New Configuration

Kill any existing servers and run fresh tests:

```bash
# Kill all existing backend/frontend servers
pkill -f "node.*backend.*server"
pkill -f "next-server"

# Clear MailHog inbox
curl -X DELETE http://localhost:8025/api/v1/messages

# Run tests (backend will start with NODE_ENV=test)
npx playwright test --project=chromium --reporter=list
```

### Step 2: Verify MailHog Captures Emails

During test run, check MailHog:

```bash
# In separate terminal, monitor emails
watch -n 2 'curl -s http://localhost:8025/api/v2/messages | jq ".total"'

# Or after test run:
curl -s http://localhost:8025/api/v2/messages | jq ".total"
```

**Expected Result**: Should see emails being captured (total > 0)

### Step 3: Analyze Results

Check if our fixes worked:

```bash
# View captured emails
curl -s http://localhost:8025/api/v2/messages | jq ".items[] | {to: .To[0].Mailbox, subject: .Content.Headers.Subject[0]}"

# Check test results
npx playwright show-report
```

## Expected Outcomes

### Scenario A: MailHog Captures Emails ✅

**What it means**: Our configuration fix worked!

**Next steps**:
1. Analyze which tests still fail
2. Focus on fixing test locator issues (strict mode violations)
3. Update tests to use `getLatestEmail()` and `getMagicTokenFromEmail()`

### Scenario B: MailHog Still Has 0 Emails ❌

**What it means**: Something else is blocking email flow

**Debugging steps**:
1. Check backend logs during test:
   ```bash
   cd backend && NODE_ENV=test npm start
   # Watch logs for SMTP errors
   ```

2. Verify `.env.test` is loaded:
   ```bash
   # In running backend, check env
   ps aux | grep "node.*backend"
   ```

3. Test email manually:
   ```bash
   cd backend && NODE_ENV=test node test-email.js
   ```

## Test Result Expectations

Current: **25/135 passing (18.5%)**

After configuration fix:
- **Minimum**: Same pass rate, but emails captured in MailHog
- **Expected**: 30-40/135 passing (22-30%) - minor improvements
- **Target after locator fixes**: 67-81/135 passing (50-60%)

## Why Tests May Still Fail

Even with MailHog working, many tests will fail due to:

1. **Locator Issues** (strict mode violations)
   ```
   locator('text=event name') resolved to 2 elements
   ```
   Fix: Use more specific selectors with `data-testid`

2. **UI Assertion Failures**
   ```
   Expected: visible
   Received: hidden
   ```
   Fix: Add proper wait conditions

3. **Tests Not Using Email Flow**
   - Currently tests use API responses, not actual email tokens
   - Need to update tests to use MailHog helpers

## Summary

**You're at a critical checkpoint:**
1. Configuration is fixed (backend will use MailHog)
2. But tests haven't been re-run yet with new config
3. Need to verify emails actually flow through MailHog

**Recommended Action**: Run the full test suite again and verify MailHog captures emails. This will confirm our fix works and provide direction for next improvements.

---

**Created**: 2025-12-23
**Status**: Configuration fixed, awaiting validation
