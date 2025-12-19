# Event Aggregation Dashboard - Detailed Implementation Tasks

**PRD**: 0001-prd-event-aggregation-dashboard.md
**Date**: 2025-12-19
**Status**: Ready for Development
**Target**: Next Sprint

---

## Relevant Files

### Backend Files (Create/Modify)
- `/home/hamr/PycharmProjects/gitdone/backend/utils/statsAggregator.js` - Core aggregation logic for scanning events and calculating metrics
- `/home/hamr/PycharmProjects/gitdone/backend/utils/statsScheduler.js` - Background job scheduler using node-cron for 6-hour intervals
- `/home/hamr/PycharmProjects/gitdone/backend/routes/stats.js` - Express routes: GET /api/stats and POST /api/stats/refresh
- `/home/hamr/PycharmProjects/gitdone/backend/server.js` - Modified to register stats routes and start scheduler on startup

### Frontend Files (Create/Modify)
- `/home/hamr/PycharmProjects/gitdone/frontend/src/components/StatsTable.tsx` - React component for displaying metrics table
- `/home/hamr/PycharmProjects/gitdone/frontend/src/app/page.tsx` - Modified to import and render StatsTable at bottom

### Data Files
- `/home/hamr/PycharmProjects/gitdone/data/stats.json` - JSON cache file created/updated by aggregator (not checked in)

### Test Files
- `/home/hamr/PycharmProjects/gitdone/backend/utils/__tests__/statsAggregator.test.js` - Unit tests for aggregation logic
- `/home/hamr/PycharmProjects/gitdone/backend/routes/__tests__/stats.test.js` - Integration tests for API endpoints
- `/home/hamr/PycharmProjects/gitdone/frontend/src/components/__tests__/StatsTable.test.tsx` - Component tests for React component

### Supporting Files
- `/home/hamr/PycharmProjects/gitdone/package.json` (backend) - Will add node-cron dependency
- `/home/hamr/PycharmProjects/gitdone/.gitignore` - May need to add `/data/stats.json` if not already present

---

## Notes

### Testing Instructions
- **Unit Tests**: Run `npm test -- statsAggregator.test.js` in `/backend` directory
- **Integration Tests**: Run `npm test -- stats.test.js` in `/backend` directory
- **Component Tests**: Run `npm test` in `/frontend` directory
- **Manual Testing**: Use `POST http://localhost:3001/api/stats/refresh` to trigger aggregation manually
- **Test Data**: Create mock event files in `/data/events/` for testing (use UUIDs as filenames)

### Architectural Patterns to Follow
1. **Error Handling**: Follow patterns from `events.js` route—graceful error responses, try-catch wrapping
2. **File I/O**: Use `fs.promises` API (async/await) consistent with existing code
3. **Utils Pattern**: Create modular utilities in `backend/utils/` (see `magicLinkService.js`, `fileManager.js` as examples)
4. **Route Handler Pattern**: Express route handlers should be thin wrappers around utility functions
5. **Logging**: Use `console.log()` and `console.error()` with prefixes like `[Stats Aggregator]` or `[Stats Scheduler]`
6. **JSON Formatting**: Use `JSON.stringify(obj, null, 2)` for readable file output
7. **Date Handling**: Always use UTC dates with `.toISOString()` method

### Important Considerations
- **Atomicity**: Stats file writes must be atomic—use `fs.writeFile()` not stream writes
- **Concurrency**: No file locking needed for v1; last write wins (acceptable per PRD)
- **Error Recovery**: Aggregation failures should NOT crash the server or scheduler
- **Monthly Records**: Only created when transitioning to a new calendar month (check logic carefully in Section 6.5 of PRD)
- **Performance**: Aggregation must complete in < 5 seconds for 1000 events (monitor `last_refresh_duration_ms`)
- **Edge Cases**: Handle missing `/data/events/` dir, empty events dir, corrupt JSON files gracefully
- **Scheduler Startup**: Ensure scheduler starts AFTER server initialization (register routes first)
- **No Client Polling**: Frontend should fetch stats once on page load—no auto-refresh client-side

### Potential Challenges
1. **Monthly Record Logic**: Complex condition checking if month has ended—see PRD 6.5 algorithm carefully
2. **Concurrent Refresh**: Manual POST refresh + scheduled job may write simultaneously—acceptable but test thoroughly
3. **First Run**: Ensure stats.json is created on first aggregation even if no events exist
4. **Performance Regression**: Monitor for slow event file reading with large dataset—may need optimization in future
5. **Timezone Handling**: All timestamps MUST be UTC—no timezone conversion logic needed, but double-check all `new Date()` calls

### Git Integration Note
- Stats aggregation reads from `/data/events/` (which may be Git-backed per existing architecture)
- No Git operations needed for stats.json—purely JSON file caching
- Each event file is independent; no need to commit stats results to event repos

---

## Tasks

### Phase 1: Core Infrastructure Setup

- [x] **1.0 Setup Backend Dependencies and Project Structure** ✓ COMPLETE
  - **Effort**: Small (30 min)
  - **Dependencies**: None
  - **Acceptance Criteria**:
    - [x] `node-cron` installed via `npm install node-cron` in `/backend` directory
    - [x] Version pinned in package.json (e.g., "^3.0.0")
    - [x] `/backend/utils/` directory exists and is writable
  - [x] 1.1 Install node-cron scheduling package ✓
    - Navigate to `/home/hamr/PycharmProjects/gitdone/backend`
    - Run: `npm install node-cron`
    - Verify in `package.json` that dependency is added
    - **Reference**: Similar dependency installation pattern in existing setup
    - **Testing**: `npm ls node-cron` should show installed version
  - [x] 1.2 Verify utils directory structure ✓
    - Check `/home/hamr/PycharmProjects/gitdone/backend/utils/` exists
    - Confirm it contains existing utilities (magicLinkService.js, fileManager.js, etc.)
    - Note patterns for consistent file structure
  - [x] 1.3 Create `/data/stats.json` template locally (not committed) ✓
    - Document the expected initial structure as comment in statsAggregator.js
    - Ensure `.gitignore` contains `/data/stats.json` (stats cache should not be committed)
    - **Acceptance**: `.gitignore` verified or updated to exclude stats cache

