# Architecture Documentation

GitDone system architecture, technology stack, and design decisions.

---

## System Overview

**GitDone** is a multi-vendor workflow coordination platform with cryptographic proof of work sequence. The system enables event planners to coordinate vendors through magic link authentication with Git-backed audit trails.

### Core Concept

Event workflows are tracked using Git commits as immutable proof of completion. Each vendor step creates a commit with uploaded files, creating a verifiable timeline of work completion.

---

## Technology Stack

### Frontend

| Technology | Version | Purpose |
|------------|---------|---------|
| **Next.js** | 15 | React framework with App Router |
| **TypeScript** | Latest | Type-safe development |
| **Tailwind CSS** | Latest | Utility-first CSS framework |
| **React** | 18+ | UI library |

### Backend

| Technology | Version | Purpose |
|------------|---------|---------|
| **Node.js** | 18+ | JavaScript runtime |
| **Express** | 4.x | Web application framework |
| **JWT** | Latest | Token-based authentication |
| **Nodemailer** | Latest | SMTP email sending |

### File Processing

| Technology | Purpose |
|------------|---------|
| **Sharp** | Image compression and optimization |
| **fluent-ffmpeg** | Video processing |
| **FFmpeg** | Media manipulation (system dependency) |

### Storage & Version Control

| Technology | Purpose |
|------------|---------|
| **JSON Files** | Event and token storage |
| **Git** | Version control for audit trails |
| **File System** | File upload storage |

---

## System Architecture

### High-Level Architecture

```
┌─────────────────┐
│   Frontend      │  Next.js 15 (Port 3000)
│   (Next.js)     │  - Event creation UI
└────────┬────────┘  - Vendor completion interface
         │           - Public views
         │ HTTP/REST
┌────────▼────────┐
│   Backend       │  Express (Port 3001)
│   (Express)     │  - API endpoints
└────────┬────────┘  - Magic link generation
         │           - File processing
         │
    ┌────┴────┬─────────┬──────────┐
    │         │         │          │
┌───▼───┐ ┌──▼───┐ ┌───▼────┐ ┌───▼────┐
│ JSON  │ │ Git  │ │ Files  │ │ Email  │
│ Store │ │ Repos│ │ Upload │ │ SMTP   │
└───────┘ └──────┘ └────────┘ └────────┘
```

### Directory Structure

```
gitdone/
├── frontend/                  # Next.js application
│   ├── src/
│   │   ├── app/              # App Router pages
│   │   │   ├── page.tsx      # Home page (event creation)
│   │   │   ├── complete/     # Vendor completion interface
│   │   │   └── view/         # Public event views
│   │   └── components/       # React components
│   └── package.json
│
├── backend/                   # Express API server
│   ├── server.js             # Main server entry point
│   ├── routes/               # API route handlers
│   │   ├── events.js         # Event CRUD operations
│   │   ├── magic.js          # Magic link generation
│   │   ├── complete.js       # Step completion endpoint
│   │   ├── view.js           # Public view endpoints
│   │   └── manage.js         # Event management
│   ├── utils/                # Utility modules
│   │   ├── gitManager.js     # Git operations
│   │   ├── emailService.js   # SMTP email sending
│   │   ├── magicLinkService.js # JWT token management
│   │   └── fileManager.js    # File processing
│   ├── middleware/           # Express middleware
│   └── package.json
│
├── data/                      # Data storage
│   ├── events/               # Event JSON files
│   │   └── {eventId}.json    # One file per event
│   ├── git_repos/            # Git repositories
│   │   └── {eventId}/        # One repo per event
│   ├── uploads/              # Uploaded files
│   │   └── {filename}        # Processed files
│   └── magic_tokens.json     # Active magic links
│
├── docs/                      # Documentation
├── .env                       # Environment configuration
├── quick-start.sh            # Quick setup script
└── dev.sh                    # Interactive dev menu
```

---

## Data Flow

### 1. Event Creation Flow

```
User → Frontend → POST /api/events → Backend
                                      ↓
                                   Create Event JSON
                                      ↓
                                   Initialize Git Repo
                                      ↓
                                   Return Event ID
```

**Event JSON Structure** (`data/events/{eventId}.json`):
```json
{
  "id": "uuid",
  "name": "Wedding Setup",
  "owner_email": "planner@example.com",
  "flow_type": "sequential",
  "status": "pending",
  "steps": [
    {
      "id": "step-uuid",
      "name": "Venue Setup",
      "vendor_email": "vendor@example.com",
      "status": "pending",
      "position": 0,
      "description": "Setup details"
    }
  ],
  "created_at": "2025-01-15T10:00:00Z",
  "git_repo": "/path/to/repo"
}
```

