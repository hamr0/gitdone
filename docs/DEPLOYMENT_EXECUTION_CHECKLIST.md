# Production Deployment Execution Checklist
## Event Aggregation Dashboard Feature

**Deployment Date**: December 20, 2025
**Deployment Time**: 02:00 UTC
**Estimated Duration**: 5 minutes deployment + 2 hours monitoring
**Status**: [UPDATE AS YOU PROGRESS]

---

## Pre-Deployment (1 hour before)

### 30 Minutes Before Deployment

- [ ] **Communication**: Send pre-deployment notification to team
  ```
  Subject: Deploying Event Aggregation Dashboard in 30 minutes

  Team, we're deploying the Event Aggregation Dashboard feature at 02:00 UTC.
  Expected duration: < 5 minutes
  Rollback plan: Available if critical issues detected

  All hands on deck. Deployment lead: [Name]
  ```

- [ ] **Pre-Flight Checks**: Deployment lead verifies
  - [ ] All team members acknowledged briefing document
  - [ ] Each team member confirmed their role and ready
  - [ ] Backend operations team logged into production server
  - [ ] Frontend operations team logged into production server
  - [ ] Monitoring systems running (logs, APM, uptime monitors)
  - [ ] Incident response team on standby

### 10 Minutes Before Deployment

- [ ] **Final System Check**
  ```bash
  # Backend readiness
  ssh your-backend-server
  ps aux | grep "node.*server.js"  # Should show running process
  curl http://localhost:3001/api/health  # Should return 200

  # Frontend readiness
  ssh your-frontend-server
  ps aux | grep "node.*next"  # Should show running process
  curl http://localhost:3000/  | head -5  # Should return HTML
  ```

- [ ] **Confirm Backup/Rollback Capability**
  - [ ] Previous code version accessible (git, backup)
  - [ ] Database backups current (if applicable)
  - [ ] Rollback scripts tested and ready

- [ ] **Deployment Lead Final Confirmation**
  - [ ] Review all checklist items completed
  - [ ] Confirm all team members ready
  - [ ] Take a screenshot of current system state (for comparison post-deploy)
  - [ ] **Decision**: Go/No-Go for deployment

---

## Deployment Execution (0-5 minutes)

### Minute 0-1: Code Deployment

**Backend Operations**:
```bash
# 1. Verify current state
cd /home/hamr/PycharmProjects/gitdone
git status
# Expected: "On branch main" with no uncommitted changes

# 2. Pull latest code
git fetch origin
git pull origin main
# Expected: "Already up to date." or "Fast-forward [commits]"

# 3. Verify files deployed
ls -la backend/utils/statsAggregator.js
ls -la backend/utils/statsScheduler.js
ls -la backend/routes/stats.js
# All should exist and be non-empty
```

**Frontend Operations**:
```bash
# 1. Pull latest code (parallel with backend)
cd /home/hamr/PycharmProjects/gitdone
git fetch origin
git pull origin main

# 2. Verify files deployed
ls -la frontend/src/components/StatsTable.tsx
ls -la frontend/src/app/page.tsx
# Both should exist
```

**Checklist**:
- [ ] Backend code pulled successfully
- [ ] Frontend code pulled successfully
- [ ] No git conflicts
- [ ] No uncommitted changes

---

### Minute 1-2: Dependency Installation & Build

**Backend Operations**:
```bash
# 1. Install dependencies
cd /home/hamr/PycharmProjects/gitdone/backend
npm install
# Expected: "added 0 packages" (already installed) or "up to date"

# 2. Verify node-cron installed
npm ls node-cron
# Expected: node-cron@3.0.0 (or similar)

# 3. Check for any obvious syntax errors
node -c server.js
# Expected: No output (success)
```

**Frontend Operations**:
```bash
# 1. Install dependencies (if not already done)
cd /home/hamr/PycharmProjects/gitdone/frontend
npm install

# 2. Build frontend
npm run build
# Expected: "next build" completes successfully
# Look for: "Compiled successfully" message
# Should complete in < 60 seconds

# Check for build errors
if [ $? -ne 0 ]; then
  echo "Build failed! Immediate rollback needed."
  # Execute Rollback Option 4 (Full git rollback)
fi
```

**Checklist**:
- [ ] Backend npm install completed
- [ ] Frontend npm install completed
- [ ] Frontend build completed successfully
- [ ] No syntax errors detected
- [ ] Build artifacts generated

---

### Minute 2-3: Service Restart

**Backend Operations**:
```bash
# 1. Stop current backend service
npm stop
# OR if using PM2:
pm2 stop gitdone-backend

# 2. Restart backend service
npm start
# OR if using PM2:
pm2 start backend/server.js --name gitdone-backend

# 3. Wait for startup (5 seconds)
sleep 5

# 4. Check for scheduler startup message in logs
tail -20 /path/to/logs/server.log | grep "Stats Scheduler"
# Expected output: "[Stats Scheduler] Started—running every 6 hours at 00:00, 06:00, 12:00, 18:00 UTC"

# If scheduler message NOT found:
# This is CRITICAL - execute Rollback Option 2
```