- [x] **2.0 Create statsAggregator Utility Module** ✓ COMPLETE
  - **Effort**: Medium (2-3 hours)
  - **Dependencies**: 1.0 setup
  - **Acceptance Criteria**:
    - [x] Module exports `aggregateStats()` async function
    - [x] Returns stats object matching schema in PRD Section 4.1
    - [x] Handles all 4 metrics correctly (total_events, total_steps, completed_events, completed_steps)
    - [x] Gracefully handles missing/empty `/data/events/` directory
    - [x] Gracefully skips corrupt JSON files with console warnings
    - [x] Performance: completes in < 5 seconds for 1000 events
  - [x] 2.1 Implement core aggregation logic ✓
    - **File**: `/home/hamr/PycharmProjects/gitdone/backend/utils/statsAggregator.js`
    - Create async function `aggregateStats()` that:
      - Reads all `.json` files from `/data/events/`
      - Counts total events as file count
      - Iterates through each event file and:
        - Sums `event.steps.length` into totalSteps
        - Counts steps with `status === "completed"`
        - Checks if ALL steps in event have completed status (for completedEvents)
      - Measures execution time and records in `last_refresh_duration_ms`
      - Returns metrics object with timestamp
    - **Code Pattern**: Similar to `fileManager.listEvents()` pattern—use `fs.promises.readdir()` + `fs.promises.readFile()`
    - **Error Handling**: Wrap file operations in try-catch; skip corrupt files and log warnings
    - **Acceptance**:
      - [ ] Function returns correct structure matching PRD schema
      - [ ] Unit test verifies accuracy with 10 test events
      - [ ] Handles empty directory gracefully (returns zeros, no error)
      - [ ] Handles corrupt JSON by skipping and logging
  - [ ] 2.2 Implement monthly record creation logic
    - **File**: Same as 2.1, add `checkAndCreateMonthlyRecord()` function
    - Implement algorithm from PRD Section 6.5:
      - Check if current month already has a record (prevent duplicates)
      - Determine if we've transitioned to a new month
      - Create new record with cumulative metrics
      - Generate correct ISO 8601 timestamp (last day of month at 23:59:00 UTC)
    - Helper function to calculate last day of month:
      - Input: year, month
      - Output: Date object at 23:59:00 UTC of last day
      - **Reference**: JavaScript `new Date(year, month, 0)` gives last day of previous month
    - **Acceptance**:
      - [ ] No duplicate records created (idempotent)
      - [ ] Records created only when transitioning to next month
      - [ ] Monthly records array is sorted chronologically
      - [ ] Unit test verifies correct record creation across month boundaries
  - [ ] 2.3 Implement atomic file writing
    - **File**: Add `saveStats()` function
    - Use `fs.promises.writeFile()` to atomically write `/data/stats.json`
    - Include JSON formatting: `JSON.stringify(stats, null, 2)`
    - Ensure stats directory exists before writing
    - **Error Handling**: Throw descriptive errors that can be caught by route handlers
    - **Acceptance**:
      - [ ] File is written atomically (readable file or not at all)
      - [ ] JSON is properly formatted (2-space indentation)
      - [ ] Handles permission errors and surfaces them

- [x] **3.0 Create statsScheduler Background Job Module** ✓ COMPLETE
  - **Effort**: Small (1-1.5 hours)
  - **Dependencies**: 2.0 aggregator complete
  - **Acceptance Criteria**:
    - [x] Scheduler runs aggregation every 6 hours (00:00, 06:00, 12:00, 18:00 UTC)
    - [x] Timing tolerance within ±5 minutes
    - [x] Errors logged but don't crash server
    - [x] Module exports `startScheduler()` function
    - [x] Scheduler logs successful runs with timestamps
  - [x] 3.1 Set up node-cron scheduler ✓
    - **File**: `/home/hamr/PycharmProjects/gitdone/backend/utils/statsScheduler.js`
    - Import `node-cron` and `statsAggregator`
    - Create cron pattern: `'0 0,6,12,18 * * *'` (every 6 hours at UTC times)
    - **Cron Pattern Explanation**:
      - Minute: 0
      - Hour: 0,6,12,18 (four times daily)
      - Day, Month, Day-of-week: * (daily)
    - Define `startScheduler()` function that calls `cron.schedule()`
    - Export: `module.exports = { startScheduler };`
    - **Reference**: See PRD Section 6.4 for scheduler configuration example
    - **Acceptance**:
      - [x] Cron pattern is correctly formatted
      - [x] Function is exported and callable from server.js
  - [x] 3.2 Implement error handling in scheduler ✓
    - Wrap `aggregateStats()` call in try-catch
    - Log errors to console with `[Stats Scheduler]` prefix
    - Do NOT throw error (scheduler should continue)
    - Include timestamp in log messages
    - Log success message: `[Stats Scheduler] ✓ Aggregation completed at HH:MM UTC`
    - **Acceptance**:
      - [x] Scheduler logs both successes and errors
      - [x] Errors don't cause process exit
      - [x] Logs are traceable in server output
  - [x] 3.3 Add scheduler startup to server ✓
    - **File**: `/home/hamr/PycharmProjects/gitdone/backend/server.js`
    - Import scheduler at top: `const { startScheduler } = require('./utils/statsScheduler');`
    - Call `startScheduler()` AFTER all routes registered (before `app.listen()`)
    - Add console.log: `console.log('[Stats Scheduler] Started—running every 6 hours at 00:00, 06:00, 12:00, 18:00 UTC');`
    - **Acceptance**:
      - [x] Server starts without errors
      - [x] Scheduler log message appears in console on startup
      - [x] Stats routes already registered before scheduler starts

