const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const { aggregateAndSaveStats } = require('../utils/statsAggregator');

const STATS_FILE = path.join(__dirname, '../../data/stats.json');

/**
 * GET /api/stats
 * Retrieves cached statistics from stats.json
 * Returns current metrics and historical monthly records
 *
 * Response on success (HTTP 200):
 * {
 *   success: true,
 *   last_updated: ISO 8601 timestamp,
 *   current_metrics: { total_events, total_steps, completed_events, completed_steps },
 *   monthly_records: [ { year, month, total_events, total_steps, completed_events, completed_steps, timestamp } ]
 * }
 *
 * Response on fallback (stats.json missing, HTTP 200):
 * {
 *   success: true,
 *   last_updated: null,
 *   current_metrics: { total_events: 0, total_steps: 0, completed_events: 0, completed_steps: 0 },
 *   monthly_records: []
 * }
 *
 * Response on error (HTTP 500):
 * {
 *   success: false,
 *   error: "Error message"
 * }
 */
router.get('/', async (req, res) => {
  try {
    const startTime = Date.now();

    try {
      const statsData = await fs.readFile(STATS_FILE, 'utf8');
      const stats = JSON.parse(statsData);

      res.json({
        success: true,
        last_updated: stats.timestamp,
        current_metrics: stats.current_metrics,
        monthly_records: stats.monthly_records || [],
        response_time_ms: Date.now() - startTime
      });
    } catch (error) {
      // File not found or parse error - return zeros (fallback)
      if (error.code === 'ENOENT' || error instanceof SyntaxError) {
        res.json({
          success: true,
          last_updated: null,
          current_metrics: {
            total_events: 0,
            total_steps: 0,
            completed_events: 0,
            completed_steps: 0
          },
          monthly_records: [],
          response_time_ms: Date.now() - startTime
        });
      } else {
        // Other read errors
        throw error;
      }
    }
  } catch (error) {
    console.error('[Stats API] GET /api/stats error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/stats/refresh
 * Manually triggers statistics aggregation and saves results
 * Useful for immediate updates without waiting for scheduled job
 *
 * Response on success (HTTP 200):
 * {
 *   success: true,
 *   message: "Statistics refreshed successfully",
 *   refresh_duration_ms: number,
 *   metrics: { current_metrics: {...}, monthly_records: [...] },
 *   next_scheduled_refresh: ISO 8601 timestamp of next scheduled run
 * }
 *
 * Response on error (HTTP 500):
 * {
 *   success: false,
 *   error: "Error message",
 *   error_code: "CODE_IDENTIFIER"
 * }
 */
router.post('/refresh', async (req, res) => {
  try {
    const startTime = Date.now();

    try {
      // Call aggregation and save
      const stats = await aggregateAndSaveStats();
      const refreshDuration = Date.now() - startTime;

      // Calculate next scheduled refresh
      // Scheduler runs at 00:00, 06:00, 12:00, 18:00 UTC
      const now = new Date();
      const currentHour = now.getUTCHours();
      let nextHour;

      if (currentHour < 6) {
        nextHour = 6;
      } else if (currentHour < 12) {
        nextHour = 12;
      } else if (currentHour < 18) {
        nextHour = 18;
      } else {
        nextHour = 0; // Next day at 00:00
      }

      const nextRefresh = new Date(now);
      nextRefresh.setUTCHours(nextHour, 0, 0, 0);

      if (nextHour === 0 && currentHour >= 18) {
        // Move to next day
        nextRefresh.setUTCDate(nextRefresh.getUTCDate() + 1);
      }

      res.json({
        success: true,
        message: 'Statistics refreshed successfully',
        refresh_duration_ms: refreshDuration,
        metrics: {
          current_metrics: stats.current_metrics,
          monthly_records: stats.monthly_records || []
        },
        next_scheduled_refresh: nextRefresh.toISOString()
      });
    } catch (error) {
      // Categorize error for better debugging
      let errorCode = 'AGGREGATION_ERROR';

      if (error.message.includes('Permission denied')) {
        errorCode = 'FILE_WRITE_ERROR';
      } else if (error.message.includes('No space left')) {
        errorCode = 'NO_SPACE_ERROR';
      } else if (error.message.includes('Events directory')) {
        errorCode = 'EVENTS_DIR_READ_ERROR';
      }

      throw {
        message: error.message,
        code: errorCode
      };
    }
  } catch (error) {
    console.error('[Stats API] POST /api/stats/refresh error:', error);

    const errorCode = error.code || 'REFRESH_ERROR';
    const errorMessage = error.message || 'Failed to refresh statistics';

    res.status(500).json({
      success: false,
      error: errorMessage,
      error_code: errorCode
    });
  }
});

module.exports = router;
