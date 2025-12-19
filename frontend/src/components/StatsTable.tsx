'use client';

import React from 'react';
import { Loader } from 'lucide-react';

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

export default function StatsTable({ loading = false, error = null, stats }: StatsTableProps) {
  // Format timestamp from ISO 8601 to human-readable format
  const formatTimestamp = (isoString: string | null): string => {
    if (!isoString) {
      return 'Not yet available';
    }

    try {
      const date = new Date(isoString);
      return date.toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'UTC',
        timeZoneName: 'short',
      });
    } catch {
      return 'Not yet available';
    }
  };

  // Show loading state
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center p-8">
        <Loader className="h-8 w-8 text-blue-600 animate-spin" />
        <p className="mt-4 text-gray-600">Loading statistics...</p>
      </div>
    );
  }

  // Show error state
  if (error) {
    return (
      <div className="p-6 bg-red-50 border border-red-200 rounded-lg">
        <p className="text-red-600">Statistics unavailable: {error}</p>
      </div>
    );
  }

  // Use fallback (zeros) if stats unavailable
  const metrics = stats?.current_metrics || {
    total_events: 0,
    total_steps: 0,
    completed_events: 0,
    completed_steps: 0,
  };

  const lastUpdated = stats?.last_updated || null;

  return (
    <div className="w-full">
      {/* Fallback message if no stats available yet */}
      {!stats && (
        <p className="text-gray-500 text-sm mb-4">Statistics are not yet available</p>
      )}

      {/* Table */}
      <table className="w-full border-collapse border border-gray-300 bg-white">
        {/* Header */}
        <thead>
          <tr className="bg-gray-100">
            <th className="border border-gray-300 px-4 py-2 text-left font-semibold text-gray-800">
              Platform Statistics
            </th>
            <th className="border border-gray-300 px-4 py-2 text-right font-semibold text-gray-800">
              Count
            </th>
          </tr>
        </thead>

        {/* Body */}
        <tbody>
          <tr className="border-b border-gray-200 hover:bg-gray-50">
            <td className="border border-gray-300 px-4 py-2 text-gray-700">Total Events</td>
            <td className="border border-gray-300 px-4 py-2 text-right font-semibold text-gray-900">
              {metrics.total_events}
            </td>
          </tr>
          <tr className="border-b border-gray-200 hover:bg-gray-50">
            <td className="border border-gray-300 px-4 py-2 text-gray-700">Total Steps</td>
            <td className="border border-gray-300 px-4 py-2 text-right font-semibold text-gray-900">
              {metrics.total_steps}
            </td>
          </tr>
          <tr className="border-b border-gray-200 hover:bg-gray-50">
            <td className="border border-gray-300 px-4 py-2 text-gray-700">Completed Events</td>
            <td className="border border-gray-300 px-4 py-2 text-right font-semibold text-gray-900">
              {metrics.completed_events}
            </td>
          </tr>
          <tr className="hover:bg-gray-50">
            <td className="border border-gray-300 px-4 py-2 text-gray-700">Completed Steps</td>
            <td className="border border-gray-300 px-4 py-2 text-right font-semibold text-gray-900">
              {metrics.completed_steps}
            </td>
          </tr>
        </tbody>
      </table>

      {/* Last Updated Timestamp */}
      <p className="text-xs text-gray-500 mt-3">
        Last updated: {formatTimestamp(lastUpdated)} UTC
      </p>
    </div>
  );
}