- [x] **4.0 Create Statistics API Routes** ✓ COMPLETE
  - **Effort**: Medium (2 hours)
  - **Dependencies**: 2.0, 3.0 complete
  - **Acceptance Criteria**:
    - [x] GET /api/stats endpoint returns HTTP 200 with stats object
    - [x] POST /api/stats/refresh endpoint triggers aggregation and returns HTTP 200
    - [x] Both endpoints handle errors gracefully with HTTP 500 responses
    - [x] GET endpoint returns fallback (zeros) if cache missing
    - [x] POST endpoint includes next_scheduled_refresh in response
    - [x] No authentication required on either endpoint
  - [x] 4.1 Create stats routes file ✓
    - **File**: `/home/hamr/PycharmProjects/gitdone/backend/routes/stats.js`
    - Import: `express`, `statsAggregator`, `fs.promises`, `path`
    - Create router: `const router = express.Router();`
    - Define stats file path: `/home/hamr/PycharmProjects/gitdone/data/stats.json`
    - **Pattern**: Follow structure from `events.js` route file
    - **Acceptance**:
      - [ ] File created in correct location
      - [ ] All required imports present
      - [ ] Router is exported: `module.exports = router;`
  - [ ] 4.2 Implement GET /api/stats endpoint
    - **Endpoint**: `router.get('/', async (req, res) => { ... })`
    - Read `/data/stats.json` file
    - **Response on Success (file exists)**:
      - [ ] Parse JSON
      - [ ] Return HTTP 200 with data including `success: true`, `last_updated`, `current_metrics`, `monthly_records`
      - [ ] Response time < 100ms
    - **Response on Fallback (file missing or first run)**:
      - [ ] Return HTTP 200 with zeros structure (not error)
      - [ ] `last_updated: null`
      - [ ] `current_metrics` all zero
      - [ ] `monthly_records: []`
    - **Error Handling**:
      - [ ] If read error occurs, catch and return HTTP 500 with error message
      - [ ] Log error to console
    - **Acceptance**:
      - [ ] Endpoint responds within 100ms
      - [ ] Correct JSON response structure
      - [ ] Graceful fallback handling
  - [ ] 4.3 Implement POST /api/stats/refresh endpoint
    - **Endpoint**: `router.post('/refresh', async (req, res) => { ... })`
    - Call `aggregateStats()` from utils
    - Time the execution to record in response
    - **Response on Success**:
      - [ ] HTTP 200 status
      - [ ] Include: `success: true`, `message`, `refresh_duration_ms`, `metrics` (current_metrics), `next_scheduled_refresh`
      - [ ] Calculate next refresh time (next scheduled 6-hour window)
      - [ ] Response must complete within 10 seconds
    - **Error Handling**:
      - [ ] HTTP 500 on aggregation failure
      - [ ] Include `error` and `error_code` fields
      - [ ] Examples: `"EVENTS_DIR_READ_ERROR"`, `"FILE_WRITE_ERROR"`
      - [ ] Log error with context
    - **Acceptance**:
      - [ ] Manual refresh works via POST request
      - [ ] Metrics reflect latest event data
      - [ ] Response time < 10 seconds
      - [ ] Errors include clear error codes
  - [ ] 4.4 Register routes in server
    - **File**: `/home/hamr/PycharmProjects/gitdone/backend/server.js`
    - Add import: `const statsRouter = require('./routes/stats');`
    - Add route registration: `app.use('/api/stats', statsRouter);`
    - Place alongside other route registrations (after line 43)
    - **Acceptance**:
      - [ ] Routes registered before error handlers
      - [ ] No conflicts with existing routes
      - [ ] Endpoints accessible at /api/stats and /api/stats/refresh

---

### Phase 2: Frontend UI Components

- [x] **5.0 Create StatsTable React Component** ✓ COMPLETE
  - **Effort**: Small-Medium (1.5 hours)
  - **Dependencies**: 4.0 routes complete
  - **Acceptance Criteria**:
    - [x] Component accepts props: `loading`, `error`, `stats` (optional)
    - [x] Renders table with 4 metric rows: Total Events, Total Steps, Completed Events, Completed Steps
    - [x] Shows last_updated timestamp below table
    - [x] Displays loading spinner while fetching (optional—can show skeleton)
    - [x] Shows error message gracefully if fetch fails
    - [x] Shows fallback message if stats unavailable
    - [x] Responsive on mobile and desktop
    - [x] Uses Tailwind CSS consistent with landing page design
  - [x] 5.1 Create StatsTable component file ✓
    - **File**: `/home/hamr/PycharmProjects/gitdone/frontend/src/components/StatsTable.tsx`
    - Language: TypeScript (React component)
    - Import: `React`, `useState`, `useEffect`, `lucide-react` icons (optional—Stats or Activity icon)
    - Define TypeScript interface for props (matching PRD Section 7.2):
      ```typescript
      interface StatsTableProps {
        loading?: boolean;
        error?: string | null;
        stats?: {
          current_metrics: {
            total_events: number;
            total_steps: number;
            completed_events: number;
            completed_steps: number;
          };
          last_updated: string | null;
        };
      }
      ```
    - **Acceptance**:
      - [ ] File created in correct location
      - [ ] TypeScript compiles without errors
      - [ ] Props interface matches PRD schema
  - [ ] 5.2 Implement table rendering
    - Use semantic HTML: `<table>`, `<thead>`, `<tbody>`, `<tr>`, `<td>`
    - Structure:
      ```
      ┌─────────────────────────────────────────┐
      │ Platform Statistics                      │
      ├──────────────────┬──────────────────────┤
      │ Metric           │ Count                │
      ├──────────────────┼──────────────────────┤
      │ Total Events     │ {count}              │
      │ Total Steps      │ {count}              │
      │ Completed Events │ {count}              │
      │ Completed Steps  │ {count}              │
      ├──────────────────┴──────────────────────┤
      │ Last updated: 2025-12-19 at 18:00 UTC   │
      └──────────────────────────────────────────┘
      ```
    - Metric display order: total_events, total_steps, completed_events, completed_steps
    - Format numbers with thousand separators if > 999 (optional enhancement)
    - **Tailwind Classes**:
      - [ ] Table: `w-full border-collapse`
      - [ ] Header: `bg-gray-100 or bg-blue-50`
      - [ ] Rows: `border-b border-gray-200`
      - [ ] Cells: `px-4 py-2 text-left`
      - [ ] Numbers: `text-right font-semibold`
    - **Acceptance**:
      - [ ] Table renders without layout issues
      - [ ] All 4 metrics visible
      - [ ] Timestamp visible below table
  - [ ] 5.3 Implement loading state
    - While `loading === true`:
      - [ ] Show loading spinner or skeleton (use lucide-react `Loader` icon with animation)
      - [ ] Display "Loading statistics..." text (optional)
      - [ ] Alternative: Show skeleton table rows with gray placeholder
    - **CSS Animation**: Use Tailwind `animate-spin` for spinner
    - **Acceptance**:
      - [ ] Loading state visible when component prop `loading={true}`
      - [ ] Spinner or skeleton shows
  - [ ] 5.4 Implement error and fallback states
    - **Error State** (when `error` prop is not null):
      - [ ] Display: `<p className="text-red-600">Statistics unavailable: {error}</p>`
      - [ ] Don't show table
      - [ ] Page layout not broken
    - **Fallback State** (when `stats` prop is undefined):
      - [ ] Display all metrics as 0
      - [ ] Show message: `<p className="text-gray-500">Statistics are not yet available</p>`
      - [ ] Show table with zeros
    - **Acceptance**:
      - [ ] Error message displays correctly
      - [ ] Fallback state shows zeros
      - [ ] No console errors or exceptions
  - [ ] 5.5 Format and display last_updated timestamp
    - Parse `stats.last_updated` (ISO 8601 string) into readable format
    - Display format: `"Last updated: Dec 19, 2025 at 18:00 UTC"`
    - Handle null value: `"Last updated: Not yet available"`
    - **Date Formatting**: Use JavaScript `Date` object with `toLocaleString()` or manual formatting
    - Place below table with smaller font: `<p className="text-xs text-gray-500 mt-2">Last updated: ...</p>`
    - **Acceptance**:
      - [ ] Timestamp displays in human-readable format
      - [ ] Handles null gracefully
      - [ ] Position below table

