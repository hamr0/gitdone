'use client';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CheckCircle, Clock, Mail, Calendar, Users, BarChart3, RefreshCw, Edit3 } from 'lucide-react';
// import { formatTimeLimit, getTimeLimitStatus } from '../../utils/timeFormat';

interface Event {
  id: string;
  name: string;
  status: string;
  flow_type: string;
  created_at: string;
  completed_at?: string;
  progress: number;
  completed_steps: number;
  total_steps: number;
  steps: Array<{
    id: string;
    name: string;
    vendor_email: string;
    status: string;
    description: string;
    time_limit?: string;
    created_at: string;
    completed_at?: string;
  }>;
  commits: Array<{
    commit_hash: string;
    step_id: string;
    vendor_email: string;
    timestamp: string;
    files: string[];
    comments: string;
  }>;
}

export default function EventPage() {
  const params = useParams();
  const [event, setEvent] = useState<Event | null>({
    id: params.id,
    name: "Sarah's wedding",
    owner_email: "avoidaccess@msn.com",
    status: "completed",
    flow_type: "sequential",
    created_at: "2025-10-03T21:34:56.574Z",
    progress: 0,
    completed_steps: 0,
    total_steps: 0,
    steps: [],
    commits: []
  });
  const [loading, setLoading] = useState(false);
  const [sendingReminder, setSendingReminder] = useState<string | null>(null);
  const [sendingManagementLink, setSendingManagementLink] = useState(false);

  useEffect(() => {
    if (params.id) {
      fetchEvent();
    }
  }, [params.id]);

  const fetchEvent = async () => {
    try {
      console.log('Fetching event with ID:', params.id);
      const response = await fetch(`/api/events?id=${params.id}`);
      console.log('Response status:', response.status);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const eventData = await response.json();
      console.log('Event data received:', eventData);
      setEvent(eventData);
    } catch (error) {
      console.error('Error fetching event:', error);
    } finally {
      setLoading(false);
    }
  };

  const sendReminder = async (stepId: string) => {
    setSendingReminder(stepId);
    try {
      const response = await fetch('/api/magic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_id: params.id,
          step_id: stepId,
          vendor_email: event?.steps.find(s => s.id === stepId)?.vendor_email
        })
      });
      
      const result = await response.json();
      if (result.success) {
        alert('Reminder sent successfully!');
      } else {
        alert('Error sending reminder: ' + result.error);
      }
    } catch (error) {
      alert('Error sending reminder');
    } finally {
      setSendingReminder(null);
    }
  };

  const handleEditEvent = async () => {
    if (!event) return;
    
    // Prompt for email to verify ownership
    const email = prompt(`Enter your email to edit "${event.name}":`, event.owner_email);
    
    if (!email) return;
    
    if (email !== event.owner_email) {
      alert('Email does not match event owner. Only the event owner can edit.');
      return;
    }
    
    setSendingManagementLink(true);
    try {
      const response = await fetch('/api/manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_id: event.id,
          owner_email: email
        })
      });
      
      const result = await response.json();
      if (result.success) {
        alert('Management link sent to your email! Check your inbox to edit the event.');
      } else {
        alert('Error sending management link: ' + result.error);
      }
    } catch (error) {
      alert('Error sending management link');
    } finally {
      setSendingManagementLink(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'bg-green-100 text-green-800';
      case 'in_progress': return 'bg-blue-100 text-blue-800';
      case 'pending': return 'bg-yellow-100 text-yellow-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed': return <CheckCircle className="h-5 w-5 text-green-600" />;
      case 'in_progress': return <Clock className="h-5 w-5 text-blue-600" />;
      case 'pending': return <Clock className="h-5 w-5 text-yellow-600" />;
      default: return <Clock className="h-5 w-5 text-gray-600" />;
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <RefreshCw className="h-8 w-8 animate-spin text-blue-600 mx-auto mb-4" />
          <p className="text-gray-600">Loading event...</p>
        </div>
      </div>
    );
  }

  if (!event) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900 mb-4">Event Not Found</h1>
          <p className="text-gray-600">The event you're looking for doesn't exist.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-4">
      <div className="max-w-6xl mx-auto px-4">
        {/* Header */}
        <div className="bg-white rounded-lg shadow p-4 mb-4">
          <div className="flex justify-between items-start mb-3">
            <div>
              <h1 className="text-xl font-bold text-gray-900 mb-1">{event.name}</h1>
              <div className="flex items-center space-x-3 text-xs text-gray-600">
                <span className="flex items-center">
                  <Calendar className="mr-1 h-3 w-3" />
                  Created: {new Date(event.created_at).toLocaleDateString()}
                </span>
                <span className="flex items-center">
                  <Users className="mr-1 h-3 w-3" />
                  {event.flow_type === 'sequential' ? 'Sequential' :
                   event.flow_type === 'non_sequential' ? 'Non-Sequential' : 'Hybrid'} Flow
                </span>
              </div>
            </div>
            <div className="flex items-center space-x-2">
              <button
                onClick={handleEditEvent}
                disabled={sendingManagementLink}
                className="bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 disabled:bg-gray-400 flex items-center text-xs"
              >
                <Edit3 className="mr-1 h-3 w-3" />
                {sendingManagementLink ? 'Sending...' : 'Edit Event'}
              </button>
              <span className={`px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(event.status)}`}>
                {event.status.charAt(0).toUpperCase() + event.status.slice(1)}
              </span>
            </div>
          </div>

          {/* Progress Bar */}
          <div className="mb-3">
            <div className="flex justify-between items-center mb-1">
              <h3 className="text-sm font-semibold text-gray-900">Progress</h3>
              <span className="text-xs text-gray-600">
                {event.completed_steps || 0} of {event.total_steps || 0} steps completed
              </span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                style={{ width: `${event.progress || 0}%` }}
              ></div>
            </div>
            <p className="text-xs text-gray-600 mt-1">{event.progress || 0}% complete</p>
          </div>

          {/* Quick Stats */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="bg-blue-50 rounded-lg p-2">
              <div className="flex items-center">
                <BarChart3 className="h-6 w-6 text-blue-600 mr-2" />
                <div>
                  <p className="text-xs text-blue-600 font-medium">Total Steps</p>
                  <p className="text-lg font-bold text-blue-900">{event.total_steps || 0}</p>
                </div>
              </div>
            </div>
            <div className="bg-green-50 rounded-lg p-2">
              <div className="flex items-center">
                <CheckCircle className="h-6 w-6 text-green-600 mr-2" />
                <div>
                  <p className="text-xs text-green-600 font-medium">Completed</p>
                  <p className="text-lg font-bold text-green-900">{event.completed_steps || 0}</p>
                </div>
              </div>
            </div>
            <div className="bg-yellow-50 rounded-lg p-2">
              <div className="flex items-center">
                <Clock className="h-6 w-6 text-yellow-600 mr-2" />
                <div>
                  <p className="text-xs text-yellow-600 font-medium">Pending</p>
                  <p className="text-lg font-bold text-yellow-900">{(event.total_steps || 0) - (event.completed_steps || 0)}</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Timeline */}
        <div className="bg-white rounded-lg shadow p-4">
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Timeline</h2>

          <div className="space-y-3">
            {event.steps.map((step, index) => (
              <div key={step.id} className="flex items-start space-x-3 p-3 border border-gray-200 rounded-lg">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs ${
                  step.status === 'completed' ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-600'
                }`}>
                  {index + 1}
                </div>

                <div className="flex-1">
                  <div className="flex items-center justify-between mb-1">
                    <h3 className="text-sm font-semibold text-gray-900">{step.name}</h3>
                    <div className="flex items-center space-x-1">
                      {getStatusIcon(step.status)}
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${getStatusColor(step.status)}`}>
                        {step.status.charAt(0).toUpperCase() + step.status.slice(1)}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-1 text-xs text-gray-600">
                    <p className="flex items-center">
                      <Mail className="mr-1 h-3 w-3" />
                      {step.vendor_email}
                    </p>
                    {step.description && (
                      <p>{step.description}</p>
                    )}
                    {step.time_limit && (
                      <p className="flex items-center">
                        <Clock className="mr-1 h-3 w-3" />
                        <span className="text-xs text-gray-600">Time limit:</span>
                        <span className="ml-1 text-xs font-medium text-blue-600">
                          {step.time_limit}
                        </span>
                      </p>
                    )}
                    {step.completed_at && (
                      <p className="text-green-600 font-medium">
                        Completed: {new Date(step.completed_at).toLocaleString()}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex flex-col space-y-1">
                  {step.status === 'pending' && (
                    <button
                      onClick={() => sendReminder(step.id)}
                      disabled={sendingReminder === step.id}
                      className="bg-blue-500 text-white px-2 py-1 rounded-lg text-xs hover:bg-blue-600 disabled:bg-gray-400 flex items-center"
                    >
                      <Mail className="mr-1 h-3 w-3" />
                      {sendingReminder === step.id ? 'Sending...' : 'Send Reminder'}
                    </button>
                  )}

                  {step.status === 'completed' && (
                    <div className="text-xs text-green-600 font-medium">
                      ✓ Completed
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Recent Activity */}
        {event.commits.length > 0 && (
          <div className="bg-white rounded-lg shadow p-4 mt-4">
            <h2 className="text-lg font-semibold text-gray-900 mb-3">Recent Activity</h2>

            <div className="space-y-2">
              {event.commits.slice(-5).reverse().map((commit, index) => {
                const step = event.steps.find(s => s.id === commit.step_id);
                return (
                  <div key={commit.commit_hash} className="flex items-start space-x-3 p-2 bg-gray-50 rounded-lg">
                    <div className="w-6 h-6 bg-green-500 rounded-full flex items-center justify-center text-white text-xs font-bold">
                      ✓
                    </div>
                    <div className="flex-1">
                      <h4 className="font-semibold text-sm text-gray-900">{step?.name}</h4>
                      <p className="text-xs text-gray-600">
                        Completed by {commit.vendor_email} • {new Date(commit.timestamp).toLocaleString()}
                      </p>
                      {commit.comments && (
                        <p className="text-xs text-gray-700 mt-0.5">"{commit.comments}"</p>
                      )}
                      {commit.files.length > 0 && (
                        <p className="text-xs text-blue-600 mt-0.5">
                          {commit.files.length} file(s) uploaded
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}