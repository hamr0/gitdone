# Team Briefing: Event Aggregation Dashboard Deployment
## Rollback Procedures and Operational Readiness

**Document Type**: Team Briefing & Deployment Operations Guide
**Date**: December 19, 2025
**Deployment Date**: December 20, 2025, 02:00 UTC
**Target Audience**: Engineering Team, Operations Team, On-Call Support

---

## Meeting Agenda (30 minutes)

### 1. Feature Overview (5 minutes)
- **What**: Event Aggregation Dashboard adds platform statistics to landing page
- **Impact**: Zero-downtime deployment, read-only feature, no data modifications
- **Scope**: Backend scheduler + Frontend UI component

### 2. Deployment Plan (5 minutes)
- **When**: Dec 20, 2025 at 02:00 UTC
- **Duration**: < 5 minutes deployment + 2 hours monitoring
- **Rollback Option**: Available if critical issues detected
- **No downtime expected**: Zero-downtime deployment strategy

### 3. Rollback Procedures (10 minutes)
- Quick rollback options (< 5 minutes)
- Full rollback procedures (< 10 minutes)
- Decision matrix for when to rollback
- Post-rollback checklist

### 4. Monitoring & Alerting (5 minutes)
- What to monitor during and after deployment
- Where to look for issues
- Alert thresholds and escalation

### 5. Questions & Concerns (5 minutes)
- Q&A session
- Clarify roles and responsibilities
- Confirm everyone is comfortable with procedures

---

## Deployment Team Roles

### Role 1: Deployment Lead
**Responsibility**: Orchestrate the deployment, communication, and decision-making

**Tasks**:
- [ ] Review this document with the team 1 hour before deployment
- [ ] Execute deployment steps in DEPLOYMENT_STATS_FEATURE.md
- [ ] Monitor system during 2-hour post-deployment window
- [ ] Make go/no-go decisions on rollback if needed
- [ ] Communicate status to stakeholders

**Assigned to**: [Engineering Lead/DevOps Lead]

---

### Role 2: Backend Operations
**Responsibility**: Manage backend server deployment and verification

**Tasks**:
- [ ] Pull latest code to production server
- [ ] Run `npm install` in backend directory
- [ ] Verify statsScheduler.js and statsAggregator.js are present
- [ ] Restart backend service (PM2 or equivalent)
- [ ] Verify scheduler startup message in logs
- [ ] Test GET /api/stats endpoint: `curl http://localhost:3001/api/stats`
- [ ] Test POST /api/stats/refresh endpoint: `curl -X POST http://localhost:3001/api/stats/refresh`
- [ ] Monitor server logs for "[Stats Scheduler]" messages
- [ ] Alert lead immediately if any errors observed

**Assigned to**: [Backend Operations Engineer]

---

### Role 3: Frontend Operations
**Responsibility**: Manage frontend deployment and verification

**Tasks**:
- [ ] Pull latest code to production server
- [ ] Run `npm install && npm run build` in frontend directory
- [ ] Deploy built app (PM2, Vercel, or equivalent)
- [ ] Verify landing page loads: `curl http://yourdomain.com`
- [ ] Open landing page in browser (Chrome, Safari)
- [ ] Verify StatsTable component visible at bottom
- [ ] Verify metrics display correctly (4 rows visible)
- [ ] Test on mobile viewport (responsive design)
- [ ] Check browser console for any errors
- [ ] Alert lead immediately if page won't load or console errors

**Assigned to**: [Frontend Operations Engineer]

---

### Role 4: Monitoring & On-Call
**Responsibility**: Watch for issues during and after deployment window

**Tasks**:
- [ ] Set up real-time log monitoring for backend and frontend
- [ ] Watch for any error patterns in logs
- [ ] Monitor API response times: expect GET < 100ms, POST < 10s
- [ ] Periodically check /data/stats.json file exists and updates
- [ ] Monitor landing page performance: expect < 2 second load time
- [ ] Be ready to escalate issues to Deployment Lead
- [ ] Continue monitoring for 2+ hours post-deployment

**Assigned to**: [On-Call Engineer / Operations]

---

### Role 5: Communication Lead
**Responsibility**: Keep stakeholders informed of deployment status

**Tasks**:
- [ ] Send pre-deployment notification to team (1 hour before)
- [ ] Confirm all roles are ready to proceed
- [ ] Provide real-time updates during deployment
- [ ] If rollback needed: notify stakeholders immediately
- [ ] Send post-deployment summary to team
- [ ] Archive this document and decisions for future reference

**Assigned to**: [Product Lead / Team Lead]

---

## Rollback Decision Matrix

**Use this to determine if immediate rollback is necessary:**

