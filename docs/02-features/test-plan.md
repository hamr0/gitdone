# GitDone Playwright Test Plan

## Overview
Comprehensive end-to-end test plan for GitDone using Playwright to detect broken scenarios and ensure system reliability.

## Test Environment Setup
- Backend: http://localhost:3001
- Frontend: http://localhost:3000
- Test data directory: `tests/fixtures/`
- Test event cleanup after each run

---

## 1. Event Creation Workflows

### 1.1 Sequential Flow Event Creation
**Priority**: Critical
**Test**: `test-event-creation-sequential.spec.ts`

#### Scenarios:
- ✅ Create event with valid data (name, owner email, 3 steps)
- ✅ Verify magic link sent only to first vendor
- ✅ Verify event appears in homepage stats
- ✅ Verify event can be viewed via `/event/:id`
- ❌ Create event without name (should show error)
- ❌ Create event without owner email (should show error)
- ❌ Create event without any steps (should show error)
- ❌ Create event with invalid email format (should show error)

#### Success Criteria:
- Event JSON created in `data/events/`
- Magic link token stored in `data/magic_tokens.json`
- Email sent to owner with event creation confirmation
- Only first step vendor receives magic link
- Stats updated correctly

---

### 1.2 Non-Sequential Flow Event Creation
**Priority**: Critical
**Test**: `test-event-creation-non-sequential.spec.ts`

#### Scenarios:
- ✅ Create non-sequential event with 4 steps
- ✅ Verify magic links sent to ALL vendors simultaneously
- ✅ Verify any vendor can complete their step in any order
- ✅ Verify event completion when all steps done (regardless of order)

---

### 1.3 Hybrid Flow Event Creation
**Priority**: Critical
**Test**: `test-event-creation-hybrid.spec.ts`

#### Scenarios:
- ✅ Create hybrid event with custom sequences (1, 1, 2, 2, 3)
- ✅ Verify magic links sent to all sequence=1 vendors initially
- ✅ Verify sequence=2 vendors get links after ALL sequence=1 complete
- ✅ Verify sequence progression logic

---

## 2. Magic Link & Vendor Completion Workflows

### 2.1 Valid Magic Link Access
**Priority**: Critical
**Test**: `test-magic-link-completion.spec.ts`

#### Scenarios:
- ✅ Vendor clicks magic link
- ✅ Completion page loads with correct step info
- ✅ Vendor uploads 1 image file
- ✅ Vendor uploads 3 files (mixed: image, video, PDF)
- ✅ Vendor adds comments without files (should work)
- ✅ Verify file processing (images converted to WebP)
- ✅ Verify step marked as completed
- ✅ Verify Git commit created
- ✅ Verify next step vendor gets magic link (sequential flow)
- ✅ Verify event completion email sent when all done

#### File Upload Tests:
- ✅ Upload valid image (JPG, PNG)
- ✅ Upload valid video (MP4, MOV)
- ✅ Upload valid document (PDF, DOCX)
- ❌ Upload file > 25MB (should fail)
- ❌ Upload invalid file type (EXE, ZIP) (should fail)
- ✅ Upload 10 files (max limit)
- ❌ Upload 11 files (should fail)

---

### 2.2 Invalid Magic Link Scenarios
**Priority**: High
**Test**: `test-magic-link-errors.spec.ts`

#### Scenarios:
- ❌ Access with expired token
- ❌ Access with already-used token
- ❌ Access with malformed token
- ❌ Access with non-existent event ID
- ❌ Submit completion twice with same token
- ❌ Submit without files and without comments

---

## 3. Event Management Workflows

### 3.1 Request Management Link
**Priority**: High
**Test**: `test-event-management.spec.ts`

#### Scenarios:
- ✅ Owner requests management link via email
- ✅ Verify aggregated email sent with all owner's events
- ✅ Click management link from email
- ✅ View event details
- ✅ Enter edit mode
- ✅ Update event name
- ✅ Update step details
- ✅ Add new step to event
- ✅ Remove step from event
- ✅ Send reminder to pending step vendor
- ✅ Save changes successfully

#### Error Scenarios:
- ❌ Request management link with email that owns no events
- ❌ Access management link after expiration (7 days)
- ❌ Try to edit without proper permissions

---

### 3.2 View Event Page (Public)
**Priority**: Medium
**Test**: `test-event-view-page.spec.ts`

#### Scenarios:
- ✅ View event progress via `/event/:id`
- ✅ Verify progress bar shows correct percentage
- ✅ Verify step timeline displays correctly
- ✅ Verify completed steps show completion date
- ✅ Request edit link (owner email verification)
- ✅ Send reminder to pending vendor
- ✅ View recent activity (commits)

---

## 4. Flow Type Progression Tests

### 4.1 Sequential Flow Progression
**Priority**: Critical
**Test**: `test-sequential-flow-progression.spec.ts`

