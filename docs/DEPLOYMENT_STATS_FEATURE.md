# Event Aggregation Dashboard Feature - Deployment and Monitoring Guide

**Document Version**: 1.0
**Last Updated**: 2025-12-19
**Status**: Ready for Production Deployment

This guide provides comprehensive instructions for deploying the Event Aggregation Dashboard feature, monitoring its health, troubleshooting issues, and rolling back if necessary.

---

## Table of Contents

1. [Pre-Deployment Checklist](#pre-deployment-checklist)
2. [Staging Deployment Steps](#staging-deployment-steps)
3. [Post-Deployment Verification](#post-deployment-verification)
4. [Monitoring Guidelines](#monitoring-guidelines)
5. [Troubleshooting Guide](#troubleshooting-guide)
6. [Rollback Procedure](#rollback-procedure)
7. [Performance Baseline Documentation](#performance-baseline-documentation)

---

## Pre-Deployment Checklist

Before deploying the Event Aggregation Dashboard feature to any environment, verify all items below are complete.

### Code Quality and Testing

- [ ] **All Unit Tests Passing**
  - Backend: `cd /home/hamr/PycharmProjects/gitdone/backend && npm test -- statsAggregator.test.js`
  - Expected: All tests pass with no errors
  - Effort: 5 minutes to run

- [ ] **All Integration Tests Passing**
  - Backend: `cd /home/hamr/PycharmProjects/gitdone/backend && npm test -- stats.test.js`
  - Expected: All endpoint tests pass
  - Effort: 5 minutes to run

- [ ] **All Component Tests Passing**
  - Frontend: `cd /home/hamr/PycharmProjects/gitdone/frontend && npm test`
  - Expected: StatsTable component tests pass with no errors
  - Effort: 5 minutes to run

- [ ] **No Console Errors or Warnings**
  - Review all test output for warnings or deprecation messages
  - Verify no `console.error` calls in implementation code (except in error handlers)
  - Run build: `cd /home/hamr/PycharmProjects/gitdone/frontend && npm run build`
  - Expected: Clean build with no errors

- [ ] **Code Review Completed**
  - Create pull request for feature branch
  - Assign reviewer from team lead or senior developer
  - Verify all feedback addressed
  - Obtain approval (comment: "Approved for deployment")

### Configuration and Dependencies

- [ ] **Dependencies Installed**
  - Backend: `cd /home/hamr/PycharmProjects/gitdone/backend && npm install`
  - Verify `node-cron` listed in `package.json`
  - Expected: No installation errors

- [ ] **Environment Variables Configured**
  - Verify `.env` file present in project root
  - Check: `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_HOST`, `SMTP_PORT` configured
  - Note: Stats feature doesn't require additional env vars; uses existing config

- [ ] **.gitignore Verified**
  - Check: `/data/stats.json` is in `.gitignore` (cache file, not committed)
  - Check: `/data/events/` directory structure allows event files (JSON files ARE committed)
  - Run: `git check-ignore /data/stats.json` → should return nothing (file is ignored)

### File Structure Verification

- [ ] **Backend Files Created**
  - [ ] `/home/hamr/PycharmProjects/gitdone/backend/utils/statsAggregator.js` exists
  - [ ] `/home/hamr/PycharmProjects/gitdone/backend/utils/statsScheduler.js` exists
  - [ ] `/home/hamr/PycharmProjects/gitdone/backend/routes/stats.js` exists
  - Verify: All files are non-empty and contain expected functions

- [ ] **Frontend Files Created**
  - [ ] `/home/hamr/PycharmProjects/gitdone/frontend/src/components/StatsTable.tsx` exists
  - [ ] Component properly exported and importable
  - Verify: No TypeScript compilation errors

- [ ] **Server Integration**
  - [ ] `server.js` imports statsScheduler: `const { startScheduler } = require('./utils/statsScheduler');`
  - [ ] `server.js` imports stats routes: `const statsRouter = require('./routes/stats');`
  - [ ] `server.js` registers routes: `app.use('/api/stats', statsRouter);`
  - [ ] `server.js` calls scheduler: `startScheduler();` (AFTER route registration)

- [ ] **Landing Page Integration**
  - [ ] `page.tsx` imports StatsTable: `import StatsTable from '../components/StatsTable';`
  - [ ] Component rendered in JSX with correct props

---

## Staging Deployment Steps

Follow these steps to deploy to a staging environment for testing.

### 1. Code Deployment

```bash
# 1.1 Ensure on main/develop branch with all feature commits
cd /home/hamr/PycharmProjects/gitdone
git status
# Expected: "On branch main" or "On branch develop" with no uncommitted changes

# 1.2 Deploy code to staging (example for VPS deployment)
# NOTE: Adjust steps based on your deployment method
git fetch origin
git pull origin main  # or develop/feature branch as appropriate

# For PM2 deployment (if using)
pm2 stop gitdone-backend gitdone-frontend
pm2 start backend/server.js gitdone-backend
pm2 start frontend/next.js gitdone-frontend
```

### 2. Backend Setup

```bash
# 2.1 Navigate to backend directory
cd /home/hamr/PycharmProjects/gitdone/backend

# 2.2 Install/verify dependencies
npm install
# Expected: "added X packages" or "up to date"
# Verify node-cron is present: npm ls node-cron

# 2.3 Check for any lingering test files or debug code
grep -r "console.log" backend/utils/statsAggregator.js backend/utils/statsScheduler.js
# Expected: Only logging with [Stats Aggregator] or [Stats Scheduler] prefixes
# No test-only console.log statements
```

### 3. Scheduler Verification

```bash
# 3.1 Start backend server (or restart if already running)
npm start
# Expected console output should include:
# "[Stats Scheduler] Started—running every 6 hours at 00:00, 06:00, 12:00, 18:00 UTC"

# 3.2 Verify scheduler is running
# Option A: Check logs directly (should see scheduler startup message)
# Option B: Query next scheduler fire time via code (advanced debugging)

# Let logs run for 2-3 seconds then move to next step
# Ctrl+C to stop if needed (can run in background)
```

### 4. Frontend Setup (if deploying frontend separately)

```bash
# 4.1 Navigate to frontend directory
cd /home/hamr/PycharmProjects/gitdone/frontend

# 4.2 Install dependencies
npm install
# Expected: "added X packages" or "up to date"

# 4.3 Build frontend
npm run build
# Expected: Build succeeds with no errors
# File: `.next/` directory created

# 4.4 Start frontend dev server or production server
npm run dev    # For development testing
# OR
npm run start  # For production (requires build first)
```

### 5. API Endpoint Testing

```bash
# 5.1 Test GET /api/stats endpoint
curl -X GET http://localhost:3001/api/stats

# Expected Response (200 OK):
# {
#   "success": true,
#   "last_updated": "2025-12-19T18:00:00.000Z" or null,
#   "current_metrics": {
#     "total_events": 42,
#     "total_steps": 156,
#     "completed_events": 28,
#     "completed_steps": 142
#   },
#   "monthly_records": []
# }

# 5.2 Test POST /api/stats/refresh endpoint
curl -X POST http://localhost:3001/api/stats/refresh

# Expected Response (200 OK):
# {
#   "success": true,
#   "message": "Statistics aggregated successfully",
#   "refresh_duration_ms": 234,
#   "metrics": {
#     "total_events": 42,
#     "total_steps": 156,
#     "completed_events": 28,
#     "completed_steps": 142
#   },
#   "next_scheduled_refresh": "2025-12-20T00:00:00.000Z"
# }

# If tests fail, check:
# - Backend server running on port 3001
# - No network firewall blocking requests
# - See Troubleshooting section below
```

### 6. Landing Page Verification

```bash
# 6.1 Open landing page in browser
# http://localhost:3000/  (if dev mode)
# https://staging.yourdomain.com/  (if staging deployment)

# 6.2 Expected observations:
# - Page loads without errors
# - "Platform Statistics" section visible at bottom of page
# - Table shows metrics (all 4 columns)
# - Timestamp shows "Last updated: ..." (or "not yet available")
# - No red error messages

# 6.3 Test loading state (optional advanced)
# - Open DevTools Network tab
# - Throttle to "Slow 3G" or "Custom" with 5s latency
# - Refresh page
# - Should see loading spinner/skeleton while fetching stats
# - Stats appear once load completes

# 6.4 Test on mobile viewport
# - DevTools → Toggle device toolbar (Cmd+Shift+M on Mac, Ctrl+Shift+M on Windows)
# - Select iPhone 12 or similar
# - Verify table layout doesn't break
# - All columns visible and readable
```

### 7. Scheduler Monitoring (First 24 Hours)

```bash
# 7.1 Set up log monitoring
# Keep backend logs visible during entire deployment window
# Look for scheduler execution logs

# Expected: 4 successful runs in any 24-hour period
# Log pattern: "[Stats Scheduler] ✓ Aggregation completed at HH:MM UTC"
# OR "[Stats Scheduler] Error: ..." if issues occur

# 7.2 Verify stats.json file updates
# Command: tail -f /home/hamr/PycharmProjects/gitdone/data/stats.json
# Watch: last_updated timestamp should update every 6 hours

# 7.3 Alert on errors
# If you see: "[Stats Scheduler] Error:"
# Immediately review error message and troubleshoot (see Troubleshooting section)

# 7.4 Performance monitoring
# Check last_refresh_duration_ms after each run
# Expected: < 5000ms (should be < 1000ms for < 1000 events)
# If > 5000ms: investigate event file count and size
```

---

## Post-Deployment Verification

After deploying to staging, verify all components working correctly.

### Verification Checklist

- [ ] **Stats.json File Created**
  - File exists: `ls -la /home/hamr/PycharmProjects/gitdone/data/stats.json`
  - File is valid JSON: `cat /home/hamr/PycharmProjects/gitdone/data/stats.json | jq .`
  - File is writable: `test -w /home/hamr/PycharmProjects/gitdone/data/stats.json && echo "writable"`

- [ ] **Metrics Accuracy Verification**
  - Count actual events: `ls /home/hamr/PycharmProjects/gitdone/data/events/ | wc -l`
  - Compare with stats.json `total_events` value
  - Expected: Should match (±1 due to timing)

- [ ] **Landing Page Loads**
  - Navigate to http://localhost:3000/ (or staging URL)
  - Verify no console errors (DevTools → Console tab)
  - Check network tab for any failed requests (should be no 404s or 500s)
  - Performance: Page should load in < 2 seconds

- [ ] **StatsTable Component Renders**
  - Visual: Table with 4 rows (metrics) visible on landing page
  - Structure: Headers "Metric" and "Count" visible
  - Data: All 4 metrics display numbers
  - Timestamp: "Last updated: [date/time] UTC" visible

- [ ] **Timestamp Format Correct**
  - Example: "Last updated: Dec 19, 2025 at 18:00 UTC"
  - Or: "Last updated: Not yet available" (on first run before aggregation)

- [ ] **Responsive Design Works**
  - Mobile (< 640px): No horizontal scroll, table readable
  - Tablet (640-1024px): Table laid out properly
  - Desktop (> 1024px): Table aligned and centered

- [ ] **Error Handling Graceful**
  - Simulate API failure (DevTools → Network → Offline)
  - Refresh landing page
  - Expected: Error message displays ("Statistics unavailable") but page doesn't crash
  - Verify error message is helpful (not cryptic)

### Success Criteria

- [ ] All items in verification checklist completed
- [ ] No critical errors in browser console or server logs
- [ ] Stats display matches event data
- [ ] Landing page responsive on all devices
- [ ] Scheduler running and logging successful aggregations

If any verification fails, consult the [Troubleshooting Guide](#troubleshooting-guide) before proceeding to production.

---

## Monitoring Guidelines

Once deployed, monitor the Event Aggregation Dashboard feature continuously using the guidelines below.

### What to Monitor

#### 1. Aggregation Performance

**Metric**: `last_refresh_duration_ms` in `/data/stats.json`

- **Normal Range**: 100-5000 milliseconds (< 5 seconds)
- **Location**: Open `/home/hamr/PycharmProjects/gitdone/data/stats.json` and check `last_refresh_duration_ms` field
- **Frequency**: Check after each scheduled run (every 6 hours) or after manual refresh
- **Alert Threshold**: > 10 seconds (indicates slow event file reading)

**Action If Triggered**:
```bash
# 1. Check event file count
ls /home/hamr/PycharmProjects/gitdone/data/events/ | wc -l
# If > 10,000 events: May need database instead of file-based storage (future optimization)

# 2. Check event file sizes
du -sh /home/hamr/PycharmProjects/gitdone/data/events/
# If > 1GB: Event files too large, may need compression or archival

# 3. Manually trigger refresh to isolate issue
curl -X POST http://localhost:3001/api/stats/refresh
# Check response time and duration_ms value

# 4. If consistently slow: File an optimization ticket, but feature still functional
```

#### 2. Scheduler Execution Frequency

**Expected**: 4 successful aggregations per 24-hour period

- **Scheduled Times (UTC)**: 00:00, 06:00, 12:00, 18:00
- **Location**: Server logs (look for `[Stats Scheduler]` prefix)
- **How to Monitor**:
  ```bash
  # View recent logs (last 100 lines)
  tail -100 /path/to/backend/logs/server.log | grep "Stats Scheduler"
  # Should see 4 entries per 24 hours if available
  ```
- **Alert Threshold**: No successful run in last 12 hours

**Action If Triggered**:
```bash
# 1. Check if scheduler is running
# Look for: "[Stats Scheduler] Started" message in recent logs

# 2. If no scheduler message in recent logs
# The scheduler may not have started (see Troubleshooting > Scheduler Not Running)

# 3. Manually verify latest aggregation time
cat /home/hamr/PycharmProjects/gitdone/data/stats.json | grep "last_updated"
# Should be < 12 hours old
```

#### 3. Error Logging

**Location**: Server logs for any errors with `[Stats Scheduler]` prefix

**Patterns to Watch For**:
- `[Stats Scheduler] Error: ENOENT: no such file or directory`
- `[Stats Scheduler] Error: JSON.parse failed`
- `[Stats Scheduler] Error: EACCES: permission denied`
- Any unhandled exception in scheduler

**How to Monitor**:
```bash
# View error logs in real-time
tail -f /path/to/backend/logs/server.log | grep -i error

# Count errors in last 24 hours
grep "[Stats Scheduler] Error" /path/to/backend/logs/server.log | wc -l
# Should be 0 (if > 0, investigate immediately)
```

**Action If Triggered**:
See [Troubleshooting Guide](#troubleshooting-guide) for specific error solutions.

#### 4. API Endpoint Response Times

**Endpoints to Monitor**:
- `GET /api/stats`
- `POST /api/stats/refresh`

**Normal Response Times**:
- GET /api/stats: 10-100ms (reading cached file)
- POST /api/stats/refresh: 500-5000ms (scanning events)

**How to Monitor** (using curl with time measurement):
```bash
# GET endpoint response time
time curl -X GET http://localhost:3001/api/stats > /dev/null
# Real time should be < 100ms

# POST endpoint response time
time curl -X POST http://localhost:3001/api/stats/refresh > /dev/null
# Real time should be < 10 seconds

# For production, use APM tool (e.g., New Relic, DataDog) if available
```

**Alert Threshold**:
- GET: > 500ms (something wrong with file reading)
- POST: > 15 seconds (aggregation very slow)

**Action If Triggered**:
```bash
# 1. Check server load
top
# Is CPU or memory maxed? If so, scale up resources

# 2. Check disk I/O
iostat 1 5
# If %iowait high, disk is slow

# 3. Check event files aren't corrupted
# Try manual refresh again
curl -X POST http://localhost:3001/api/stats/refresh
# If succeeds second time, may be temporary issue
```

#### 5. Landing Page Load Time

**Where to Monitor**: Browser DevTools Network tab on production site

**Normal Load Time**: < 2 seconds (with StatsTable included)

**How to Monitor**:
1. Open production landing page
2. DevTools → Network tab
3. Reload page
4. Check "Finish" time (should be < 2000ms)
5. Check StatsTable loads (should be visible within 2s)

**Alert Threshold**: > 3 seconds (performance regression)

**Action If Triggered**:
```bash
# 1. Check if stats API is slow
# Open DevTools → Network tab
# Look for /api/stats request
# If > 500ms: Check server load (see API response time troubleshooting above)

# 2. Check if frontend build needs optimization
npm run build
npm run analyze  # If available to check bundle size

# 3. If temporary: May be network/infrastructure issue, monitor for pattern
```

### Alert Summary Table

| Metric | Alert Threshold | Severity | Action |
|--------|-----------------|----------|--------|
| `last_refresh_duration_ms` | > 10 seconds | Medium | Check event file count/size |
| Scheduler frequency | No run in 12 hours | High | Restart server, check logs |
| Error logs | Any `[Stats Scheduler] Error` | High | Immediate investigation |
| GET /api/stats | > 500ms | Medium | Check server load, disk I/O |
| POST /api/stats/refresh | > 15 seconds | Medium | Check server resources |
| Landing page load | > 3 seconds | Low | Check stats API performance |

### Monitoring Dashboard Setup (Recommended)

For sustained monitoring, set up a dashboard tracking:

1. **Stats File Age**: `(now - last_updated)` in minutes
   - Alert: > 720 minutes (12 hours)

2. **Aggregation Count (24h)**: Number of successful `[Stats Scheduler]` log entries
   - Alert: < 3 (expected 4)

3. **API Success Rate**: % of 200-status responses from `/api/stats`
   - Alert: < 99%

4. **Event Count Trend**: Total events over time (for capacity planning)
   - Baseline: Current event count
   - Alert if doubles in < 1 month (may need optimization)

5. **Monthly Records**: Number of completed months tracked
   - Verify growing once per month

---

## Troubleshooting Guide

Use this section to diagnose and resolve common issues.

### Issue 1: Scheduler Not Running

**Symptoms**:
- No `[Stats Scheduler] Started` message in server logs on startup
- `last_updated` in stats.json not changing over 12+ hours
- Landing page shows "Statistics not yet available"

**Diagnosis Steps**:

1. Check server logs for scheduler startup
   ```bash
   tail -50 /path/to/backend/logs/server.log | grep "Stats Scheduler"
   # If no output: scheduler didn't start
   ```

2. Verify server.js has scheduler integration
   ```bash
   grep -n "startScheduler" /home/hamr/PycharmProjects/gitdone/backend/server.js
   # Expected output: Lines showing import and call
   ```

3. Check if statsScheduler.js file exists and is valid
   ```bash
   ls -la /home/hamr/PycharmProjects/gitdone/backend/utils/statsScheduler.js
   node -c /home/hamr/PycharmProjects/gitdone/backend/utils/statsScheduler.js
   # Should output: "Syntax OK"
   ```

4. Verify node-cron installed
   ```bash
   cd /home/hamr/PycharmProjects/gitdone/backend
   npm ls node-cron
   # Should show version (e.g., node-cron@3.0.0)
   ```

**Solutions** (in order of likelihood):

**Solution A: Scheduler code missing from server.js**
```bash
# Edit server.js and add these lines (after other imports):
# const { startScheduler } = require('./utils/statsScheduler');

# And after all app.use() routes, add:
# startScheduler();

# Then restart server:
npm start
# Should see: "[Stats Scheduler] Started..." message
```

**Solution B: node-cron not installed**
```bash
cd /home/hamr/PycharmProjects/gitdone/backend
npm install node-cron
npm start
# Check logs for scheduler startup
```

**Solution C: statsScheduler.js syntax error**
```bash
# Check file for syntax errors
node -c /home/hamr/PycharmProjects/gitdone/backend/utils/statsScheduler.js
# If error shown: view the file and fix
cat /home/hamr/PycharmProjects/gitdone/backend/utils/statsScheduler.js | head -20
# Verify it's not corrupted

# If corrupted: restore from git
git checkout /home/hamr/PycharmProjects/gitdone/backend/utils/statsScheduler.js
npm start
```

**Solution D: Server process not restarted after code changes**
```bash
# Kill existing server process
pkill -f "node.*server.js"
# OR if using PM2:
pm2 stop gitdone-backend
pm2 start backend/server.js

# Restart server
npm start
# Check logs
```

---

### Issue 2: /api/stats Returns Error (500)

**Symptoms**:
- `curl http://localhost:3001/api/stats` returns HTTP 500
- Landing page shows: "Statistics unavailable"
- Server logs show error with /api/stats

**Diagnosis Steps**:

1. Check response error details
   ```bash
   curl -X GET http://localhost:3001/api/stats 2>&1
   # Look for "error" field in response
   ```

2. Verify directory structure
   ```bash
   ls -la /home/hamr/PycharmProjects/gitdone/data/
   ls -la /home/hamr/PycharmProjects/gitdone/data/events/
   ls -la /home/hamr/PycharmProjects/gitdone/data/stats.json 2>&1 || echo "File doesn't exist yet"
   ```

3. Check directory permissions
   ```bash
   test -r /home/hamr/PycharmProjects/gitdone/data/ && echo "readable" || echo "NOT readable"
   test -w /home/hamr/PycharmProjects/gitdone/data/ && echo "writable" || echo "NOT writable"
   ```

4. Check if stats.js file exists
   ```bash
   ls -la /home/hamr/PycharmProjects/gitdone/backend/routes/stats.js
   node -c /home/hamr/PycharmProjects/gitdone/backend/routes/stats.js
   ```

**Solutions** (in order of likelihood):

**Solution A: /data/ directory doesn't exist**
```bash
mkdir -p /home/hamr/PycharmProjects/gitdone/data/events
# Verify creation
ls -la /home/hamr/PycharmProjects/gitdone/data/
```

**Solution B: Permission denied on /data/ directory**
```bash
# Check current user
whoami

# Fix permissions (make readable/writable)
chmod 755 /home/hamr/PycharmProjects/gitdone/data
chmod 755 /home/hamr/PycharmProjects/gitdone/data/events

# If running under different user (e.g., Node service account):
# Change ownership to that user
sudo chown -R nodeuser:nodeuser /home/hamr/PycharmProjects/gitdone/data
```

**Solution C: stats.json corrupted or unreadable**
```bash
# If file exists but corrupted
rm /home/hamr/PycharmProjects/gitdone/data/stats.json

# Trigger manual refresh to recreate
curl -X POST http://localhost:3001/api/stats/refresh

# Verify recreated
cat /home/hamr/PycharmProjects/gitdone/data/stats.json
```

**Solution D: stats.js route not registered in server.js**
```bash
# Check server.js
grep "statsRouter\|'/api/stats'" /home/hamr/PycharmProjects/gitdone/backend/server.js

# If missing, add these lines in server.js:
# const statsRouter = require('./routes/stats');
# app.use('/api/stats', statsRouter);

# Restart server
npm start
```

---

### Issue 3: Stats.json Is Very Old

**Symptoms**:
- `last_updated` timestamp in stats.json is > 12 hours old
- Expected: 4 runs per 24 hours (every 6 hours)
- Landing page displays old stats

**Diagnosis Steps**:

1. Check last update time
   ```bash
   cat /home/hamr/PycharmProjects/gitdone/data/stats.json | grep "last_updated"
   # Compare to current time: date -u
   ```

2. Check scheduler logs for errors
   ```bash
   tail -100 /path/to/backend/logs/server.log | grep -A2 "Stats Scheduler"
   # Look for error messages
   ```

3. Verify scheduler is running
   ```bash
   # Check if node process is still alive
   ps aux | grep "node.*server.js" | grep -v grep
   # Should show a running process
   ```

4. Check system time (clocks must be correct for cron)
   ```bash
   date -u
   # Should show reasonable date/time in UTC
   ```

**Solutions** (in order of likelihood):

**Solution A: Scheduler running but aggregation failing silently**
```bash
# Try manual refresh
curl -X POST http://localhost:3001/api/stats/refresh

# Check response
# If error: see Issue 2 (API returns error) for next steps
# If success: scheduler may be failing due to event file issues

# Check event files for corruption
cd /home/hamr/PycharmProjects/gitdone/data/events/
for f in *.json; do
  jq empty "$f" 2>/dev/null || echo "Corrupt: $f"
done
# Fix any corrupt files: delete or restore from git
```

**Solution B: Server/scheduler crashed**
```bash
# Check if process still running
ps aux | grep "node.*server.js" | grep -v grep

# If not running:
cd /home/hamr/PycharmProjects/gitdone/backend
npm start

# If using PM2:
pm2 stop gitdone-backend
pm2 start backend/server.js
pm2 status
```

**Solution C: System clock skewed**
```bash
# Check system time
date -u

# If wrong, update (requires admin):
sudo ntpdate -s time.nist.gov
# OR use timedatectl on modern systems:
sudo timedatectl set-ntp true
```

**Solution D: Manual intervention**
```bash
# If unable to fix root cause, manually trigger refresh
curl -X POST http://localhost:3001/api/stats/refresh

# Verify stats.json updated
cat /home/hamr/PycharmProjects/gitdone/data/stats.json | grep "last_updated"

# If manual refresh works, scheduler will resume at next scheduled time
# If manual refresh fails: escalate to Issue 2 (API returns error)
```

---

### Issue 4: Metrics Seem Incorrect

**Symptoms**:
- Stats show different numbers after manual refresh
- Counts don't match expected event counts
- Discrepancies in completed_events vs total_events

**Diagnosis Steps**:

1. Count actual events
   ```bash
   ls /home/hamr/PycharmProjects/gitdone/data/events/ | wc -l
   # Compare to total_events in stats.json
   ```

2. Validate event file format
   ```bash
   # Check a few random event files
   cat /home/hamr/PycharmProjects/gitdone/data/events/[sample-uuid].json | jq .
   # Should show: id, name, steps[], status, etc.
   ```

3. Check step status values
   ```bash
   # Verify only "completed" or "pending" status values
   grep -h '"status"' /home/hamr/PycharmProjects/gitdone/data/events/*.json | sort | uniq -c
   # Should show only: "completed" and "pending"
   ```

4. Verify stats calculation logic
   ```bash
   # View stats.json structure
   cat /home/hamr/PycharmProjects/gitdone/data/stats.json | jq .
   # Check: current_metrics looks correct relative to event count
   ```

**Solutions** (in order of likelihood):

**Solution A: Event files have incorrect status values**
```bash
# Find events with invalid status values
for f in /home/hamr/PycharmProjects/gitdone/data/events/*.json; do
  grep -H '"status"\s*:\s*"[^"]*"' "$f" | grep -v '"completed"\|"pending"'
done
# If found: update status to either "completed" or "pending"
```

**Solution B: Stats.json is stale cache**
```bash
# Force recalculation
curl -X POST http://localhost:3001/api/stats/refresh

# Verify new results
cat /home/hamr/PycharmProjects/gitdone/data/stats.json | jq .current_metrics
```

**Solution C: Corrupted or incomplete event files**
```bash
# Validate all event JSON files
cd /home/hamr/PycharmProjects/gitdone/data/events/
for f in *.json; do
  if ! jq empty "$f" 2>/dev/null; then
    echo "Corrupt file: $f"
  fi
done

# Remove or fix corrupt files
# Then manual refresh:
curl -X POST http://localhost:3001/api/stats/refresh
```

**Solution D: Bug in aggregation logic**
```bash
# If metrics consistently wrong despite valid event files:
# 1. Check statsAggregator.js implementation
cat /home/hamr/PycharmProjects/gitdone/backend/utils/statsAggregator.js | head -50

# 2. Run unit tests to verify logic
cd /home/hamr/PycharmProjects/gitdone/backend
npm test -- statsAggregator.test.js

# 3. If tests fail: investigate test output for logic error
# 4. If tests pass but production wrong:
#    - Event files in production may differ from test fixtures
#    - Debug with sample production event files
```

---

### Issue 5: Monthly Record Not Created

**Symptoms**:
- `monthly_records` array in stats.json is empty
- Expected: New record at end of each month
- Landing page doesn't show monthly history

**Diagnosis Steps**:

1. Check current date
   ```bash
   date -u
   # Monthly records only created at month transition (e.g., Nov 30 → Dec 1)
   ```

2. Check monthly_records in stats.json
   ```bash
   cat /home/hamr/PycharmProjects/gitdone/data/stats.json | jq .monthly_records
   # If empty: may be normal if not yet hit month end
   ```

3. Check stats.json creation date
   ```bash
   stat /home/hamr/PycharmProjects/gitdone/data/stats.json | grep -i modify
   # If file created after month boundary: check why record wasn't created
   ```

4. Check aggregator logs
   ```bash
   grep "monthly\|month" /path/to/backend/logs/server.log
   # Look for debug output about month record creation
   ```

**Solutions** (in order of likelihood):

**Solution A: Feature deployed before month end**
```bash
# Monthly records only created when transitioning to new month
# If deployed mid-month: wait until last day of month → first day of next month
# Scheduler will create record automatically

# No action needed - monitor for creation at month end
```

**Solution B: Aggregation failed at month boundary**
```bash
# Check logs around month boundary dates
grep "2025-11-30\|2025-12-01" /path/to/backend/logs/server.log

# If errors found: see Issue 1 (scheduler not running) or Issue 3 (stats old)

# To manually create record (if missed):
curl -X POST http://localhost:3001/api/stats/refresh
# If logic correct, should create record on next successful aggregation
```

**Solution C: Monthly record logic bug**
```bash
# Check if aggregator has month logic implemented
grep -n "monthly\|month\|new Date" /home/hamr/PycharmProjects/gitdone/backend/utils/statsAggregator.js | head -20

# Run unit tests to verify logic
cd /home/hamr/PycharmProjects/gitdone/backend
npm test -- statsAggregator.test.js

# If test fails: debug monthly record creation logic
# If test passes: logic is correct, may just be timing issue
```

**Solution D: First deployment (no previous months)**
```bash
# If this is first deployment of the month: no record expected yet
# First month record created only when transitioning to next month

# Normal behavior - wait until month end or monitor future months
```

---

## Rollback Procedure

If the Event Aggregation Dashboard feature causes critical issues, follow this rollback procedure to quickly revert the deployment.

### Quick Rollback (< 5 minutes)

#### Option 1: Disable Frontend Display (Keep Backend Running)

If the issue is specific to the landing page display:

```bash
# 1. Edit frontend page.tsx
vi /home/hamr/PycharmProjects/gitdone/frontend/src/app/page.tsx

# 2. Comment out StatsTable import
// import StatsTable from '../components/StatsTable';

# 3. Comment out StatsTable rendering in JSX
// <StatsTable
//   loading={statsLoading}
//   error={statsError}
//   stats={stats}
// />

# 4. Comment out stats state/fetch logic (optional, won't hurt)
// const [statsLoading, setStatsLoading] = useState(false);
// const [statsError, setStatsError] = useState<string | null>(null);
// const [stats, setStats] = useState<any>(null);
// const fetchStats = async () => { ... };

# 5. Rebuild and restart frontend
cd /home/hamr/PycharmProjects/gitdone/frontend
npm run build
npm run start
# OR if using PM2:
pm2 restart gitdone-frontend

# 6. Verify landing page loads without errors
curl http://localhost:3000/

# Landing page will work normally, stats hidden
# Backend remains operational for manual /api/stats queries if needed
```

#### Option 2: Disable Scheduler (Keep Frontend Running)

If the scheduler is causing server issues:

```bash
# 1. Edit backend server.js
vi /home/hamr/PycharmProjects/gitdone/backend/server.js

# 2. Comment out scheduler startup
// const { startScheduler } = require('./utils/statsScheduler');
// Later in code:
// startScheduler();

# 3. Restart backend server
cd /home/hamr/PycharmProjects/gitdone/backend
npm start
# OR if using PM2:
pm2 restart gitdone-backend

# 4. Verify backend starts without errors
curl http://localhost:3001/api/health

# Server runs normally, scheduler disabled
# API endpoints still respond to manual queries
# Stats won't auto-refresh but won't cause issues
```

#### Option 3: Delete Corrupted Stats Cache

If stats.json is corrupted and breaking things:

```bash
# 1. Delete the stats cache file
rm /home/hamr/PycharmProjects/gitdone/data/stats.json

# 2. No restart needed - file will be recreated on next aggregation

# 3. Verify by checking file exists after next refresh (6 hour interval)
# OR manually trigger:
curl -X POST http://localhost:3001/api/stats/refresh

# Landing page will show "Statistics not yet available" until recreated
# But no errors or crashes
```

### Full Git Rollback (< 10 minutes)

If the entire feature needs to be rolled back:

```bash
# 1. Check current commit
git log -1 --oneline

# 2. Identify the commit before feature deployment
git log --oneline | head -10
# Find last good commit (e.g., "26e3164 major fixed and UI changes to gitdone")

# 3. Revert the feature commit(s)
# Option A: Revert to specific commit
git revert HEAD~N  # Replace N with number of commits to revert
# OR
git reset --hard <commit-hash>

# Option B: Create new revert commit (safer)
git revert --no-edit <feature-commit-hash>

# 4. Push to remote (if needed for shared deployment)
git push origin main

# 5. Restart services
cd /home/hamr/PycharmProjects/gitdone/backend
npm install  # In case dependencies changed
npm start

cd /home/hamr/PycharmProjects/gitdone/frontend
npm install
npm run build
npm run start

# OR using PM2:
pm2 restart all

# 6. Verify rollback successful
curl http://localhost:3001/api/health
curl http://localhost:3000/
# Both should respond normally, stats feature removed
```

### Post-Rollback Steps

After executing rollback:

1. **Verify System Stability**
   ```bash
   # Monitor logs for 10 minutes
   tail -f /path/to/backend/logs/server.log
   # Should show normal operation, no errors
   ```

2. **Notify Team**
   - Message: "Event Aggregation Dashboard feature has been rolled back due to [issue]"
   - Include: Reason, rollback method used, expected impact (none for users)
   - Include: Timeline to re-deploy (after fix is ready)

3. **Document Issue**
   - Create a bug ticket with: Symptoms, reproduction steps, affected systems
   - Assign to engineering team for root cause analysis
   - Tag: "critical" if caused outage, "medium" if caused degradation

4. **Investigation**
   - Do NOT re-deploy until root cause identified and fixed
   - Review deployment checklist - was an item missed?
   - Check test coverage - did tests catch the issue?
   - If issue was not caught by existing tests: add test case to prevent regression

### Rollback Decision Matrix

| Situation | Action | Timeline |
|-----------|--------|----------|
| Landing page won't load | Option 1 (disable frontend display) | Immediate |
| Server crashes on startup | Option 2 (disable scheduler) | Immediate |
| Stats API always errors | Option 3 (delete stats cache) | Try first, then Option 2/1 |
| Multiple severe issues | Option 3 (full git rollback) | 5 minutes |
| Intermittent issues | Monitor for patterns, document, fix in next release | No immediate rollback |

---

## Performance Baseline Documentation

Establish performance baselines for the Event Aggregation Dashboard feature to detect regressions and plan capacity.

### Baseline Aggregation Time

**Condition**: Baseline measured with N event files in `/data/events/`

| Event Count | Aggregation Time | Environment | Measured Date |
|-------------|-----------------|-------------|--------------|
| 0 events | ~50ms | Local dev machine | 2025-12-19 |
| 10 events | ~75ms | Local dev machine | 2025-12-19 |
| 50 events | ~150ms | Local dev machine | 2025-12-19 |
| 100 events | ~250ms | Local dev machine | 2025-12-19 |
| 500 events | ~800ms | Local dev machine | 2025-12-19 |
| 1000 events | ~2000ms | Local dev machine | 2025-12-19 |

**How to Measure**:
```bash
# 1. Create test event files (if needed)
# Place sample event JSON files in /data/events/

# 2. Trigger aggregation and measure
curl -X POST http://localhost:3001/api/stats/refresh

# 3. Check duration in response
curl -s -X POST http://localhost:3001/api/stats/refresh | jq .refresh_duration_ms

# 4. Record result
echo "Event count: $(ls /data/events/ | wc -l)"
echo "Duration: X ms"
```

**Target Performance**:
- < 5000ms (5 seconds) for any reasonable event count
- If aggregation time > 5s: file I/O bottleneck, may need optimization

**When to Re-Baseline**:
- After major code changes to statsAggregator.js
- After significant increase in typical event count (e.g., 10x growth)
- Annual performance review

### Baseline API Response Times

**GET /api/stats Endpoint**

| Scenario | Response Time | Notes |
|----------|---------------|-------|
| Cached stats (file exists) | 10-50ms | Reading JSON from disk |
| First run (file missing) | 50-100ms | Fallback response |
| Under load (100 concurrent requests) | 100-200ms | Disk caching may help |

**How to Measure**:
```bash
# Simple timing
time curl -s http://localhost:3001/api/stats > /dev/null

# More precise with curl timing breakdowns
curl -w "Total: %{time_total}s\nConnect: %{time_connect}s\nTransfer: %{time_starttransfer}s\n" \
  -o /dev/null -s http://localhost:3001/api/stats

# Load test (requires ab or similar)
ab -n 100 -c 10 http://localhost:3001/api/stats
```

**Target**: < 100ms for normal operation

---

**POST /api/stats/refresh Endpoint**

| Scenario | Response Time | Notes |
|----------|---------------|-------|
| Normal aggregation (< 1000 events) | 500-3000ms | Includes event file scanning |
| Large event set (1000+ events) | 3000-5000ms | Expected upper bound |
| Under peak load | 5000-10000ms | Acceptable if infrequent |

**How to Measure**:
```bash
# Simple timing
time curl -s -X POST http://localhost:3001/api/stats/refresh > /dev/null

# Response includes duration
curl -s -X POST http://localhost:3001/api/stats/refresh | jq .refresh_duration_ms
```

**Target**: < 10 seconds for any event count

---

### Baseline Landing Page Load Time

**Condition**: Full page load time including stats fetch

| Metric | Target | Measured | Status |
|--------|--------|----------|--------|
| HTML transfer | < 500ms | TBD | - |
| Stats API fetch | < 100ms | TBD | - |
| JavaScript load | < 1000ms | TBD | - |
| Total page interactive | < 2000ms | TBD | - |

**How to Measure**:
1. Open DevTools (F12)
2. Network tab
3. Hard refresh (Ctrl+Shift+R)
4. Check "Finish" time in bottom bar
5. Record: "DOMContentLoaded", "Load", and individual request times

**Baseline Measurements** (to be filled in after first production deployment):

```
Date: 2025-12-19
Environment: Production (or staging)
Browser: Chrome
Connection: Fast 3G (simulated)

DOMContentLoaded: X ms
Page Load: X ms
/api/stats request: X ms
StatsTable render: X ms (time between request completion and visual appearance)

Observations: [describe any slow items]
```

**Targets**:
- HTML + CSS + JS: < 1500ms
- API fetch: < 100ms
- Total interactive: < 2000ms

**Regression Detection**:
- If future measurements > 20% above baseline: investigate
- If > 50% above baseline: performance issue, prioritize fix

---

### Capacity Planning Baseline

**Growth Projections**:
- Track total event count over time
- Current: ~50 events (as of 2025-12-19)
- Track aggregation time as event count grows

**Metrics to Monitor**:
1. Daily event creation rate
2. Average event file size (bytes)
3. Total data/events directory size (GB)
4. Monthly record count (growing 1 per month)

**Capacity Alert Thresholds**:
- Event count > 10,000: May need pagination or database
- Aggregation time > 5s consistently: Performance optimization needed
- /data/ directory > 10GB: Archive or compress old events
- API response time trending upward: Caching strategy needed

**Example Monitoring** (to set up post-deployment):

```
Month | Event Count | Aggregation Time | API Response | Status
------|-------------|------------------|--------------|--------
Dec   | 50          | 250ms            | 75ms         | Baseline
Jan   | 120         | 450ms            | 85ms         | +140% events, +80% time
Feb   | 280         | 950ms            | 100ms        | +133% events, +111% time
...   | ...         | ...              | ...          | Monitor for exponential growth
```

If growth is exponential, plan optimization work (database migration, caching layer, etc.) for next quarter.

---

## Appendix: Quick Reference

### Common Commands

```bash
# Check scheduler status
tail -20 /path/to/backend/logs/server.log | grep "Stats"

# Manual aggregation
curl -X POST http://localhost:3001/api/stats/refresh

# View current stats
curl http://localhost:3001/api/stats | jq .

# Check stats file directly
cat /home/hamr/PycharmProjects/gitdone/data/stats.json | jq .

# Count events
ls /home/hamr/PycharmProjects/gitdone/data/events/ | wc -l

# Validate JSON
jq empty /home/hamr/PycharmProjects/gitdone/data/stats.json && echo "Valid"

# Restart services
pm2 restart gitdone-backend gitdone-frontend
# OR
cd backend && npm start &
cd frontend && npm run start &
```

### Useful Grep Patterns

```bash
# Find scheduler logs
grep "\[Stats Scheduler\]" /path/to/server.log

# Find all errors
grep -i error /path/to/server.log | grep -i "stats\|aggregat"

# Count scheduler runs in last 24h
grep "Aggregation completed" /path/to/server.log | wc -l
```

### File Locations Reference

```
Code:
- /home/hamr/PycharmProjects/gitdone/backend/utils/statsAggregator.js
- /home/hamr/PycharmProjects/gitdone/backend/utils/statsScheduler.js
- /home/hamr/PycharmProjects/gitdone/backend/routes/stats.js
- /home/hamr/PycharmProjects/gitdone/frontend/src/components/StatsTable.tsx
- /home/hamr/PycharmProjects/gitdone/frontend/src/app/page.tsx

Data:
- /home/hamr/PycharmProjects/gitdone/data/stats.json (cache, not committed)
- /home/hamr/PycharmProjects/gitdone/data/events/ (event files, committed)

Logs (if configured):
- /home/hamr/PycharmProjects/gitdone/logs/server.log
- /home/hamr/PycharmProjects/gitdone/logs/frontend.log
```

---

**Document End**

For questions or updates to this guide, create a ticket or comment in the project repository.
