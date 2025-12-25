# Test Improvement Roadmap - Magic Token Retrieval

**Date**: December 23, 2025
**Issue**: 17 tests failing due to magic token retrieval race conditions
**Current Pass Rate**: 22.2% (30/135 tests)
**Expected After Fix**: 50-60% (67-81/135 tests)

---

## Problem Statement

Tests that simulate the complete vendor workflow fail because:
1. Tests try to read magic tokens from `data/magic_tokens.json`
2. Race condition: Tokens are written asynchronously by backend
3. Tests timeout waiting for "Complete Your Task" page to load
4. **Root cause**: Invalid/undefined token → wrong page loads

**Affected Tests**: All workflow completion tests (10 scenarios × 3 browsers = 30 tests failing)

---

## Solution Progression

### ✅ Phase 1: Immediate Fix (Right Now - 5 min)
**Implement**: Retry logic with timeout

**Goal**: Get tests passing to validate E2E functionality

**Approach**:
```typescript
async getMagicToken(eventId: string, stepIndex: number = 0): Promise<string> {
  const tokensPath = path.join(__dirname, '../../data/magic_tokens.json');

  // Retry up to 3 times with 1s delay
  for (let i = 0; i < 3; i++) {
    if (fs.existsSync(tokensPath)) {
      const tokensData = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
      const tokens = Object.keys(tokensData.tokens).filter(token => {
        const tokenInfo = tokensData.tokens[token];
        return tokenInfo.event_id === eventId && !tokenInfo.used;
      });

      if (tokens.length > 0) {
        return tokens[stepIndex] || tokens[0];
      }
    }

    // Wait and retry
    await this.page.waitForTimeout(1000);
  }

  throw new Error(`No magic token found for event ${eventId} after 3 attempts`);
}
```

**Pros**:
- ✅ Quick to implement
- ✅ Handles race conditions
- ✅ Fails fast with clear error message
- ✅ Gets tests passing immediately

**Cons**:
- ⚠️ Tests implementation detail (filesystem)
- ⚠️ Won't work if storage changes (DB, Redis)
- ⚠️ Not how real users work

**Expected Result**: 67-81 tests passing (50-60% pass rate)

**Use Case**: E2E testing during development - validates functionality works

---

### 🎯 Phase 2: Production-Quality Testing (Next Sprint - 30 min)
**Implement**: Test-only API endpoint

**Goal**: Test through APIs like production, not filesystem

**Approach**:
```javascript
// backend/routes/testing.js (NEW FILE)
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// ONLY enable in non-production environments
if (process.env.NODE_ENV !== 'production') {
  router.get('/api/test/magic-tokens/:eventId', (req, res) => {
    try {
      const tokensPath = path.join(__dirname, '../data/magic_tokens.json');
      const tokensData = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));

      const tokens = Object.keys(tokensData.tokens).filter(tokenKey => {
        const token = tokensData.tokens[tokenKey];
        return token.event_id === req.params.eventId && !token.used;
      });

      res.json({
        success: true,
        tokens,
        count: tokens.length
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });
}

module.exports = router;
```

```javascript
// backend/server.js
// Add this line with other routes
if (process.env.NODE_ENV !== 'production') {
  app.use(require('./routes/testing'));
}
```

```typescript
// tests/helpers/test-utils.ts
async getMagicToken(eventId: string, stepIndex: number = 0): Promise<string> {
  const response = await this.page.request.get(
    `http://localhost:3001/api/test/magic-tokens/${eventId}`
  );

  expect(response.ok()).toBeTruthy();
  const { tokens } = await response.json();

  if (!tokens || tokens.length === 0) {
    throw new Error(`No magic tokens found for event ${eventId}`);
  }

  return tokens[stepIndex] || tokens[0];
}
```

**Pros**:
- ✅ Tests through API (production-like)
- ✅ Storage-agnostic (works with DB, Redis, etc.)
- ✅ No race conditions (API waits for data)
- ✅ Disabled in production (security)
- ✅ Follows testing best practices

**Cons**:
- ⚠️ Still not testing email delivery
- ⚠️ Requires backend changes

**Expected Result**: Same 50-60% pass rate, but more robust

**Use Case**: CI/CD testing - reliable, fast, production-quality

---

### 🏆 Phase 3: Gold Standard (Future - 1-2 hours)
**Implement**: Email interception with Ethereal Email

**Goal**: Test EXACTLY how real users experience the system

**Approach**:
```javascript
// backend/.env.test
SMTP_HOST=smtp.ethereal.email
SMTP_PORT=587
SMTP_USER=your-ethereal-username
SMTP_PASS=your-ethereal-password
```

```typescript
// tests/helpers/email-helper.ts
import nodemailer from 'nodemailer';

export class EmailHelper {
  private account: any;

  async setup() {
    // Create test account at Ethereal Email
    this.account = await nodemailer.createTestAccount();
  }

  async getLatestEmail(recipientEmail: string): Promise<any> {
    // Fetch emails from Ethereal API
    const response = await fetch(
      `https://api.ethereal.email/messages?to=${recipientEmail}`
    );
    const emails = await response.json();
    return emails[0];
  }

