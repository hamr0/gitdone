# Product Requirements Document: Event Aggregation Dashboard

**Document Version**: 1.0
**Date Created**: December 19, 2025
**Status**: Ready for Development
**Owner**: Product Manager
**Target Release**: Next Sprint

---

## 1. Executive Summary

GitDone will add a public-facing event aggregation dashboard to the landing page that displays platform-wide statistics collected from all event JSON files. This lightweight feature provides transparency into platform activity and tracks cumulative metrics over time with monthly snapshots for analytics and reporting.

**Core Value**: Give users visibility into platform health and activity at a glance while maintaining a simple, performant architecture using JSON-based caching.

---

## 2. Feature Overview & Business Context

### Problem Statement
Currently, there is no visibility into overall platform usage metrics. Event planners cannot see aggregate statistics about how many total events have been created, how many steps are in the system, or how many events are fully completed. This limits platform transparency and prevents basic analytics.

### Goals
1. **Provide Platform Transparency**: Display real-time, aggregate statistics on the landing page for all visitors
2. **Track Historical Trends**: Maintain monthly snapshots of key metrics to build a historical record (up to 12 records per year for analytics)
3. **Support Future Analytics**: Create a foundation for future dashboards, reports, and performance tracking
4. **Maintain Simplicity**: Use lightweight JSON-based storage without introducing database complexity
5. **Ensure Performance**: Cache aggregated data to minimize file I/O and maintain fast landing page load times

### User Stories

**US1**: As a **platform visitor**, I want to see aggregate statistics on the landing page so that I can understand the scale and activity level of the platform.

**US2**: As a **product manager**, I want historical monthly snapshots of key metrics so that I can track platform growth trends over time.

**US3**: As a **system administrator**, I want the ability to manually refresh statistics so that I can verify data accuracy or force an update if needed.

**US4**: As a **platform user**, I want statistics to be updated regularly (every 6 hours) so that the displayed data remains reasonably current without impacting site performance.

---

## 3. Functional Requirements

### 3.1 Aggregation Logic

The system must calculate the following metrics from all event JSON files in `/data/events/`:

**Metric Definitions**:

| Metric | Definition | Calculation Method |
|--------|-----------|-------------------|
| **Total Events** | Count of all event JSON files | Count all `.json` files in `/data/events/` directory |
| **Total Steps** | Sum of all steps across all events | For each event, sum the length of `event.steps[]` array |
| **Completed Events** | Count of events where ALL steps have `status: "completed"` | For each event, check if every step in `event.steps[]` has `status === "completed"`. Count if true. |
| **Completed Steps** | Count of all steps with `status: "completed"` | For each event, count steps where `status === "completed"`, sum across all events |

**Requirements**:
- **FR1.1**: Aggregation logic must include ALL events in `/data/events/` directory (no filtering by status or date)
- **FR1.2**: A step is only counted as "completed" when `status === "completed"` (case-sensitive exact match)
- **FR1.3**: An event is only counted as "completed" when ALL steps in that event have `status === "completed"` (no partial completion)
- **FR1.4**: Aggregation must be transactional—all metrics calculated from the same point-in-time snapshot
- **FR1.5**: If `/data/events/` is empty or inaccessible, aggregation must gracefully return zeros for all metrics without throwing errors

### 3.2 Monthly Records (Historical Snapshots)

The system must maintain cumulative monthly records for historical tracking:

**Requirements**:
- **FR2.1**: At the end of each calendar month (11:59 PM UTC on the last day), capture a monthly snapshot of all metrics
- **FR2.2**: Monthly records are CUMULATIVE (not reset each month). They show totals at that point in time, not monthly deltas
- **FR2.3**: Each monthly record must include:
  - `year`: Numeric year (e.g., 2025)
  - `month`: Numeric month (1-12, January = 1)
  - `date`: ISO 8601 date string when snapshot was captured (e.g., "2025-12-31T23:59:00Z")
  - `total_events`: Cumulative total events at end of month
  - `total_steps`: Cumulative total steps at end of month
  - `completed_events`: Cumulative completed events at end of month
  - `completed_steps`: Cumulative completed steps at end of month
- **FR2.4**: A calendar year will have UP TO 12 monthly records (January through December). If records don't exist for all months (e.g., platform launched mid-year), only existing months are recorded
- **FR2.5**: Monthly records are permanent once created and must never be overwritten or deleted
- **FR2.6**: The current month should NOT be added to monthly records until the month ends (only full calendar months are recorded)

### 3.3 Data Refresh Strategy

