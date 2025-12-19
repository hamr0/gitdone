I'll create two comprehensive MD files for you.

## First, the **MVP Specification MD**:

```markdown
# FlowProof MVP Specification

## 🎯 Product Vision
**"Git-like sequence proof for physical world workflows"**
A simple web app for multi-vendor coordination with cryptographic proof of work sequence and timing.

## 🏗️ Architecture Overview

### Tech Stack
```
Frontend: Next.js 14 (TypeScript) + Tailwind CSS
Backend: Node.js + Express
Storage: JSON files + Git repositories
Email: Nodemailer + Gmail SMTP
Auth: JWT magic links
File Processing: Sharp (images) + fluent-ffmpeg (videos)
Deployment: RackNerd VPS
```

### File Structure
```
flowproof/
├── data/
│   ├── events/                 # JSON event files
│   ├── git_repos/              # Git repositories
│   ├── magic_tokens.json       # Active tokens
│   └── analytics.json          # Usage metrics
├── frontend/                   # Next.js app
├── backend/                    # Express API
└── scripts/                    # Utility scripts
```

## 📁 Data Models

### Event Schema (events/{eventId}.json)
```json
{
  "id": "wedding_abc123",
  "name": "Sarah's Wedding",
  "owner_email": "planner@email.com",
  "flow_type": "sequential", // or "non_sequential"
  "created_at": "2024-01-15T10:00:00Z",
  "status": "active", // active, completed, archived
  "steps": [
    {
      "id": "step_1",
      "name": "Venue Setup",
      "vendor_email": "venue@email.com",
      "status": "pending", // pending, in_progress, completed
      "required_previous": null, // for sequential flows
      "time_limit": "24 hours", // optional
      "description": "Setup tables, chairs, decor"
    }
  ],
  "commits": [
    {
      "commit_hash": "a1b2c3d4",
      "step_id": "step_1",
      "vendor_email": "venue@email.com",
      "timestamp": "2024-01-15T14:30:00Z",
      "files": ["photo1.jpg", "photo2.jpg"],
      "comments": "Venue setup complete with 50 tables",
      "parent_hash": null
    }
  ]
}
```

### Magic Token Schema (magic_tokens.json)
```json
{
  "tokens": {
    "xyz_token_123": {
      "event_id": "wedding_abc123",
      "step_id": "step_1",
      "vendor_email": "venue@email.com",
      "created_at": "2024-01-15T10:00:00Z",
      "expires_at": "2024-02-15T10:00:00Z", // 30 days default
      "used": false
    }
  }
}
```

## 🔄 Flow Types

### Sequential Flow
```
A → B → C
- Step B requires Step A completion
- Git commits form linear chain
- Time limits can auto-advance steps
```

### Non-Sequential Flow
```
A, B, C (any order)
- Steps can complete independently
- Git commits form tree structure
- All steps must complete for event completion
```

## 🔐 Authentication & Security

### Magic Link Generation
```javascript
// JWT-based magic links
function generateMagicLink(eventId, stepId, vendorEmail) {
  const token = jwt.sign(
    {
      event_id: eventId,
      step_id: stepId,
      vendor_email: vendorEmail,
      purpose: 'step_completion'
    },
    process.env.JWT_SECRET,
    { expiresIn: '30 days' } // No expiration for non-timed steps
  );
  
  return `https://flowproof.com/complete/${token}`;
}
```

### Token Validation
```javascript
function validateMagicLink(token) {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Additional checks
    if (decoded.vendor_email !== currentVendorEmail) {
      throw new Error('Token email mismatch');
    }
    
    return decoded;
  } catch (error) {
    throw new Error('Invalid or expired magic link');
  }
}
```

## 📧 Email System

### Email Templates
```javascript
const emailTemplates = {
  step_assignment: {
    subject: "Action Required: {stepName} for {eventName}",
    body: `
      You've been assigned a task for {eventName}.
      
      Task: {stepName}
      Description: {stepDescription}
      
      Click here to complete: {magicLink}
      
      This link is unique to you and will expire in 30 days.
    `
  },
  step_completed: {
    subject: "Step Completed: {stepName} for {eventName}",
    body: `
      {vendorEmail} has completed: {stepName}
      
      Comments: {comments}
      Photos: {photoCount} attached
      
      View progress: {eventLink}
    `
  },
  event_completed: {
    subject: "🎉 Event Complete: {eventName}",
    body: `
      All steps have been completed for {eventName}!
      
      Timeline:
      {timelineSummary}
      
      Download complete event history: {exportLink}
    `
  }
};
```

## 🗂️ File Handling

### File Processing Pipeline
```javascript
async function processUploadedFile(file) {
  const maxSizes = {
    image: 2 * 1024 * 1024, // 2MB
    video: 25 * 1024 * 1024, // 25MB
    document: 10 * 1024 * 1024 // 10MB
  };
  
  if (file.mimetype.startsWith('image/')) {
    return await sharp(file.buffer)
      .webp({ quality: 85 })
      .toBuffer();
  }
  
  if (file.mimetype.startsWith('video/')) {
    return await convertToMP4(file.buffer, {
      size: '1280x720',
      bitrate: '1500k'
    });
  }
  
  return file.buffer; // Documents as-is
}
```

### Git Integration
```javascript
class EventGit {
  constructor(eventId) {
    this.repoPath = `./data/git_repos/${eventId}`;
    this.git = simpleGit(this.repoPath);
  }
  
