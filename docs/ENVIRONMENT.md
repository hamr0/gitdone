# Environment Setup & Path Configuration

## Overview

This document explains how environment variables are loaded and managed across the GitDone application to ensure consistent configuration.

## Environment Variable Loading Strategy

All backend files that need environment variables use **absolute paths** to load the `.env` file from the project root. This ensures consistency regardless of where scripts are executed from.

### Pattern Used

```javascript
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
```

## Files That Load .env

### 1. Server & Main Entry Point
- **`backend/server.js`** - Main application server
  - Loads `.env` using absolute path
  - All routes inherit environment from this

### 2. Standalone Scripts
These scripts can be run independently and each loads `.env`:

- **`backend/test-email.js`** - Email configuration testing
- **`backend/test-end-to-end.js`** - End-to-end testing
- **`backend/test-fixes.js`** - Component testing
- **`backend/send-completion-email.js`** - Manual email sending

### 3. Utility Modules
These modules **DO NOT** load `.env` - they rely on the parent process:

- `backend/utils/emailService.js`
- `backend/utils/magicLinkService.js`
- `backend/utils/gitManager.js`
- `backend/utils/completionEmail.js`
- `backend/utils/eventCreationEmail.js`
- `backend/utils/timeoutHandler.js`
- `backend/utils/fileManager.js`

### 4. Route Modules
These modules **DO NOT** load `.env` - they rely on `server.js`:

- `backend/routes/events.js`
- `backend/routes/magic.js`
- `backend/routes/complete.js`
- `backend/routes/view.js`
- `backend/routes/manage.js`

## Quick Start Script

The `quick-start.sh` script includes automatic environment cleanup:

```bash
# Clear any existing SMTP environment variables to prevent conflicts
unset SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_FROM 2>/dev/null || true
```

This ensures that the `.env` file is the source of truth, not shell environment variables.

## Important: Environment Variable Precedence

**dotenv does NOT override existing environment variables.** This means:

1. **Shell environment variables** take precedence over `.env` file
2. If you've exported SMTP variables in your shell, they will be used instead of `.env`
3. To ensure `.env` is used, unset any conflicting variables:

```bash
unset SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_FROM
```

## Configuration File Location

```
gitdone/
├── .env                  # Main configuration file (git-ignored)
├── .env.example          # Template with placeholder values
├── backend/
│   ├── server.js         # Loads .env
│   ├── test-*.js         # Each loads .env
│   ├── utils/            # Do NOT load .env
│   └── routes/           # Do NOT load .env
├── frontend/
└── quick-start.sh        # Clears env vars before starting
```

## Required Environment Variables

### SMTP Email Configuration

```bash
SMTP_HOST=smtp.gmail.com      # SMTP server hostname
SMTP_PORT=587                  # SMTP port (587 for TLS, 465 for SSL)
SMTP_USER=your@gmail.com      # Email address for authentication
SMTP_PASS=your-app-password   # App password (not regular password)
SMTP_FROM=your@gmail.com      # "From" email address (usually same as SMTP_USER)
```

### Server Configuration

```bash
PORT=3001                      # Backend server port
NODE_ENV=development           # Environment (development/production)
BASE_URL=http://localhost:3000 # Base URL for the application
FRONTEND_URL=http://localhost:3000  # Frontend URL for CORS
```

### Security

```bash
JWT_SECRET=your-secret-key                    # JWT signing key
ENCRYPTION_KEY=your-encryption-key            # Data encryption key
```

### Data Storage

```bash
DATA_PATH=./data
EVENTS_PATH=./data/events
UPLOADS_PATH=./data/uploads
GIT_REPOS_PATH=./data/git_repos
```

## Troubleshooting

### Problem: Old/incorrect values being used

**Cause:** Shell environment variables are overriding `.env` file

**Solution:**
```bash
# Check if variables are set in shell
env | grep SMTP

# Unset them
unset SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_FROM

# Or use quick-start.sh which does this automatically
./quick-start.sh
```

### Problem: `.env` not found

**Cause:** Script running from wrong directory or incorrect path resolution

**Solution:** All scripts use `path.resolve(__dirname, '../.env')` which resolves to project root. Ensure you're running from the correct directory.

### Problem: Email authentication fails

**Cause:** Using regular password instead of app password, or environment variable conflict

**Solution:**
1. Generate Gmail app password: https://myaccount.google.com/apppasswords
2. Update `.env` with the 16-character password (no spaces)
3. Unset any shell SMTP variables
4. Restart the server

## Testing Configuration

### Test Environment Loading
```bash
node -e "require('dotenv').config({ path: require('path').resolve(__dirname, '.env') }); console.log('SMTP_USER:', process.env.SMTP_USER);"
```

### Test Email Configuration
```bash
cd backend
node test-email.js
```

### Test Server Startup
```bash
./quick-start.sh
```

## Best Practices

1. **Never commit `.env`** - It's in `.gitignore` for security
2. **Use `.env.example`** - Document all required variables
3. **Use absolute paths** - Always use `path.resolve(__dirname, '../.env')`
4. **Clear shell vars** - Run `quick-start.sh` or manually unset before testing
5. **One source of truth** - The `.env` file should be the only source
6. **App passwords** - Use Gmail app passwords, not regular passwords

## VPS Deployment

When deploying to a VPS:

```bash
# Copy .env to server
scp .env user@your-vps:/path/to/gitdone/.env

# Or set environment variables directly
export SMTP_HOST=smtp.gmail.com
export SMTP_PORT=587
export SMTP_USER=your@gmail.com
export SMTP_PASS=your-app-password
export SMTP_FROM=your@gmail.com

# Start server
cd /path/to/gitdone
./quick-start.sh
```

## Summary

- ✅ All backend entry points load `.env` with absolute paths
- ✅ Utility modules inherit environment from parent
- ✅ `quick-start.sh` clears conflicting environment variables
- ✅ Configuration is consistent across all environments
- ✅ No system dependencies (MSMTP removed, using SMTP/nodemailer)
- ✅ VPS-ready with simple `.env` file copy