**Requirements**:
- **FR3.1**: Aggregated statistics must be refreshed automatically every 6 hours (0:00 AM, 6:00 AM, 12:00 PM, 6:00 PM UTC)
- **FR3.2**: Refresh timing tolerance is ±5 minutes (e.g., 6:00 AM ± 5 minutes acceptable)
- **FR3.3**: A manual refresh endpoint must be available for administrators to trigger immediate recalculation
- **FR3.4**: Background refresh job must continue running even if manual refresh is triggered
- **FR3.5**: If automatic refresh fails (e.g., file read error), the system must log the error and retry at the next scheduled window (no exponential backoff required for initial version)
- **FR3.6**: Refresh operations must be atomic—if any step in aggregation fails, the previous cached stats remain valid
- **FR3.7**: Each refresh must complete in under 5 seconds for up to 1000 events

### 3.4 Display Requirements

**Requirements**:
- **FR4.1**: Statistics must be displayed on the landing page (`/frontend/src/app/page.tsx`) in a simple table format
- **FR4.2**: Table must be positioned at the bottom of the landing page (below the event creation form)
- **FR4.3**: Table must display current aggregate metrics with these columns:
  - Metric name (e.g., "Total Events")
  - Current count
  - Optional: trend indicator (e.g., "+5 from last month" if monthly records available)
- **FR4.4**: Table title must be "Platform Statistics" or similar
- **FR4.5**: Data must be fetched client-side via GET `/api/stats` endpoint
- **FR4.6**: If stats cannot be fetched (API error), display a graceful fallback message ("Statistics unavailable" or similar) without breaking page layout
- **FR4.7**: Stats should refresh automatically on page load (GET `/api/stats` call on component mount)
- **FR4.8**: No client-side auto-refresh polling required (stats update via backend scheduler, not client-triggered refreshes)

---

## 4. Data Structures

### 4.1 Stats Cache File Structure

**File Location**: `/data/stats.json`

**Full Schema**:

```json
{
  "last_updated": "2025-12-19T18:00:00.000Z",
  "last_refresh_duration_ms": 1234,
  "current_metrics": {
    "total_events": 42,
    "total_steps": 156,
    "completed_events": 18,
    "completed_steps": 89
  },
  "monthly_records": [
    {
      "year": 2025,
      "month": 1,
      "date": "2025-01-31T23:59:00.000Z",
      "total_events": 5,
      "total_steps": 18,
      "completed_events": 2,
      "completed_steps": 8
    },
    {
      "year": 2025,
      "month": 2,
      "date": "2025-02-28T23:59:00.000Z",
      "total_events": 12,
      "total_steps": 45,
      "completed_events": 5,
      "completed_steps": 22
    },
    {
      "year": 2025,
      "month": 12,
      "date": "2025-12-31T23:59:00.000Z",
      "total_events": 42,
      "total_steps": 156,
      "completed_events": 18,
      "completed_steps": 89
    }
  ]
}
```

**Field Descriptions**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `last_updated` | ISO 8601 string | Yes | Timestamp when stats were last calculated (UTC) |
| `last_refresh_duration_ms` | Integer | Yes | Milliseconds taken to calculate stats (for monitoring performance) |
| `current_metrics.total_events` | Integer | Yes | Count of all events |
| `current_metrics.total_steps` | Integer | Yes | Sum of all steps across all events |
| `current_metrics.completed_events` | Integer | Yes | Count of events where ALL steps are completed |
| `current_metrics.completed_steps` | Integer | Yes | Count of individual steps with status="completed" |
| `monthly_records` | Array | Yes | Array of monthly snapshot objects (empty array if no months recorded yet) |
| `monthly_records[].year` | Integer | Yes | Calendar year (e.g., 2025) |
| `monthly_records[].month` | Integer | Yes | Month number (1-12) |
| `monthly_records[].date` | ISO 8601 string | Yes | Date when snapshot was captured (should be last moment of month, e.g., 23:59:00 UTC) |
| `monthly_records[].total_events` | Integer | Yes | Cumulative total events at end of that month |
| `monthly_records[].total_steps` | Integer | Yes | Cumulative total steps at end of that month |
| `monthly_records[].completed_events` | Integer | Yes | Cumulative completed events at end of that month |
| `monthly_records[].completed_steps` | Integer | Yes | Cumulative completed steps at end of that month |

**Constraints**:
- `monthly_records` must be sorted in chronological order (earliest month first)
- `monthly_records` must not contain duplicate month/year combinations
- `current_metrics` values must be integers >= 0
- All timestamps must be in UTC (Z suffix or +00:00)

### 4.2 Event JSON Structure (Reference)

For context, each event file at `/data/events/{eventId}.json` contains:

