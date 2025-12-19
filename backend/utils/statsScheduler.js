const cron = require('node-cron');
const { aggregateStats } = require('./statsAggregator');

/**
 * Starts a background scheduler to run stats aggregation every 6 hours
 * Schedule: 00:00, 06:00, 12:00, 18:00 UTC
 * Cron pattern: '0 0,6,12,18 * * *'
 *   - Minute: 0
 *   - Hour: 0,6,12,18 (four times daily)
 *   - Day, Month, Day-of-week: * (daily)
 *
 * Errors are caught and logged but do NOT crash the scheduler
 */
function startScheduler() {
  const cronPattern = '0 0,6,12,18 * * *';

  const task = cron.schedule(cronPattern, async () => {
    const now = new Date();
    const hours = String(now.getUTCHours()).padStart(2, '0');
    const minutes = String(now.getUTCMinutes()).padStart(2, '0');

    try {
      await aggregateStats();
      console.log(`[Stats Scheduler] ✓ Aggregation completed at ${hours}:${minutes} UTC`);
    } catch (error) {
      console.error(`[Stats Scheduler] Error during aggregation at ${hours}:${minutes} UTC:`, error.message);
      // Do NOT throw—scheduler should continue running
    }
  });

  return task;
}

module.exports = { startScheduler };