#### Scenario:
```
Event: Wedding Setup (Sequential)
Steps:
1. Venue Setup (Vendor A)
2. Catering Setup (Vendor B)
3. Decoration Setup (Vendor C)

Test Flow:
1. Create event → Only Vendor A gets magic link
2. Vendor A completes → Vendor B gets magic link
3. Try Vendor C completion before B completes → Should fail (token not sent yet)
4. Vendor B completes → Vendor C gets magic link
5. Vendor C completes → Event marked complete
6. Verify completion email sent to owner
```

---

### 4.2 Non-Sequential Flow Progression
**Priority**: Critical
**Test**: `test-non-sequential-flow-progression.spec.ts`

#### Scenario:
```
Event: Restaurant Opening (Non-Sequential)
Steps:
1. Kitchen Prep (Vendor A)
2. Dining Setup (Vendor B)
3. Bar Setup (Vendor C)

Test Flow:
1. Create event → ALL vendors get magic links immediately
2. Vendor C completes first (out of order) → OK
3. Vendor A completes second → OK
4. Vendor B completes last → Event marked complete
5. Verify completion email sent
```

---

### 4.3 Hybrid Flow Progression
**Priority**: Critical
**Test**: `test-hybrid-flow-progression.spec.ts`

#### Scenario:
```
Event: Conference Setup (Hybrid)
Steps:
1. Stage Setup (Vendor A) - Sequence 1
2. AV Setup (Vendor B) - Sequence 1
3. Lighting Check (Vendor C) - Sequence 2
4. Sound Check (Vendor D) - Sequence 2
5. Final Walk-through (Vendor E) - Sequence 3

Test Flow:
1. Create event → Vendor A & B get magic links (sequence 1)
2. Vendor A completes → Vendor C & D still wait
3. Vendor B completes → Vendor C & D get magic links (sequence 2)
4. Vendor D completes first → Vendor E still waits
5. Vendor C completes → Vendor E gets magic link (sequence 3)
6. Vendor E completes → Event complete
```

---

## 5. Email Delivery Tests

### 5.1 SMTP Email Functionality
**Priority**: High
**Test**: `test-email-delivery.spec.ts`

#### Scenarios:
- ✅ Event creation email sent to owner
- ✅ Magic link email sent to vendor
- ✅ Management link email sent to owner
- ✅ Event completion email sent to owner
- ✅ Verify email contains correct links
- ✅ Verify email HTML rendering
- ❌ Handle SMTP connection failure gracefully

---

## 6. Statistics Dashboard Tests

### 6.1 Stats Aggregation
**Priority**: Medium
**Test**: `test-stats-dashboard.spec.ts`

#### Scenarios:
- ✅ Homepage displays platform statistics
- ✅ Stats show correct total events count
- ✅ Stats show correct completed events count
- ✅ Stats show correct total steps count
- ✅ Stats show correct completed steps count
- ✅ Stats refresh endpoint works
- ✅ Verify stats update after event creation
- ✅ Verify stats update after step completion

---

## 7. File Upload & Processing Tests

### 7.1 Image Processing
**Priority**: Medium
**Test**: `test-file-processing.spec.ts`

#### Scenarios:
- ✅ Upload JPG → Verify converted to WebP
- ✅ Upload PNG → Verify converted to WebP
- ✅ Verify image quality maintained (85%)
- ✅ Verify file stored in `data/uploads/`
- ✅ Verify original filename preserved in metadata

### 7.2 Other File Types
- ✅ Upload PDF → Stored as-is
- ✅ Upload DOCX → Stored as-is
- ✅ Upload MP4 → Stored as-is (no transcoding)

---

## 8. Git Integration Tests

### 8.1 Repository Management
**Priority**: High
**Test**: `test-git-integration.spec.ts`

#### Scenarios:
- ✅ Event creation initializes Git repo
- ✅ Step completion creates Git commit
- ✅ Commit contains uploaded files
- ✅ Commit message includes step name & vendor
- ✅ Commit hash stored in event JSON
- ✅ Event JSON tracks all commits
- ✅ Verify Git log shows proper history

---

## 9. Time Limit Tests

### 9.1 Time Limit Validation
**Priority**: Medium
**Test**: `test-time-limits.spec.ts`

#### Scenarios:
- ✅ Create step with time limit (1h, 24h, 3d, 1w)
- ✅ Verify time limit displayed to vendor
- ✅ Verify time limit in custom format (date string)
- ✅ Complete step before time limit → Success
- ⚠️ Complete step after time limit → Success (warning logged)

---

## 10. Error Handling & Edge Cases

### 10.1 API Error Responses
**Priority**: High
**Test**: `test-api-error-handling.spec.ts`

#### Scenarios:
- ❌ POST /api/events with missing fields → 400 error
- ❌ GET /api/events/:invalid-id → 404 error
- ❌ POST /api/complete/:invalid-token → 401 error
- ❌ POST /api/magic/send without event_id → 400 error
- ❌ PUT /api/manage/:token without permissions → 403 error

### 10.2 Frontend Error Handling
**Priority**: Medium
**Test**: `test-frontend-error-handling.spec.ts`

#### Scenarios:
- ❌ Navigate to non-existent event → Show error page
- ❌ Network error during submission → Show retry option
- ❌ Invalid file upload → Show error message
- ❌ Form validation errors → Show inline messages

