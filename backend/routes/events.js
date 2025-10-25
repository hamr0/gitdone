const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');
const EventCreationEmailService = require('../utils/eventCreationEmail');
const MagicLinkService = require('../utils/magicLinkService');

const EVENTS_DIR = path.join(__dirname, '../../data/events');

// Ensure events directory exists
async function ensureEventsDir() {
  try {
    await fs.access(EVENTS_DIR);
  } catch {
    await fs.mkdir(EVENTS_DIR, { recursive: true });
  }
}

// Calculate required previous step based on flow type
function calculateRequiredPrevious(flowType, steps, currentIndex) {
  if (flowType === 'sequential') {
    return currentIndex > 0 ? steps[currentIndex - 1].id : null;
  } else if (flowType === 'hybrid') {
    const currentStep = steps[currentIndex];
    const currentSequence = currentStep.sequence || (currentIndex + 1);
    
    // Find the previous step with a lower sequence number
    const previousStep = steps
      .slice(0, currentIndex)
      .reverse()
      .find(step => (step.sequence || (steps.indexOf(step) + 1)) < currentSequence);
    
    return previousStep ? previousStep.id : null;
  } else {
    // non_sequential - no dependencies
    return null;
  }
}

// POST /api/events - Create new event
router.post('/', async (req, res) => {
  try {
    await ensureEventsDir();
    
    const { name, owner_email, flow_type, steps } = req.body;
    
    // Validation
    if (!name || !owner_email || !steps || steps.length === 0) {
      return res.status(400).json({ error: 'Missing required fields: name, owner_email, steps' });
    }
    
    const eventId = uuidv4();
    
    const event = {
      id: eventId,
      name,
      owner_email,
      flow_type: flow_type || 'sequential',
      created_at: new Date().toISOString(),
      status: 'active',
      steps: steps.map((step, index) => ({
        id: uuidv4(),
        name: step.name,
        vendor_email: step.vendor_email,
        status: 'pending',
        required_previous: calculateRequiredPrevious(flow_type, steps, index),
        time_limit: step.time_limit || null,
        description: step.description || '',
        sequence: step.sequence || (index + 1),
        created_at: new Date().toISOString()
      })),
      commits: []
    };
    
    await fs.writeFile(
      path.join(EVENTS_DIR, `${eventId}.json`),
      JSON.stringify(event, null, 2)
    );

    // Send event creation email to owner
    try {
      const eventCreationEmailService = new EventCreationEmailService();
      await eventCreationEmailService.sendEventCreationEmail(event);
      console.log('✅ Event creation email sent to organizer');
    } catch (emailError) {
      console.error('Failed to send event creation email:', emailError);
      // Don't fail the request if email fails
    }

    // Automatically send magic links for ready-to-execute steps
    try {
      const magicLinkService = new MagicLinkService();
      let readySteps = [];

      if (flow_type === 'sequential') {
        // Sequential: only first step is ready
        readySteps = event.steps.length > 0 ? [event.steps[0]] : [];
      } else if (flow_type === 'hybrid') {
        // Hybrid: all steps with the minimum sequence number are ready
        const minSequence = Math.min(...event.steps.map(s => s.sequence));
        readySteps = event.steps.filter(s => s.sequence === minSequence);
      } else {
        // Non-sequential: all steps are ready
        readySteps = event.steps;
      }

      // Send magic links to all ready steps
      const magicLinkResults = [];
      for (const step of readySteps) {
        try {
          const result = await magicLinkService.sendMagicLink(eventId, step.id, step.vendor_email);
          magicLinkResults.push({
            step_name: step.name,
            vendor_email: step.vendor_email,
            success: true
          });
          console.log(`✅ Magic link sent to ${step.vendor_email} for step: ${step.name}`);
        } catch (linkError) {
          magicLinkResults.push({
            step_name: step.name,
            vendor_email: step.vendor_email,
            success: false,
            error: linkError.message
          });
          console.error(`Failed to send magic link for step ${step.name}:`, linkError.message);
        }
      }

      res.json({
        success: true,
        eventId,
        event,
        magic_links_sent: magicLinkResults
      });
    } catch (magicLinkError) {
      console.error('Error sending magic links:', magicLinkError);
      // Event was created successfully, just return without magic link info
      res.json({ success: true, eventId, event });
    }
  } catch (error) {
    console.error('Error creating event:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/events/:id - Get event details
router.get('/:id', async (req, res) => {
  try {
    const eventPath = path.join(EVENTS_DIR, `${req.params.id}.json`);
    const eventData = await fs.readFile(eventPath, 'utf8');
    const event = JSON.parse(eventData);
    
    // Calculate progress
    const completedSteps = event.steps.filter(step => step.status === 'completed').length;
    const totalSteps = event.steps.length;
    const progress = totalSteps > 0 ? (completedSteps / totalSteps) * 100 : 0;
    
    res.json({
      ...event,
      progress: Math.round(progress),
      completed_steps: completedSteps,
      total_steps: totalSteps
    });
  } catch (error) {
    console.error('Error fetching event:', error);
    res.status(404).json({ error: 'Event not found' });
  }
});

// GET /api/events/:id/timeline - Get event timeline
router.get('/:id/timeline', async (req, res) => {
  try {
    const eventPath = path.join(EVENTS_DIR, `${req.params.id}.json`);
    const eventData = await fs.readFile(eventPath, 'utf8');
    const event = JSON.parse(eventData);
    
    // Create timeline from commits
    const timeline = event.commits.map(commit => ({
      ...commit,
      step: event.steps.find(s => s.id === commit.step_id)
    })).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    res.json({ timeline, event: { name: event.name, status: event.status } });
  } catch (error) {
    console.error('Error fetching timeline:', error);
    res.status(404).json({ error: 'Event not found' });
  }
});

// POST /api/events/:id/steps - Add step to event
router.post('/:id/steps', async (req, res) => {
  try {
    const eventPath = path.join(EVENTS_DIR, `${req.params.id}.json`);
    const eventData = await fs.readFile(eventPath, 'utf8');
    const event = JSON.parse(eventData);
    
    const { name, vendor_email, description, time_limit } = req.body;
    
    if (!name || !vendor_email) {
      return res.status(400).json({ error: 'Missing required fields: name, vendor_email' });
    }
    
    const newStep = {
      id: uuidv4(),
      name,
      vendor_email,
      status: 'pending',
      required_previous: event.flow_type === 'sequential' && event.steps.length > 0 
        ? event.steps[event.steps.length - 1].id 
        : null,
      time_limit: time_limit || null,
      description: description || '',
      created_at: new Date().toISOString()
    };
    
    event.steps.push(newStep);
    
    await fs.writeFile(eventPath, JSON.stringify(event, null, 2));
    
    res.json({ success: true, step: newStep });
  } catch (error) {
    console.error('Error adding step:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/events/:id/status - Update event status
router.put('/:id/status', async (req, res) => {
  try {
    const eventPath = path.join(EVENTS_DIR, `${req.params.id}.json`);
    const eventData = await fs.readFile(eventPath, 'utf8');
    const event = JSON.parse(eventData);
    
    const { status } = req.body;
    
    if (!['active', 'completed', 'archived'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be: active, completed, or archived' });
    }
    
    event.status = status;
    event.updated_at = new Date().toISOString();
    
    await fs.writeFile(eventPath, JSON.stringify(event, null, 2));
    
    res.json({ success: true, event });
  } catch (error) {
    console.error('Error updating event status:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;