### 2. Magic Link Flow

```
Planner → Send Magic Link → POST /api/magic/send
                              ↓
                           Generate JWT Token
                              ↓
                           Store in magic_tokens.json
                              ↓
                           Send Email via SMTP
                              ↓
Vendor ← Receives Email with Link
```

**Magic Token Structure**:
```json
{
  "token": "jwt-string",
  "event_id": "uuid",
  "step_id": "step-uuid",
  "vendor_email": "vendor@example.com",
  "expires_at": "2025-02-14T10:00:00Z"
}
```

**JWT Payload**:
```json
{
  "eventId": "uuid",
  "stepId": "step-uuid",
  "vendorEmail": "vendor@example.com",
  "iat": 1234567890,
  "exp": 1237246290
}
```

### 3. Step Completion Flow

```
Vendor → Click Magic Link → GET /api/complete/:token
                              ↓
                           Validate JWT
                              ↓
                           Display Completion Form
                              ↓
Vendor → Submit Files → POST /api/complete/:token
                              ↓
                           Process Files (Sharp/FFmpeg)
                              ↓
                           Save to uploads/
                              ↓
                           Create Git Commit
                              ↓
                           Update Event JSON
                              ↓
                           Update Step Status
```

**Git Commit Message Format**:
```
Step completed: {Step Name}

Vendor: {vendor_email}
Completed: {timestamp}
Files: {file_count}
```

### 4. Workflow Type Logic

**Sequential Flow**:
- Steps have `position` field (0, 1, 2, ...)
- Only step at current position can be completed
- Next step unlocks after current completes
- Linear Git history

**Non-Sequential Flow**:
- Steps can complete in any order
- All steps must complete for event completion
- Tree-like Git history

---

## Authentication & Security

### Magic Link Authentication

**Token Generation**:
```javascript
const token = jwt.sign(
  {
    eventId: event.id,
    stepId: step.id,
    vendorEmail: step.vendor_email
  },
  process.env.JWT_SECRET,
  { expiresIn: '30d' }
);
```

**Token Validation**:
- Verify JWT signature
- Check expiration
- Validate against stored tokens
- Ensure step not already completed

**Security Features**:
- 30-day token expiration
- One-time use tokens (invalidated after use)
- HTTPS required in production
- JWT secret from environment variables

### File Upload Security

**Validation**:
- Max file size: 25MB per file
- Max files: 10 per request
- Allowed MIME types checked
- File path sanitization

**Processing**:
- Images compressed with Sharp
- Videos processed with fluent-ffmpeg
- Original files replaced with processed versions
- Unique filenames (UUID-based)

---

## Git Integration

### Repository Structure

Each event gets its own Git repository:
```
data/git_repos/{eventId}/
├── .git/
└── {uploaded-files}
```

### Commit Strategy

**On Step Completion**:
1. Save uploaded files to repo directory
2. `git add .`
3. `git commit -m "Step completed: {name}"`
4. Commit hash stored in event JSON

**Commit Metadata**:
- Author: Vendor email
- Message: Step name and details
- Timestamp: Completion time
- Files: All uploaded files

**Benefits**:
- Immutable audit trail
- File versioning
- Timeline visualization
- Proof of completion order

---

## Email System

### SMTP Configuration

**Supported Providers**:
- Gmail (development)
- SendGrid (production recommended)
- Outlook, Yahoo, Custom SMTP

**Configuration** (`.env`):
```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@gmail.com
SMTP_PASS=app-password
SMTP_FROM=your@gmail.com
```

### Email Templates

**Magic Link Email**:
- Subject: "Action Required: {Step Name}"
- Body: Event details + magic link
- Link: `{BASE_URL}/complete/{token}`

**Reminder Email**:
- Subject: "Reminder: {Step Name}"
- Body: Status update + original link

---

## File Processing Pipeline

### Image Processing (Sharp)

```javascript
sharp(inputPath)
  .resize(1920, 1080, { fit: 'inside' })
  .jpeg({ quality: 80 })
  .toFile(outputPath);
```

**Processing**:
- Max dimensions: 1920x1080
- Quality: 80%
- Format: JPEG
- Preserves aspect ratio

### Video Processing (fluent-ffmpeg)

```javascript
ffmpeg(inputPath)
  .videoCodec('libx264')
  .audioCodec('aac')
  .format('mp4')
  .save(outputPath);
```