  async initialize() {
    await this.git.init();
    // Initial commit with event config
  }
  
  async commitStep(stepData, files, comments) {
    const commitMessage = `
      STEP_COMPLETE: ${stepData.name}
      Vendor: ${stepData.vendor_email}
      Timestamp: ${new Date().toISOString()}
      Files: ${files.length} files
      Comments: ${comments}
    `.trim();
    
    // Add files to repo
    for (const file of files) {
      fs.writeFileSync(`${this.repoPath}/files/${file.name}`, file.buffer);
    }
    
    await this.git.add('./*');
    const commit = await this.git.commit(commitMessage);
    return commit.commit;
  }
}
```

## 🌐 API Endpoints

### Event Management
```
POST   /api/events           - Create new event
GET    /api/events/:id       - Get event details
GET    /api/events/:id/timeline - Get event timeline
```

### Step Management
```
POST   /api/events/:id/steps - Add step to event
POST   /api/steps/:id/complete - Complete step (magic link)
GET    /api/steps/:id        - Get step details
```

### Vendor Interface
```
GET    /api/complete/:token  - Magic link landing
POST   /api/complete/:token  - Submit step completion
```

### Public Views
```
GET    /api/view/:eventId    - Read-only event view
GET    /api/export/:eventId  - Export event data
```

## 📱 UI Components

### Core Pages
```
/
  - Landing page with event creation

/event/[id]
  - Event owner dashboard
  - Timeline view
  - Management controls

/complete/[token]
  - Vendor completion interface
  - Mobile-optimized
  - File upload

/view/[eventId]
  - Read-only progress view
  - Client/stakeholder access
```

### Key Components
```
<EventCreator>
  - Flow type selection
  - Step configuration
  - Vendor email input

<TimelineView>
  - Visual progress display
  - Photo gallery
  - Status indicators

<StepCompleter>
  - File upload interface
  - Comment input
  - Mobile camera integration

<ProgressTracker>
  - Completion percentages
  - Bottleneck identification
  - Time tracking
```

## 🔧 Configuration

### Environment Variables
```bash
# Email
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@gmail.com
SMTP_PASS=app-specific-password

# Security
JWT_SECRET=your-jwt-secret
ENCRYPTION_KEY=your-encryption-key

# Storage
DATA_PATH=./data
MAX_FILE_SIZE=26214400

# Server
PORT=3000
NODE_ENV=production
```

## 🚀 Deployment

### VPS Setup
```bash
# Initial server setup
ssh root@your-vps
apt update && apt upgrade -y
apt install nodejs npm git ffmpeg -y

# Application setup
git clone https://github.com/your-repo/flowproof.git
cd flowproof
npm install

