# API Reference

Complete API documentation for GitDone backend endpoints.

**Base URL**: `http://localhost:3001` (development) or your production domain

---

## Authentication

Most endpoints are public. Magic link endpoints use JWT token authentication.

**Token Format**: Included in URL for vendor access
```
/complete/{JWT_TOKEN}
```

---

## Event Management

### Create Event

**Endpoint**: `POST /api/events`

**Description**: Create a new event with workflow steps

**Request Body**:
```json
{
  "name": "Wedding Setup",
  "owner_email": "planner@example.com",
  "flow_type": "sequential",  // or "non-sequential"
  "steps": [
    {
      "name": "Venue Setup",
      "vendor_email": "venue@example.com",
      "description": "Setup tables, chairs, decor"
    },
    {
      "name": "Catering Ready",
      "vendor_email": "catering@example.com",
      "description": "Prepare food and beverages"
    }
  ]
}
```

**Response**: `201 Created`
```json
{
  "id": "uuid-string",
  "name": "Wedding Setup",
  "owner_email": "planner@example.com",
  "flow_type": "sequential",
  "status": "pending",
  "created_at": "2025-01-15T10:30:00.000Z",
  "steps": [
    {
      "id": "step-uuid-1",
      "name": "Venue Setup",
      "vendor_email": "venue@example.com",
      "status": "pending",
      "position": 0
    }
  ],
  "git_repo": "/path/to/git/repo"
}
```

---

### Get Event Details

**Endpoint**: `GET /api/events/:id`

**Description**: Retrieve full event details including steps and timeline

**Parameters**:
- `id` (path) - Event UUID

**Response**: `200 OK`
```json
{
  "id": "uuid-string",
  "name": "Wedding Setup",
  "flow_type": "sequential",
  "status": "in_progress",
  "steps": [...],
  "created_at": "2025-01-15T10:30:00.000Z",
  "updated_at": "2025-01-15T11:00:00.000Z"
}
```

---

### Get Event Timeline

**Endpoint**: `GET /api/events/:id/timeline`

**Description**: Get Git commit timeline for event

**Response**: `200 OK`
```json
{
  "commits": [
    {
      "hash": "abc123",
      "message": "Step completed: Venue Setup",
      "timestamp": "2025-01-15T11:00:00.000Z",
      "author": "venue@example.com"
    }
  ]
}
```

---

### Add Step to Event

**Endpoint**: `POST /api/events/:id/steps`

**Description**: Add a new step to an existing event

**Request Body**:
```json
{
  "name": "Photography",
  "vendor_email": "photo@example.com",
  "description": "Capture event photos"
}
```

**Response**: `201 Created`

---

## Magic Links

### Send Magic Link

**Endpoint**: `POST /api/magic/send`

**Description**: Send magic link email to vendor for specific step

**Request Body**:
```json
{
  "event_id": "uuid-string",
  "step_id": "step-uuid",
  "vendor_email": "vendor@example.com"
}
```

**Response**: `200 OK`
```json
{
  "message": "Magic link sent to vendor@example.com",
  "token": "jwt-token-string",
  "expires_at": "2025-02-14T10:30:00.000Z"
}
```

**Email Template**:
- Subject: "Action Required: {Step Name}"
- Body includes magic link: `{BASE_URL}/complete/{TOKEN}`
- Link expires in 30 days

---

### Send All Magic Links

**Endpoint**: `POST /api/magic/send-all`

**Description**: Send magic links to all pending vendors in event

**Request Body**:
```json
{
  "event_id": "uuid-string"
}
```

**Response**: `200 OK`
```json
{
  "sent": 3,
  "failed": 0,
  "details": [
    {
      "step_id": "step-uuid-1",
      "vendor_email": "vendor1@example.com",
      "status": "sent"
    }
  ]
}
```

---

### Check Token Status

**Endpoint**: `GET /api/magic/status/:token`

**Description**: Validate magic link token and get associated step info

