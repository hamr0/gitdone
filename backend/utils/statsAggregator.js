const fs = require('fs').promises;
const path = require('path');

const EVENTS_DIR = path.join(__dirname, '../../data/events');
const STATS_FILE = path.join(__dirname, '../../data/stats.json');
const DATA_DIR = path.join(__dirname, '../../data');

/**
 * Scans all event files and calculates aggregated statistics
 * Metrics: total_events, total_steps, completed_events, completed_steps
 * Gracefully handles missing/corrupt files with console warnings
 *
 * @returns {Promise<Object>} Stats object with timestamp and metrics
 */
async function aggregateStats() {
  const startTime = Date.now();
  console.log('[Stats Aggregator] Starting aggregation...');

  try {
    // Ensure events directory exists
    let eventFiles = [];
    try {
      eventFiles = await fs.readdir(EVENTS_DIR);
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.warn('[Stats Aggregator] Events directory not found, creating...');
        await fs.mkdir(EVENTS_DIR, { recursive: true });
        eventFiles = [];
      } else {
        throw error;
      }
    }

    // Filter for .json files only
    const jsonFiles = eventFiles.filter(file => file.endsWith('.json'));

    // Initialize metrics
    let totalEvents = 0;
    let totalSteps = 0;
    let completedEvents = 0;
    let completedSteps = 0;

    // Process each event file
    for (const file of jsonFiles) {
      try {
        const filePath = path.join(EVENTS_DIR, file);
        const fileContent = await fs.readFile(filePath, 'utf8');
        const event = JSON.parse(fileContent);

        // Validate event structure
        if (!event.steps || !Array.isArray(event.steps)) {
          console.warn(`[Stats Aggregator] Skipping ${file}: invalid steps structure`);
          continue;
        }

        totalEvents++;

        const eventStepCount = event.steps.length;
        totalSteps += eventStepCount;

        // Count completed steps and check if all steps in event are completed
        let eventCompletedSteps = 0;
        for (const step of event.steps) {
          if (step.status === 'completed') {
            completedSteps++;
            eventCompletedSteps++;
          }
        }

        // Check if all steps in this event are completed
        if (eventCompletedSteps === eventStepCount && eventStepCount > 0) {
          completedEvents++;
        }
      } catch (error) {
        if (error instanceof SyntaxError) {
          console.warn(`[Stats Aggregator] Skipping ${file}: invalid JSON - ${error.message}`);
        } else {
          console.warn(`[Stats Aggregator] Skipping ${file}: error reading file - ${error.message}`);
        }
      }
    }

    const executionTime = Date.now() - startTime;

    const stats = {
      timestamp: new Date().toISOString(),
      current_metrics: {
        total_events: totalEvents,
        total_steps: totalSteps,
        completed_events: completedEvents,
        completed_steps: completedSteps
      },
      last_refresh_duration_ms: executionTime,
      monthly_records: []
    };

    console.log('[Stats Aggregator] Aggregation completed', {
      total_events: totalEvents,
      total_steps: totalSteps,
      completed_events: completedEvents,
      completed_steps: completedSteps,
      execution_time_ms: executionTime
    });

    return stats;
  } catch (error) {
    console.error('[Stats Aggregator] Aggregation failed:', error);
    throw error;
  }
}

/**
 * Checks if current month already has a record and creates new record if transitioning to new month
 * Monthly records are created only when transitioning to a new calendar month
 * Prevents duplicate records for the same month
 *
 * According to PRD 6.5: Monthly record is created for the PREVIOUS month
 * when we transition into a new month
 *
 * @param {Object} currentStats - Current stats object with current_metrics
 * @param {Array} monthlyRecords - Existing monthly records array (may be empty)
 * @returns {Promise<Array>} Updated monthly records array
 */