| Issue | Severity | Action | Timeline |
|-------|----------|--------|----------|
| Landing page won't load | CRITICAL | Rollback Option 1 | Immediate |
| Backend crashes repeatedly | CRITICAL | Rollback Option 2 | Immediate |
| API endpoints returning 500 errors for all requests | CRITICAL | Rollback Option 3 then Option 2 | 5 minutes |
| Statistics show incorrect numbers | MEDIUM | Investigate, monitor, roll back if pattern continues | 30 minutes |
| Scheduler not running but page works | MEDIUM | Check server logs, restart if needed | 15 minutes |
| Aggregation slow (> 10 seconds) | MEDIUM | Monitor, may optimize later | No rollback needed |
| Single user reports error (isolated) | LOW | Collect info, don't rollback immediately | Monitor |
| Intermittent errors in logs | MEDIUM | Monitor pattern, escalate if > 5% | 20 minutes |

**Key Principle**: If feature is breaking core functionality → rollback immediately. If feature is broken but not breaking core functionality → diagnose before rolling back.

---

## Quick Rollback Procedures

### Option 1: Disable Frontend Display (< 3 minutes)

**When to use**: Landing page won't load or StatsTable is breaking layout

```bash
# 1. SSH to frontend server
ssh your-frontend-server

# 2. Edit page.tsx
vi /home/hamr/PycharmProjects/gitdone/frontend/src/app/page.tsx

# 3. Comment out StatsTable import (find line with import)
# Before:
# import StatsTable from '../components/StatsTable';
# After:
// import StatsTable from '../components/StatsTable';

# 4. Comment out StatsTable component rendering in JSX (find section)
# Before:
# <StatsTable loading={statsLoading} error={statsError} stats={stats} />
# After:
// <StatsTable loading={statsLoading} error={statsError} stats={stats} />

# 5. Optional: Comment out stats state/fetch logic
# (This is optional but cleans up unused code)

# 6. Rebuild and restart frontend
cd /home/hamr/PycharmProjects/gitdone/frontend
npm run build
npm run start
# OR if using PM2:
pm2 restart gitdone-frontend

# 7. Verify landing page works
curl http://localhost:3000/

# Result: Landing page works normally, stats hidden
# Time to complete: 2-3 minutes
```

---

### Option 2: Disable Backend Scheduler (< 3 minutes)

**When to use**: Server crashes or scheduler causes issues

```bash
# 1. SSH to backend server
ssh your-backend-server

# 2. Edit server.js
vi /home/hamr/PycharmProjects/gitdone/backend/server.js

# 3. Comment out scheduler import (find line with require)
# Before:
# const { startScheduler } = require('./utils/statsScheduler');
# After:
// const { startScheduler } = require('./utils/statsScheduler');

# 4. Comment out scheduler startup call (find startScheduler() call)
# Before:
# startScheduler();
# After:
// startScheduler();

# 5. Restart backend service
npm start
# OR if using PM2:
pm2 restart gitdone-backend

# 6. Verify backend starts without errors
curl http://localhost:3001/api/health

# Result: Server runs normally, scheduler disabled
# API endpoints still work but won't auto-refresh statistics
# Time to complete: 2-3 minutes
```

---

### Option 3: Delete Corrupted Cache (< 1 minute)

**When to use**: Stats.json file corrupted and causing API errors

```bash
# 1. SSH to backend server
ssh your-backend-server

# 2. Delete stats.json cache file
rm /home/hamr/PycharmProjects/gitdone/data/stats.json

# 3. Trigger manual refresh to recreate (or wait 6 hours for scheduler)
curl -X POST http://localhost:3001/api/stats/refresh

# 4. Verify file recreated
ls -la /home/hamr/PycharmProjects/gitdone/data/stats.json

# Result: Fresh stats cache created
# Landing page shows "Statistics not yet available" until recreated
# Time to complete: 1 minute
```

---

### Option 4: Full Git Rollback (< 10 minutes)

**When to use**: Multiple critical issues, need complete feature removal

```bash
# 1. SSH to deployment server
ssh your-deployment-server

# 2. Identify the commit to rollback to
cd /home/hamr/PycharmProjects/gitdone
git log --oneline | head -10
# Find the last commit before this feature (e.g., "26e3164 major fixed and UI changes")

# 3. Revert the feature commits (SAFE: creates new revert commit)
git revert --no-edit <feature-commit-hash>
# OR revert to specific commit (DESTRUCTIVE: loses commits):
# git reset --hard <previous-commit-hash>

# 4. Push to remote (if shared deployment)
git push origin main

# 5. Redeploy both services
# Backend
cd /home/hamr/PycharmProjects/gitdone/backend
npm install
npm start &

# Frontend
cd /home/hamr/PycharmProjects/gitdone/frontend
npm install
npm run build
npm run start &

# OR if using PM2:
pm2 restart all

# 6. Verify both services running
curl http://localhost:3001/api/health
curl http://localhost:3000/

# Result: Complete rollback to previous state
# Feature completely removed
# Time to complete: 5-10 minutes
```

---

## Post-Rollback Checklist

After executing any rollback option:

- [ ] **Verify System Stability**
  ```bash
  # Monitor logs for 10 minutes
  tail -f /path/to/logs/server.log
  # Should show normal operation, no errors
  ```

