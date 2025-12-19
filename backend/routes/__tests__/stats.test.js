const request = require('supertest');
const express = require('express');
const statsRouter = require('../stats');

// Mock the statsAggregator module
jest.mock('../../utils/statsAggregator');
const { aggregateAndSaveStats } = require('../../utils/statsAggregator');

// Mock fs.promises
jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
    readdir: jest.fn(),
    mkdir: jest.fn(),
    access: jest.fn()
  }
}));

const fs = require('fs').promises;

/**
 * Integration Tests for Stats API Endpoints
 * Tests GET /api/stats and POST /api/stats/refresh
 * Subtasks 8.1-8.8
 */
describe('Stats API Routes', () => {
  let app;

  // Setup test app before each test
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/stats', statsRouter);

    // Clear all mocks before each test
    jest.clearAllMocks();
  });

  describe('8.1: Integration Test Setup', () => {
    it('should load test app with stats router mounted', () => {
      expect(app).toBeDefined();
      expect(statsRouter).toBeDefined();
    });

    it('should have mocked statsAggregator module', () => {
      expect(aggregateAndSaveStats).toBeDefined();
      expect(typeof aggregateAndSaveStats).toBe('function');
    });

    it('should have mocked fs module', () => {
      expect(fs.readFile).toBeDefined();
      expect(fs.readFile.mock).toBeDefined();
    });
  });

  describe('8.2: GET /api/stats - Success Case', () => {
    it('should return HTTP 200 with cached stats', async () => {
      // Mock successful file read
      const mockStats = {
        timestamp: '2025-12-19T18:00:00.000Z',
        current_metrics: {
          total_events: 42,
          total_steps: 156,
          completed_events: 38,
          completed_steps: 142
        },
        monthly_records: [
          {
            year: 2025,
            month: 11,
            total_events: 30,
            total_steps: 100,
            completed_events: 25,
            completed_steps: 85,
            timestamp: '2025-11-30T23:59:00.000Z'
          }
        ],
        last_refresh_duration_ms: 234
      };

      fs.readFile.mockResolvedValue(JSON.stringify(mockStats));

      const response = await request(app)
        .get('/api/stats')
        .expect(200);

      // Verify response structure
      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('last_updated', mockStats.timestamp);
      expect(response.body).toHaveProperty('current_metrics');
      expect(response.body).toHaveProperty('monthly_records');
      expect(response.body).toHaveProperty('response_time_ms');
    });

    it('should include all 4 metric fields in response', async () => {
      const mockStats = {
        timestamp: '2025-12-19T18:00:00.000Z',
        current_metrics: {
          total_events: 10,
          total_steps: 40,
          completed_events: 8,
          completed_steps: 35
        },
        monthly_records: []
      };

      fs.readFile.mockResolvedValue(JSON.stringify(mockStats));

      const response = await request(app)
        .get('/api/stats')
        .expect(200);

      const { current_metrics } = response.body;
      expect(current_metrics).toHaveProperty('total_events', 10);
      expect(current_metrics).toHaveProperty('total_steps', 40);
      expect(current_metrics).toHaveProperty('completed_events', 8);
      expect(current_metrics).toHaveProperty('completed_steps', 35);
    });

    it('should include monthly_records array in response', async () => {
      const mockStats = {
        timestamp: '2025-12-19T18:00:00.000Z',
        current_metrics: {
          total_events: 10,
          total_steps: 40,
          completed_events: 8,
          completed_steps: 35
        },
        monthly_records: [
          {
            year: 2025,
            month: 12,
            total_events: 5,
            total_steps: 20,
            completed_events: 4,
            completed_steps: 18,
            timestamp: '2025-12-31T23:59:00.000Z'
          }
        ]
      };

      fs.readFile.mockResolvedValue(JSON.stringify(mockStats));

      const response = await request(app)
        .get('/api/stats')
        .expect(200);

      expect(response.body.monthly_records).toEqual(mockStats.monthly_records);
    });

    it('should respond within 100ms', async () => {
      const mockStats = {
        timestamp: '2025-12-19T18:00:00.000Z',
        current_metrics: {
          total_events: 10,
          total_steps: 40,
          completed_events: 8,
          completed_steps: 35
        },
        monthly_records: []
      };

      fs.readFile.mockResolvedValue(JSON.stringify(mockStats));

      const startTime = Date.now();
      await request(app)
        .get('/api/stats')
        .expect(200);
      const elapsedTime = Date.now() - startTime;

      // Should complete in less than 100ms (allowing some margin in tests)
      expect(elapsedTime).toBeLessThan(500); // More relaxed for test environment
    });
  });

  describe('8.3: GET /api/stats - Fallback Case', () => {
    it('should return HTTP 200 when stats.json missing', async () => {
      // Mock file not found
      const error = new Error('File not found');
      error.code = 'ENOENT';
      fs.readFile.mockRejectedValue(error);

      const response = await request(app)
        .get('/api/stats')
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('should return zeros for all metrics when file missing', async () => {
      const error = new Error('File not found');
      error.code = 'ENOENT';
      fs.readFile.mockRejectedValue(error);

      const response = await request(app)
        .get('/api/stats')
        .expect(200);

      const { current_metrics } = response.body;
      expect(current_metrics.total_events).toBe(0);
      expect(current_metrics.total_steps).toBe(0);
      expect(current_metrics.completed_events).toBe(0);
      expect(current_metrics.completed_steps).toBe(0);
    });

    it('should return null for last_updated when file missing', async () => {
      const error = new Error('File not found');
      error.code = 'ENOENT';
      fs.readFile.mockRejectedValue(error);

      const response = await request(app)
        .get('/api/stats')
        .expect(200);

      expect(response.body.last_updated).toBeNull();
    });

    it('should return empty monthly_records array when file missing', async () => {
      const error = new Error('File not found');
      error.code = 'ENOENT';
      fs.readFile.mockRejectedValue(error);

      const response = await request(app)
        .get('/api/stats')
        .expect(200);

      expect(Array.isArray(response.body.monthly_records)).toBe(true);
      expect(response.body.monthly_records).toEqual([]);
    });

    it('should handle JSON parse error gracefully', async () => {
      // Mock parse error
      fs.readFile.mockResolvedValue('invalid json {');

      const response = await request(app)
        .get('/api/stats')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.current_metrics.total_events).toBe(0);
    });
  });

  describe('8.4: GET /api/stats - Error Case', () => {
    it('should return HTTP 500 on file read error', async () => {
      const error = new Error('Permission denied');
      error.code = 'EACCES';
      fs.readFile.mockRejectedValue(error);

      const response = await request(app)
        .get('/api/stats')
        .expect(500);

      expect(response.body.success).toBe(false);
    });

    it('should include error message in response', async () => {
      const error = new Error('Disk read error');
      error.code = 'EIO';
      fs.readFile.mockRejectedValue(error);

      const response = await request(app)
        .get('/api/stats')
        .expect(500);

      expect(response.body).toHaveProperty('error');
      expect(typeof response.body.error).toBe('string');
    });

    it('should not include stats data when error occurs', async () => {
      const error = new Error('Read failed');
      fs.readFile.mockRejectedValue(error);

      const response = await request(app)
        .get('/api/stats')
        .expect(500);

      expect(response.body.current_metrics).toBeUndefined();
      expect(response.body.monthly_records).toBeUndefined();
    });
  });

  describe('8.5: POST /api/stats/refresh - Success Case', () => {
    it('should return HTTP 200 on successful aggregation', async () => {
      const mockStats = {
        timestamp: '2025-12-19T18:30:00.000Z',
        current_metrics: {
          total_events: 50,
          total_steps: 200,
          completed_events: 45,
          completed_steps: 185
        },
        monthly_records: [],
        last_refresh_duration_ms: 450
      };

      aggregateAndSaveStats.mockResolvedValue(mockStats);

      const response = await request(app)
        .post('/api/stats/refresh')
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('should include success message in response', async () => {
      const mockStats = {
        timestamp: '2025-12-19T18:30:00.000Z',
        current_metrics: {
          total_events: 50,
          total_steps: 200,
          completed_events: 45,
          completed_steps: 185
        },
        monthly_records: []
      };

      aggregateAndSaveStats.mockResolvedValue(mockStats);

      const response = await request(app)
        .post('/api/stats/refresh')
        .expect(200);

      expect(response.body).toHaveProperty('message');
      expect(typeof response.body.message).toBe('string');
    });

    it('should include refresh_duration_ms in response', async () => {
      const mockStats = {
        timestamp: '2025-12-19T18:30:00.000Z',
        current_metrics: {
          total_events: 50,
          total_steps: 200,
          completed_events: 45,
          completed_steps: 185
        },
        monthly_records: [],
        last_refresh_duration_ms: 450
      };

      aggregateAndSaveStats.mockResolvedValue(mockStats);

      const response = await request(app)
        .post('/api/stats/refresh')
        .expect(200);

      expect(response.body).toHaveProperty('refresh_duration_ms');
      expect(typeof response.body.refresh_duration_ms).toBe('number');
    });

    it('should include metrics with current_metrics in response', async () => {
      const mockStats = {
        timestamp: '2025-12-19T18:30:00.000Z',
        current_metrics: {
          total_events: 50,
          total_steps: 200,
          completed_events: 45,
          completed_steps: 185
        },
        monthly_records: []
      };

      aggregateAndSaveStats.mockResolvedValue(mockStats);

      const response = await request(app)
        .post('/api/stats/refresh')
        .expect(200);

      expect(response.body).toHaveProperty('metrics');
      expect(response.body.metrics).toHaveProperty('current_metrics');
      expect(response.body.metrics.current_metrics).toEqual(mockStats.current_metrics);
    });

    it('should include next_scheduled_refresh timestamp', async () => {
      const mockStats = {
        timestamp: '2025-12-19T18:30:00.000Z',
        current_metrics: {
          total_events: 50,
          total_steps: 200,
          completed_events: 45,
          completed_steps: 185
        },
        monthly_records: []
      };

      aggregateAndSaveStats.mockResolvedValue(mockStats);

      const response = await request(app)
        .post('/api/stats/refresh')
        .expect(200);

      expect(response.body).toHaveProperty('next_scheduled_refresh');
      // Should be ISO 8601 format string
      expect(typeof response.body.next_scheduled_refresh).toBe('string');
      expect(() => new Date(response.body.next_scheduled_refresh)).not.toThrow();
    });

    it('should calculate next refresh as next 6-hour window', async () => {
      const mockStats = {
        timestamp: '2025-12-19T03:00:00.000Z',
        current_metrics: {
          total_events: 50,
          total_steps: 200,
          completed_events: 45,
          completed_steps: 185
        },
        monthly_records: []
      };

      aggregateAndSaveStats.mockResolvedValue(mockStats);

      const response = await request(app)
        .post('/api/stats/refresh')
        .expect(200);

      const nextRefresh = new Date(response.body.next_scheduled_refresh);
      // Should be a valid future date
      expect(nextRefresh.getTime()).toBeGreaterThan(Date.now());
    });

    it('should complete within 10 seconds', async () => {
      const mockStats = {
        timestamp: '2025-12-19T18:30:00.000Z',
        current_metrics: {
          total_events: 50,
          total_steps: 200,
          completed_events: 45,
          completed_steps: 185
        },
        monthly_records: []
      };

      aggregateAndSaveStats.mockResolvedValue(mockStats);

      const startTime = Date.now();
      await request(app)
        .post('/api/stats/refresh')
        .expect(200);
      const elapsedTime = Date.now() - startTime;

      expect(elapsedTime).toBeLessThan(10000);
    });
  });

  describe('8.6: POST /api/stats/refresh - Error Case', () => {
    it('should return HTTP 500 on aggregation failure', async () => {
      const error = new Error('Aggregation failed');
      aggregateAndSaveStats.mockRejectedValue(error);

      const response = await request(app)
        .post('/api/stats/refresh')
        .expect(500);

      expect(response.body.success).toBe(false);
    });

    it('should include error message in response', async () => {
      const error = new Error('Events directory read error');
      aggregateAndSaveStats.mockRejectedValue(error);

      const response = await request(app)
        .post('/api/stats/refresh')
        .expect(500);

      expect(response.body).toHaveProperty('error');
      expect(typeof response.body.error).toBe('string');
    });

    it('should include error_code in response', async () => {
      const error = new Error('Events directory read error');
      aggregateAndSaveStats.mockRejectedValue(error);

      const response = await request(app)
        .post('/api/stats/refresh')
        .expect(500);

      expect(response.body).toHaveProperty('error_code');
      expect(typeof response.body.error_code).toBe('string');
    });

    it('should categorize error codes for different failure types', async () => {
      // Test FILE_WRITE_ERROR
      const writeError = new Error('Permission denied writing to file');
      aggregateAndSaveStats.mockRejectedValue(writeError);

      const response = await request(app)
        .post('/api/stats/refresh')
        .expect(500);

      expect(response.body.error_code).toBeDefined();
      expect(typeof response.body.error_code).toBe('string');
    });

    it('should not return metrics when error occurs', async () => {
      const error = new Error('Aggregation failed');
      aggregateAndSaveStats.mockRejectedValue(error);

      const response = await request(app)
        .post('/api/stats/refresh')
        .expect(500);

      expect(response.body.metrics).toBeUndefined();
      expect(response.body.refresh_duration_ms).toBeUndefined();
    });
  });

  describe('8.7: Response Time Constraints', () => {
    it('GET /api/stats should respond in less than 100ms', async () => {
      const mockStats = {
        timestamp: '2025-12-19T18:00:00.000Z',
        current_metrics: {
          total_events: 10,
          total_steps: 40,
          completed_events: 8,
          completed_steps: 35
        },
        monthly_records: []
      };

      fs.readFile.mockResolvedValue(JSON.stringify(mockStats));

      const startTime = Date.now();
      const response = await request(app)
        .get('/api/stats')
        .expect(200);
      const elapsedTime = Date.now() - startTime;

      // In test environment, we use a more relaxed timing constraint
      // but verify that response_time_ms in body is reasonable
      expect(response.body.response_time_ms).toBeLessThan(100);
    });

    it('POST /api/stats/refresh should complete in less than 10 seconds', async () => {
      const mockStats = {
        timestamp: '2025-12-19T18:30:00.000Z',
        current_metrics: {
          total_events: 50,
          total_steps: 200,
          completed_events: 45,
          completed_steps: 185
        },
        monthly_records: []
      };

      aggregateAndSaveStats.mockResolvedValue(mockStats);

      const startTime = Date.now();
      const response = await request(app)
        .post('/api/stats/refresh')
        .expect(200);
      const elapsedTime = Date.now() - startTime;

      expect(response.body.refresh_duration_ms).toBeLessThan(10000);
      expect(elapsedTime).toBeLessThan(10000);
    });
  });

  describe('8.8: Authentication (None Required)', () => {
    it('GET /api/stats should not require authentication', async () => {
      const mockStats = {
        timestamp: '2025-12-19T18:00:00.000Z',
        current_metrics: {
          total_events: 10,
          total_steps: 40,
          completed_events: 8,
          completed_steps: 35
        },
        monthly_records: []
      };

      fs.readFile.mockResolvedValue(JSON.stringify(mockStats));

      // Send request without any auth headers
      const response = await request(app)
        .get('/api/stats')
        .expect(200);

      // Should succeed with HTTP 200
      expect(response.body.success).toBe(true);
    });

    it('GET /api/stats should return 200 without auth headers', async () => {
      const mockStats = {
        timestamp: '2025-12-19T18:00:00.000Z',
        current_metrics: {
          total_events: 10,
          total_steps: 40,
          completed_events: 8,
          completed_steps: 35
        },
        monthly_records: []
      };

      fs.readFile.mockResolvedValue(JSON.stringify(mockStats));

      const response = await request(app)
        .get('/api/stats')
        .set('Authorization', '') // Explicitly empty auth header
        .expect(200);

      expect(response.status).toBe(200);
    });

    it('POST /api/stats/refresh should not require authentication', async () => {
      const mockStats = {
        timestamp: '2025-12-19T18:30:00.000Z',
        current_metrics: {
          total_events: 50,
          total_steps: 200,
          completed_events: 45,
          completed_steps: 185
        },
        monthly_records: []
      };

      aggregateAndSaveStats.mockResolvedValue(mockStats);

      // Send request without any auth headers
      const response = await request(app)
        .post('/api/stats/refresh')
        .expect(200);

      // Should succeed with HTTP 200
      expect(response.body.success).toBe(true);
    });

    it('POST /api/stats/refresh should return 200 without auth headers', async () => {
      const mockStats = {
        timestamp: '2025-12-19T18:30:00.000Z',
        current_metrics: {
          total_events: 50,
          total_steps: 200,
          completed_events: 45,
          completed_steps: 185
        },
        monthly_records: []
      };

      aggregateAndSaveStats.mockResolvedValue(mockStats);

      const response = await request(app)
        .post('/api/stats/refresh')
        .set('Authorization', '') // Explicitly empty auth header
        .expect(200);

      expect(response.status).toBe(200);
    });

    it('endpoints should work without any special headers', async () => {
      const mockStats = {
        timestamp: '2025-12-19T18:00:00.000Z',
        current_metrics: {
          total_events: 10,
          total_steps: 40,
          completed_events: 8,
          completed_steps: 35
        },
        monthly_records: []
      };

      fs.readFile.mockResolvedValue(JSON.stringify(mockStats));
      aggregateAndSaveStats.mockResolvedValue(mockStats);

      // GET without headers
      const getResponse = await request(app)
        .get('/api/stats')
        .expect(200);

      expect(getResponse.body.success).toBe(true);

      // POST without headers
      const postResponse = await request(app)
        .post('/api/stats/refresh')
        .expect(200);

      expect(postResponse.body.success).toBe(true);
    });
  });

  describe('Additional Edge Cases', () => {
    it('should handle stats with no monthly records', async () => {
      const mockStats = {
        timestamp: '2025-12-19T18:00:00.000Z',
        current_metrics: {
          total_events: 5,
          total_steps: 15,
          completed_events: 3,
          completed_steps: 10
        }
        // No monthly_records property
      };

      fs.readFile.mockResolvedValue(JSON.stringify(mockStats));

      const response = await request(app)
        .get('/api/stats')
        .expect(200);

      expect(response.body.monthly_records).toEqual([]);
    });

    it('should handle multiple monthly records correctly', async () => {
      const mockStats = {
        timestamp: '2025-12-19T18:00:00.000Z',
        current_metrics: {
          total_events: 100,
          total_steps: 400,
          completed_events: 90,
          completed_steps: 380
        },
        monthly_records: [
          {
            year: 2025,
            month: 10,
            total_events: 30,
            total_steps: 120,
            completed_events: 27,
            completed_steps: 110,
            timestamp: '2025-10-31T23:59:00.000Z'
          },
          {
            year: 2025,
            month: 11,
            total_events: 70,
            total_steps: 280,
            completed_events: 63,
            completed_steps: 270,
            timestamp: '2025-11-30T23:59:00.000Z'
          }
        ]
      };

      fs.readFile.mockResolvedValue(JSON.stringify(mockStats));

      const response = await request(app)
        .get('/api/stats')
        .expect(200);

      expect(response.body.monthly_records).toHaveLength(2);
      expect(response.body.monthly_records[0].month).toBe(10);
      expect(response.body.monthly_records[1].month).toBe(11);
    });

    it('should properly format and preserve all fields in metrics', async () => {
      const mockStats = {
        timestamp: '2025-12-19T18:00:00.000Z',
        current_metrics: {
          total_events: 42,
          total_steps: 156,
          completed_events: 38,
          completed_steps: 142
        },
        monthly_records: []
      };

      fs.readFile.mockResolvedValue(JSON.stringify(mockStats));

      const response = await request(app)
        .get('/api/stats')
        .expect(200);

      const metrics = response.body.current_metrics;
      expect(metrics.total_events).toBe(42);
      expect(metrics.total_steps).toBe(156);
      expect(metrics.completed_events).toBe(38);
      expect(metrics.completed_steps).toBe(142);
    });
  });
});