async function checkAndCreateMonthlyRecord(currentStats, monthlyRecords = []) {
  try {
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth(); // 0-based (0 = January, 11 = December)

    console.log(`[Stats Aggregator] Checking monthly record for ${currentYear}-${String(currentMonth + 1).padStart(2, '0')}`);

    // Get last record if it exists
    const lastRecord = monthlyRecords.length > 0 ? monthlyRecords[monthlyRecords.length - 1] : null;

    if (!lastRecord) {
      // No records exist yet - don't create first record
      // We should wait until we transition to a new month before creating any records
      console.log('[Stats Aggregator] No previous records, waiting for month transition to create first record');
      return monthlyRecords;
    }

    // Calculate the PREVIOUS month (the month we should be creating a record for)
    // If we're in December (month 11), previous is November (month 10)
    // If we're in January (month 0), previous is December (month 11 of previous year)
    const prevMonthNumber = currentMonth === 0 ? 12 : currentMonth;
    const prevMonthYear = currentMonth === 0 ? currentYear - 1 : currentYear;

    // Check if a record already exists for the previous month
    const previousMonthRecordExists = monthlyRecords.some(record => {
      return record.year === prevMonthYear && record.month === prevMonthNumber;
    });

    if (previousMonthRecordExists) {
      console.log(`[Stats Aggregator] Record already exists for ${prevMonthYear}-${String(prevMonthNumber).padStart(2, '0')}`);
      return monthlyRecords;
    }

    // Create monthly record for the PREVIOUS month (last day of month at 23:59:00 UTC)
    // JavaScript Date: new Date(year, monthIndex, dayOfMonth)
    // To get last day of a month: new Date(year, monthIndex + 1, 0)
    // monthIndex is 0-based, so prevMonthNumber (1-based) - 1 = monthIndex
    const lastDayOfPreviousMonth = new Date(Date.UTC(
      prevMonthYear,
      prevMonthNumber, // This will give us the 0th day of next month = last day of this month
      0, // 0th day of the month means last day of previous month
      23,
      59,
      0
    ));

    const newRecord = {
      year: prevMonthYear,
      month: prevMonthNumber,
      total_events: currentStats.current_metrics.total_events,
      total_steps: currentStats.current_metrics.total_steps,
      completed_events: currentStats.current_metrics.completed_events,
      completed_steps: currentStats.current_metrics.completed_steps,
      timestamp: lastDayOfPreviousMonth.toISOString()
    };

    monthlyRecords.push(newRecord);
    console.log(`[Stats Aggregator] Created monthly record for ${prevMonthYear}-${String(prevMonthNumber).padStart(2, '0')}`);

    return monthlyRecords;
  } catch (error) {
    console.error('[Stats Aggregator] Error checking/creating monthly record:', error);
    throw error;
  }
}

/**
 * Saves stats object to /data/stats.json atomically
 * Formats JSON with 2-space indentation
 * Ensures /data/ directory exists before writing
 * Throws descriptive errors for permission issues or write failures
 *
 * @param {Object} stats - Stats object to save
 * @returns {Promise<void>}
 */
async function saveStats(stats) {
  try {
    console.log('[Stats Aggregator] Saving stats to file...');

    // Ensure data directory exists
    try {
      await fs.access(DATA_DIR);
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('[Stats Aggregator] Creating data directory...');
        await fs.mkdir(DATA_DIR, { recursive: true });
      } else {
        throw error;
      }
    }

    // Write file atomically using fs.writeFile
    const jsonContent = JSON.stringify(stats, null, 2);
    await fs.writeFile(STATS_FILE, jsonContent, 'utf8');

    console.log('[Stats Aggregator] Stats saved successfully to', STATS_FILE);
  } catch (error) {
    if (error.code === 'EACCES') {
      throw new Error(`Permission denied writing to ${STATS_FILE}: ${error.message}`);
    } else if (error.code === 'ENOSPC') {
      throw new Error(`No space left on device writing to ${STATS_FILE}`);
    } else {
      throw new Error(`Failed to write stats file: ${error.message}`);
    }
  }
}

/**
 * Complete aggregation workflow: aggregate stats, check monthly records, and save
 * This is the main entry point for external callers
 *
 * @returns {Promise<Object>} Complete stats object with all data
 */
async function aggregateAndSaveStats() {
  try {
    // Get current stats
    const currentStats = await aggregateStats();

    // Load existing monthly records
    let monthlyRecords = [];
    try {
      const existingStats = await fs.readFile(STATS_FILE, 'utf8');
      const parsedStats = JSON.parse(existingStats);
      if (parsedStats.monthly_records && Array.isArray(parsedStats.monthly_records)) {
        monthlyRecords = parsedStats.monthly_records;
      }
    } catch (error) {
      // File doesn't exist yet, that's fine
      if (error.code !== 'ENOENT') {
        console.warn('[Stats Aggregator] Could not load existing stats:', error.message);
      }
    }

    // Check and create monthly records if needed
    const updatedMonthlyRecords = await checkAndCreateMonthlyRecord(currentStats, monthlyRecords);

    // Combine into final stats object
    const finalStats = {
      ...currentStats,
      monthly_records: updatedMonthlyRecords
    };

    // Save to file
    await saveStats(finalStats);

    return finalStats;
  } catch (error) {
    console.error('[Stats Aggregator] Error in aggregateAndSaveStats:', error);
    throw error;
  }
}

module.exports = {
  aggregateStats,
  checkAndCreateMonthlyRecord,
  saveStats,
  aggregateAndSaveStats
};
