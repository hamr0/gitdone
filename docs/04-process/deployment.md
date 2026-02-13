# 🚀 GitDone VPS Deployment Guide

**Simple, fast, and reliable deployment for production VPS**

## 📋 Prerequisites

- **VPS**: Ubuntu 20.04+ (2GB RAM minimum, 4GB recommended)
- **Domain**: Pointed to your VPS IP
- **SSL Certificate**: Let's Encrypt (free)

## 🔧 VPS Setup

### 1. **Initial Server Setup**

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2 globally
sudo npm install -g pm2

# Install Nginx
sudo apt install nginx -y

# Install Git
sudo apt install git -y

# Install FFmpeg (for video processing)
sudo apt install ffmpeg -y

# Install Sharp dependencies
sudo apt install build-essential libvips-dev -y
```

### 2. **Create Application User**

```bash
# Create gitdone user
sudo adduser gitdone
sudo usermod -aG sudo gitdone

# Switch to gitdone user
su - gitdone
```

### 3. **Deploy Application**

```bash
# Clone repository
git clone <your-repo-url> /home/gitdone/gitdone
cd /home/gitdone/gitdone

# Install dependencies
cd backend && npm install --production
cd ../frontend && npm install --production

# Build frontend
npm run build

# Create data directories
mkdir -p data/events data/uploads data/git_repos
```

### 4. **Environment Configuration**

```bash
# Create production environment file
cat > .env << EOF
# Server Configuration
NODE_ENV=production
PORT=3001
BASE_URL=https://yourdomain.com

# Email Configuration (Gmail SMTP)
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password

# Security
JWT_SECRET=your-super-secret-jwt-key-here
ENCRYPTION_KEY=your-encryption-key-here

# File Limits
MAX_FILE_SIZE=26214400
MAX_FILES_PER_REQUEST=10

# Backend URL for frontend
BACKEND_URL=http://localhost:3001
EOF
```

### 5. **PM2 Configuration**

```bash
# Create PM2 ecosystem file
cat > ecosystem.config.js << EOF
module.exports = {
  apps: [
    {
      name: 'gitdone-backend',
      script: './backend/server.js',
      cwd: '/home/gitdone/gitdone',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3001
      },
      error_file: '/home/gitdone/logs/backend-error.log',
      out_file: '/home/gitdone/logs/backend-out.log',
      log_file: '/home/gitdone/logs/backend-combined.log',
      time: true,
      max_memory_restart: '1G',
      restart_delay: 4000,
      max_restarts: 10,
      min_uptime: '10s'
    },
    {
      name: 'gitdone-frontend',
      script: 'npm',
      args: 'start',
      cwd: '/home/gitdone/gitdone/frontend',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      error_file: '/home/gitdone/logs/frontend-error.log',
      out_file: '/home/gitdone/logs/frontend-out.log',
      log_file: '/home/gitdone/logs/frontend-combined.log',
      time: true,
      max_memory_restart: '1G',
      restart_delay: 4000,
      max_restarts: 10,
      min_uptime: '10s'
    }
  ]
};
EOF

# Create logs directory
mkdir -p /home/gitdone/logs

# Start applications
pm2 start ecosystem.config.js

# Save PM2 configuration
pm2 save