- [x] **6.0 Integrate StatsTable into Landing Page** ✓ COMPLETE
  - **Effort**: Small (45 min)
  - **Dependencies**: 5.0 component complete, 4.0 API routes complete
  - **Acceptance Criteria**:
    - [x] StatsTable component renders at bottom of landing page (below event creation form)
    - [x] Stats fetch via GET /api/stats on page load (useEffect)
    - [x] Loading state visible while fetching
    - [x] Error state handled gracefully
    - [x] Stats display correctly with live data
  - [x] 6.1 Import StatsTable into page ✓
    - **File**: `/home/hamr/PycharmProjects/gitdone/frontend/src/app/page.tsx`
    - Add import at top: `import StatsTable from '../components/StatsTable';`
    - **Acceptance**:
      - [ ] Import statement present
      - [ ] No TypeScript errors
  - [ ] 6.2 Add state management for stats data
    - Create state variables:
      ```typescript
      const [statsLoading, setStatsLoading] = useState(false);
      const [statsError, setStatsError] = useState<string | null>(null);
      const [stats, setStats] = useState<any>(null);
      ```
    - **Acceptance**:
      - [ ] State variables initialized correctly
      - [ ] Proper TypeScript types
  - [ ] 6.3 Implement fetch logic on component mount
    - Create `fetchStats()` function:
      ```typescript
      const fetchStats = async () => {
        setStatsLoading(true);
        setStatsError(null);
        try {
          const response = await fetch('/api/stats');
          if (!response.ok) throw new Error('Failed to fetch stats');
          const data = await response.json();
          setStats(data);
        } catch (error) {
          setStatsError('Could not load statistics');
          console.error('Stats fetch error:', error);
        } finally {
          setStatsLoading(false);
        }
      };
      ```
    - Call in `useEffect` with empty dependency array:
      ```typescript
      useEffect(() => {
        fetchStats();
      }, []);
      ```
    - **Acceptance**:
      - [ ] Function fetches from correct endpoint
      - [ ] Loading state managed correctly
      - [ ] Error handled with try-catch
      - [ ] Fetch happens on page load
  - [ ] 6.4 Render StatsTable component
    - Add at bottom of JSX (below event creation form):
      ```tsx
      <StatsTable
        loading={statsLoading}
        error={statsError}
        stats={stats}
      />
      ```
    - Place after `</form>` or equivalent closing tag of event creation UI
    - Add spacing: `<section className="mt-12 mb-8">` wrapper
    - **Acceptance**:
      - [ ] Component renders without errors
      - [ ] Props passed correctly
      - [ ] Position at bottom of page visually verified
  - [ ] 6.5 Style for responsive layout
    - Container for StatsTable should be full-width on mobile
    - Desktop: Optional max-width constraint (align with form above)
    - Padding: `px-4 md:px-0`
    - **Acceptance**:
      - [ ] Responsive on mobile (< 640px width)
      - [ ] Responsive on tablet (640px - 1024px)
      - [ ] Responsive on desktop (> 1024px)
      - [ ] No horizontal scroll

---

### Phase 3: Testing