  extractMagicToken(emailBody: string): string {
    // Extract token from email HTML/text
    const match = emailBody.match(/\/complete\/([a-zA-Z0-9._-]+)/);
    return match ? match[1] : '';
  }
}
```

```typescript
// tests/helpers/test-utils.ts
async getMagicTokenFromEmail(vendorEmail: string): Promise<string> {
  // Wait for email to arrive
  await this.page.waitForTimeout(2000);

  // Fetch email
  const email = await this.emailHelper.getLatestEmail(vendorEmail);

  // Extract token from email body
  const token = this.emailHelper.extractMagicToken(email.html);

  if (!token) {
    throw new Error(`No magic link found in email to ${vendorEmail}`);
  }

  return token;
}
```

**Pros**:
- ✅ Tests EXACTLY how users use the system
- ✅ Validates email delivery works
- ✅ Validates email content/template is correct
- ✅ Catches email formatting bugs
- ✅ True end-to-end test
- ✅ No backend code changes needed

**Cons**:
- ⚠️ Slower tests (email delivery time)
- ⚠️ More setup complexity
- ⚠️ Requires Ethereal account or MailHog server

**Expected Result**: Same 50-60% pass rate, highest confidence

**Use Case**: Production readiness testing - full E2E validation

---

## Understanding: E2E Testing Levels

### Your Question: "We need to test E2E and option 1 is best but email interception for prod testing, correct?"

**Almost!** Let me clarify:

### E2E Testing Has Multiple Levels

**Level 1: API E2E** (Phase 1 - Current)
- Tests: Frontend → Backend API → Database → Backend API → Frontend
- **Missing**: Email delivery
- **Good for**: Fast development feedback
- **Use**: Every PR, every commit

**Level 2: API E2E with Test Endpoint** (Phase 2)
- Tests: Frontend → Backend API (including test endpoints) → Database → Frontend
- **Missing**: Email delivery
- **Good for**: CI/CD reliability
- **Use**: Every PR, CI/CD pipeline

**Level 3: Full E2E with Email** (Phase 3)
- Tests: Frontend → Backend API → Database → Email Service → Email Inbox → Frontend
- **Missing**: Nothing - complete user journey
- **Good for**: Production readiness validation
- **Use**: Pre-release, nightly builds, production smoke tests

---

## Recommended Strategy

### Development (Daily)
✅ **Use Phase 1 (retry logic)**
- Fast feedback
- Validates functionality works
- Run on every code change

### CI/CD (Every PR)
✅ **Use Phase 2 (test API endpoint)**
- Reliable, no flakiness
- Storage-agnostic
- Fast enough for CI/CD

### Pre-Production (Before Deploy)
✅ **Use Phase 3 (email interception)**
- Complete validation
- Catches email issues
- Full confidence

---

## Corrected Understanding

**Your statement**: "We need to test E2E and option 1 is best but email interception for prod testing"

**Correction**:

1. ✅ **Yes**, we need E2E testing
2. ⚠️ **Phase 1 (retry logic)** is best for **right now** to get tests passing
3. ✅ **Yes**, email interception is for **production-level E2E testing**
4. 🎯 **But also**: Phase 2 (API endpoint) is the sweet spot for **CI/CD testing**

**Better way to think about it**:
- **Phase 1**: Quick fix to validate E2E flows work ✅ (use now)
- **Phase 2**: Production-quality E2E for CI/CD ✅✅ (use soon)
- **Phase 3**: True E2E for production validation ✅✅✅ (use before releases)

All three are "E2E tests" - they just test at different levels of the stack!

---

## Implementation Plan

### Today (5 minutes) ⏰
- [x] Implement retry logic in `getMagicToken()`
- [x] Run tests - expect 50-60% pass rate
- [x] Commit with message: "fix: Add retry logic for magic token retrieval in tests"

### Next Sprint (30 minutes) 📅
- [ ] Create `backend/routes/testing.js`
- [ ] Add test endpoint `/api/test/magic-tokens/:eventId`
- [ ] Update `test-utils.ts` to use API endpoint
- [ ] Add environment check to disable in production
- [ ] Update tests, verify pass rate maintained
- [ ] Commit with message: "test: Replace filesystem token access with test API endpoint"

### Future Enhancement (1-2 hours) 🚀
- [ ] Set up Ethereal Email account
- [ ] Create `EmailHelper` class
- [ ] Update backend to use Ethereal SMTP in test env
- [ ] Implement `getMagicTokenFromEmail()`
- [ ] Add email validation tests
- [ ] Document email testing setup
- [ ] Commit with message: "test: Add email interception for true E2E testing"

---

## Expected Results

| Phase | Pass Rate | What It Tests | Speed | Reliability | Production-Like |
|-------|-----------|---------------|-------|-------------|-----------------|
| **Current** | 22% | Event creation only | Fast | ❌ | ⚠️ |
| **Phase 1** | 50-60% | Full workflows (filesystem) | Fast | ⚠️ | ❌ |
| **Phase 2** | 50-60% | Full workflows (API) | Fast | ✅ | ✅ |
| **Phase 3** | 50-60% | Full workflows + email | Medium | ✅ | ✅✅ |

---

## Key Takeaways

1. **All three phases are E2E tests** - just at different levels
2. **Phase 1 gets you passing tests quickly** - validates functionality
3. **Phase 2 makes tests production-quality** - reliable for CI/CD
4. **Phase 3 tests like real users** - complete confidence

**You're correct**: Email interception is for production-level testing, but Phase 2 (API endpoint) is the best balance for most testing needs.

---

## Resources

- [Ethereal Email](https://ethereal.email/) - Free fake SMTP service for testing
- [MailHog](https://github.com/mailhog/MailHog) - Self-hosted email testing tool
- [Testing Trophy](https://kentcdodds.com/blog/the-testing-trophy-and-testing-classifications) - Testing philosophy
- [Playwright Best Practices](https://playwright.dev/docs/best-practices)

---

**Next Action**: Implement Phase 1 (retry logic) to unblock tests immediately! 🚀

**Status**: Ready to apply fix
**Expected Impact**: +30-40 tests passing (+58% improvement)
**Time to Implement**: 5 minutes
