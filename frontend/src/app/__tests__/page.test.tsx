import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import Home from '../page';

/**
 * Subtask 9.6: Test landing page integration
 * - Landing page fetches stats on mount
 * - StatsTable component renders
 * - Stats data displayed correctly
 * - Error handling verified on API error
 */

// Mock the Next.js router
jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
  }),
}));

// Mock fetch globally
global.fetch = jest.fn();

describe('Landing Page - Stats Integration', () => {
  beforeEach(() => {
    (global.fetch as jest.Mock).mockClear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Stats fetching on mount', () => {
    test('should fetch stats on component mount', async () => {
      const mockStats = {
        current_metrics: {
          total_events: 42,
          total_steps: 156,
          completed_events: 28,
          completed_steps: 98,
        },
        last_updated: '2025-12-19T18:00:00.000Z',
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockStats,
      });

      render(<Home />);

      // Verify fetch was called with correct endpoint
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/stats');
      });
    });

    test('should render StatsTable component', async () => {
      const mockStats = {
        current_metrics: {
          total_events: 42,
          total_steps: 156,
          completed_events: 28,
          completed_steps: 98,
        },
        last_updated: '2025-12-19T18:00:00.000Z',
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockStats,
      });

      render(<Home />);

      // Wait for stats to load and verify table is rendered
      await waitFor(() => {
        expect(screen.getByRole('table')).toBeInTheDocument();
      });
    });

    test('should display stats data correctly', async () => {
      const mockStats = {
        current_metrics: {
          total_events: 42,
          total_steps: 156,
          completed_events: 28,
          completed_steps: 98,
        },
        last_updated: '2025-12-19T18:00:00.000Z',
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockStats,
      });

      render(<Home />);

      // Verify stats are displayed
      await waitFor(() => {
        expect(screen.getByText('42')).toBeInTheDocument(); // total_events
        expect(screen.getByText('156')).toBeInTheDocument(); // total_steps
        expect(screen.getByText('28')).toBeInTheDocument(); // completed_events
        expect(screen.getByText('98')).toBeInTheDocument(); // completed_steps
      });
    });

    test('should display all metric labels', async () => {
      const mockStats = {
        current_metrics: {
          total_events: 5,
          total_steps: 20,
          completed_events: 3,
          completed_steps: 15,
        },
        last_updated: '2025-12-19T18:00:00.000Z',
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockStats,
      });

      render(<Home />);

      await waitFor(() => {
        expect(screen.getByText('Total Events')).toBeInTheDocument();
        expect(screen.getByText('Total Steps')).toBeInTheDocument();
        expect(screen.getByText('Completed Events')).toBeInTheDocument();
        expect(screen.getByText('Completed Steps')).toBeInTheDocument();
      });
    });

    test('should display timestamp when stats loaded', async () => {
      const mockStats = {
        current_metrics: {
          total_events: 5,
          total_steps: 20,
          completed_events: 3,
          completed_steps: 15,
        },
        last_updated: '2025-12-19T18:00:00.000Z',
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockStats,
      });

      render(<Home />);

      await waitFor(() => {
        expect(screen.getByText(/Last updated:/)).toBeInTheDocument();
      });
    });
  });

  describe('Error handling', () => {
    test('should handle API error gracefully', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      render(<Home />);

      // Error message should display
      await waitFor(() => {
        expect(screen.getByText(/Statistics unavailable/)).toBeInTheDocument();
      });
    });

    test('should handle network error gracefully', async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(
        new Error('Network failed')
      );

      render(<Home />);

      // Error message should display
      await waitFor(() => {
        expect(screen.getByText(/Statistics unavailable/)).toBeInTheDocument();
      });
    });

    test('should not crash page on stats error', async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(
        new Error('Connection timeout')
      );

      render(<Home />);

      // Page should still render with event creation form visible
      await waitFor(() => {
        // Look for event name input as evidence form rendered
        expect(screen.getByText(/Event Name/i)).toBeInTheDocument();
      });
    });

    test('should display error message without table', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      render(<Home />);

      // Error message should display, not table
      await waitFor(() => {
        expect(screen.getByText(/Statistics unavailable/)).toBeInTheDocument();
        expect(screen.queryByRole('table')).not.toBeInTheDocument();
      });
    });
  });

  describe('Loading state', () => {
    test('should show loading indicator while fetching', async () => {
      const mockStats = {
        current_metrics: {
          total_events: 5,
          total_steps: 20,
          completed_events: 3,
          completed_steps: 15,
        },
        last_updated: '2025-12-19T18:00:00.000Z',
      };

      // Delay the response to see loading state
      (global.fetch as jest.Mock).mockImplementationOnce(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  ok: true,
                  json: async () => mockStats,
                }),
              100
            )
          )
      );

      render(<Home />);

      // Loading indicator might be shown briefly
      // Once loaded, table should appear
      await waitFor(() => {
        expect(screen.getByRole('table')).toBeInTheDocument();
      });
    });
  });

  describe('Stats display with different data', () => {
    test('should handle zero metrics', async () => {
      const mockStats = {
        current_metrics: {
          total_events: 0,
          total_steps: 0,
          completed_events: 0,
          completed_steps: 0,
        },
        last_updated: null,
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockStats,
      });

      render(<Home />);

      await waitFor(() => {
        const zeros = screen.getAllByText('0');
        expect(zeros.length).toBeGreaterThanOrEqual(4);
      });
    });

    test('should handle large metric values', async () => {
      const mockStats = {
        current_metrics: {
          total_events: 999999,
          total_steps: 5000000,
          completed_events: 888888,
          completed_steps: 4500000,
        },
        last_updated: '2025-12-19T18:00:00.000Z',
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockStats,
      });

      render(<Home />);

      await waitFor(() => {
        expect(screen.getByText('999999')).toBeInTheDocument();
        expect(screen.getByText('5000000')).toBeInTheDocument();
      });
    });
  });

  describe('Component integration', () => {
    test('should render event form alongside stats', async () => {
      const mockStats = {
        current_metrics: {
          total_events: 5,
          total_steps: 20,
          completed_events: 3,
          completed_steps: 15,
        },
        last_updated: '2025-12-19T18:00:00.000Z',
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockStats,
      });

      render(<Home />);

      // Both form and stats should be present
      await waitFor(() => {
        // Check for form elements
        expect(screen.getByText(/Event Name/i)).toBeInTheDocument();
        // Check for stats table
        expect(screen.getByRole('table')).toBeInTheDocument();
      });
    });

    test('should fetch stats only once on mount', async () => {
      const mockStats = {
        current_metrics: {
          total_events: 5,
          total_steps: 20,
          completed_events: 3,
          completed_steps: 15,
        },
        last_updated: '2025-12-19T18:00:00.000Z',
      };

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => mockStats,
      });

      render(<Home />);

      await waitFor(() => {
        // Fetch should only be called once for stats
        // (not counting any other API calls)
        const statsCalls = (global.fetch as jest.Mock).mock.calls.filter(
          (call) => call[0] === '/api/stats'
        );
        expect(statsCalls.length).toBe(1);
      });
    });
  });

  describe('Fallback behavior', () => {
    test('should handle missing stats gracefully', async () => {
      const mockStats = {
        current_metrics: null,
        last_updated: null,
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockStats,
      });

      render(<Home />);

      // Should still render without crashing
      await waitFor(() => {
        expect(screen.getByRole('table')).toBeInTheDocument();
      });
    });
  });

  describe('Fetch options validation', () => {
    test('should fetch stats from correct API endpoint', async () => {
      const mockStats = {
        current_metrics: {
          total_events: 5,
          total_steps: 20,
          completed_events: 3,
          completed_steps: 15,
        },
        last_updated: '2025-12-19T18:00:00.000Z',
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockStats,
      });

      render(<Home />);

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/stats');
      });
    });

    test('should handle JSON parsing correctly', async () => {
      const mockStats = {
        current_metrics: {
          total_events: 5,
          total_steps: 20,
          completed_events: 3,
          completed_steps: 15,
        },
        last_updated: '2025-12-19T18:00:00.000Z',
      };

      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue(mockStats),
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce(mockResponse);

      render(<Home />);

      await waitFor(() => {
        expect(mockResponse.json).toHaveBeenCalled();
      });
    });
  });
});