- [ ] **7.0 Write Unit Tests for Aggregation Logic**
  - **Effort**: Medium (2-2.5 hours)
  - **Dependencies**: 2.0 aggregator complete
  - **Acceptance Criteria**:
    - [ ] Minimum 80% code coverage for statsAggregator.js
    - [ ] All metrics calculation verified with test data
    - [ ] Edge cases tested: empty dir, corrupt JSON, missing dir
    - [ ] Monthly record creation logic tested across month boundaries
    - [ ] Performance tested with 1000+ event files
    - [ ] Tests run successfully with `npm test` in backend directory
  - [ ] 7.1 Set up test file and fixtures
    - **File**: `/home/hamr/PycharmProjects/gitdone/backend/utils/__tests__/statsAggregator.test.js`
    - Create test fixtures directory: `/home/hamr/PycharmProjects/gitdone/backend/utils/__tests__/fixtures/`
    - Generate sample event JSON files in fixtures (5, 10, 100 event files)
    - Each test event should have:
      - [ ] id, name, owner_email, flow_type, created_at, status, steps[], commits[]
      - [ ] Varying number of steps (1-10 per event)
      - [ ] Mix of completed and pending steps
      - [ ] Example step: `{ id, name, vendor_email, status: "completed"|"pending", ... }`
    - **Jest Setup**: Import `fs.promises`, `path`, `statsAggregator`
    - Create `beforeEach` to set up temp test directory and cleanup
    - **Acceptance**:
      - [ ] Test file structure correct
      - [ ] Fixtures present and valid JSON
      - [ ] Jest config recognizes test patterns
  - [ ] 7.2 Test total_events metric
    - **Test Case 1**: Empty events directory
      - [ ] `aggregateStats()` with no event files → totalEvents = 0
    - **Test Case 2**: Exactly 5 events
      - [ ] 5 valid event JSON files → totalEvents = 5
    - **Test Case 3**: 100 events
      - [ ] 100 event files → totalEvents = 100
    - **Assertion**: `expect(result.current_metrics.total_events).toBe(expectedCount);`
    - **Acceptance**:
      - [ ] All 3 test cases pass
      - [ ] Count accuracy verified
  - [ ] 7.3 Test total_steps metric
    - **Test Case 1**: Event with 1 step
      - [ ] Total steps = 1
    - **Test Case 2**: Event with 5 steps
      - [ ] Total steps = 5
    - **Test Case 3**: 3 events (3 + 5 + 2 steps)
      - [ ] Total steps = 10
    - **Test Case 4**: Events with varying step counts
      - [ ] Verify sum across multiple events
    - **Assertion**: `expect(result.current_metrics.total_steps).toBe(expectedSum);`
    - **Acceptance**:
      - [ ] All test cases pass
      - [ ] Aggregation across events verified
  - [ ] 7.4 Test completed_steps metric
    - **Test Case 1**: Event with all pending steps
      - [ ] Completed steps = 0
    - **Test Case 2**: Event with all completed steps (5 steps)
      - [ ] Completed steps = 5
    - **Test Case 3**: Mixed steps (3 completed, 2 pending)
      - [ ] Completed steps = 3
    - **Test Case 4**: Multiple events with mix
      - [ ] Correct count across all events
    - **Assertion**: `expect(result.current_metrics.completed_steps).toBe(expectedCount);`
    - **Acceptance**:
      - [ ] All test cases pass
      - [ ] Case-sensitive check: only `status === "completed"` counts
  - [ ] 7.5 Test completed_events metric
    - **Test Case 1**: Event where ALL steps completed
      - [ ] Event counts toward completed_events
    - **Test Case 2**: Event with 1 pending step (rest completed)
      - [ ] Does NOT count toward completed_events
    - **Test Case 3**: Multiple events
      - [ ] Accurate count of fully-completed events
    - **Test Case 4**: No completed events
      - [ ] completed_events = 0
    - **Assertion**: `expect(result.current_metrics.completed_events).toBe(expectedCount);`
    - **Acceptance**:
      - [ ] All test cases pass
      - [ ] Correctly identifies events with ALL steps completed
  - [ ] 7.6 Test edge cases and error handling
    - **Edge Case 1: Corrupt JSON file**
      - [ ] Aggregation skips corrupt file
      - [ ] Returns stats for valid files (doesn't crash)
      - [ ] Console warning logged
    - **Edge Case 2: Missing /data/events/ directory**
      - [ ] Gracefully creates or handles absence
      - [ ] Returns zeros, doesn't throw error
    - **Edge Case 3: Empty /data/events/ directory**
      - [ ] Returns all metrics as 0
      - [ ] No error thrown
    - **Edge Case 4: Permission denied reading event file**
      - [ ] Error caught, file skipped, aggregation continues
    - **Acceptance**:
      - [ ] All edge cases handled gracefully
      - [ ] No unhandled exceptions
      - [ ] Errors logged appropriately
  - [ ] 7.7 Test monthly record creation logic
    - **Test Case 1**: First aggregation of platform
      - [ ] No monthly record created (not yet end of month)
    - **Test Case 2**: Transition to new month
      - [ ] Monthly record created for completed month
      - [ ] Record has correct year, month, date
    - **Test Case 3**: Duplicate prevention
      - [ ] Running aggregation twice in same month
      - [ ] Only 1 record for that month (no duplicates)
    - **Test Case 4**: Year boundary (Dec → Jan)
      - [ ] Correct year and month values
    - **Acceptance**:
      - [ ] Monthly records created correctly
      - [ ] No duplicates
      - [ ] Records correctly timestamped
  - [ ] 7.8 Test performance and timing
    - **Performance Test**: 1000 event files
      - [ ] Aggregation completes in < 5000ms
      - [ ] `last_refresh_duration_ms` is recorded and < 5000
    - **Acceptance**:
      - [ ] Performance target met
      - [ ] Timing is reasonable for monitoring

- [ ] **8.0 Write Integration Tests for API Endpoints**
  - **Effort**: Medium (2 hours)
  - **Dependencies**: 4.0 routes complete
  - **Acceptance Criteria**:
    - [ ] GET /api/stats endpoint tested with mocked file I/O
    - [ ] POST /api/stats/refresh endpoint tested with mocked aggregation
    - [ ] Error responses tested (HTTP 500, error messages)
    - [ ] Graceful fallback tested (missing stats.json returns zeros)
    - [ ] Response format matches API schema exactly
    - [ ] Tests run with `npm test` in backend directory
  - [ ] 8.1 Set up integration test file
    - **File**: `/home/hamr/PycharmProjects/gitdone/backend/routes/__tests__/stats.test.js`
    - Import: `supertest`, `express`, `stats router`, `statsAggregator`
    - Mock `statsAggregator` to avoid file I/O in tests
    - Use Jest mocking: `jest.mock('../utils/statsAggregator');`
    - Create test app with stats router mounted
    - **Acceptance**:
      - [ ] Test file created
      - [ ] Imports and mocks configured
      - [ ] No dependency on actual file system
  - [ ] 8.2 Test GET /api/stats success case
    - **Test**: GET /api/stats returns cached stats
      - [ ] Mock `/data/stats.json` with sample data
      - [ ] Send request to endpoint
      - [ ] Assert HTTP 200 status
      - [ ] Assert response includes `success: true`
      - [ ] Assert response includes `current_metrics` with all 4 fields
      - [ ] Assert response includes `monthly_records` array
      - [ ] Assert response includes `last_updated` timestamp
    - **Acceptance**:
      - [ ] Status code correct
      - [ ] Response structure matches PRD schema
  - [ ] 8.3 Test GET /api/stats fallback case
    - **Test**: GET /api/stats when stats.json missing
      - [ ] Mock file not found condition
      - [ ] Send request to endpoint
      - [ ] Assert HTTP 200 (not 500)
      - [ ] Assert response has zeros: `total_events: 0, total_steps: 0, completed_events: 0, completed_steps: 0`
      - [ ] Assert `last_updated: null`
      - [ ] Assert `monthly_records: []`
    - **Acceptance**:
      - [ ] Graceful fallback works
      - [ ] Returns zeros instead of error
  - [ ] 8.4 Test GET /api/stats error case
    - **Test**: GET /api/stats when file read error occurs
      - [ ] Mock file read throwing error
      - [ ] Send request to endpoint
      - [ ] Assert HTTP 500 status
      - [ ] Assert response includes `success: false`
      - [ ] Assert response includes `error` message
    - **Acceptance**:
      - [ ] Error handling correct
      - [ ] Appropriate HTTP status
  - [ ] 8.5 Test POST /api/stats/refresh success case
    - **Test**: POST /api/stats/refresh triggers aggregation
      - [ ] Mock `aggregateStats()` to return sample metrics
      - [ ] Send POST request to endpoint
      - [ ] Assert HTTP 200 status
      - [ ] Assert response includes `success: true`, `message`
      - [ ] Assert response includes `refresh_duration_ms` (number)
      - [ ] Assert response includes `metrics` with current_metrics
      - [ ] Assert response includes `next_scheduled_refresh` timestamp
    - **Acceptance**:
      - [ ] Endpoint triggers aggregation
      - [ ] Response format matches PRD schema
      - [ ] Timing information included
  - [ ] 8.6 Test POST /api/stats/refresh error case
    - **Test**: POST /api/stats/refresh when aggregation fails
      - [ ] Mock `aggregateStats()` throwing error
      - [ ] Send POST request to endpoint
      - [ ] Assert HTTP 500 status
      - [ ] Assert response includes `success: false`
      - [ ] Assert response includes `error` and `error_code`
    - **Acceptance**:
      - [ ] Error handling correct
      - [ ] Error code provided
  - [ ] 8.7 Test response time constraints
    - **Test**: GET /api/stats responds in < 100ms
      - [ ] Measure request time
      - [ ] Assert response time < 100ms
    - **Test**: POST /api/stats/refresh completes in < 10 seconds
      - [ ] Measure request time
      - [ ] Assert response time < 10 seconds
    - **Acceptance**:
      - [ ] Performance requirements met
  - [ ] 8.8 Test authentication (none required)
    - **Test**: GET /api/stats requires no authentication
      - [ ] Send request without auth headers
      - [ ] Assert HTTP 200 (not 401/403)
    - **Test**: POST /api/stats/refresh requires no authentication
      - [ ] Send request without auth headers
      - [ ] Assert HTTP 200 (not 401/403)
    - **Acceptance**:
      - [ ] Both endpoints public (no auth required)

- [ ] **9.0 Write Component/E2E Tests for Landing Page**
  - **Effort**: Medium (1.5-2 hours)
  - **Dependencies**: 6.0 integration complete
  - **Acceptance Criteria**:
    - [ ] StatsTable component renders correctly
    - [ ] Stats fetch on component mount
    - [ ] Loading state displays while fetching
    - [ ] Error state displays gracefully
    - [ ] Stats display correctly with live data
    - [ ] Responsive on mobile and desktop viewports
    - [ ] No console errors or warnings
  - [ ] 9.1 Set up component test file
    - **File**: `/home/hamr/PycharmProjects/gitdone/frontend/src/components/__tests__/StatsTable.test.tsx`
    - Use React Testing Library and Jest
    - Import: `render`, `screen`, `waitFor` from testing library
    - Import `StatsTable` component
    - Create sample stats object matching API response format
    - **Acceptance**:
      - [ ] Test file created
      - [ ] Testing library configured
      - [ ] Can render component without errors
  - [ ] 9.2 Test StatsTable rendering with data
    - **Test**: StatsTable renders metrics table
      - [ ] Render component with valid stats prop
      - [ ] Assert table element present
      - [ ] Assert all 4 metric labels visible: "Total Events", "Total Steps", "Completed Events", "Completed Steps"
      - [ ] Assert metric values display correctly
    - **Test**: StatsTable displays timestamp
      - [ ] Assert `last_updated` timestamp visible
      - [ ] Assert timestamp is formatted human-readably
    - **Acceptance**:
      - [ ] Table renders with correct structure
      - [ ] All metrics visible
      - [ ] Timestamp displayed
  - [ ] 9.3 Test StatsTable loading state
    - **Test**: Loading spinner shows when loading={true}
      - [ ] Render with `loading={true}`
      - [ ] Assert loading indicator present (spinner or skeleton)
      - [ ] Assert table not visible during loading
    - **Acceptance**:
      - [ ] Loading state renders
      - [ ] UI doesn't show stale data during load
  - [ ] 9.4 Test StatsTable error state
    - **Test**: Error message displays when error prop set
      - [ ] Render with `error="Network error"`
      - [ ] Assert error message visible
      - [ ] Assert table not visible
      - [ ] Assert page layout not broken
    - **Acceptance**:
      - [ ] Error displayed gracefully
      - [ ] No layout breaking
  - [ ] 9.5 Test StatsTable fallback state
    - **Test**: Fallback state when stats undefined
      - [ ] Render with `stats={undefined}`
      - [ ] Assert metrics display as 0
      - [ ] Assert fallback message visible
    - **Acceptance**:
      - [ ] Fallback renders correctly
  - [ ] 9.6 Test landing page integration
    - **Test**: Landing page fetches and displays stats
      - [ ] Mock API endpoint: `/api/stats`
      - [ ] Render landing page (`page.tsx`)
      - [ ] Assert fetch called on mount
      - [ ] Assert StatsTable component renders
      - [ ] Assert stats data displayed correctly
    - **Test**: Error handling in page
      - [ ] Mock API endpoint to return error
      - [ ] Render landing page
      - [ ] Assert error message displays
      - [ ] Assert page doesn't crash
    - **Acceptance**:
      - [ ] Page integration works
      - [ ] Fetch happens on mount
      - [ ] Error handling verified
  - [ ] 9.7 Test responsive design
    - **Test**: Mobile viewport (375px width)
      - [ ] Render StatsTable
      - [ ] Assert table is readable (no horizontal scroll)
      - [ ] Assert padding/spacing appropriate
    - **Test**: Desktop viewport (1280px width)
      - [ ] Render StatsTable
      - [ ] Assert table layout correct
      - [ ] Assert alignment consistent
    - **Acceptance**:
      - [ ] Responsive on both viewports
      - [ ] No layout issues
  - [ ] 9.8 Test accessibility
    - **Test**: Semantic HTML
      - [ ] Assert `<table>` element used
      - [ ] Assert `<thead>`, `<tbody>` present
      - [ ] Assert proper `<th>` and `<td>` structure
    - **Test**: ARIA labels (optional)
      - [ ] Assert `aria-label` on table if needed
      - [ ] Assert loading indicator has `role="status"` if present
    - **Acceptance**:
      - [ ] Semantic markup correct
      - [ ] Accessible to screen readers

---

### Phase 4: Documentation and Deployment

- [ ] **10.0 Document Deployment Process and Monitoring**
  - **Effort**: Small (1 hour)
  - **Dependencies**: All implementation and testing complete
  - **Acceptance Criteria**:
    - [ ] Deployment checklist created
    - [ ] Post-deployment verification steps documented
    - [ ] Monitoring instructions provided
    - [ ] Troubleshooting guide for common issues
    - [ ] Documentation in project repo or wiki
  - [ ] 10.1 Create deployment checklist
    - **File**: Create `/home/hamr/PycharmProjects/gitdone/docs/DEPLOYMENT_STATS_FEATURE.md`
    - Include pre-deployment checks:
      - [ ] All tests passing locally (unit, integration, component)
      - [ ] No console errors or warnings
      - [ ] Code review completed
      - [ ] `.gitignore` includes `/data/stats.json`
    - Include deployment steps (staging):
      - [ ] Deploy code to staging environment
      - [ ] Run `npm install` in backend to ensure node-cron installed
      - [ ] Restart backend service
      - [ ] Verify scheduler started (check logs for scheduler message)
      - [ ] Verify GET /api/stats endpoint responds (curl or Postman)
      - [ ] Verify POST /api/stats/refresh endpoint responds
      - [ ] Monitor logs for 24 hours to ensure 4 scheduled runs
    - Include post-deployment verification:
      - [ ] Check `/data/stats.json` file exists and is valid JSON
      - [ ] Verify last_updated timestamp is recent
      - [ ] Verify current_metrics reflect actual event counts
      - [ ] Landing page loads without errors
      - [ ] StatsTable component visible and renders data
      - [ ] Test on mobile and desktop browsers
    - **Acceptance**:
      - [ ] Comprehensive checklist created
      - [ ] All steps clear and actionable
  - [ ] 10.2 Create monitoring guidelines
    - Include in same deployment doc:
      - [ ] **What to monitor**:
        - `last_refresh_duration_ms` (should be < 5 seconds)
        - Frequency of successful aggregations (expect 4 per day)
        - Any error logs from scheduler
        - API endpoint response times
      - [ ] **Where to look**:
        - Server logs (look for `[Stats Scheduler]` prefix)
        - `/data/stats.json` file (check last_updated timestamp)
        - Browser console (for frontend errors)
        - Network tab (for API response times)
      - [ ] **Alert conditions**:
        - Aggregation duration > 10 seconds (investigate performance)
        - Scheduled job skipped (check server logs)
        - API endpoint returning errors (check file I/O)
        - `last_updated` older than 12 hours (scheduler may be stopped)
    - **Acceptance**:
      - [ ] Monitoring points documented
      - [ ] Alert thresholds defined
  - [ ] 10.3 Create troubleshooting guide
    - Include common issues and solutions:
      - [ ] **Issue: Scheduler not running**
        - Check: Server logs for `[Stats Scheduler] Started` message
        - Check: `server.js` has `startScheduler()` call
        - Solution: Restart backend server
      - [ ] **Issue: /api/stats returns error**
        - Check: `/data/events/` directory exists
        - Check: `/data/` directory is writable
        - Solution: Verify permissions, restart server
      - [ ] **Issue: Stats.json is very old**
        - Check: Last aggregation timestamp in file
        - Check: Scheduler logs for errors
        - Solution: Manual refresh via POST /api/stats/refresh
      - [ ] **Issue: Metrics seem incorrect**
        - Check: Event files in `/data/events/` are valid JSON
        - Check: Event step status values are "pending" or "completed"
        - Solution: Manual refresh, check event file format
      - [ ] **Issue: Monthly record not created**
        - Check: Current date is past end of month
        - Check: Check /data/stats.json for existing records
        - Solution: Month record created only at month transition—wait or manual refresh
    - **Acceptance**:
      - [ ] Common issues covered
      - [ ] Solutions actionable
  - [ ] 10.4 Document rollback procedure
    - Include:
      - [ ] If feature breaks landing page: remove StatsTable import from page.tsx, redeploy
      - [ ] If scheduler causes issues: comment out `startScheduler()` call in server.js, redeploy
      - [ ] If stats.json corrupted: delete file, manual refresh will recreate
      - [ ] Full rollback: revert git commit and redeploy previous version
    - **Acceptance**:
      - [ ] Clear rollback path documented
  - [ ] 10.5 Create performance baseline documentation
    - Include:
      - [ ] Baseline aggregation time with N events (e.g., 100 events = 234ms)
      - [ ] Baseline API response time (< 100ms for GET, < 5s for POST)
      - [ ] Baseline page load time impact (landing page + stats should be < 2s)
      - [ ] Future: Monitor these metrics post-deployment
    - **Acceptance**:
      - [ ] Baselines established
      - [ ] Comparison points for future versions

- [ ] **11.0 Final QA and Code Review**
  - **Effort**: Medium (2 hours)
  - **Dependencies**: All implementation, testing, documentation complete
  - **Acceptance Criteria**:
    - [ ] All code follows project conventions
    - [ ] No linting errors or warnings
    - [ ] No console errors or deprecation warnings
    - [ ] All unit and integration tests pass (100% pass rate)
    - [ ] Code review approved by team lead
    - [ ] All acceptance criteria from PRD met
  - [ ] 11.1 Run linting and type checking
    - **Backend**:
      - [ ] No Node.js linting errors
      - [ ] Consistent code style with existing routes/utils
    - **Frontend**:
      - [ ] No TypeScript errors: `npm run type-check` (if configured)
      - [ ] Consistent code style with existing components
    - **Acceptance**:
      - [ ] Zero linting/type errors
  - [ ] 11.2 Run full test suite
    - **Backend**: `npm test` in `/backend` directory
      - [ ] All unit tests pass
      - [ ] All integration tests pass
      - [ ] Coverage report > 80%
    - **Frontend**: `npm test` in `/frontend` directory
      - [ ] All component tests pass
      - [ ] Coverage > 70% for StatsTable component
    - **Acceptance**:
      - [ ] All tests passing
      - [ ] Coverage targets met
  - [ ] 11.3 Manual testing on local environment
    - **Setup**:
      - [ ] Create 50+ test event files in `/data/events/` (with mix of completed/pending steps)
      - [ ] Delete `/data/stats.json` (test creation)
    - **Test Scenarios**:
      - [ ] Start backend server: `npm start` → verify scheduler logs appear
      - [ ] Verify `/data/stats.json` created automatically (manual refresh or wait 6 hours)
      - [ ] Test GET /api/stats: curl and verify response
      - [ ] Test POST /api/stats/refresh: curl and verify aggregation runs
      - [ ] Test landing page: navigate to http://localhost:3000
      - [ ] Verify StatsTable displays at bottom with correct data
      - [ ] Verify loading state works (add slight network delay in DevTools)
      - [ ] Verify error state (mock API failure in browser DevTools)
      - [ ] Test on mobile viewport (DevTools mobile emulation)
      - [ ] Verify responsive layout correct
    - **Acceptance**:
      - [ ] All manual tests pass
      - [ ] No unexpected behaviors
  - [ ] 11.4 Code review checklist
    - **Functionality**:
      - [ ] All 4 metrics calculated correctly
      - [ ] Monthly records created per PRD rules
      - [ ] Background scheduler runs at correct times
      - [ ] API endpoints return correct responses
      - [ ] Frontend displays stats correctly
    - **Code Quality**:
      - [ ] Code is readable and well-commented
      - [ ] Error handling is comprehensive
      - [ ] No console logs left for debugging (use appropriate log levels)
      - [ ] No hardcoded values (use constants or config)
      - [ ] DRY principle followed (no duplicated code)
    - **Testing**:
      - [ ] Unit tests cover all aggregation logic
      - [ ] Integration tests cover all API endpoints
      - [ ] Edge cases tested
      - [ ] Error scenarios tested
    - **Performance**:
      - [ ] Aggregation < 5 seconds for 1000 events
      - [ ] API responses < 100ms (GET) and < 10s (POST)
      - [ ] No performance regression on landing page
    - **Security**:
      - [ ] No authentication bypass
      - [ ] Endpoints handle malformed input gracefully
      - [ ] No sensitive data logged
    - **Acceptance**:
      - [ ] Code review feedback incorporated
      - [ ] Approval obtained

- [ ] **12.0 Prepare for Production Deployment**
  - **Effort**: Small (1 hour)
  - **Dependencies**: 11.0 QA complete, approval obtained
  - **Acceptance Criteria**:
    - [ ] Staging environment tested for 24+ hours
    - [ ] Production deployment scheduled
    - [ ] Team notified of deployment
    - [ ] Rollback plan clear to team
  - [ ] 12.1 Final staging verification
    - [ ] Deploy to staging environment
    - [ ] Run full manual QA on staging
    - [ ] Verify stats aggregation on schedule for 24 hours
      - [ ] 4 scheduled runs expected in 24 hours
      - [ ] Each run completes successfully (check logs)
      - [ ] Stats.json updates each time
    - [ ] Load test (optional—monitor with higher event count)
    - [ ] Verify no performance regressions on landing page
    - **Acceptance**:
      - [ ] Staging stable for 24+ hours
      - [ ] No errors or warnings
  - [ ] 12.2 Prepare deployment communication
    - **Create deployment announcement** for team/users:
      - [ ] Feature description (new stats dashboard)
      - [ ] User-facing changes (landing page update)
      - [ ] Expected behavior (stats update every 6 hours)
      - [ ] No user action required
      - [ ] Timeline (deployment date/time)
    - **Acceptance**:
      - [ ] Communication prepared
  - [ ] 12.3 Brief team on rollback procedures
    - **Team Meeting**:
      - [ ] Walk through rollback procedure
      - [ ] Identify rollback triggers (e.g., if 500 errors spike)
      - [ ] Assign rollback executor
      - [ ] Confirm monitoring setup
    - **Acceptance**:
      - [ ] Team understands rollback procedure
      - [ ] Roles assigned
  - [ ] 12.4 Execute production deployment
    - **Deployment Steps**:
      - [ ] Notify team/users of maintenance window (if needed)
      - [ ] Deploy code to production
      - [ ] Run `npm install` in backend
      - [ ] Restart backend service (PM2 restart or equivalent)
      - [ ] Verify scheduler started in logs
      - [ ] Verify `/api/stats` endpoint responds
      - [ ] Verify landing page loads and displays stats
      - [ ] Monitor logs for 2+ hours post-deployment
      - [ ] Resolve any critical issues (or rollback if necessary)
    - **Acceptance**:
      - [ ] Deployment successful
      - [ ] No critical errors
      - [ ] Users report feature working

---

## Testing Strategy Summary

### Test Coverage by Layer

| Layer | Test Type | Coverage Target | Key Scenarios |
|-------|-----------|-----------------|----------------|
| **Aggregator Logic** | Unit Tests | 80%+ | Metrics calculation, edge cases, monthly records |
| **API Routes** | Integration Tests | 70%+ | Request/response format, error handling, mocking |
| **React Component** | Component Tests | 70%+ | Rendering, loading/error states, data display |
| **End-to-End** | Manual Testing | N/A | Full workflow from landing page to stats display |

### Performance Requirements

| Operation | Target | Measured By |
|-----------|--------|-------------|
| Aggregation (1000 events) | < 5 seconds | `last_refresh_duration_ms` in stats.json |
| GET /api/stats | < 100ms | API response time |
| POST /api/stats/refresh | < 10 seconds | API response time |
| Landing page load (with stats) | < 2 seconds | Browser DevTools Network tab |

### Acceptance Criteria Traceability

All PRD acceptance criteria (AC1-AC10) are covered by tasks:
- **AC1** (Aggregation Accuracy): Tasks 2.1, 7.2-7.5
- **AC2** (Data Storage): Tasks 2.1, 2.3, 7.6
- **AC3** (GET /api/stats): Tasks 4.2, 8.2-8.3
- **AC4** (POST /api/stats/refresh): Tasks 4.3, 8.5-8.6
- **AC5** (Background Scheduler): Tasks 3.0, 3.2-3.3
- **AC6** (Monthly Records): Tasks 2.2, 7.7
- **AC7** (Landing Page Display): Tasks 5.0, 6.0, 9.0
- **AC8** (Error Handling): Tasks 2.1, 4.0, 7.6, 8.0
- **AC9** (Performance): Tasks 7.8, 8.7, 10.2
- **AC10** (Code Quality): Tasks 11.0, 11.4

---

## Task Sequence Recommendations

### Recommended Implementation Order

1. **Phase 1 (Infrastructure)**: 1.0 → 2.0 → 3.0 → 4.0
   - Setup dependencies, then core logic, then scheduler, then routes
   - Parallelizable: 2.0 and 3.0 can be worked simultaneously

2. **Phase 2 (Frontend)**: 5.0 → 6.0 (after 4.0 complete)
   - Create component first, then integrate into page
   - Requires working API endpoints from Phase 1

3. **Phase 3 (Testing)**: 7.0 → 8.0 → 9.0 (can start after each phase)
   - 7.0 tests can start after 2.0 complete (doesn't depend on API)
   - 8.0 tests require 4.0
   - 9.0 requires 6.0 and working backend

4. **Phase 4 (Finalization)**: 10.0 → 11.0 → 12.0
   - Documentation after implementation
   - QA after all code complete
   - Deployment after QA approval

---

## Estimated Total Effort

- **Phase 1**: 6-7 hours (infrastructure)
- **Phase 2**: 2-2.5 hours (frontend)
- **Phase 3**: 5-6 hours (testing)
- **Phase 4**: 4-5 hours (documentation, QA, deployment)

**Total**: 17-21 hours (assuming 1-2 senior developers + 1-2 junior developers with mentoring)

**Note**: Estimates assume some parallelization (e.g., 2.0 and 3.0 simultaneously, frontend work while others test).

---

## Dependencies and Blockers

- **None**: Phase 1 can begin immediately after PRD approval
- **Internal**: Phase 2 blocked until Phase 1 complete
- **Internal**: Phase 3 can start in parallel with later Phase 1 tasks
- **Internal**: Phase 4 requires Phase 1-3 complete
- **External**: None (no new third-party integrations, existing Express + Node.js setup sufficient)

---

## Success Criteria (Go/No-Go for Production)

- [ ] All unit tests passing (80%+ coverage)
- [ ] All integration tests passing
- [ ] All component tests passing
- [ ] Manual QA on staging for 24+ hours—no errors
- [ ] Performance baselines met (aggregation < 5s, APIs < benchmarks)
- [ ] Code review approved
- [ ] Deployment procedure documented and team trained
- [ ] Rollback procedure tested and understood by team

---

**End of Detailed Task Breakdown**

Generated from PRD: `/home/hamr/PycharmProjects/gitdone/tasks/0001-prd-event-aggregation-dashboard.md`

For questions or clarifications, refer to the PRD or project CLAUDE.md documentation.