**Frontend Operations**:
```bash
# 1. Stop current frontend service
npm stop
# OR if using PM2:
pm2 stop gitdone-frontend

# 2. Restart frontend service
npm start  # Runs production server
# OR if using PM2:
pm2 start frontend/next.js --name gitdone-frontend

# 3. Wait for startup (5 seconds)
sleep 5

# 4. Check if listening on correct port
netstat -tlnp | grep 3000
# Expected: Node process listening on port 3000
```

**Checklist**:
- [ ] Backend service stopped cleanly
- [ ] Frontend service stopped cleanly
- [ ] Backend service started successfully
- [ ] Frontend service started successfully
- [ ] Scheduler startup message visible in logs
- [ ] Both services running (ps aux shows processes)

---

### Minute 3-5: Verification

**Backend Operations**:
```bash
# 1. Test GET /api/stats endpoint
curl -X GET http://localhost:3001/api/stats
# Expected: HTTP 200
# Expected response: { "success": true, "current_metrics": { ... }, "last_updated": "...", "monthly_records": [] }

# 2. Test POST /api/stats/refresh endpoint
curl -X POST http://localhost:3001/api/stats/refresh
# Expected: HTTP 200
# Expected response: { "success": true, "message": "...", "refresh_duration_ms": XXX, ... }

# 3. Verify stats.json file exists and is valid
cat /home/hamr/PycharmProjects/gitdone/data/stats.json | jq .
# Expected: Valid JSON with current metrics

# Store baseline response time
BASELINE_GET=$(time curl -s http://localhost:3001/api/stats > /dev/null 2>&1)
BASELINE_POST=$(time curl -s -X POST http://localhost:3001/api/stats/refresh > /dev/null 2>&1)
echo "GET baseline: $BASELINE_GET"
echo "POST baseline: $BASELINE_POST"
```

**Frontend Operations**:
```bash
# 1. Test landing page loads
curl -I http://localhost:3000/
# Expected: HTTP 200
# Expected: "Content-Type: text/html"

# 2. Check for StatsTable component in HTML
curl -s http://localhost:3000/ | grep -i "platform statistics\|statstable\|total events"
# Expected: Some indication that stats section is present

# 3. Open in browser and verify visually
open http://localhost:3000/  # macOS
# OR
xdg-open http://localhost:3000/  # Linux
# OR
# Manual check: Open browser and navigate to landing page

# Visual verification:
# [ ] Landing page loads without errors
# [ ] No red error messages
# [ ] "Platform Statistics" section visible at bottom
# [ ] Table has 4 metric rows
# [ ] Numbers are displayed (not "undefined" or errors)
# [ ] "Last updated" timestamp visible
# [ ] Responsive: works on mobile/tablet/desktop viewports
```

**Deployment Lead**:
```bash
# 1. Collect all verification results
echo "Deployment Verification Summary" > /tmp/deployment_summary.txt
echo "================================" >> /tmp/deployment_summary.txt
echo "Time: $(date -u)" >> /tmp/deployment_summary.txt
echo "" >> /tmp/deployment_summary.txt
echo "GET /api/stats: [PASS/FAIL]" >> /tmp/deployment_summary.txt
echo "POST /api/stats/refresh: [PASS/FAIL]" >> /tmp/deployment_summary.txt
echo "Landing page loads: [PASS/FAIL]" >> /tmp/deployment_summary.txt
echo "StatsTable visible: [PASS/FAIL]" >> /tmp/deployment_summary.txt
echo "No console errors: [PASS/FAIL]" >> /tmp/deployment_summary.txt
```

**Checklist**:
- [ ] GET /api/stats returns HTTP 200
- [ ] POST /api/stats/refresh returns HTTP 200
- [ ] stats.json file exists and is valid JSON
- [ ] Landing page loads (HTTP 200)
- [ ] StatsTable component visible
- [ ] All 4 metrics showing (not errors)
- [ ] Timestamp displays correctly
- [ ] Mobile responsive works
- [ ] Browser console shows no critical errors
- [ ] Response times are acceptable (< baseline + 10%)

---

## Post-Deployment Monitoring (5 minutes - 2+ hours)

### Immediate Post-Deployment (5-15 minutes)

**Monitoring Lead**:
```bash
# 1. Real-time log monitoring
tail -f /path/to/logs/server.log | grep -E "Stats|error|Error"

# 2. Check for errors in logs
tail -50 /path/to/logs/server.log | grep -i error
# Should be minimal (expected: 0-2 errors from test scenarios)

# 3. Monitor system resources
top
# Expected: CPU < 30%, Memory < 60%, No processes at 100%

# 4. Check disk space
df -h /home/hamr/PycharmProjects/gitdone/
# Expected: > 10% free space
```