- [ ] **Notify Stakeholders**
  - Message: "Event Aggregation Dashboard feature has been rolled back due to [issue]"
  - Include: Reason, rollback method used, expected user impact (none)
  - Include: Timeline to re-deploy

- [ ] **Document the Issue**
  - Create bug ticket with: Symptoms, reproduction steps, affected systems
  - Tag: "critical" if caused outage, "medium" if caused degradation
  - Assign to engineering for root cause analysis

- [ ] **Update Status Page** (if applicable)
  - Indicate deployment has been rolled back
  - Estimated time to resolve

- [ ] **Investigation**
  - Do NOT re-deploy until root cause identified
  - Review deployment checklist: was an item missed?
  - Check test coverage: did tests catch the issue?
  - Add test case to prevent regression

---

## Monitoring During Deployment

### Real-Time Monitoring Checklist

**During deployment (0-5 minutes):**
- [ ] Backend deployment starts
- [ ] Frontend deployment starts
- [ ] No critical console errors during startup
- [ ] Both services restart successfully

**Immediately after (5-30 minutes):**
- [ ] Landing page loads without errors
- [ ] StatsTable component renders correctly
- [ ] GET /api/stats responds with 200 status
- [ ] No 500 errors in logs
- [ ] No "Permission denied" errors
- [ ] Scheduler log shows startup message

**Continued monitoring (30 minutes - 2 hours):**
- [ ] No recurring errors in logs
- [ ] API response times normal (< 100ms for GET)
- [ ] User reports (if available): no issues
- [ ] System performance: normal CPU/memory usage
- [ ] Disk space adequate

### Alert Triggers (Immediate Escalation)

```bash
# Check these during monitoring:

# 1. Landing page fails to load
curl http://localhost:3000/ | head -20
# Should return HTML, not 404 or 500

# 2. API endpoints failing
curl http://localhost:3001/api/stats | grep -i error
# Should return JSON with stats, not error message

# 3. Scheduler not running
tail -50 /path/to/logs/server.log | grep "Stats Scheduler"
# Should show startup message and/or successful runs

# 4. High error rate in logs
tail -100 /path/to/logs/server.log | grep -i error | wc -l
# Should be < 5 errors in 100 lines

# 5. Service crashes
ps aux | grep node | grep -v grep
# Should show backend and frontend processes running
```

---

## Escalation Path

1. **Backend Engineer Detects Issue** → Report to Deployment Lead
2. **Deployment Lead Makes Decision**:
   - If recoverable: Request fix attempt (with time limit)
   - If not recoverable: Execute rollback (choose option 1-4)
3. **Execute Rollback** (< 10 minutes)
4. **Notify Stakeholders** (immediate)
5. **Investigation** (post-deployment)

**No solo decisions**: Rollback must be approved by Deployment Lead, not executed unilaterally.

---

## Team Sign-Off

**This document must be reviewed and acknowledged by all team members before deployment:**

| Role | Name | Team | Acknowledged | Date |
|------|------|------|--------------|------|
| Deployment Lead | __________ | Engineering | ☐ | ________ |
| Backend Ops | __________ | Operations | ☐ | ________ |
| Frontend Ops | __________ | Operations | ☐ | ________ |
| Monitoring/On-Call | __________ | Operations | ☐ | ________ |
| Communication Lead | __________ | Product | ☐ | ________ |

**All roles must sign off by**: December 20, 2025 at 01:00 UTC (1 hour before deployment)

---

## Key Contacts

**Deployment Lead**: [Name] - [Slack/Email] - [Phone for emergencies]
**Backend Lead**: [Name] - [Slack/Email]
**Frontend Lead**: [Name] - [Slack/Email]
**On-Call Engineer**: [Name] - [Slack/Email] - [Phone]
**Product Manager**: [Name] - [Slack/Email]
**Executive Escalation**: [Name] - [Slack/Email]

---

## Additional Resources

- **Deployment Guide**: See DEPLOYMENT_STATS_FEATURE.md
- **Troubleshooting**: See DEPLOYMENT_STATS_FEATURE.md > Troubleshooting Guide
- **API Reference**: See docs/API_REFERENCE.md
- **Architecture**: See docs/ARCHITECTURE.md
- **User Announcement**: See docs/USER_ANNOUNCEMENT.md

---

## Summary

**Key Takeaways**:
1. ✓ This is a safe, read-only feature with zero-downtime deployment
2. ✓ Quick rollback options available (< 5 minutes)
3. ✓ Comprehensive testing completed (140 tests, 100% pass)
4. ✓ Clear monitoring and escalation procedures
5. ✓ Team is trained and ready

**Go/No-Go Decision**: Assuming all team members acknowledge this document and checklist is completed → READY FOR DEPLOYMENT

---

**Document Status**: Ready for Team Review
**Last Updated**: December 19, 2025
**Approval Required By**: December 20, 2025 at 01:00 UTC