---

## 11. Concurrent Operations Tests

### 11.1 Race Conditions
**Priority**: High
**Test**: `test-concurrent-operations.spec.ts`

#### Scenarios:
- ⚠️ Two vendors complete steps simultaneously
- ⚠️ Owner edits event while vendor completes step
- ⚠️ Multiple magic link requests for same step
- ⚠️ Token expiration during form submission

---

## 12. Browser Compatibility Tests

### 12.1 Cross-Browser Testing
**Priority**: Medium
**Test**: Run all tests on multiple browsers

#### Browsers:
- ✅ Chromium (primary)
- ✅ Firefox
- ✅ WebKit (Safari)
- ✅ Mobile Chrome (viewport)
- ✅ Mobile Safari (viewport)

---

## 13. Performance Tests

### 13.1 Load Testing
**Priority**: Low
**Test**: `test-performance.spec.ts`

#### Scenarios:
- ⚠️ Create event with 50 steps
- ⚠️ Upload 10 files simultaneously (max limit)
- ⚠️ View event with 100+ commits
- ⚠️ Homepage loads within 3 seconds
- ⚠️ Stats API responds within 1 second

---

## 14. Security Tests

### 14.1 Authentication & Authorization
**Priority**: Critical
**Test**: `test-security.spec.ts`

#### Scenarios:
- ❌ Access management page without valid token
- ❌ Try to edit event as non-owner
- ❌ Reuse consumed magic link
- ❌ Access other user's event data via API
- ❌ JWT token tampering detection
- ✅ Token expiration enforcement
- ✅ CORS headers present

---

## Test Execution Strategy

### Phase 1: Critical Path (P0)
Run before every deployment:
1. Event creation (all flow types)
2. Magic link completion
3. Sequential flow progression
4. Management link access

### Phase 2: Core Features (P1)
Run nightly:
1. Email delivery
2. File upload & processing
3. Git integration
4. Error handling

### Phase 3: Extended Testing (P2)
Run weekly:
1. Statistics dashboard
2. Time limits
3. Concurrent operations
4. Performance tests
5. Security tests

---

## Test Data Management

### Fixtures:
```
tests/fixtures/
  ├── events/
  │   ├── sequential-wedding.json
  │   ├── non-sequential-conference.json
  │   └── hybrid-festival.json
  ├── users/
  │   ├── owner-emails.json
  │   └── vendor-emails.json
  └── files/
      ├── test-image.jpg
      ├── test-video.mp4
      └── test-document.pdf
```

### Cleanup:
- Delete test events after each test run
- Clear test magic tokens
- Remove uploaded files from test runs
- Reset stats aggregation

---

## Reporting

### Test Reports:
- HTML report generated in `playwright-report/`
- JSON report for CI/CD integration
- Screenshot on failure
- Video recording on failure (optional)

### Metrics to Track:
- Total tests executed
- Pass rate percentage
- Failed scenarios with screenshots
- Test execution time
- Coverage by workflow type

---

## CI/CD Integration

### GitHub Actions Workflow:
```yaml
name: E2E Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - Checkout code
      - Install dependencies
      - Start backend server
      - Start frontend server
      - Run Playwright tests
      - Upload test report
      - Upload failure artifacts
```

---

## Environment Variables for Testing

```env
# Test environment
BASE_URL=http://localhost:3000
API_BASE_URL=http://localhost:3001
JWT_SECRET=test-secret-key
SMTP_HOST=smtp.ethereal.email  # Test email service
SMTP_PORT=587
SMTP_USER=test@ethereal.email
SMTP_PASS=test-password
MAX_FILE_SIZE=26214400  # 25MB
```

---

## Success Criteria

### Test Coverage Goals:
- ✅ 90%+ critical path coverage
- ✅ 80%+ overall feature coverage
- ✅ 100% flow type coverage (sequential, non-sequential, hybrid)
- ✅ All API endpoints tested
- ✅ All user-facing pages tested

### Quality Gates:
- All critical tests must pass
- No security vulnerabilities
- Page load times < 3s
- API response times < 1s
- Zero data corruption scenarios

---

## Known Issues & Future Tests

### To Be Implemented:
1. ⏳ Timeout handler tests (automatic step expiration)
2. ⏳ Webhook integration tests
3. ⏳ Backup/restore event data tests
4. ⏳ Event archival workflow tests
5. ⏳ Mobile app integration tests (future)
6. ⏳ Real-time status updates (WebSocket tests)

### Current Limitations:
- Email testing requires mock SMTP or Ethereal Email
- Git operations require Git CLI installed
- File processing requires Sharp and FFmpeg
- Large file uploads may timeout in CI environment

---

## Maintenance

### Test Review Schedule:
- **Weekly**: Review failed tests and update assertions
- **Monthly**: Update test data fixtures
- **Quarterly**: Review and update test plan for new features
- **Per Release**: Full regression test suite execution

### Test Health Checks:
- Monitor flaky tests (> 10% failure rate)
- Review test execution times (> 30s per test)
- Update selectors when UI changes
- Verify test data cleanup after runs