# Production setup
npm run build
npm start
```

### Process Management
```json
{
  "scripts": {
    "dev": "concurrently \"npm run dev:frontend\" \"npm run dev:backend\"",
    "dev:frontend": "cd frontend && npm run dev",
    "dev:backend": "cd backend && nodemon server.js",
    "build": "cd frontend && npm run build",
    "start": "cd backend && node server.js"
  }
}
```

## 📊 Analytics & Monitoring

### Key Metrics
```javascript
const analytics = {
  events: {
    total_created: 0,
    by_flow_type: { sequential: 0, non_sequential: 0 },
    completion_rate: 0.0
  },
  steps: {
    total_assigned: 0,
    completion_rate: 0.0,
    average_completion_time: 0,
    photo_upload_rate: 0.0
  },
  vendors: {
    unique_vendors: 0,
    average_steps_per_vendor: 0.0
  },
  system: {
    magic_links_sent: 0,
    magic_links_used: 0,
    file_uploads: 0,
    error_rate: 0.0
  }
};
```

## 🎯 MVP Success Criteria

### Functional Requirements
- [ ] Create events with sequential/non-sequential flows
- [ ] Send magic links to vendors via email
- [ ] Vendor can upload files and complete steps
- [ ] Real-time timeline view for event owners
- [ ] Read-only view for clients
- [ ] Basic file compression and processing
- [ ] Git-based commit history

### Non-Functional Requirements
- [ ] Mobile-responsive vendor interface
- [ ] < 5 second step completion process
- [ /> 95% email deliverability rate
- [ ] < 100ms API response times
- [ ] Support 100 concurrent users

### Business Metrics
- [ ] 10 active events in first month
- [ ] 85% step completion rate
- [ ] 70% photo upload rate
- [ ] 3 user testimonials
```

## Now, the **Cursor AI Agent Prompt MD**:

```markdown
# Cursor AI Implementation Guide - FlowProof MVP

## 🎯 Project Setup Instructions

### Step 1: Initialize Project Structure
```bash
# Create project directory
mkdir flowproof-mvp
cd flowproof-mvp

# Initialize package.json for workspace
npm init -y

# Create workspace structure
mkdir -p frontend backend data/events data/git_repos scripts
```

### Step 2: Frontend Setup (Next.js)
```bash
cd frontend
npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*"
npm install axios lucide-react
```

### Step 3: Backend Setup (Express)
```bash
cd ../backend
npm init -y
npm install express cors helmet morgan dotenv
npm install nodemailer jsonwebtoken sharp fluent-ffmpeg simple-git
npm install -D nodemon @types/node
```

## 🏗️ Implementation Steps

### PHASE 1: CORE BACKEND (Days 1-3)

#### Step 1.1: Basic Express Server
```javascript
// backend/server.js
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`FlowProof API running on port ${PORT}`);
});
```

#### Step 1.2: Event Management API
```javascript
// backend/routes/events.js
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');

const EVENTS_DIR = path.join(__dirname, '../../data/events');

// Ensure events directory exists
async function ensureEventsDir() {
  try {
    await fs.access(EVENTS_DIR);
  } catch {
    await fs.mkdir(EVENTS_DIR, { recursive: true });
  }
}

