# GitDone - Workflow Coordination Platform

**"Git-like sequence proof for physical world workflows"**

A web application for multi-vendor coordination with cryptographic proof of work sequence and timing. Perfect for event planning, construction projects, and any multi-step workflow that requires vendor coordination.

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ 
- npm or yarn
- Git

### 🎯 Super Quick Start (Recommended)

**One command to rule them all:**
```bash
git clone <your-repo>
cd gitdone
./quick-start.sh
```

That's it! 🎉 Your app will be running at http://localhost:3000

### 🎮 Interactive Development (Menu-driven)

**For more control and options:**
```bash
git clone <your-repo>
cd gitdone
./dev.sh
```

This gives you a menu with options to:
- 🚀 Start/Stop servers
- 📊 Check status
- 📋 View logs
- 🧪 Test application
- 📦 Install dependencies
- ⚙️ Setup environment

📚 **See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for complete development guide**

### 🔧 Manual Setup (Traditional)

1. **Clone and setup**
```bash
git clone <your-repo>
cd gitdone
```

2. **Install dependencies**
```bash
# Backend
cd backend
npm install

# Frontend  
cd ../frontend
npm install
```

3. **Configure environment**
```bash
# Copy environment template
cp .env.example .env

# Edit .env with your settings
nano .env
```

4. **Start the application**
```bash
# Terminal 1 - Backend
cd backend
npm start

# Terminal 2 - Frontend
cd frontend  
npm run dev
```

5. **Access the application**
- Frontend: http://localhost:3000
- Backend API: http://localhost:3001

## 🎯 Features

### ✅ Completed Features

- **Event Creation**: Create events with sequential or non-sequential workflows
- **Step Management**: Add multiple steps with vendor assignments
- **Magic Links**: Secure JWT-based links for vendor access
- **File Upload**: Support for images, videos, and documents
- **File Processing**: Automatic image compression with Sharp
- **Git Integration**: Each step completion creates a Git commit
- **Real-time Dashboard**: Track progress and send reminders
- **Vendor Interface**: Mobile-optimized completion interface
- **Read-only Views**: Public access for clients/stakeholders

### 🔄 Workflow Types

**Sequential Flow (A → B → C)**
- Steps must be completed in order
- Next step unlocks when previous completes
- Git commits form linear chain

**Non-Sequential Flow (A, B, C)**
- Steps can complete independently  
- All steps must finish for event completion
- Git commits form tree structure

## 🏗️ Architecture

### Tech Stack
- **Frontend**: Next.js 15 + TypeScript + Tailwind CSS
- **Backend**: Node.js + Express
- **Storage**: JSON files + Git repositories
- **Email**: SMTP via Nodemailer (Gmail, Outlook, SendGrid, etc.)
- **Auth**: JWT magic links
- **File Processing**: Sharp (images) + fluent-ffmpeg (videos)

### Project Structure
```
gitdone/
├── backend/                 # Express API server
│   ├── routes/             # API endpoints
│   ├── utils/              # Git manager, file processing
│   ├── middleware/         # File upload, security
│   └── server.js           # Main server file
├── frontend/               # Next.js application
│   ├── src/app/           # App router pages
│   └── package.json       # Frontend dependencies
├── data/                   # Data storage
│   ├── events/            # Event JSON files
│   ├── uploads/           # Uploaded files
│   ├── git_repos/         # Git repositories
│   └── magic_tokens.json  # Token tracking
└── .env                    # Environment configuration
```

## 📡 API Endpoints

### Event Management
- `POST /api/events` - Create new event
- `GET /api/events/:id` - Get event details
- `GET /api/events/:id/timeline` - Get event timeline
- `POST /api/events/:id/steps` - Add step to event

### Magic Links
- `POST /api/magic/send` - Send magic link to vendor
- `POST /api/magic/send-all` - Send links to all pending steps
- `GET /api/magic/status/:token` - Check token status

### Vendor Interface
- `GET /api/complete/:token` - Validate magic link
- `POST /api/complete/:token` - Complete step with files

### Public Views
- `GET /api/view/:eventId` - Read-only event view
- `GET /api/view/:eventId/export` - Export event data
- `GET /api/view/:eventId/files/:fileName` - Serve uploaded files

## 🔧 Configuration

### Environment Variables

```bash
# Server
PORT=3001
NODE_ENV=development
BASE_URL=http://localhost:3000
FRONTEND_URL=http://localhost:3000

# Email (SMTP Configuration)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM=your@gmail.com

# Security
JWT_SECRET=your-super-secret-jwt-key
ENCRYPTION_KEY=your-encryption-key

# File Limits
MAX_FILE_SIZE=26214400  # 25MB
MAX_FILES_PER_REQUEST=10

# Data Storage
DATA_PATH=./data
EVENTS_PATH=./data/events
UPLOADS_PATH=./data/uploads
GIT_REPOS_PATH=./data/git_repos
```

### Email Setup

**Option 1: Gmail (Recommended for Development)**

1. Enable 2-factor authentication on your Gmail account
2. Generate an "App Password" at https://myaccount.google.com/apppasswords
3. Update `.env`:
   ```bash
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=your@gmail.com
   SMTP_PASS=your-16-char-app-password  # No spaces
   SMTP_FROM=your@gmail.com
   ```
4. Test: `cd backend && node test-email.js`

**Option 2: Other Providers**

- **Outlook**: `smtp-mail.outlook.com:587`
- **Yahoo**: `smtp.mail.yahoo.com:587`
- **SendGrid**: `smtp.sendgrid.net:587` (recommended for production)
- **Custom SMTP**: Any SMTP server with TLS support

📧 **See [docs/EMAIL_SETUP.md](docs/EMAIL_SETUP.md) for detailed configuration guide**