**Checklist** (every 5 minutes for first 15 minutes):
- [ ] No critical errors in logs
- [ ] No repeated error patterns
- [ ] System resources normal (CPU, memory)
- [ ] Both services still running (ps aux)
- [ ] Landing page still loads
- [ ] API endpoints still respond

### Early Monitoring (15 minutes - 1 hour)

**Each Team Member** (10-minute intervals):

Backend Operations:
- [ ] Check scheduler logs: `tail -100 /logs | grep Stats`
- [ ] Verify GET endpoint responds: `curl /api/stats`
- [ ] Verify POST endpoint responds: `curl -X POST /api/stats/refresh`
- [ ] Monitor for performance regression

Frontend Operations:
- [ ] Load landing page in browser
- [ ] Check browser console (DevTools)
- [ ] Verify StatsTable renders correctly
- [ ] Test on different device sizes

Monitoring/On-Call:
- [ ] Watch logs for any errors
- [ ] Monitor API response times
- [ ] Check uptime monitoring (if configured)
- [ ] Note any user-reported issues

**Checklist**:
- [ ] 15 minutes: No critical issues
- [ ] 30 minutes: System stable
- [ ] 45 minutes: All systems normal
- [ ] 60 minutes: No error patterns, full green

### Extended Monitoring (1 - 2 hours)

**Continue standard checks**:
- [ ] Every 30 minutes: Full verification cycle
  - [ ] API endpoints respond correctly
  - [ ] Landing page loads
  - [ ] Browser console clean
  - [ ] Logs show no errors

- [ ] Watch for scheduler execution
  - If deployment is near 06:00 UTC: Monitor for first scheduled run
  - [ ] Verify scheduler runs on schedule
  - [ ] Verify logs show "Aggregation completed"
  - [ ] Verify stats.json updates

**Checklist**:
- [ ] 1 hour: System stable, ready to stand down to normal monitoring
- [ ] 2 hours: All systems fully operational
- [ ] 2+ hours: Switch to normal post-deployment monitoring

---

## Monitoring Dashboard (During 2-Hour Window)

**Track These Metrics**:

| Metric | Expected | Status | Notes |
|--------|----------|--------|-------|
| Landing page load time | < 2s | ☐ | Should include stats |
| GET /api/stats response | < 100ms | ☐ | Cached response |
| POST /api/stats/refresh | < 10s | ☐ | Aggregation time |
| Backend process running | Always | ☐ | Should not crash |
| Frontend process running | Always | ☐ | Should not crash |
| Error rate in logs | < 5 per hour | ☐ | Expected errors from testing |
| Scheduler startup message | Yes | ☐ | Should appear once on startup |
| System CPU usage | < 50% | ☐ | Sustained below peak |
| System memory | < 60% | ☐ | No memory leaks |
| Disk space | > 10% free | ☐ | Should not fill up |

---

## Decision Points

### 30 Minutes In: Go/No-Go Check

**Deployment Lead Reviews**:
- [ ] All basic verification passed?
- [ ] Any critical errors detected?
- [ ] System stable and responsive?

**Decision**:
- ☐ **GO**: Continue monitoring, looks good
- ☐ **MONITOR**: Some minor issues, continue watching
- ☐ **ROLLBACK**: Critical issues detected, execute rollback

If **ROLLBACK** decision: Go to Rollback Execution section

---

### 1 Hour In: Stability Check

**Deployment Lead Reviews**:
- [ ] Any patterns of errors or issues?
- [ ] Performance maintained?
- [ ] All team members reporting normal operation?

**Decision**:
- ☐ **CONTINUE**: All systems stable, good for next check
- ☐ **INVESTIGATE**: Some concerns, diagnose before standing down
- ☐ **ROLLBACK**: Issues not resolving, execute rollback

If **INVESTIGATE**: Troubleshoot using DEPLOYMENT_STATS_FEATURE.md > Troubleshooting

If **ROLLBACK**: Go to Rollback Execution section

---

### 2 Hours In: Full Stability Check

**Deployment Lead Reviews**:
- [ ] System stable for full 2-hour window?
- [ ] All metrics green?
- [ ] Ready to stand down and switch to normal monitoring?

**Decision**:
- ☐ **DECLARE SUCCESS**: Feature deployed successfully
- ☐ **EXTEND MONITORING**: Continue monitoring past 2 hours (unusual)
- ☐ **ROLLBACK**: Issues still present, final rollback decision

If **DECLARE SUCCESS**: Go to Success & Sign-Off section

If **ROLLBACK**: Go to Rollback Execution section

---

## Rollback Execution (If Needed)