**Response**: `200 OK`
```json
{
  "valid": true,
  "event_id": "uuid-string",
  "step_id": "step-uuid",
  "step_name": "Venue Setup",
  "vendor_email": "vendor@example.com",
  "expires_at": "2025-02-14T10:30:00.000Z"
}
```

**Error Response**: `401 Unauthorized`
```json
{
  "error": "Invalid or expired token"
}
```

---

## Vendor Interface

### Validate Magic Link

**Endpoint**: `GET /api/complete/:token`

**Description**: Get step details for vendor completion page

**Response**: `200 OK`
```json
{
  "event": {
    "name": "Wedding Setup",
    "owner_email": "planner@example.com"
  },
  "step": {
    "name": "Venue Setup",
    "description": "Setup tables, chairs, decor",
    "vendor_email": "vendor@example.com"
  }
}
```

---

### Complete Step

**Endpoint**: `POST /api/complete/:token`

**Description**: Complete step with file uploads

**Content-Type**: `multipart/form-data`

**Form Fields**:
- `notes` (text) - Completion notes from vendor
- `files` (files) - Multiple file uploads

**Response**: `200 OK`
```json
{
  "message": "Step completed successfully",
  "step_id": "step-uuid",
  "files_uploaded": 3,
  "git_commit": "abc123def456"
}
```

**File Processing**:
- Images: Automatically compressed with Sharp
- Videos: Processed with fluent-ffmpeg
- Max file size: 25MB per file
- Max files: 10 per request

---

## Public Views

### Get Public Event View

**Endpoint**: `GET /api/view/:eventId`

**Description**: Read-only public view of event progress

**Response**: `200 OK`
```json
{
  "id": "uuid-string",
  "name": "Wedding Setup",
  "status": "in_progress",
  "progress": {
    "completed": 2,
    "total": 5,
    "percentage": 40
  },
  "steps": [
    {
      "name": "Venue Setup",
      "status": "completed",
      "completed_at": "2025-01-15T11:00:00.000Z"
    }
  ]
}
```

---

### Export Event Data

**Endpoint**: `GET /api/view/:eventId/export`

**Description**: Export complete event data as JSON

**Response**: `200 OK` (full event JSON)

---

### Serve Uploaded Files

**Endpoint**: `GET /api/view/:eventId/files/:fileName`

**Description**: Serve uploaded files for public viewing

**Response**: File content with appropriate MIME type

---

## Health Check

### Server Health

**Endpoint**: `GET /api/health`

**Description**: Check if server is running

**Response**: `200 OK`
```json
{
  "status": "ok",
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

---

## Error Responses

All errors follow consistent format:

```json
{
  "error": "Error message description",
  "code": "ERROR_CODE",
  "details": {} // Optional additional context
}
```

### Common HTTP Status Codes

- `200 OK` - Success
- `201 Created` - Resource created
- `400 Bad Request` - Invalid request data
- `401 Unauthorized` - Invalid/expired token
- `404 Not Found` - Resource not found
- `413 Payload Too Large` - File size exceeds limit
- `500 Internal Server Error` - Server error

---

## Rate Limiting

Currently no rate limiting implemented. Consider adding for production:
- Magic link sending: 10 requests per minute per IP
- File uploads: 5 requests per minute per token

---

## CORS Configuration

Development:
- Allows all origins
- Credentials enabled

Production:
- Configure `FRONTEND_URL` in `.env`
- Restricts to specific origin

---

## File Upload Limits

Configured in `.env`:
```bash
MAX_FILE_SIZE=26214400      # 25MB
MAX_FILES_PER_REQUEST=10
```

Supported file types:
- Images: JPEG, PNG, GIF, WebP
- Videos: MP4, MOV, AVI
- Documents: PDF, DOC, DOCX

---

## Testing

Use `curl` or Postman for API testing:

```bash
# Create event
curl -X POST http://localhost:3001/api/events \
  -H "Content-Type: application/json" \
  -d @test-event.json

# Upload files to step
curl -X POST http://localhost:3001/api/complete/{TOKEN} \
  -F "notes=Completed setup" \
  -F "files=@photo1.jpg" \
  -F "files=@photo2.jpg"
```