## 🎮 Usage Examples

### 1. Create an Event
```bash
curl -X POST http://localhost:3001/api/events \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Wedding Setup",
    "owner_email": "planner@example.com",
    "flow_type": "sequential",
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
  }'
```

### 2. Send Magic Links
```bash
curl -X POST http://localhost:3001/api/magic/send \
  -H "Content-Type: application/json" \
  -d '{
    "event_id": "event-id-here",
    "step_id": "step-id-here", 
    "vendor_email": "vendor@example.com"
  }'
```

### 3. Complete a Step
```bash
curl -X POST http://localhost:3001/api/complete/token-here \
  -F "files=@photo1.jpg" \
  -F "files=@photo2.jpg" \
  -F "comments=Venue setup complete with 50 tables"
```

## 🔒 Security Features

- **JWT Magic Links**: Secure, time-limited access tokens
- **Email Binding**: Tokens tied to specific vendor emails
- **File Validation**: Type and size restrictions
- **CORS Protection**: Configured for production domains
- **Input Sanitization**: All user inputs validated

## 📊 Git Integration

Each step completion creates a Git commit with:
- Step metadata (JSON)
- Uploaded files
- Completion comments
- Timestamp and vendor info

Git repositories are stored in `data/git_repos/{eventId}/` and can be:
- Cloned for external access
- Used for audit trails
- Integrated with CI/CD systems

## 🚀 Deployment

### VPS Deployment

**Prerequisites:**
- Ubuntu 20.04+ or similar Linux distribution
- Node.js 18+ installed
- Domain name pointed to your VPS (optional)

**Quick VPS Setup:**
```bash
# 1. Clone repository on VPS
git clone <your-repo> /var/www/gitdone
cd /var/www/gitdone

# 2. Copy .env file from local to VPS
# On local machine:
scp .env user@your-vps:/var/www/gitdone/.env

# 3. Run quick-start on VPS
./quick-start.sh
```

### Production Setup

1. **Environment Configuration**
```bash
NODE_ENV=production
BASE_URL=https://your-domain.com
FRONTEND_URL=https://your-domain.com

# Email (Consider using SendGrid or transactional email service)
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=your-sendgrid-api-key
SMTP_FROM=noreply@yourdomain.com
```

2. **Build Frontend**
```bash
cd frontend
npm run build
```

3. **Process Management (PM2)**
```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

### Docker Deployment
```bash
# Build and run with Docker Compose
docker-compose up -d
```

📖 **See [DEPLOYMENT.md](DEPLOYMENT.md) for comprehensive deployment guide**

## 🧪 Testing

### Manual Testing Checklist
- [ ] Create event with multiple steps
- [ ] Send magic links to vendors
- [ ] Vendor completes step with file upload
- [ ] Event timeline updates in real-time
- [ ] Read-only view works without authentication
- [ ] File compression works for images
- [ ] Git commits are created for each completion

### API Testing
```bash
# Health check
curl http://localhost:3001/api/health

# Create test event
curl -X POST http://localhost:3001/api/events \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","owner_email":"test@example.com","steps":[{"name":"Test Step","vendor_email":"vendor@example.com"}]}'
```

## 🐛 Troubleshooting

### Common Issues

**Backend won't start**
- Check if port 3001 is available
- Verify all dependencies are installed
- Check environment variables

**Email not sending**
- Verify SMTP credentials are correct (use app password for Gmail, not regular password)
- Check all SMTP_* variables in .env (HOST, PORT, USER, PASS, FROM)
- Ensure 2FA is enabled for Gmail accounts
- Clear shell environment variables: `unset SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_FROM`
- Test with: `cd backend && node test-email.js`
- Check EMAIL_SETUP.md for detailed troubleshooting

**File uploads failing**
- Check file size limits in .env
- Verify uploads directory permissions
- Check file type restrictions

**Frontend build errors**
- Clear Next.js cache: `rm -rf .next`
- Reinstall dependencies: `rm -rf node_modules && npm install`
- Check TypeScript errors

## 📈 Next Steps

### Planned Features
- [ ] Video processing with FFmpeg
- [ ] Real-time notifications
- [ ] Advanced analytics dashboard
- [ ] Multi-language support
- [ ] Mobile app (React Native)
- [ ] Payment integration
- [ ] Team collaboration features

### Contributing
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details

## 📚 Documentation

Complete documentation is available in the `/docs` directory:

- **[KNOWLEDGE_BASE.md](docs/KNOWLEDGE_BASE.md)** - Master documentation index and quick reference
- **[ARCHITECTURE.md](docs/ARCHITECTURE.md)** - System architecture, tech stack, and design decisions
- **[DEVELOPMENT.md](docs/DEVELOPMENT.md)** - Development workflow, scripts, and troubleshooting
- **[DEPLOYMENT.md](docs/DEPLOYMENT.md)** - VPS deployment guide with PM2, Nginx, and SSL
- **[EMAIL_SETUP.md](docs/EMAIL_SETUP.md)** - Email provider configuration (Gmail, SendGrid, etc.)
- **[ENVIRONMENT.md](docs/ENVIRONMENT.md)** - Environment variables and configuration management
- **[API_REFERENCE.md](docs/API_REFERENCE.md)** - Complete API endpoint documentation
- **[WORKFLOWS.md](docs/WORKFLOWS.md)** - Development workflows and testing strategies

**Start here**: [docs/KNOWLEDGE_BASE.md](docs/KNOWLEDGE_BASE.md)

## 🆘 Support

- **Documentation**: Check [docs/KNOWLEDGE_BASE.md](docs/KNOWLEDGE_BASE.md) first
- **Issues**: Create GitHub issues for bugs
- **Email**: Contact the development team

---

**GitDone** - Making complex workflows simple and trackable! 🎉