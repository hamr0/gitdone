'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2, Calendar, Users, Clock, Edit3, Mail, CheckCircle, AlertCircle } from 'lucide-react';
import Modal from '../components/Modal';
import StatsTable from '../components/StatsTable';

interface Step {
  name: string;
  vendor_email: string;
  description: string;
  time_limit?: string;
  sequence?: number;
}

interface StepWithId extends Step {
  id: string;
}

interface StatsData {
  current_metrics: {
    total_events: number;
    total_steps: number;
    completed_events: number;
    completed_steps: number;
  };
  last_updated: string | null;
}

export default function Home() {
  const router = useRouter();
  const [eventName, setEventName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [flowType, setFlowType] = useState<'sequential' | 'non_sequential' | 'hybrid'>('sequential');
  const [steps, setSteps] = useState<Step[]>([
    { name: '', vendor_email: '', description: '', time_limit: '', sequence: 1 }
  ]);
  const [loading, setLoading] = useState(false);

  // Stats state management
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [stats, setStats] = useState<StatsData | null>(null);

  // Edit event state
  const [editOwnerEmail, setEditOwnerEmail] = useState('');
  const [sendingEditLink, setSendingEditLink] = useState(false);

  // Modal states
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [modalMessage, setModalMessage] = useState('');
  const [createdEventId, setCreatedEventId] = useState('');

  // Fetch stats on component mount
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

  useEffect(() => {
    fetchStats();
  }, []);

  const addStep = () => {
    const nextSequence = Math.max(...steps.map(s => s.sequence || 0)) + 1;
    setSteps([...steps, { name: '', vendor_email: '', description: '', time_limit: '', sequence: nextSequence }]);
  };

  const removeStep = (index: number) => {
    if (steps.length > 1) {
      setSteps(steps.filter((_, i) => i !== index));
    }
  };

  const updateStep = (index: number, field: keyof Step, value: string) => {
    const newSteps = [...steps];
    newSteps[index][field] = value;
    setSteps(newSteps);
  };

  const createEvent = async () => {
    if (!eventName.trim() || !ownerEmail.trim()) {
      setModalMessage('Please fill in event name and your email');
      setShowErrorModal(true);
      return;
    }

    const validSteps = steps.filter(step =>
      step.name.trim() && step.vendor_email.trim()
    );

    if (validSteps.length === 0) {
      setModalMessage('Please add at least one step with name and vendor email');
      setShowErrorModal(true);
      return;
    }

    setLoading(true);

    try {
      console.log('Creating event with data:', {
        name: eventName.trim(),
        owner_email: ownerEmail.trim(),
        flow_type: flowType,
        steps: validSteps.map(step => ({
          name: step.name.trim(),
          vendor_email: step.vendor_email.trim(),
          description: step.description.trim(),
          time_limit: step.time_limit?.trim() || null,
          sequence: step.sequence
        }))
      });

      const response = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: eventName.trim(),
          owner_email: ownerEmail.trim(),
          flow_type: flowType,
          steps: validSteps.map(step => ({
            name: step.name.trim(),
            vendor_email: step.vendor_email.trim(),
            description: step.description.trim(),
            time_limit: step.time_limit?.trim() || null,
            sequence: step.sequence
          }))
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();

      if (result.success) {
        setCreatedEventId(result.eventId);
        setModalMessage(`Event "${eventName}" created successfully! Magic links have been sent to vendors.`);
        setShowSuccessModal(true);
      } else {
        setModalMessage('Error creating event: ' + result.error);
        setShowErrorModal(true);
      }
    } catch (error) {
      console.error('Error creating event:', error);
      setModalMessage('Error creating event. Please try again.');
      setShowErrorModal(true);
    } finally {
      setLoading(false);
    }
  };

  const sendMagicLinksBasedOnFlow = async (eventId: string, steps: StepWithId[], flowType: string) => {
    try {
      let stepsToTrigger = [];
      
      if (flowType === 'sequential') {
        // For sequential flow, only trigger the first step
        stepsToTrigger = [steps[0]];
      } else if (flowType === 'hybrid') {
        // For hybrid flow, trigger all steps with sequence 1
        stepsToTrigger = steps.filter(step => (step.sequence || 1) === 1);
      } else {
        // For non_sequential flow, trigger all steps
        stepsToTrigger = steps;
      }
      
      console.log(`Triggering ${stepsToTrigger.length} step(s) for ${flowType} flow:`, stepsToTrigger.map(s => s.name));
      
      const promises = stepsToTrigger.map(step => 
        fetch('/api/magic', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event_id: eventId,
            step_id: step.id,
            vendor_email: step.vendor_email
          })
        })
      );
      
      await Promise.all(promises);
    } catch (error) {
      console.error('Error sending magic links:', error);
    }
  };

  const sendMagicLinks = async (eventId: string, steps: StepWithId[]) => {
    try {
      const promises = steps.map(step => 
        fetch('/api/magic', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event_id: eventId,
            step_id: step.id, // Use the actual step ID from the backend response
            vendor_email: step.vendor_email
          })
        })
      );
      
      await Promise.all(promises);
    } catch (error) {
      console.error('Error sending magic links:', error);
    }
  };

  const sendEditLink = async () => {
    if (!editOwnerEmail.trim()) {
      setModalMessage('Please enter your email address');
      setShowErrorModal(true);
      return;
    }

    setSendingEditLink(true);
    try {
      const response = await fetch('/api/manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner_email: editOwnerEmail.trim()
        })
      });

      const result = await response.json();
      if (result.success) {
        setModalMessage('Management links sent to your email! Check your inbox to edit your events.');
        setShowSuccessModal(true);
        setEditOwnerEmail('');
      } else {
        setModalMessage('Error sending management links: ' + result.error);
        setShowErrorModal(true);
      }
    } catch (error) {
      console.error('Error sending management links:', error);
      setModalMessage('Error sending management links. Please try again.');
      setShowErrorModal(true);
    } finally {
      setSendingEditLink(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 py-4">
      <div className="max-w-4xl mx-auto px-4">
        <div className="text-center mb-4">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">
            GitDone Workflow Manager
          </h1>
          <p className="text-sm text-gray-600">
            Create new workflows or edit existing ones
          </p>
        </div>

        {/* Edit Existing Event Section */}
        <div className="bg-white rounded-lg shadow p-4 mb-4">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center mb-3">
            <Edit3 className="mr-2 h-5 w-5 text-green-600" />
            Edit Existing Event
          </h2>
          <p className="text-sm text-gray-600 mb-3">
            Already have an event? Enter your email to get management links for all your events.
          </p>

          <div className="max-w-md">
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Your Email *
            </label>
            <input
              type="email"
              value={editOwnerEmail}
              onChange={(e) => setEditOwnerEmail(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
              placeholder="planner@email.com"
            />
          </div>

          <div className="mt-3">
            <button
              onClick={sendEditLink}
              disabled={sendingEditLink}
              className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 disabled:bg-gray-400 flex items-center text-xs font-medium"
            >
              <Mail className="mr-2 h-3 w-3" />
              {sendingEditLink ? 'Sending...' : 'Send Management Link'}
            </button>
          </div>
        </div>

        {/* Divider */}
        <div className="flex items-center my-4">
          <div className="flex-1 border-t border-gray-300"></div>
          <span className="px-3 text-sm text-gray-500 font-medium">OR</span>
          <div className="flex-1 border-t border-gray-300"></div>
        </div>

        <div className="bg-white rounded-lg shadow p-4 space-y-4">
          {/* Event Basic Info */}
          <div className="space-y-3">
            <h2 className="text-lg font-semibold text-gray-900 flex items-center">
              <Calendar className="mr-2 h-5 w-5 text-blue-600" />
              Create New Event
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Event Name *
                </label>
                <input
                  type="text"
                  value={eventName}
                  onChange={(e) => setEventName(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="e.g., Sarah's Wedding, Kitchen Renovation"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Your Email *
                </label>
                <input
                  type="email"
                  value={ownerEmail}
                  onChange={(e) => setOwnerEmail(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="planner@email.com"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Flow Type
              </label>
              <select
                value={flowType}
                onChange={(e) => setFlowType(e.target.value as 'sequential' | 'non_sequential' | 'hybrid')}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="sequential">Sequential (A → B → C)</option>
                <option value="non_sequential">Non-Sequential (A, B, C in any order)</option>
                <option value="hybrid">Hybrid (Custom sequencing: 1, 1, 2, 3, 4, 5, 5, 6, 7)</option>
              </select>
              <p className="mt-1 text-xs text-gray-500">
                {flowType === 'sequential'
                  ? 'Steps must be completed in order'
                  : flowType === 'non_sequential'
                  ? 'Steps can be completed independently'
                  : 'Steps can have custom sequence numbers (e.g., 1, 1, 2, 3, 4, 5, 5, 6, 7)'
                }
              </p>
            </div>
          </div>

          {/* Steps */}
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-semibold text-gray-900 flex items-center">
                <Users className="mr-2 h-5 w-5 text-green-600" />
                Steps & Vendors
              </h2>
              <button
                type="button"
                onClick={addStep}
                className="bg-green-500 text-white px-3 py-1.5 text-xs rounded-lg hover:bg-green-600 flex items-center"
              >
                <Plus className="mr-1 h-3 w-3" />
                Add Step
              </button>
            </div>

            {steps.map((step, index) => (
              <div key={index} className="border border-gray-200 rounded-lg p-3 space-y-2">
                <div className="flex justify-between items-center">
                  <h3 className="font-semibold text-sm text-gray-900">
                    Step {index + 1}
                  </h3>
                  {steps.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeStep(index)}
                      className="text-red-500 hover:text-red-700 flex items-center text-xs"
                    >
                      <Trash2 className="mr-1 h-3 w-3" />
                      Remove
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Step Name *
                    </label>
                    <input
                      type="text"
                      value={step.name}
                      onChange={(e) => updateStep(index, 'name', e.target.value)}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="e.g., Venue Setup, Catering Ready"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Vendor Email *
                    </label>
                    <input
                      type="email"
                      value={step.vendor_email}
                      onChange={(e) => updateStep(index, 'vendor_email', e.target.value)}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="vendor@email.com"
                    />
                  </div>

                  {flowType === 'hybrid' && (
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">
                        Sequence Number *
                      </label>
                      <input
                        type="number"
                        min="1"
                        value={step.sequence || ''}
                        onChange={(e) => updateStep(index, 'sequence', parseInt(e.target.value) || 1)}
                        className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        placeholder="1"
                      />
                      <p className="text-xs text-gray-500 mt-0.5">Order of execution (1, 1, 2, 3, 4, 5, 5, 6, 7)</p>
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Description
                  </label>
                  <textarea
                    value={step.description}
                    onChange={(e) => updateStep(index, 'description', e.target.value)}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="What needs to be done?"
                    rows={2}
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1 flex items-center">
                    <Clock className="mr-1 h-3 w-3" />
                    Time Limit (Optional)
                  </label>
                  <div className="space-y-1">
                    <select
                      value={step.time_limit || ''}
                      onChange={(e) => updateStep(index, 'time_limit', e.target.value)}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    >
                      <option value="">No time limit</option>
                      <option value="30m">30 minutes</option>
                      <option value="1h">1 hour</option>
                      <option value="2h">2 hours</option>
                      <option value="4h">4 hours</option>
                      <option value="6h">6 hours</option>
                      <option value="12h">12 hours</option>
                      <option value="16h">16 hours</option>
                      <option value="24h">24 hours</option>
                      <option value="2d">2 days</option>
                      <option value="3d">3 days</option>
                      <option value="1w">1 week</option>
                    </select>
                    <input
                      type="text"
                      value={step.time_limit || ''}
                      onChange={(e) => updateStep(index, 'time_limit', e.target.value)}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="Or enter custom: 2024-12-25, Dec 25 2024 2:00 PM"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="pt-3 border-t border-gray-200">
            <button
              onClick={createEvent}
              disabled={loading}
              className="w-full bg-blue-600 text-white py-2.5 rounded-lg font-semibold hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-sm"
            >
              {loading ? 'Creating Event...' : 'Create Event & Send Invitations'}
            </button>
          </div>
        </div>

        {/* Stats Section */}
        <section className="mt-12 mb-8 bg-white rounded-lg shadow p-4">
          <h2 className="text-lg font-semibold text-gray-900 mb-6">Platform Statistics</h2>
          <div className="px-4 md:px-0">
            <StatsTable
              loading={statsLoading}
              error={statsError}
              stats={stats}
            />
          </div>
        </section>
      </div>

      {/* Success Modal */}
      <Modal
        isOpen={showSuccessModal}
        onClose={() => setShowSuccessModal(false)}
        title="Success!"
      >
        <div className="text-center py-4">
          <CheckCircle className="h-16 w-16 text-green-500 mx-auto mb-4" />
          <p className="text-gray-700 mb-6">{modalMessage}</p>
          {createdEventId && (
            <button
              onClick={() => router.push(`/event/${createdEventId}`)}
              className="w-full bg-blue-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-blue-700 mb-2"
            >
              View Event
            </button>
          )}
          <button
            onClick={() => {
              setShowSuccessModal(false);
              if (createdEventId) {
                // Reset form
                setEventName('');
                setOwnerEmail('');
                setSteps([{ name: '', vendor_email: '', description: '', time_limit: '', sequence: 1 }]);
                setCreatedEventId('');
              }
            }}
            className="w-full bg-gray-200 text-gray-700 px-6 py-3 rounded-lg font-semibold hover:bg-gray-300"
          >
            Close
          </button>
        </div>
      </Modal>

      {/* Error Modal */}
      <Modal
        isOpen={showErrorModal}
        onClose={() => setShowErrorModal(false)}
        title="Error"
      >
        <div className="text-center py-4">
          <AlertCircle className="h-16 w-16 text-red-500 mx-auto mb-4" />
          <p className="text-gray-700 mb-6">{modalMessage}</p>
          <button
            onClick={() => setShowErrorModal(false)}
            className="w-full bg-blue-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-blue-700"
          >
            Close
          </button>
        </div>
      </Modal>
    </div>
  );
}