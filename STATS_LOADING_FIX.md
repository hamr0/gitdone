# Stats Loading Fix - Complete Resolution

## Problem
The frontend was unable to fetch platform statistics, displaying an error "Failed to fetch stats" and showing zeros for all metrics (Total Events, Total Steps, Completed Events, Completed Steps).

## Root Cause
The frontend (`localhost:3000`) was making relative fetch requests to `/api/stats`, which the browser resolved to `http://localhost:3000/api/stats` (the frontend's own port) instead of `http://localhost:3001/api/stats` (where the backend API runs).

Since there's no `/api/stats` endpoint on the frontend server, the fetch would fail, triggering the error state and fallback display of zeros.

## Solution
Configure the frontend to use the correct backend API URL through environment variables.

### For Development

1. Create `.env.local` in the `frontend/` directory:
```bash
cd frontend
echo "NEXT_PUBLIC_API_BASE_URL=http://localhost:3001" > .env.local
```

2. Restart the frontend development server:
```bash
npm run dev
```

The stats will now load correctly on `http://localhost:3000`.

### For Production

Set the environment variable before starting the application:
```bash
export NEXT_PUBLIC_API_BASE_URL=https://api.yourdomain.com
npm run build
npm start
```

Or in your `.env.production.local` file:
```
NEXT_PUBLIC_API_BASE_URL=https://api.yourdomain.com
```

## Code Changes

### File: `frontend/src/app/page.tsx`

**Before:**
```typescript
const response = await fetch('/api/stats');
```

**After:**
```typescript
const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3001';
const response = await fetch(`${apiBaseUrl}/api/stats`);
```

This uses the `NEXT_PUBLIC_API_BASE_URL` environment variable if set, otherwise defaults to `http://localhost:3001`.

## Verification

After setup, you should see:

1. **Loading spinner** briefly appears when page loads
2. **Stats load successfully** with actual values:
   - Total Events: 64
   - Total Steps: 186
   - Completed Events: 23
   - Completed Steps: 106
3. **Last updated** timestamp displays

If stats still show zeros:
1. Check that backend is running on port 3001
2. Verify `.env.local` exists with correct URL
3. Check browser console for network errors (F12 → Network tab)
4. Ensure both frontend and backend servers are running

## Environment Configuration

| Environment | URL | Setup |
|---|---|---|
| Local Development | `http://localhost:3001` | `.env.local` file |
| Docker Development | `http://backend:3001` | Docker service name |
| Production | `https://api.yourdomain.com` | Environment variable |

The `NEXT_PUBLIC_` prefix means this variable is exposed to the browser (safe since it only contains the API URL, no secrets).

## Files Changed
- `frontend/src/app/page.tsx` - Updated fetchStats() to use environment variable
- `frontend/.env.local` - Created with local development URL (not in git)
- `frontend/.env.example` - Documentation template (for reference)

## Status
✅ **FIXED** - Frontend now correctly fetches stats from backend API