If at any point a rollback is needed:

1. **Deployment Lead Makes Decision**
   - [ ] Confirmed with team that rollback is necessary
   - [ ] Chose appropriate rollback option (see TEAM_BRIEFING_ROLLBACK.md)
   - [ ] Documented decision reason

2. **Execute Rollback**
   - [ ] Chose rollback option: ☐ Option 1 ☐ Option 2 ☐ Option 3 ☐ Option 4
   - [ ] Followed steps from TEAM_BRIEFING_ROLLBACK.md
   - [ ] Verified rollback completed successfully
   - [ ] Verified system working post-rollback

3. **Notify Stakeholders**
   - [ ] Sent immediate notification: "Rollback executed due to [reason]"
   - [ ] Explained impact: "Users may have experienced [symptoms]"
   - [ ] Provided timeline: "System restored at [time]"

4. **Escalate & Document**
   - [ ] Created incident ticket with: Symptoms, timeline, root cause (if known)
   - [ ] Assigned to engineering for investigation
   - [ ] Set severity level: Critical/Medium/Low

---

## Success & Sign-Off

### Deployment Complete (After 2 Hours)

If all checks pass and system is stable:

1. **Deployment Lead Signs Off**
   ```bash
   echo "Deployment Summary" > /tmp/deployment_complete.txt
   echo "Feature: Event Aggregation Dashboard" >> /tmp/deployment_complete.txt
   echo "Date: $(date -u)" >> /tmp/deployment_complete.txt
   echo "Status: SUCCESSFUL" >> /tmp/deployment_complete.txt
   echo "Verified by: [Lead Name]" >> /tmp/deployment_complete.txt
   echo "Ready for production monitoring" >> /tmp/deployment_complete.txt
   ```

2. **Team Signs Off**
   - [ ] Backend Operations: ___________________  ________ (Signature, Date)
   - [ ] Frontend Operations: ___________________  ________ (Signature, Date)
   - [ ] Monitoring/On-Call: ___________________  ________ (Signature, Date)
   - [ ] Deployment Lead: ___________________  ________ (Signature, Date)

3. **Notify Stakeholders**
   ```
   Subject: Event Aggregation Dashboard Deployed Successfully

   The Event Aggregation Dashboard feature has been successfully deployed to production.

   - Deployment completed at [time] UTC
   - All verification checks passed
   - System stable for 2+ hours
   - Ready for normal monitoring

   Users will see new "Platform Statistics" section on landing page.
   Statistics update automatically every 6 hours.

   Next scheduled update: [time] UTC
   ```

4. **Switch to Normal Monitoring**
   - [ ] Stand down intensive 2-hour monitoring
   - [ ] Resume normal on-call monitoring (see DEPLOYMENT_STATS_FEATURE.md > Monitoring Guidelines)
   - [ ] Continue watching for the first 24 hours
   - [ ] Verify all 4 scheduled runs occur in first 24 hours

### Post-Deployment Tasks

- [ ] Archive this checklist and all logs
- [ ] Send deployment summary to team
- [ ] Schedule retrospective/lessons learned (if any issues)
- [ ] Update deployment documentation with any learnings
- [ ] Verify announcements were sent to users
- [ ] Close deployment ticket/issue

---

## Quick Reference: Emergency Contacts

**During Deployment**:
- **Deployment Lead**: [Name/Phone]
- **Backend Ops**: [Name/Phone]
- **Frontend Ops**: [Name/Phone]
- **On-Call**: [Name/Phone]

**For Rollback Decision**:
- **Engineering Lead**: [Name/Phone]
- **Product Lead**: [Name/Phone]

**For Escalation**:
- **Director/Manager**: [Name/Phone]
- **Incident Commander**: [Name/Phone]

---

## Appendix: Deployment Timeline

```
Dec 20, 2025

01:00 UTC - All team members on-call, briefing documents signed
01:30 UTC - Final pre-flight checks, deployment readiness confirmed
02:00 UTC - DEPLOYMENT START
  02:00 - Code deployment begins
  02:01 - Dependencies installed, builds complete
  02:02 - Services restarted
  02:03 - Initial verification (5 quick checks)
  02:05 - DEPLOYMENT COMPLETE
02:05-02:20 - Intensive monitoring (every 5 min checks)
02:20-03:05 - Active monitoring (every 10 min checks)
03:05-04:05 - Extended monitoring (every 30 min checks)
04:05+ - Normal monitoring, stand down from war room

Scheduled Scheduler Run: 06:00 UTC (verify first automated run works)

Post-Deployment:
- Monitoring continues for 24 hours (watch for all 4 scheduled runs)
- Weekly checks for first month
- Then: Normal production monitoring
```

---

**Document Status**: Ready for Execution
**Last Updated**: December 19, 2025
**Approval**: [Deployment Lead Signature]

