# 🛠️ GitDone Development Guide

**Local development setup and scripts for GitDone**

## 🚀 Quick Start Scripts

### 🎯 Super Quick Start
```bash
git clone <your-repo>
cd gitdone
./quick-start.sh
```
**One command** - installs dependencies, sets up environment, and starts both servers!

### 🎮 Interactive Development Menu
```bash
git clone <your-repo>
cd gitdone
./dev.sh
```
**Menu-driven interface** with full control over your development environment.

## 📋 Available Scripts

| Script | Purpose | Best For |
|--------|---------|----------|
| `quick-start.sh` | 🚀 **Instant Setup** | First-time setup, quick testing |
| `dev.sh` | 🎮 **Interactive Menu** | Daily development work |
| `deploy.sh` | 🏭 **Production Deploy** | VPS deployment (PM2 + Nginx) |

## 🎮 Development Menu Options

When you run `./dev.sh`, you get these options:

### 🚀 **1. Start Development Servers**
- Starts backend (port 3001) and frontend (port 3000)
- Checks if servers are already running
- Shows URLs when ready

### 🛑 **2. Stop Development Servers**
- Cleanly stops all running servers
- Removes PID files
- Safe shutdown

### 📊 **3. Check Server Status**
- Shows which servers are running
- Health check results
- Port status

### 📋 **4. Show Server Logs**
- Recent backend logs
- Recent frontend logs
- Debug information

### 🧪 **5. Test Application**
- Backend health check
- Frontend accessibility test
- End-to-end validation

### 📦 **6. Install/Update Dependencies**
- Fresh npm install for backend
- Fresh npm install for frontend
- Updates all packages

### ⚙️ **7. Setup Environment**
- Creates `.env` from template
- Creates data directories
- Initial configuration

### ❓ **8. Help**
- Complete documentation
- Troubleshooting guide
- Project structure info

### 🚪 **9. Exit**
- Clean shutdown
- Stops all servers
- Safe exit

## 🔧 Manual Development

If you prefer manual control:

### Backend
```bash
cd backend
npm install
npm start
# Runs on http://localhost:3001
```

### Frontend
```bash
cd frontend
npm install
npm run dev
# Runs on http://localhost:3000
```

## 📁 Project Structure

```
gitdone/
├── backend/                 # Express API server
│   ├── routes/             # API endpoints
│   ├── utils/              # Services & utilities
│   ├── server.js           # Main server file
│   └── package.json        # Backend dependencies
├── frontend/               # Next.js application
│   ├── src/app/           # App router pages
│   ├── package.json       # Frontend dependencies
│   └── next.config.ts     # Next.js config
├── data/                   # Data storage
│   ├── events/            # Event JSON files
│   ├── uploads/           # Uploaded files
│   └── git_repos/         # Git repositories
├── dev.sh                 # Interactive development script
├── quick-start.sh         # One-command setup
├── deploy.sh              # Production deployment
└── .env                   # Environment configuration
```

## 🔍 Troubleshooting

### **Servers Won't Start**
```bash
# Check if ports are free
lsof -i :3000
lsof -i :3001

# Kill processes using ports
sudo kill -9 $(lsof -t -i:3000)
sudo kill -9 $(lsof -t -i:3001)
```

### **Dependencies Issues**
```bash
# Clear npm cache
npm cache clean --force

# Remove node_modules and reinstall
rm -rf backend/node_modules frontend/node_modules
./dev.sh  # Choose option 6
```

### **Environment Issues**
```bash
# Check .env file
cat .env

# Recreate from template
cp .env.example .env
# Edit with your settings
nano .env
```

### **Email Not Working**
1. Check `.env` file for SMTP settings
2. Verify Gmail app password
3. Test email service:
```bash
cd backend
node test-email.js
```

## 🎯 Development Workflow

### **Daily Development**
1. Run `./dev.sh`
2. Choose option 1 (Start Servers)
3. Develop your features
4. Test with option 5 (Test Application)
5. Stop with Ctrl+C or option 2

### **Fresh Setup**
1. Clone repository
2. Run `./quick-start.sh`
3. Start developing!

### **Debugging**
1. Use option 3 (Check Status) to see what's running
2. Use option 4 (Show Logs) to see errors
3. Use option 5 (Test Application) for health checks

## 🔧 Configuration

### **Environment Variables**
Edit `.env` file for:
- Email settings (SMTP_USER, SMTP_PASS)
- Security keys (JWT_SECRET, ENCRYPTION_KEY)
- File limits (MAX_FILE_SIZE)
- URLs (BASE_URL, FRONTEND_URL)

### **Port Configuration**
- Frontend: 3000 (Next.js default)
- Backend: 3001 (Express server)
- Change in respective package.json files

## 📊 Monitoring

### **Health Checks**
- Backend: `http://localhost:3001/api/health`
- Frontend: `http://localhost:3000`

### **Logs**
- Backend logs: Check terminal output
- Frontend logs: Check terminal output
- Use `./dev.sh` option 4 for log viewing

## 🚀 Production vs Development

| Feature | Development | Production |
|---------|-------------|------------|
| **Script** | `dev.sh` | `deploy.sh` |
| **Process Manager** | Direct npm | PM2 |
| **Reverse Proxy** | None | Nginx |
| **SSL** | None | Let's Encrypt |
| **Environment** | development | production |
| **Logging** | Console | Files |
| **Auto-restart** | Manual | Automatic |

## 🎉 Tips

- **Use `quick-start.sh`** for instant setup
- **Use `dev.sh`** for daily development
- **Check status** before starting servers
- **Test application** after changes
- **Stop servers** cleanly before exiting
- **Configure email** for full functionality

---

**Happy coding! 🚀**