// POST /api/events - Create new event
router.post('/', async (req, res) => {
  try {
    await ensureEventsDir();
    
    const { name, owner_email, flow_type, steps } = req.body;
    const eventId = uuidv4();
    
    const event = {
      id: eventId,
      name,
      owner_email,
      flow_type: flow_type || 'sequential',
      created_at: new Date().toISOString(),
      status: 'active',
      steps: steps.map(step => ({
        id: uuidv4(),
        name: step.name,
        vendor_email: step.vendor_email,
        status: 'pending',
        required_previous: step.required_previous || null,
        time_limit: step.time_limit || null,
        description: step.description || ''
      })),
      commits: []
    };
    
    await fs.writeFile(
      path.join(EVENTS_DIR, `${eventId}.json`),
      JSON.stringify(event, null, 2)
    );
    
    res.json({ success: true, eventId, event });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/events/:id - Get event details
router.get('/:id', async (req, res) => {
  try {
    const eventPath = path.join(EVENTS_DIR, `${req.params.id}.json`);
    const eventData = await fs.readFile(eventPath, 'utf8');
    res.json(JSON.parse(eventData));
  } catch (error) {
    res.status(404).json({ error: 'Event not found' });
  }
});

module.exports = router;
```

#### Step 1.3: Magic Link System
```javascript
// backend/routes/magic.js
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const fs = require('fs').promises;
const path = require('path');

const EVENTS_DIR = path.join(__dirname, '../../data/events');

// Email transporter
const transporter = nodemailer.createTransporter({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// POST /api/magic/send - Send magic link
router.post('/send', async (req, res) => {
  try {
    const { event_id, step_id, vendor_email } = req.body;
    
    // Read event to validate
    const eventPath = path.join(EVENTS_DIR, `${event_id}.json`);
    const eventData = await fs.readFile(eventPath, 'utf8');
    const event = JSON.parse(eventData);
    
    const step = event.steps.find(s => s.id === step_id);
    if (!step) {
      return res.status(404).json({ error: 'Step not found' });
    }
    
    // Generate magic token
    const token = jwt.sign(
      {
        event_id,
        step_id,
        vendor_email,
        purpose: 'step_completion'
      },
      process.env.JWT_SECRET || 'fallback-secret-change-in-production',
      { expiresIn: '30 days' }
    );
    
    const magicLink = `${process.env.BASE_URL || 'http://localhost:3000'}/complete/${token}`;
    
    // Send email
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: vendor_email,
      subject: `Action Required: ${step.name} for ${event.name}`,
      html: `
        <h2>You have a task to complete</h2>
        <p><strong>Event:</strong> ${event.name}</p>
        <p><strong>Task:</strong> ${step.name}</p>
        <p><strong>Description:</strong> ${step.description || 'No description provided'}</p>
        <a href="${magicLink}" style="background: #0070f3; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;">
          Complete This Step
        </a>
        <p><small>This link is unique to you and will expire in 30 days.</small></p>
      `
    });
    
    res.json({ success: true, message: 'Magic link sent' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
```

### PHASE 2: FRONTEND (Days 4-6)

#### Step 2.1: Event Creation Form
```typescript
// frontend/src/app/page.tsx
'use client';
import { useState } from 'react';

interface Step {
  name: string;
  vendor_email: string;
  description: string;
}

export default function Home() {
  const [eventName, setEventName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [flowType, setFlowType] = useState<'sequential' | 'non_sequential'>('sequential');
  const [steps, setSteps] = useState<Step[]>([{ name: '', vendor_email: '', description: '' }]);

  const addStep = () => {
    setSteps([...steps, { name: '', vendor_email: '', description: '' }]);
  };

  const removeStep = (index: number) => {
    setSteps(steps.filter((_, i) => i !== index));
  };

  const updateStep = (index: number, field: keyof Step, value: string) => {
    const newSteps = [...steps];
    newSteps[index][field] = value;
    setSteps(newSteps);
  };

  const createEvent = async () => {
    try {
      const response = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: eventName,
          owner_email: ownerEmail,
          flow_type: flowType,
          steps: steps
        })
      });
      
      const result = await response.json();
      if (result.success) {
        alert(`Event created! ID: ${result.eventId}`);
        // Redirect to event page
        window.location.href = `/event/${result.eventId}`;
      }
    } catch (error) {
      alert('Error creating event');
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-2xl mx-auto px-4">
        <h1 className="text-3xl font-bold text-gray-900 mb-8">Create New Event</h1>
        
        <div className="bg-white rounded-lg shadow-md p-6 space-y-6">
          {/* Event Basic Info */}
          <div>
            <label className="block text-sm font-medium text-gray-700">Event Name</label>
            <input
              type="text"
              value={eventName}
              onChange={(e) => setEventName(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
              placeholder="e.g., Sarah's Wedding, Kitchen Renovation"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Your Email</label>
            <input
              type="email"
              value={ownerEmail}
              onChange={(e) => setOwnerEmail(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
              placeholder="planner@email.com"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Flow Type</label>
            <select
              value={flowType}
              onChange={(e) => setFlowType(e.target.value as any)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
            >
              <option value="sequential">Sequential (A → B → C)</option>
              <option value="non_sequential">Non-Sequential (A, B, C in any order)</option>
            </select>
          </div>

          {/* Steps */}
          <div>
            <div className="flex justify-between items-center mb-4">
              <label className="block text-sm font-medium text-gray-700">Steps</label>
              <button
                type="button"
                onClick={addStep}
                className="bg-blue-500 text-white px-3 py-1 rounded text-sm"
              >
                Add Step
              </button>
            </div>
            
            {steps.map((step, index) => (
              <div key={index} className="border rounded-lg p-4 mb-4 space-y-3">
                <div className="flex justify-between">
                  <h3 className="font-medium">Step {index + 1}</h3>
                  {steps.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeStep(index)}
                      className="text-red-500 text-sm"
                    >
                      Remove
                    </button>
                  )}
                </div>
                
                <div>
                  <label className="block text-xs text-gray-600">Step Name</label>
                  <input
                    type="text"
                    value={step.name}
                    onChange={(e) => updateStep(index, 'name', e.target.value)}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    placeholder="e.g., Venue Setup, Catering Ready"
                  />
                </div>
                
                <div>
                  <label className="block text-xs text-gray-600">Vendor Email</label>
                  <input
                    type="email"
                    value={step.vendor_email}
                    onChange={(e) => updateStep(index, 'vendor_email', e.target.value)}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    placeholder="vendor@email.com"
                  />
                </div>
                
                <div>
                  <label className="block text-xs text-gray-600">Description</label>
                  <textarea
                    value={step.description}
                    onChange={(e) => updateStep(index, 'description', e.target.value)}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    placeholder="What needs to be done?"
                    rows={2}
                  />
                </div>
              </div>
            ))}
          </div>

          <button
            onClick={createEvent}
            className="w-full bg-green-500 text-white py-3 rounded-lg font-medium hover:bg-green-600"
          >
            Create Event & Send Invitations
          </button>
        </div>
      </div>
    </div>
  );
}
```

#### Step 2.2: Event Dashboard
```typescript
// frontend/src/app/event/[id]/page.tsx
'use client';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

interface Event {
  id: string;
  name: string;
  status: string;
  steps: Array<{
    id: string;
    name: string;
    vendor_email: string;
    status: string;
  }>;
}

export default function EventPage() {
  const params = useParams();
  const [event, setEvent] = useState<Event | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchEvent();
  }, [params.id]);

  const fetchEvent = async () => {
    try {
      const response = await fetch(`/api/events/${params.id}`);
      const eventData = await response.json();
      setEvent(eventData);
    } catch (error) {
      console.error('Error fetching event:', error);
    } finally {
      setLoading(false);
    }
  };

  const sendReminder = async (stepId: string) => {
    try {
      await fetch('/api/magic/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_id: params.id,
          step_id: stepId
        })
      });
      alert('Reminder sent!');
    } catch (error) {
      alert('Error sending reminder');
    }
  };

  if (loading) return <div>Loading...</div>;
  if (!event) return <div>Event not found</div>;

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-4xl mx-auto px-4">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900">{event.name}</h1>
          <span className={`px-3 py-1 rounded-full text-sm ${
            event.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
          }`}>
            {event.status}
          </span>
        </div>

        <div className="bg-white rounded-lg shadow-md p-6">
          <h2 className="text-xl font-semibold mb-4">Timeline</h2>
          
          <div className="space-y-4">
            {event.steps.map((step, index) => (
              <div key={step.id} className="flex items-center space-x-4 p-4 border rounded-lg">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                  step.status === 'completed' ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-600'
                }`}>
                  {index + 1}
                </div>
                
                <div className="flex-1">
                  <h3 className="font-medium">{step.name}</h3>
                  <p className="text-sm text-gray-600">{step.vendor_email}</p>
                </div>
                
                <div className="flex items-center space-x-2">
                  <span className={`px-2 py-1 rounded text-sm ${
                    step.status === 'completed' 
                      ? 'bg-green-100 text-green-800' 
                      : 'bg-yellow-100 text-yellow-800'
                  }`}>
                    {step.status}
                  </span>
                  
                  {step.status === 'pending' && (
                    <button
                      onClick={() => sendReminder(step.id)}
                      className="bg-blue-500 text-white px-3 py-1 rounded text-sm hover:bg-blue-600"
                    >
                      Send Reminder
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
```

### PHASE 3: VENDOR INTERFACE (Days 7-8)

#### Step 3.1: Magic Link Completion Page
```typescript
// frontend/src/app/complete/[token]/page.tsx
'use client';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

interface StepInfo {
  event_name: string;
  step_name: string;
  vendor_email: string;
}

export default function CompletePage() {
  const params = useParams();
  const [stepInfo, setStepInfo] = useState<StepInfo | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [comments, setComments] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    validateToken();
  }, [params.token]);

  const validateToken = async () => {
    try {
      const response = await fetch(`/api/complete/${params.token}`);
      const data = await response.json();
      
      if (data.valid) {
        setStepInfo(data.step_info);
      } else {
        alert('Invalid or expired link');
      }
    } catch (error) {
      alert('Error validating link');
    } finally {
      setLoading(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setFiles(Array.from(e.target.files));
    }
  };

  const submitCompletion = async () => {
    setSubmitting(true);
    
    try {
      const formData = new FormData();
      formData.append('comments', comments);
      
      files.forEach(file => {
        formData.append('files', file);
      });

      const response = await fetch(`/api/complete/${params.token}`, {
        method: 'POST',
        body: formData
      });

      const result = await response.json();
      
      if (result.success) {
        alert('Step completed successfully!');
        window.location.href = '/success';
      } else {
        alert('Error completing step: ' + result.error);
      }
    } catch (error) {
      alert('Error submitting completion');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div>Loading...</div>;
  if (!stepInfo) return <div>Invalid access</div>;

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-md mx-auto px-4">
        <div className="bg-white rounded-lg shadow-md p-6">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Complete Your Task</h1>
          <p className="text-gray-600 mb-6">
            {stepInfo.event_name} - {stepInfo.step_name}
          </p>

          {/* File Upload */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Upload Photos/Documents
            </label>
            <input
              type="file"
              multiple
              accept="image/*,video/*,.pdf"
              onChange={handleFileSelect}
              className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
            />
            {files.length > 0 && (
              <div className="mt-2 text-sm text-gray-600">
                {files.length} file(s) selected
              </div>
            )}
          </div>

          {/* Comments */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Comments
            </label>
            <textarea
              value={comments}
              onChange={(e) => setComments(e.target.value)}
              rows={4}
              className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
              placeholder="Add any notes about this completion..."
            />
          </div>

          {/* Submit */}
          <button
            onClick={submitCompletion}
            disabled={submitting}
            className="w-full bg-green-500 text-white py-3 rounded-lg font-medium hover:bg-green-600 disabled:bg-gray-400"
          >
            {submitting ? 'Submitting...' : 'Mark Step Complete'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

### PHASE 4: FILE PROCESSING & GIT (Days 9-10)

#### Step 4.1: File Processing Middleware
```javascript
// backend/middleware/fileProcessor.js
const sharp = require('sharp');
const path = require('path');
const fs = require('fs').promises;

async function processUploadedFile(fileBuffer, originalName) {
  const fileExt = path.extname(originalName).toLowerCase();
  
  // Image processing
  if (['.jpg', '.jpeg', '.png', '.webp'].includes(fileExt)) {
    return await sharp(fileBuffer)
      .webp({ quality: 85 })
      .toBuffer();
  }
  
  // For now, return original for other files
  // Video processing would go here with fluent-ffmpeg
  return fileBuffer;
}

module.exports = { processUploadedFile };
```

#### Step 4.2: Git Integration
```javascript
// backend/utils/gitManager.js
const simpleGit = require('simple-git');
const fs = require('fs').promises;
const path = require('path');

class GitManager {
  constructor(eventId) {
    this.repoPath = path.join(__dirname, '../../data/git_repos', eventId);
    this.git = simpleGit(this.repoPath);
  }

  async initialize() {
    try {
      await fs.mkdir(this.repoPath, { recursive: true });
      await this.git.init();
      
      // Create initial structure
      await fs.writeFile(
        path.join(this.repoPath, 'README.md'),
        `# FlowProof Event\n\nThis repository tracks the event workflow.`
      );
      
      await this.git.add('./*');
      await this.git.commit('Initial event setup');
      
      return true;
    } catch (error) {
      console.error('Git initialization failed:', error);
      return false;
    }
  }

  async commitStep(stepData, files, comments) {
    try {
      // Create step directory
      const stepDir = path.join(this.repoPath, 'steps', stepData.id);
      await fs.mkdir(stepDir, { recursive: true });
      
      // Write files
      for (const file of files) {
        await fs.writeFile(
          path.join(stepDir, file.name),
          file.buffer
        );
      }
      
      // Create metadata file
      const metadata = {
        step: stepData,
        completed_at: new Date().toISOString(),
        files: files.map(f => f.name),
        comments
      };
      
      await fs.writeFile(
        path.join(stepDir, 'metadata.json'),
        JSON.stringify(metadata, null, 2)
      );
      
      // Git commit
      await this.git.add('./*');
      const commit = await this.git.commit(
        `STEP_COMPLETE: ${stepData.name}\n\nVendor: ${stepData.vendor_email}\nFiles: ${files.length}\nComments: ${comments}`
      );
      
      return commit.commit;
    } catch (error) {
      console.error('Git commit failed:', error);
      throw error;
    }
  }
}

module.exports = GitManager;
```

## 🚀 Deployment Instructions

### Step 5.1: Environment Setup
```bash
# Create .env file
cat > .env << EOL
# Email
SMTP_USER=your@gmail.com
SMTP_PASS=your-app-specific-password

# Security
JWT_SECRET=your-super-secret-jwt-key-change-in-production
ENCRYPTION_KEY=your-encryption-key

# Server
PORT=3001
NODE_ENV=production
BASE_URL=https://your-domain.com

# File Limits
MAX_FILE_SIZE=26214400
EOL
```

### Step 5.2: Production Build
```bash
# Build frontend
cd frontend
npm run build

# Start backend
cd ../backend
npm start
```

### Step 5.3: Process Management (PM2)
```bash
# Install PM2
npm install -g pm2

# Create ecosystem file
cat > ecosystem.config.js << EOL
module.exports = {
  apps: [{
    name: 'flowproof-backend',
    script: './backend/server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    }
  }]
};
EOL

# Start with PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

## 🎯 Testing Checklist

### Backend API Tests
```javascript
// backend/tests/events.test.js
const request = require('supertest');
const app = require('../server');

describe('Event API', () => {
  it('should create a new event', async () => {
    const response = await request(app)
      .post('/api/events')
      .send({
        name: 'Test Event',
        owner_email: 'test@email.com',
        flow_type: 'sequential',
        steps: [
          {
            name: 'Test Step',
            vendor_email: 'vendor@email.com',
            description: 'Test description'
          }
        ]
      });
    
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.eventId).toBeDefined();
  });
});
```

### Manual Testing Scenarios
1. ✅ Create event with multiple steps
2. ✅ Send magic links to vendors
3. ✅ Vendor completes step with file upload
4. ✅ Event timeline updates in real-time
5. ✅ Read-only view works without authentication
6. ✅ File compression works for images
7. ✅ Git commits are created for each completion

## 📞 Support & Next Steps

### Immediate Next Steps After MVP
1. Add video processing with ffmpeg
2. Implement read-only view pages
3. Add email notifications for step completions
4. Create export functionality
5. Add basic analytics dashboard

### Common Issues & Solutions
- **Magic links not working**: Check JWT secret and token validation
- **File upload failures**: Verify file size limits and storage permissions
- **Email delivery issues**: Check Gmail app passwords and SMTP configuration
- **Git errors**: Ensure write permissions in data/git_repos directory

This implementation plan will get you from zero to working MVP in approximately 10 development days. Start with Phase 1 and test each component thoroughly before moving to the next phase.
```

These two MD files give you:
1. **Complete MVP specification** for your reference
2. **Step-by-step implementation guide** for Cursor AI

Ready to start building? Which phase would you like to begin with?