```json
{
  "id": "uuid",
  "name": "Event Name",
  "owner_email": "email@example.com",
  "flow_type": "sequential|non_sequential|hybrid",
  "created_at": "2025-10-15T06:47:53.116Z",
  "status": "active|completed|archived",
  "steps": [
    {
      "id": "uuid",
      "name": "Step Name",
      "vendor_email": "vendor@example.com",
      "status": "pending|completed",
      "created_at": "2025-10-15T06:47:53.118Z",
      "completed_at": "2025-10-15T06:56:00.455Z",
      "description": "Step description",
      "sequence": 1
    }
  ],
  "commits": []
}
```

**For Aggregation**: Only `steps[].status` field is used. Event `status` field is ignored.

---

## 5. API Design

### 5.1 GET /api/stats - Fetch Current Statistics

**Endpoint**: `GET /api/stats`

**Purpose**: Retrieve current aggregated metrics and monthly records. Called by landing page to display statistics table.

**Request**:
```
GET /api/stats HTTP/1.1
Host: localhost:3001
```

**Response (Success - HTTP 200)**:
```json
{
  "success": true,
  "last_updated": "2025-12-19T18:00:00.000Z",
  "current_metrics": {
    "total_events": 42,
    "total_steps": 156,
    "completed_events": 18,
    "completed_steps": 89
  },
  "monthly_records": [
    {
      "year": 2025,
      "month": 1,
      "date": "2025-01-31T23:59:00.000Z",
      "total_events": 5,
      "total_steps": 18,
      "completed_events": 2,
      "completed_steps": 8
    }
  ]
}
```

**Response (Fallback - HTTP 200, stats.json missing)**:
```json
{
  "success": true,
  "last_updated": null,
  "current_metrics": {
    "total_events": 0,
    "total_steps": 0,
    "completed_events": 0,
    "completed_steps": 0
  },
  "monthly_records": []
}
```

**Response (Error - HTTP 500)**:
```json
{
  "success": false,
  "error": "Failed to read statistics"
}
```

**Status Codes**:
- `200 OK`: Stats retrieved successfully (or graceful fallback)
- `500 Internal Server Error`: Unexpected error reading stats file

**Notes**:
- Endpoint has NO authentication required (public endpoint)
- Endpoint should NOT trigger recalculation (read-only)
- Response time should be < 100ms (simple file read)
- If `/data/stats.json` does not exist, return graceful fallback (zeros) rather than error

---

### 5.2 POST /api/stats/refresh - Manual Statistics Refresh

**Endpoint**: `POST /api/stats/refresh`

**Purpose**: Manually trigger recalculation and caching of statistics. Used by administrators or for verification/debugging.

**Request**:
```
POST /api/stats/refresh HTTP/1.1
Host: localhost:3001
Content-Type: application/json

{
  "admin_token": "optional_token_if_authentication_added_later"
}
```

**Response (Success - HTTP 200)**:
```json
{
  "success": true,
  "message": "Statistics refreshed successfully",
  "refresh_duration_ms": 1234,
  "metrics": {
    "total_events": 42,
    "total_steps": 156,
    "completed_events": 18,
    "completed_steps": 89
  },
  "next_scheduled_refresh": "2025-12-19T00:00:00.000Z"
}
```

**Response (Error - HTTP 500)**:
```json
{
  "success": false,
  "error": "Failed to read events directory",
  "error_code": "EVENTS_DIR_READ_ERROR"
}
```

**Status Codes**:
- `200 OK`: Refresh completed successfully
- `500 Internal Server Error`: Error during aggregation or file write

**Notes**:
- No authentication required for initial version (can be added later)
- Refresh is synchronous—response waits for calculation to complete
- Does NOT interrupt scheduled background refresh job
- Should include `next_scheduled_refresh` timestamp for user feedback
- If monthly record should be created (month ended), do so during this refresh

**Timing Guarantee**: Manual refresh must complete within 5 seconds for up to 1000 events.

---

## 6. Technical Implementation

### 6.1 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│ Frontend (Next.js Landing Page)                                 │
│  - On load: GET /api/stats                                      │
│  - Display stats table with current_metrics                     │
│  - Optional: Show monthly_records as trend (future enhancement) │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       │ HTTP Requests
                       ↓