# Setup PM2 startup
pm2 startup
# Follow the instructions shown by PM2
```

### 6. **Nginx Configuration**

```bash
# Create Nginx configuration
sudo tee /etc/nginx/sites-available/gitdone << EOF
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    # Frontend
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }

    # Backend API
    location /api/ {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        
        # Increase timeout for file uploads
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # File uploads
    location /uploads/ {
        proxy_pass http://localhost:3001;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;
    add_header Content-Security-Policy "default-src 'self' http: https: data: blob: 'unsafe-inline'" always;

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_proxied expired no-cache no-store private must-revalidate auth;
    gzip_types text/plain text/css text/xml text/javascript application/x-javascript application/xml+rss application/javascript;
}
EOF

# Enable site
sudo ln -s /etc/nginx/sites-available/gitdone /etc/nginx/sites-enabled/

# Remove default site
sudo rm /etc/nginx/sites-enabled/default

# Test configuration
sudo nginx -t

# Restart Nginx
sudo systemctl restart nginx
sudo systemctl enable nginx
```

### 7. **SSL Certificate (Let's Encrypt)**

```bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx -y

# Get SSL certificate
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com

# Test auto-renewal
sudo certbot renew --dry-run
```

### 8. **Firewall Configuration**

```bash
# Configure UFW
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

## 🔄 **Deployment Process**

### **Initial Deployment**
```bash
# 1. Clone and setup (one-time)
git clone <your-repo> /home/gitdone/gitdone
cd /home/gitdone/gitdone
./deploy.sh
```

### **Updates**
```bash
# 2. Update application
cd /home/gitdone/gitdone
git pull origin main
pm2 restart all
```

## 📊 **Monitoring & Maintenance**

### **PM2 Commands**
```bash
# Check status
pm2 status

# View logs
pm2 logs gitdone-backend
pm2 logs gitdone-frontend

# Restart services
pm2 restart all

# Monitor resources
pm2 monit
```

### **Nginx Commands**
```bash
# Check status
sudo systemctl status nginx

# View logs
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log

# Test configuration
sudo nginx -t

# Reload configuration
sudo systemctl reload nginx
```

### **System Monitoring**
```bash
# Check disk space
df -h

# Check memory usage
free -h

# Check running processes
htop

# Check system logs
sudo journalctl -f
```

## 🛠️ **Backup Strategy**

### **Data Backup**
```bash
# Create backup script
cat > /home/gitdone/backup.sh << EOF
#!/bin/bash
DATE=\$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/home/gitdone/backups"
mkdir -p \$BACKUP_DIR

# Backup data directory
tar -czf \$BACKUP_DIR/gitdone_data_\$DATE.tar.gz data/

# Keep only last 7 days of backups
find \$BACKUP_DIR -name "gitdone_data_*.tar.gz" -mtime +7 -delete

echo "Backup completed: \$BACKUP_DIR/gitdone_data_\$DATE.tar.gz"
EOF

chmod +x /home/gitdone/backup.sh

# Add to crontab (daily at 2 AM)
(crontab -l 2>/dev/null; echo "0 2 * * * /home/gitdone/backup.sh") | crontab -
```

## 🚨 **Troubleshooting**

### **Common Issues**

**Backend won't start:**
```bash
# Check logs
pm2 logs gitdone-backend

# Check port availability
sudo netstat -tlnp | grep :3001

# Check environment variables
cat .env
```

**Frontend build fails:**
```bash
# Clear Next.js cache
cd frontend
rm -rf .next
npm run build
```

**Nginx 502 errors:**
```bash
# Check if backend is running
pm2 status

# Check backend logs
pm2 logs gitdone-backend

# Restart backend
pm2 restart gitdone-backend
```

**SSL certificate issues:**
```bash
# Check certificate status
sudo certbot certificates

# Renew certificate
sudo certbot renew
```

## 📈 **Performance Optimization**

### **Nginx Optimization**
```bash
# Add to /etc/nginx/nginx.conf
worker_processes auto;
worker_connections 1024;

# Enable caching
location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
}
```

### **PM2 Optimization**
```bash
# Monitor memory usage
pm2 monit

# Set memory limits
pm2 restart all --max-memory-restart 1G
```

## 🔒 **Security Checklist**

- [ ] ✅ Firewall configured (UFW)
- [ ] ✅ SSL certificate installed
- [ ] ✅ Strong JWT secret set
- [ ] ✅ App-specific email password
- [ ] ✅ Regular security updates
- [ ] ✅ Backup strategy in place
- [ ] ✅ Log monitoring setup

## 📞 **Support**

**Quick Commands:**
```bash
# Check everything is running
pm2 status && sudo systemctl status nginx

# View all logs
pm2 logs --lines 50

# Restart everything
pm2 restart all && sudo systemctl restart nginx
```

---

**🎉 Your GitDone is now production-ready!**

**Access your application at:** `https://yourdomain.com`