import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import StatsTable from '../StatsTable';

/**
 * Subtask 9.1: Set up component test file
 * - Use React Testing Library and Jest
 * - Import render, screen, waitFor from testing library
 * - Import StatsTable component
 * - Create sample stats object matching API response format
 */

// Sample stats object matching API response format
const mockStats = {
  current_metrics: {
    total_events: 42,
    total_steps: 156,
    completed_events: 28,
    completed_steps: 98,
  },
  last_updated: '2025-12-19T18:00:00.000Z',
};

const mockEmptyStats = {
  current_metrics: {
    total_events: 0,
    total_steps: 0,
    completed_events: 0,
    completed_steps: 0,
  },
  last_updated: null,
};

describe('StatsTable Component', () => {
  /**
   * Subtask 9.2: Test StatsTable rendering with data
   * - Test table renders with valid stats prop
   * - Assert all 4 metric labels visible: "Total Events", "Total Steps", "Completed Events", "Completed Steps"
   * - Assert metric values display correctly
   * - Assert timestamp displays and is formatted human-readably
   */
  describe('Rendering with data', () => {
    test('should render table with valid stats prop', () => {
      render(<StatsTable stats={mockStats} />);

      // Assert table element is present
      const table = screen.getByRole('table');
      expect(table).toBeInTheDocument();
    });

    test('should display all 4 metric labels', () => {
      render(<StatsTable stats={mockStats} />);

      expect(screen.getByText('Total Events')).toBeInTheDocument();
      expect(screen.getByText('Total Steps')).toBeInTheDocument();
      expect(screen.getByText('Completed Events')).toBeInTheDocument();
      expect(screen.getByText('Completed Steps')).toBeInTheDocument();
    });

    test('should display metric values correctly', () => {
      render(<StatsTable stats={mockStats} />);

      // Assert metric values are displayed
      expect(screen.getByText('42')).toBeInTheDocument(); // total_events
      expect(screen.getByText('156')).toBeInTheDocument(); // total_steps
      expect(screen.getByText('28')).toBeInTheDocument(); // completed_events
      expect(screen.getByText('98')).toBeInTheDocument(); // completed_steps
    });

    test('should display timestamp in human-readable format', () => {
      render(<StatsTable stats={mockStats} />);

      // The timestamp should be formatted human-readably
      // Check for presence of month/day/year/time elements
      const updatedText = screen.getByText(/Last updated:/);
      expect(updatedText).toBeInTheDocument();

      // Should contain parts of the formatted date (Dec, 19, 2025, etc.)
      expect(updatedText.textContent).toMatch(/Dec|December/);
      expect(updatedText.textContent).toMatch(/\d{1,2}/); // Day
      expect(updatedText.textContent).toMatch(/2025/); // Year
      expect(updatedText.textContent).toMatch(/\d{1,2}:\d{2}/); // Time
    });

    test('should display timestamp with UTC indicator', () => {
      render(<StatsTable stats={mockStats} />);

      const updatedText = screen.getByText(/Last updated:/);
      expect(updatedText.textContent).toMatch(/UTC/);
    });

    test('should render table with semantic HTML structure', () => {
      render(<StatsTable stats={mockStats} />);

      // Check for semantic table structure
      const table = screen.getByRole('table');
      const thead = table.querySelector('thead');
      const tbody = table.querySelector('tbody');

      expect(thead).toBeInTheDocument();
      expect(tbody).toBeInTheDocument();

      // Check for table header cells
      const ths = table.querySelectorAll('th');
      expect(ths.length).toBeGreaterThan(0);

      // Check for table body cells
      const tds = table.querySelectorAll('td');
      expect(tds.length).toBeGreaterThan(0);
    });
  });

  /**
   * Subtask 9.3: Test StatsTable loading state
   * - Loading spinner shows when loading={true}
   * - Assert table not visible during loading
   * - Loading indicator present
   */
  describe('Loading state', () => {
    test('should show loading spinner when loading={true}', () => {
      render(<StatsTable loading={true} />);

      // Check for loading indicator (spinner or text)
      const loadingText = screen.getByText(/Loading statistics/);
      expect(loadingText).toBeInTheDocument();
    });

    test('should hide table during loading', () => {
      render(<StatsTable loading={true} />);

      // Table should not be visible
      const table = screen.queryByRole('table');
      expect(table).not.toBeInTheDocument();
    });

    test('should display loading spinner icon', () => {
      const { container } = render(<StatsTable loading={true} />);

      // Check for the Loader icon from lucide-react
      // The component uses className animate-spin for the spinner
      const spinner = container.querySelector('.animate-spin');
      expect(spinner).toBeInTheDocument();
    });

    test('should show proper spacing during loading state', () => {
      const { container } = render(<StatsTable loading={true} />);

      // Check that loading container has proper styling
      const loadingContainer = container.querySelector('.flex');
      expect(loadingContainer).toBeInTheDocument();
    });
  });

  /**
   * Subtask 9.4: Test StatsTable error state
   * - Error message displays when error prop set
   * - Assert error message visible
   * - Assert table not visible
   * - Assert page layout not broken
   */
  describe('Error state', () => {
    test('should display error message when error prop is set', () => {
      const errorMessage = 'Network connection failed';
      render(<StatsTable error={errorMessage} />);

      expect(screen.getByText(/Statistics unavailable:/)).toBeInTheDocument();
      expect(screen.getByText(new RegExp(errorMessage))).toBeInTheDocument();
    });

    test('should hide table when error is present', () => {
      render(<StatsTable error="Network error" />);

      const table = screen.queryByRole('table');
      expect(table).not.toBeInTheDocument();
    });

    test('should display error in red color styling', () => {
      const { container } = render(<StatsTable error="Network error" />);

      const errorContainer = container.querySelector('.bg-red-50');
      expect(errorContainer).toBeInTheDocument();

      const errorText = container.querySelector('.text-red-600');
      expect(errorText).toBeInTheDocument();
    });

    test('should not break page layout on error', () => {
      const { container } = render(<StatsTable error="Network error" />);

      // Check that error container has proper styling
      const errorContainer = container.querySelector('.rounded-lg');
      expect(errorContainer).toBeInTheDocument();

      // Should have padding
      const paddedElement = container.querySelector('.p-6');
      expect(paddedElement).toBeInTheDocument();
    });

    test('should handle different error messages', () => {
      const errors = [
        'Connection timeout',
        'Server error',
        'Invalid response',
      ];

      errors.forEach((error) => {
        const { unmount } = render(<StatsTable error={error} />);
        expect(screen.getByText(new RegExp(error))).toBeInTheDocument();
        unmount();
      });
    });
  });

  /**
   * Subtask 9.5: Test StatsTable fallback state
   * - Fallback when stats undefined
   * - Assert metrics display as 0
   * - Assert fallback message visible
   */
  describe('Fallback state', () => {
    test('should display metrics as 0 when stats undefined', () => {
      render(<StatsTable stats={undefined} />);

      // All metrics should show 0
      const zeros = screen.getAllByText('0');
      expect(zeros.length).toBeGreaterThanOrEqual(4);
    });

    test('should show fallback message when stats unavailable', () => {
      render(<StatsTable stats={undefined} />);

      expect(
        screen.getByText('Statistics are not yet available')
      ).toBeInTheDocument();
    });

    test('should display table even in fallback state', () => {
      render(<StatsTable stats={undefined} />);

      // Table should still be rendered with zero values
      const table = screen.getByRole('table');
      expect(table).toBeInTheDocument();
    });

    test('should show "Not yet available" for timestamp in fallback', () => {
      render(<StatsTable stats={undefined} />);

      const updatedText = screen.getByText(/Last updated:/);
      expect(updatedText.textContent).toContain('Not yet available');
    });

    test('should display fallback message with gray styling', () => {
      const { container } = render(<StatsTable stats={undefined} />);

      const fallbackMsg = container.querySelector('.text-gray-500');
      expect(fallbackMsg?.textContent).toContain(
        'Statistics are not yet available'
      );
    });

    test('should render with empty stats object', () => {
      render(<StatsTable stats={mockEmptyStats} />);

      // All metrics should show 0
      const zeros = screen.getAllByText('0');
      expect(zeros.length).toBeGreaterThanOrEqual(4);
    });
  });

  /**
   * Subtask 9.6: Test landing page integration
   * - Landing page fetches stats on mount
   * - StatsTable component renders
   * - Stats data displayed correctly
   * - Error handling verified on API error
   *
   * Note: This test focuses on the StatsTable component's ability to receive
   * and display data that would come from a landing page fetch.
   * Integration tests for the actual fetch logic would be in the landing page tests.
   */
  describe('Integration scenarios', () => {
    test('should render StatsTable component with props', () => {
      render(
        <StatsTable
          loading={false}
          error={null}
          stats={mockStats}
        />
      );

      expect(screen.getByRole('table')).toBeInTheDocument();
      expect(screen.getByText('42')).toBeInTheDocument();
    });

    test('should handle transitions from loading to data state', () => {
      const { rerender } = render(<StatsTable loading={true} />);

      expect(screen.getByText(/Loading statistics/)).toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();

      // Simulate fetch complete
      rerender(<StatsTable loading={false} stats={mockStats} />);

      expect(screen.queryByText(/Loading statistics/)).not.toBeInTheDocument();
      expect(screen.getByRole('table')).toBeInTheDocument();
      expect(screen.getByText('42')).toBeInTheDocument();
    });

    test('should handle transitions from loading to error state', () => {
      const { rerender } = render(<StatsTable loading={true} />);

      expect(screen.getByText(/Loading statistics/)).toBeInTheDocument();

      // Simulate fetch error
      rerender(<StatsTable loading={false} error="Failed to fetch" />);

      expect(screen.queryByText(/Loading statistics/)).not.toBeInTheDocument();
      expect(screen.getByText(/Statistics unavailable/)).toBeInTheDocument();
    });

    test('should handle null error prop as no error', () => {
      render(<StatsTable error={null} stats={mockStats} />);

      // Error message should not appear
      const errorMsg = screen.queryByText(/Statistics unavailable/);
      expect(errorMsg).not.toBeInTheDocument();

      // Stats should display normally
      expect(screen.getByRole('table')).toBeInTheDocument();
    });
  });

  /**
   * Subtask 9.7: Test responsive design
   * - Mobile viewport (375px width) - no horizontal scroll
   * - Desktop viewport (1280px width) - proper layout
   * - Padding/spacing appropriate on both
   */
  describe('Responsive design', () => {
    test('should render without horizontal scroll on mobile viewport', () => {
      // Set viewport width to 375px (mobile)
      Object.defineProperty(window, 'innerWidth', {
        writable: true,
        configurable: true,
        value: 375,
      });

      const { container } = render(<StatsTable stats={mockStats} />);

      // Check that the main container has proper width
      const mainDiv = container.querySelector('.w-full');
      expect(mainDiv).toBeInTheDocument();

      // Table should exist and be responsive
      const table = screen.getByRole('table');
      expect(table).toBeInTheDocument();

      // Check that table has proper styling for responsiveness
      expect(table.className).toContain('w-full');
    });

    test('should have proper padding on mobile', () => {
      const { container } = render(<StatsTable stats={mockStats} />);

      // Check for padding styles in table cells
      const cells = container.querySelectorAll('td, th');
      expect(cells.length).toBeGreaterThan(0);

      cells.forEach((cell) => {
        // All cells should have padding
        expect(cell.className).toMatch(/px-4|px-2/);
        expect(cell.className).toMatch(/py-2|py-1/);
      });
    });

    test('should maintain proper layout on desktop viewport', () => {
      Object.defineProperty(window, 'innerWidth', {
        writable: true,
        configurable: true,
        value: 1280,
      });

      render(<StatsTable stats={mockStats} />);

      const table = screen.getByRole('table');
      expect(table).toBeInTheDocument();

      // Desktop should have consistent styling
      expect(table.className).toContain('w-full');
    });

    test('should not show horizontal scrollbar', () => {
      render(<StatsTable stats={mockStats} />);

      // Check that the table has full width and doesn't have overflow
      const table = screen.getByRole('table');
      expect(table.className).toContain('w-full');
    });

    test('should have proper spacing between rows', () => {
      const { container } = render(<StatsTable stats={mockStats} />);

      const rows = container.querySelectorAll('tbody tr');
      expect(rows.length).toBe(4); // 4 metrics

      rows.forEach((row) => {
        // Each row should have border or hover styling
        expect(row.className).toMatch(/border|hover/);
      });
    });

    test('should be readable on small screens', () => {
      Object.defineProperty(window, 'innerWidth', {
        writable: true,
        configurable: true,
        value: 320,
      });

      render(<StatsTable stats={mockStats} />);

      // All text should still be visible
      expect(screen.getByText('Total Events')).toBeVisible();
      expect(screen.getByText('Total Steps')).toBeVisible();
      expect(screen.getByText('Completed Events')).toBeVisible();
      expect(screen.getByText('Completed Steps')).toBeVisible();
    });
  });

  /**
   * Subtask 9.8: Test accessibility
   * - Semantic HTML: <table>, <thead>, <tbody>, <th>, <td>
   * - Screen readers can access content
   * - ARIA labels if needed
   */
  describe('Accessibility', () => {
    test('should use semantic HTML table structure', () => {
      render(<StatsTable stats={mockStats} />);

      const table = screen.getByRole('table');
      expect(table).toBeInTheDocument();

      // Check for thead
      const thead = table.querySelector('thead');
      expect(thead).toBeInTheDocument();

      // Check for tbody
      const tbody = table.querySelector('tbody');
      expect(tbody).toBeInTheDocument();
    });

    test('should use proper table header cells (th)', () => {
      const { container } = render(<StatsTable stats={mockStats} />);

      const ths = container.querySelectorAll('th');
      expect(ths.length).toBeGreaterThan(0);

      // All th elements should be in thead
      const thead = container.querySelector('thead');
      const thsInThead = thead?.querySelectorAll('th');
      expect(thsInThead?.length).toBeGreaterThan(0);
    });

    test('should use proper table data cells (td)', () => {
      const { container } = render(<StatsTable stats={mockStats} />);

      const tds = container.querySelectorAll('tbody td');
      expect(tds.length).toBeGreaterThan(0);

      // Should have 8 td elements (2 per row × 4 rows)
      expect(tds.length).toBe(8);
    });

    test('should be accessible to screen readers', () => {
      render(<StatsTable stats={mockStats} />);

      // All metric labels should be accessible as text content
      const table = screen.getByRole('table');
      expect(table).toBeInTheDocument();

      // Each metric should be findable by screen readers
      expect(screen.getByText('Total Events')).toBeInTheDocument();
      expect(screen.getByText(/Total Events/)).toBeInTheDocument();
    });

    test('should have accessible loading indicator', () => {
      render(<StatsTable loading={true} />);

      // Loading text should be present for screen readers
      expect(screen.getByText(/Loading statistics/)).toBeInTheDocument();
    });

    test('should have accessible error message', () => {
      render(<StatsTable error="Network failed" />);

      // Error text should be clearly readable
      const errorMsg = screen.getByText(/Statistics unavailable/);
      expect(errorMsg).toBeInTheDocument();

      // Error message should be in an accessible container with proper styling
      expect(errorMsg.className).toContain('text-red-600');
    });

    test('should have proper heading structure in table', () => {
      const { container } = render(<StatsTable stats={mockStats} />);

      const thead = container.querySelector('thead');
      const ths = thead?.querySelectorAll('th');

      expect(ths?.length).toBeGreaterThan(0);

      // Header cells should contain meaningful text
      ths?.forEach((th) => {
        expect(th.textContent).toBeTruthy();
      });
    });

    test('should have readable text contrast', () => {
      const { container } = render(<StatsTable stats={mockStats} />);

      // Check that text elements have sufficient contrast classes
      const valueElements = container.querySelectorAll('.font-semibold');
      expect(valueElements.length).toBeGreaterThan(0);

      // Labels and values should have distinct styling
      const labelElements = container.querySelectorAll('.text-gray-700');
      expect(labelElements.length).toBeGreaterThan(0);
    });

    test('should display timestamp in accessible format', () => {
      render(<StatsTable stats={mockStats} />);

      // Timestamp should be readable by screen readers
      const updatedText = screen.getByText(/Last updated:/);
      expect(updatedText.textContent).toBeTruthy();

      // Format should include readable date/time
      expect(updatedText.textContent).toMatch(/\d+/); // Should have numbers
      expect(updatedText.textContent).toMatch(/UTC/); // Should have timezone
    });

    test('should have proper text alignment in table', () => {
      const { container } = render(<StatsTable stats={mockStats} />);

      // Right-aligned numeric values
      const rightAlignedCells = container.querySelectorAll('.text-right');
      expect(rightAlignedCells.length).toBeGreaterThan(0);

      // Left-aligned labels
      const leftAlignedCells = container.querySelectorAll('.text-left');
      expect(leftAlignedCells.length).toBeGreaterThan(0);
    });
  });

  /**
   * Edge cases and additional robustness tests
   */
  describe('Edge cases', () => {
    test('should handle missing current_metrics gracefully', () => {
      const statsWithoutMetrics = {
        current_metrics: undefined,
        last_updated: '2025-12-19T18:00:00.000Z',
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render(<StatsTable stats={statsWithoutMetrics as any} />);

      // Should show zeros
      const zeros = screen.getAllByText('0');
      expect(zeros.length).toBeGreaterThanOrEqual(4);
    });

    test('should handle zero values correctly', () => {
      render(<StatsTable stats={mockEmptyStats} />);

      const zeros = screen.getAllByText('0');
      expect(zeros.length).toBe(4);
    });

    test('should handle large numbers in metrics', () => {
      const largeStats = {
        current_metrics: {
          total_events: 999999,
          total_steps: 1234567,
          completed_events: 888888,
          completed_steps: 777777,
        },
        last_updated: '2025-12-19T18:00:00.000Z',
      };

      render(<StatsTable stats={largeStats} />);

      expect(screen.getByText('1234567')).toBeInTheDocument();
      expect(screen.getByText('888888')).toBeInTheDocument();
      expect(screen.getByText('777777')).toBeInTheDocument();
      // Check all large numbers are present
      expect(screen.getAllByText(/\d{6,}/)).toBeTruthy();
    });

    test('should handle invalid ISO string gracefully', () => {
      const statsWithBadDate = {
        current_metrics: mockStats.current_metrics,
        last_updated: 'invalid-date-string',
      };

      render(<StatsTable stats={statsWithBadDate} />);

      // Should show "Not yet available" for invalid date or show Invalid Date
      const updatedText = screen.getByText(/Last updated:/);
      expect(updatedText).toBeInTheDocument();
      // Should handle gracefully without crashing
      expect(updatedText.textContent).toBeTruthy();
    });

    test('should render without stats prop at all', () => {
      render(<StatsTable />);

      // Should show fallback state
      const table = screen.getByRole('table');
      expect(table).toBeInTheDocument();

      // All metrics should be 0
      const zeros = screen.getAllByText('0');
      expect(zeros.length).toBeGreaterThanOrEqual(4);
    });

    test('should handle concurrent state updates', () => {
      const { rerender } = render(
        <StatsTable loading={true} stats={mockStats} />
      );

      expect(screen.getByText(/Loading statistics/)).toBeInTheDocument();

      rerender(<StatsTable loading={false} stats={mockStats} />);

      expect(screen.queryByText(/Loading statistics/)).not.toBeInTheDocument();
      expect(screen.getByText('42')).toBeInTheDocument();
    });
  });
});