┌─────────────────────────────────────────────────────────────────┐
│ Backend Express Server (Node.js)                                 │
│                                                                   │
│  Route Handlers:                                                │
│  ├─ GET /api/stats                                             │
│  │  └─ Read /data/stats.json (cached)                          │
│  │  └─ Return current_metrics + monthly_records                │
│  │                                                              │
│  └─ POST /api/stats/refresh                                    │
│     └─ Trigger aggregation calculation                         │
│     └─ Update /data/stats.json                                 │
│     └─ Check if monthly record should be created               │
│                                                                  │
│  Background Jobs (Node Scheduler):                             │
│  └─ Every 6 hours (0:00, 6:00, 12:00, 18:00 UTC)             │
│     └─ Call same aggregation logic as /api/stats/refresh      │
│     └─ Auto-create monthly records at month-end               │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ↓
┌─────────────────────────────────────────────────────────────────┐
│ File System                                                      │
│  ├─ /data/events/*.json (input—event files)                    │
│  └─ /data/stats.json (output—cached aggregates)                │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 File Structure

**Backend Files to Create/Modify**:

```
backend/
├── routes/
│   ├── stats.js (NEW) ← Implement GET /api/stats & POST /api/stats/refresh
│   └── events.js (EXISTING)
├── utils/
│   ├── statsAggregator.js (NEW) ← Core aggregation logic
│   └── statsScheduler.js (NEW) ← Background job scheduler
└── server.js (MODIFY) ← Register stats routes & start scheduler
```

**Frontend Files to Modify**:

```
frontend/src/
├── app/
│   └── page.tsx (MODIFY) ← Add stats table component at bottom
└── components/
    └── StatsTable.tsx (NEW) ← Reusable stats display component
```

**Data Files**:

```
/data/
├── events/ (EXISTING—input)
│   ├── {eventId}.json
│   └── ...
└── stats.json (NEW—output) ← Created/updated by aggregation
```

### 6.3 Aggregation Algorithm (Pseudocode)

```
FUNCTION aggregateStats():
    START_TIME = now()

    // Read all event files
    eventFiles = list all .json files in /data/events/

    totalEvents = eventFiles.length
    totalSteps = 0
    completedEvents = 0
    completedSteps = 0

    FOR each eventFile in eventFiles:
        LOAD event = parse(eventFile)

        // Count total steps
        totalSteps += event.steps.length

        // Count completed steps
        FOR each step in event.steps:
            IF step.status === "completed":
                completedSteps += 1

        // Check if event is fully complete
        isEventComplete = all(step.status === "completed" for step in event.steps)
        IF isEventComplete:
            completedEvents += 1

    // Calculate refresh duration
    DURATION = now() - START_TIME

    // Check if we need to create monthly record
    IF currentMonth has ended (and record doesn't exist):
        CREATE monthly record with current metrics

    // Build stats object
    stats = {
        last_updated: now() in UTC,
        last_refresh_duration_ms: DURATION,
        current_metrics: {
            total_events: totalEvents,
            total_steps: totalSteps,
            completed_events: completedEvents,
            completed_steps: completedSteps
        },
        monthly_records: [existing records + new record if created]
    }

    // Atomic write
    WRITE stats to /data/stats.json

    RETURN stats
```

### 6.4 Background Scheduler Implementation

**Technology Choice**: `node-cron` or `node-schedule` npm package

**Scheduler Configuration**:

```javascript
// Every day at 00:00, 06:00, 12:00, 18:00 UTC
const schedule = '0 0,6,12,18 * * *'; // cron format

scheduler.scheduleJob(schedule, async () => {
    try {
        await aggregateStats();
        console.log('[Stats Scheduler] ✓ Aggregation completed');
    } catch (error) {
        console.error('[Stats Scheduler] ✗ Aggregation failed:', error);
        // Don't throw—let scheduler continue
    }
});
```

**Error Handling**:
- Log errors to console (and optionally to file)
- Do NOT crash the process if aggregation fails
- Retry at next scheduled window (do NOT implement exponential backoff for v1)
- Alert/notification system is OUT OF SCOPE for this PRD

### 6.5 Monthly Record Creation Logic

**Trigger**: During aggregation, check if current month has ended and no record exists for it.

**Definition of "Month Ended"**:
- Today's date > last day of previous month (e.g., December 31st has passed if we're in January)
- OR: Current UTC date is >= 1st of next month

**Algorithm**:

```javascript
FUNCTION checkAndCreateMonthlyRecord(stats):
    now = getCurrentUTCDate()
    currentYear = now.getUTCFullYear()
    currentMonth = now.getUTCMonth() + 1 // 1-12

    // Check if record for THIS month already exists
    existingRecord = find record where year === currentYear AND month === currentMonth

    IF existingRecord exists:
        RETURN // Already recorded, don't create duplicate

    // Check if we're in the NEXT month (which means last month ended)
    lastRecordYear = stats.monthly_records[-1].year (if exists)
    lastRecordMonth = stats.monthly_records[-1].month (if exists)

    IF stats.monthly_records is empty:
        // First month—create record for the previous month that ended
        monthToRecord = currentMonth - 1
        yearToRecord = currentYear
        IF monthToRecord < 1:
            monthToRecord = 12
            yearToRecord = currentYear - 1
    ELSE:
        // Only create if we've moved to next month
        IF currentMonth === lastRecordMonth AND currentYear === lastRecordYear:
            RETURN // Still in same month as last record

        // We're in a new month—create record for previous month
        monthToRecord = lastRecordMonth + 1
        yearToRecord = lastRecordYear
        IF monthToRecord > 12:
            monthToRecord = 1
            yearToRecord = yearToRecord + 1

    // Create the record
    newRecord = {
        year: yearToRecord,
        month: monthToRecord,
        date: lastDayOfMonth(yearToRecord, monthToRecord) at 23:59:00 UTC,
        total_events: stats.current_metrics.total_events,
        total_steps: stats.current_metrics.total_steps,
        completed_events: stats.current_metrics.completed_events,
        completed_steps: stats.current_metrics.completed_steps
    }

    stats.monthly_records.append(newRecord)
    RETURN stats
```

**Example Timeline**:
- January 31, 2025: First aggregation run → Create January record
- February 15, 2025: Aggregation run → No new record (still in February)
- March 5, 2025: Aggregation run → Create February record (month ended, we're now in March)
- April 1, 2025: Aggregation run → Create March record (we're now in April)

### 6.6 Error Handling & Edge Cases

**Edge Case 1: /data/stats.json doesn't exist on first run**
- Aggregation creates it from scratch
- GET /api/stats returns graceful fallback if file missing

**Edge Case 2: /data/events/ is empty**
- All metrics return 0
- No error thrown
- Stats file still written with zeros

**Edge Case 3: An event file is corrupt JSON**
- Skip that event (do not crash)
- Log warning to console
- Continue aggregation with remaining valid events
- Count will be slightly off but will self-correct when corrupt file is removed/fixed

**Edge Case 4: Permission error writing /data/stats.json**
- Log error to console
- Throw error (will be caught by route handler)
- Return HTTP 500 to client
- Previous cached stats remain valid until next successful write

**Edge Case 5: Scheduled job runs while POST /api/stats/refresh is executing**
- Both operations read from same event files (safe—reads are concurrent)
- Whichever finishes last wins (writes are atomic at file level)
- No locking mechanism required for v1

**Edge Case 6: Manual refresh triggered during month boundary**
- Monthly record creation happens within that same refresh
- If month ends between 6-hour intervals, record is created at next manual refresh
- Background scheduler catches it 6 hours later if manual refresh didn't run

### 6.7 Performance Considerations

**Optimization Goals**:
- Aggregation completes in < 5 seconds for 1000 events
- GET /api/stats responds in < 100ms (file read only)
- POST /api/stats/refresh blocks response until complete (acceptable for manual refresh)

**Optimization Strategies**:
1. **Streaming**: Read event files sequentially (not in parallel for v1—simplicity over speed)
2. **Caching**: GET /api/stats serves from cached `/data/stats.json` only (no recalculation)
3. **Minimal I/O**: Background scheduler writes once per 6 hours (4 writes/day max)
4. **No Database**: JSON files eliminate database connection overhead

**Monitoring** (Out of Scope for PRD but noted):
- Log `last_refresh_duration_ms` to track performance trends
- Alert if aggregation exceeds 5 seconds (possible implementation)

---

## 7. UI/UX Requirements

### 7.1 Stats Table Display

**Location**: Bottom of landing page (`/frontend/src/app/page.tsx`), below the event creation form

**Layout**:
```
┌─────────────────────────────────────────────────────────┐
│ Platform Statistics                                      │
├─────────────────────┬──────────────────────────────────┤
│ Metric              │ Count                            │
├─────────────────────┼──────────────────────────────────┤
│ Total Events        │ 42                               │
│ Total Steps         │ 156                              │
│ Completed Events    │ 18                               │
│ Completed Steps     │ 89                               │
├─────────────────────┴──────────────────────────────────┤
│ Last updated: 2025-12-19 at 18:00 UTC                  │
└─────────────────────────────────────────────────────────┘
```

### 7.2 Component Specifications

**Component**: `StatsTable.tsx`

**Props**:
```typescript
interface StatsTableProps {
  loading?: boolean;      // Show loading spinner while fetching
  error?: string | null;  // Error message if fetch fails
  stats?: {
    current_metrics: {
      total_events: number;
      total_steps: number;
      completed_events: number;
      completed_steps: number;
    };
    last_updated: string | null;  // ISO 8601 timestamp
  };
}
```

**Features**:
- **Loading State**: Display spinner or skeleton while fetching `/api/stats`
- **Error State**: Show "Statistics unavailable" message without breaking layout
- **Fallback**: If stats is null, display zeros with message "Statistics are not yet available"
- **Timestamp**: Display "Last updated: [date] at [time] UTC" below table
- **Responsive**: Table should be full-width on mobile, centered max-width on desktop
- **Accessibility**: Use semantic HTML table markup, proper ARIA labels

### 7.3 Data Fetching

**Fetch on Mount**:
```typescript
useEffect(() => {
    fetchStats();
}, []);

async function fetchStats() {
    try {
        const response = await fetch('/api/stats');
        if (!response.ok) throw new Error('Failed to fetch');
        const data = await response.json();
        setStats(data);
    } catch (error) {
        setError('Could not load statistics');
    }
}
```

**NO Real-Time Polling**: Do NOT implement client-side auto-refresh. Stats update via backend scheduler (every 6 hours), not via client polling.

### 7.4 Styling

**Design System**: Use existing Tailwind CSS classes from landing page

**Colors & Style**:
- Table header: `bg-gray-100` or `bg-blue-50`
- Table border: `border-gray-200`
- Text: Gray scale (`text-gray-700`, `text-gray-600`)
- Timestamp text: `text-xs text-gray-500`
- Consistent with existing landing page design (see `page.tsx` for reference)

**Mobile Responsive**:
- Table must not overflow on mobile (consider stacking rows as cards if needed)
- Padding: `p-4` for cards, `px-4 py-2` for cells

---

## 8. Acceptance Criteria

### Must-Have Criteria (Feature is Complete Only If ALL Are Met)

**AC1: Aggregation Accuracy**
- [ ] Total Events count equals number of `.json` files in `/data/events/`
- [ ] Total Steps count equals sum of `event.steps.length` across all events
- [ ] Completed Events count equals count of events where ALL steps have `status === "completed"`
- [ ] Completed Steps count equals count of individual steps where `status === "completed"`
- [ ] Aggregation tested with 10, 100, and 1000 event files to verify accuracy

**AC2: Data Storage**
- [ ] `/data/stats.json` file is created and updated correctly
- [ ] File structure matches schema in Section 4.1 exactly
- [ ] `last_updated` timestamp is accurate to the second
- [ ] `last_refresh_duration_ms` is calculated and recorded
- [ ] File is valid JSON that can be parsed without errors

**AC3: GET /api/stats Endpoint**
- [ ] Endpoint returns HTTP 200 with stats data
- [ ] Response includes `current_metrics` object with all 4 metrics
- [ ] Response includes `monthly_records` array (empty if no records yet)
- [ ] Endpoint returns gracefully (zeros, not error) if `/data/stats.json` missing
- [ ] Response time is < 100ms
- [ ] Endpoint has NO authentication (publicly accessible)

**AC4: POST /api/stats/refresh Endpoint**
- [ ] Endpoint returns HTTP 200 on success
- [ ] Endpoint triggers recalculation and updates `/data/stats.json`
- [ ] Response includes `metrics` object with updated values
- [ ] Response includes `refresh_duration_ms` showing how long calculation took
- [ ] Endpoint returns HTTP 500 on error with error message
- [ ] Manual refresh does NOT interrupt scheduled background job

**AC5: Background Scheduler**
- [ ] Scheduler starts automatically on server startup
- [ ] Scheduler runs aggregation at 00:00, 06:00, 12:00, 18:00 UTC daily
- [ ] Timing is within ±5 minutes of scheduled times
- [ ] Scheduler continues running even if single aggregation fails
- [ ] Errors are logged to console (not silent failures)
- [ ] Scheduler can be verified running via server logs

**AC6: Monthly Records**
- [ ] Monthly records are created only once per month (no duplicates)
- [ ] Monthly records include all 4 metrics plus metadata (year, month, date)
- [ ] Monthly records are cumulative (not reset each month)
- [ ] Records are sorted chronologically (earliest month first)
- [ ] Records are permanent—never overwritten or deleted
- [ ] Example: After running Jan-Mar 2025, exactly 3 records exist (no partial months)

**AC7: Landing Page Display**
- [ ] Stats table appears at bottom of landing page
- [ ] Table displays all 4 metrics correctly
- [ ] Table shows `last_updated` timestamp
- [ ] Table has loading state while fetching
- [ ] Table shows error message if fetch fails (doesn't break page)
- [ ] Table displays zeros if stats unavailable
- [ ] Table is responsive on mobile and desktop
- [ ] Stats fetch via GET /api/stats on page load

**AC8: Error Handling**
- [ ] Corrupt event JSON files are skipped (not crash)
- [ ] Missing `/data/events/` directory creates it (or handles gracefully)
- [ ] Corrupted `/data/stats.json` is overwritten with fresh data
- [ ] Failed aggregation logs error and doesn't break server
- [ ] GET /api/stats returns fallback (not 500 error) if cache missing

**AC9: Performance**
- [ ] Aggregation completes in < 5 seconds for 1000 events
- [ ] GET /api/stats responds in < 100ms
- [ ] POST /api/stats/refresh responds in < 10 seconds
- [ ] Background scheduler doesn't block other API requests

**AC10: Code Quality**
- [ ] All code is commented explaining aggregation logic
- [ ] Error messages are clear and actionable
- [ ] No console errors or warnings
- [ ] Code follows existing backend/frontend style conventions
- [ ] Tests exist for aggregation logic (unit tests)

---

## 9. Success Metrics

**How to Measure Feature Success**:

| Metric | Target | How to Measure |
|--------|--------|----------------|
| **Stats Fetch Success Rate** | > 99.5% | Monitor GET /api/stats error rate in logs |
| **Aggregation Performance** | < 5 seconds for 1000 events | Check `last_refresh_duration_ms` in stats.json |
| **Scheduled Job Uptime** | 100% | Verify 4 daily refreshes complete in logs over 1 week |
| **Monthly Record Accuracy** | 100% | Manually verify Dec 31 snapshot captured correctly |
| **Data Freshness** | Updated within 6-hour windows | Check `last_updated` timestamp in response |
| **Zero Data Integrity Issues** | 0 duplicate/missing records | Audit stats.json monthly_records array |
| **Landing Page Load Impact** | No measurable increase | Compare page load time before/after (baseline to +10% acceptable) |
| **User Visibility** | Stats visible to 100% of landing page visitors | Visual QA on landing page |

**Monitoring Setup** (Out of Scope but Recommended):
- Add logging to track aggregation duration
- Set alerts if aggregation exceeds 5 seconds
- Dashboard to visualize monthly_records growth over time

---

## 10. Non-Goals (Out of Scope)

The following are explicitly NOT included in this PRD and will be considered for future iterations:

- **Database Storage**: Stats remain in JSON files (no SQL/NoSQL database)
- **Real-Time Updates**: Stats do NOT update instantly when events change—4 refreshes per day only
- **User-Specific Stats**: Feature shows platform-wide totals only (no per-user breakdown)
- **Authentication on Manual Refresh**: POST /api/stats/refresh has no auth requirement (can be added later)
- **Email Alerts**: No notifications when stats updated or threshold breached
- **Historical Trends / Charts**: No visualization of month-over-month growth (data stored for future use)
- **Event Status Filtering**: Feature counts ALL events (no filtering by active/archived status)
- **Manual Monthly Record Entry**: Records are created automatically only (no manual overrides)
- **Backup/Archive Strategy**: No automatic backup of stats history (customers responsible for backup)
- **Admin Dashboard**: No dedicated admin interface (refresh via API endpoint only)
- **Timezone Support**: All timestamps are UTC only (no per-user timezone conversion)
- **Concurrent Refresh Locking**: No lock mechanism for simultaneous manual + scheduled refresh
- **Data Export**: No CSV/JSON export of monthly records (can access via API)

---

## 11. Technical Constraints & Assumptions

**Constraints**:
1. Backend runs Node.js with Express framework (existing setup)
2. Data storage is JSON files only (no database)
3. No external services required (all in-process scheduler)
4. Stats aggregation must be synchronous (not queued/async jobs)
5. File I/O operations assume `/data/` directory is writable by backend process

**Assumptions**:
1. Event JSON files are created by existing `/api/events` endpoint (not modified by external sources)
2. Step `status` field values are consistent (only "pending" or "completed")
3. Event files are well-formed JSON (with error handling for corrupt files)
4. Server will restart infrequently (scheduler state resets on restart—acceptable for v1)
5. Platform will have < 10,000 events in `/data/events/` (single file aggregation adequate)

**Dependencies**:
- `node-cron` or `node-schedule` npm package for background scheduling
- Existing Express server infrastructure
- Existing file system access (no new permissions needed)

---

## 12. Implementation Checklist

**Phase 1: Core Infrastructure**
- [ ] Install scheduling package (`npm install node-cron`)
- [ ] Create `backend/utils/statsAggregator.js` with aggregation logic
- [ ] Create `backend/utils/statsScheduler.js` with scheduler setup
- [ ] Create `backend/routes/stats.js` with GET and POST endpoints
- [ ] Register stats routes in `backend/server.js`
- [ ] Start scheduler on server startup

**Phase 2: Testing**
- [ ] Unit tests for aggregation logic (min 80% coverage)
- [ ] Integration test for GET /api/stats endpoint
- [ ] Integration test for POST /api/stats/refresh endpoint
- [ ] Manual test with 100+ test event files
- [ ] Test error scenarios (missing events dir, corrupt JSON, etc.)
- [ ] Test monthly record creation logic

**Phase 3: Frontend**
- [ ] Create `frontend/src/components/StatsTable.tsx` component
- [ ] Modify `frontend/src/app/page.tsx` to include stats table
- [ ] Add fetch logic to load stats on component mount
- [ ] Add loading and error states
- [ ] Style table to match landing page design
- [ ] Test on mobile and desktop viewports
- [ ] QA: Verify stats display correctly

**Phase 4: Deployment & Verification**
- [ ] Deploy to staging environment
- [ ] Verify background scheduler runs on schedule (4 runs per day)
- [ ] Verify monthly record creation (wait for month transition or trigger manually)
- [ ] Verify stats cache updates correctly
- [ ] Monitor aggregation performance in production
- [ ] Deploy to production
- [ ] Monitor for 24+ hours to ensure stability

---

## 13. Open Questions

**Questions to Resolve Before Implementation** (All answered in discovery; included for reference):

1. ✅ **Endpoint Strategy**: Should stats be cached in a file or calculated on-demand? **ANSWER**: Cache in `/data/stats.json` with every-6-hour refresh (Option B)
2. ✅ **Refresh Frequency**: How often should stats update? **ANSWER**: Every 6 hours (4 times daily) automatically + manual refresh capability
3. ✅ **Monthly Record Scope**: How many months of history? **ANSWER**: Up to 12 per year (cumulative, one record per calendar month)
4. ✅ **Access Control**: Who can see stats? **ANSWER**: Public view (no authentication)
5. ✅ **Completed Event Definition**: All steps or at least one step? **ANSWER**: ALL steps must have completed status

**Potential Questions During Implementation**:

- **Q**: What if aggregation takes > 5 seconds? Should we implement async processing?
  - **A**: For v1, document warning in logs. Add async queue in v2 if needed.

- **Q**: Should we add indexes to event files for faster lookups?
  - **A**: Not required for v1 (adequate performance with sequential scan). Consider for v2+ if > 10K events.

- **Q**: How do we handle server restarts? Does scheduler state persist?
  - **A**: Scheduler restarts on each server restart. This is acceptable—worst case, one 6-hour window is skipped (next refresh catches up).

- **Q**: Should monthly records store `created_at` timestamp or just `date`?
  - **A**: Use `date` (end of month 23:59 UTC) per schema in Section 4.1.

---

## 14. Appendix: Example Walkthrough

### Scenario: Platform Uses GitDone for 3 Months

**January 31, 2025 @ 18:00 UTC**:
- Background scheduler runs aggregation
- Scans `/data/events/` and finds 5 event files
- Aggregation results: `{total_events: 5, total_steps: 18, completed_events: 2, completed_steps: 8}`
- Monthly record created: `{year: 2025, month: 1, date: "2025-01-31T23:59:00Z", total_events: 5, ...}`
- `/data/stats.json` written with this record

**February 15, 2025**:
- User visits landing page
- Frontend calls GET `/api/stats`
- Backend returns current metrics + monthly records (1 record: January)
- Landing page displays: `Total Events: 5, Total Steps: 18, Completed Events: 2, Completed Steps: 8`

**February 28, 2025 @ 12:00 UTC**:
- Aggregation runs again (scheduled)
- Now 12 event files exist (7 new events created in Feb)
- Aggregation results: `{total_events: 12, total_steps: 45, completed_events: 5, completed_steps: 22}`
- Monthly record created: `{year: 2025, month: 2, date: "2025-02-28T23:59:00Z", total_events: 12, ...}`
- `/data/stats.json` now has 2 monthly records

**March 5, 2025**:
- Landing page shows: `Total Events: 12, Total Steps: 45, Completed Events: 5, Completed Steps: 22`
- Monthly records: [Jan snapshot, Feb snapshot]
- Trend visible: Jan→Feb shows growth

**December 31, 2025 @ 18:00 UTC**:
- Final aggregation of year
- 12 monthly records exist (Jan-Dec)
- Platform can now calculate annual growth rate: Jan (5 events) → Dec (42 events)

---

## 15. Document Control

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2025-12-19 | Product Manager | Initial PRD—Ready for development |

**Approval Sign-Off** (Optional):
- [ ] Product Manager: _________________
- [ ] Engineering Lead: _________________
- [ ] QA Lead: _________________

---

**End of Document**

For questions or clarifications, contact the Product Manager.