**Processing**:
- Codec: H.264
- Audio: AAC
- Format: MP4
- Optimized for web playback

---

## API Design

### RESTful Endpoints

**Resource Structure**:
- `/api/events` - Event resources
- `/api/magic` - Magic link operations
- `/api/complete` - Vendor completion
- `/api/view` - Public views

**HTTP Methods**:
- `GET` - Retrieve resources
- `POST` - Create resources
- No `PUT`/`PATCH`/`DELETE` (events are immutable once created)

**Response Format**:
```json
{
  "data": {},           // Success response
  "error": "message"    // Error response
}
```

### CORS Configuration

**Development**:
- Allow all origins
- Credentials enabled

**Production**:
- Restrict to `FRONTEND_URL`
- Credentials enabled
- HTTPS only

---

## Deployment Architecture

### VPS Setup

**Components**:
- PM2: Process management
- Nginx: Reverse proxy
- Let's Encrypt: SSL certificates

**Process Management**:
```bash
pm2 start backend/server.js --name gitdone-api
pm2 start npm --name gitdone-frontend -- start
```

**Nginx Configuration**:
```nginx
server {
  listen 443 ssl;
  server_name yourdomain.com;

  # Frontend
  location / {
    proxy_pass http://localhost:3000;
  }

  # API
  location /api/ {
    proxy_pass http://localhost:3001;
  }
}
```

---

## Design Patterns

### Architecture Patterns

**Pattern**: Layered Architecture
- **Frontend Layer**: Next.js UI
- **API Layer**: Express routes
- **Business Logic**: Utility modules
- **Data Layer**: JSON files + Git

**Pattern**: Repository Pattern
- Event data abstracted through JSON file operations
- Git operations encapsulated in `gitManager.js`

**Pattern**: Service Layer
- `emailService.js` - Email operations
- `magicLinkService.js` - Token management
- `fileManager.js` - File operations

### Code Organization

**Separation of Concerns**:
- Routes handle HTTP requests/responses
- Utils contain business logic
- Middleware handles cross-cutting concerns

**Configuration Management**:
- Environment variables via `.env`
- Absolute path resolution for reliability
- No hardcoded configuration

---

## Performance Considerations

### Optimization Strategies

**File Processing**:
- Async processing prevents blocking
- Sharp for fast image compression
- FFmpeg for video optimization

**Storage**:
- JSON files for simple data storage
- Git for versioned storage
- File system for uploads

**Caching**:
- Static file serving via Nginx
- Browser caching headers
- Git object caching

### Scalability Limits

**Current Architecture**:
- Suitable for 100s of events
- Single-server deployment
- File-based storage

**Future Scaling Options**:
- Database migration (PostgreSQL)
- Object storage (S3)
- Load balancing
- Container orchestration

---

## Technology Decisions

### Why JSON Files?

**Pros**:
- Simple to implement
- Easy to inspect
- No database setup
- Git-friendly

**Cons**:
- Limited query capabilities
- No transactions
- Scaling limitations

**Decision**: Sufficient for MVP and small-scale deployments

### Why Git for Audit Trail?

**Pros**:
- Immutable history
- Built-in versioning
- Familiar tooling
- Distributed by nature

**Cons**:
- Storage overhead
- Repo size growth

**Decision**: Benefits outweigh costs for audit trail use case

### Why Magic Links?

**Pros**:
- No password management
- Email-based authentication
- One-click access
- Mobile-friendly

**Cons**:
- Email dependency
- 30-day expiration

**Decision**: Optimal UX for vendor coordination scenario

---

## Future Enhancements

### Potential Improvements

1. **Database Migration**: PostgreSQL for better querying
2. **Real-time Updates**: WebSockets for live status
3. **File Storage**: S3/CDN for uploads
4. **Analytics**: Event completion metrics
5. **Notifications**: SMS/push notifications
6. **API Versioning**: `/api/v1/` endpoints
7. **Rate Limiting**: Prevent abuse
8. **Webhooks**: Event completion callbacks

### Architecture Evolution

**Phase 1 (Current)**: Single VPS, file-based storage
**Phase 2**: Database + object storage
**Phase 3**: Microservices + container orchestration
**Phase 4**: Multi-region deployment

---

## References

- Next.js Documentation: https://nextjs.org/docs
- Express.js Guide: https://expressjs.com/
- Sharp Documentation: https://sharp.pixelplumbing.com/
- JWT Specification: https://jwt.io/
