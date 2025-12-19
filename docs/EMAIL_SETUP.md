# 📧 Email Setup Guide - SMTP Configuration

## 📋 Table of Contents

1. [Quick Setup](#-quick-setup)
2. [Architecture Overview](#-architecture-overview-hla)
3. [Design Details](#-design-details-hld)
4. [Configuration](#configuration)
5. [Testing](#-testing)
6. [Troubleshooting](#-troubleshooting)

---

## 🚀 Quick Setup

GitDone uses SMTP via Nodemailer for sending email notifications and magic links. No system-level configuration needed!

### Why SMTP Over MSMTP?

**Previous Implementation (MSMTP):**
- ❌ Required system-level installation (`apt-get install msmtp`)
- ❌ User-specific configuration (`~/.msmtprc`)
- ❌ Different setup for each developer/server
- ❌ Complex deployment to VPS
- ❌ Not Docker-friendly

**Current Implementation (SMTP/Nodemailer):**
- ✅ No system dependencies
- ✅ Configuration via `.env` file
- ✅ Works identically everywhere (local, VPS, Docker)
- ✅ Easy team collaboration
- ✅ One-line deployment: `scp .env user@vps:/path/to/app/`

---

## 🏗️ Architecture Overview (HLA)

### System Components

```
┌─────────────────────────────────────────────────────────────┐
│                     GitDone Application                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐     ┌──────────────┐     ┌────────────┐ │
│  │   Frontend   │────▶│   Backend    │────▶│ Email      │ │
│  │   Next.js    │     │   Express    │     │ Service    │ │
│  └──────────────┘     └──────────────┘     └─────┬──────┘ │
│                                                    │         │
└────────────────────────────────────────────────────┼─────────┘
                                                     │
                                                     ▼
                                      ┌──────────────────────┐
                                      │   Nodemailer         │
                                      │   Transport Layer    │
                                      └──────────┬───────────┘
                                                 │
                         ┌───────────────────────┼──────────────────────┐
                         │                       │                      │
                         ▼                       ▼                      ▼
              ┌─────────────────┐    ┌────────────────┐    ┌──────────────────┐
              │  Gmail SMTP     │    │  SendGrid SMTP │    │  Custom SMTP     │
              │  smtp.gmail.com │    │  smtp.sendgrid │    │  your-server.com │
              │  Port: 587      │    │  Port: 587     │    │  Port: 587/465   │
              └─────────────────┘    └────────────────┘    └──────────────────┘
```

### Data Flow

```
Event Creation
     │
     ├──▶ Magic Link Generation
     │         │
     │         ├──▶ JWT Token Created
     │         │         │
     │         │         └──▶ Token Stored (magic_tokens.json)
     │         │
     │         └──▶ Email Service Triggered
     │                   │
     │                   ├──▶ Load .env Configuration
     │                   │         │
     │                   │         ├──▶ SMTP_HOST
     │                   │         ├──▶ SMTP_PORT
     │                   │         ├──▶ SMTP_USER
     │                   │         ├──▶ SMTP_PASS
     │                   │         └──▶ SMTP_FROM
     │                   │
     │                   ├──▶ Nodemailer Transport Init
     │                   │         │
     │                   │         └──▶ Gmail Service (if Gmail)
     │                   │         └──▶ Manual Config (if other)
     │                   │
     │                   ├──▶ Email Composed
     │                   │         │
     │                   │         ├──▶ HTML Body (with magic link)
     │                   │         ├──▶ Text Body (fallback)
     │                   │         ├──▶ Subject
     │                   │         └──▶ Recipient
     │                   │
     │                   └──▶ Send via SMTP
     │                             │
     │                             ├──▶ TLS Handshake
     │                             ├──▶ Authentication
     │                             └──▶ Message Delivery
     │
     └──▶ Vendor Receives Email
               │
               └──▶ Clicks Magic Link
                         │
                         └──▶ Token Validation ──▶ Step Completion
```

---

## 🔧 Design Details (HLD)

### 1. Email Service Class

**File:** `backend/utils/emailService.js`

**Responsibilities:**
- Initialize SMTP transporter with environment configuration
- Handle Gmail-specific configuration (uses service shorthand)
- Manage email sending with HTML/text alternatives
- Provide connection testing functionality

**Key Methods:**
```javascript
class EmailService {
  constructor()              // Initialize transporter
  initTransporter()          // Configure SMTP connection
  sendEmail(to, subject, htmlBody, textBody)  // Send email
  testConnection()           // Verify SMTP credentials
  htmlToText(html)          // Convert HTML to plain text
}
```

**Configuration Logic:**
```javascript
// Gmail Detection & Optimization
if (process.env.SMTP_HOST === 'smtp.gmail.com') {
  // Use nodemailer's Gmail service shorthand
  // Handles Gmail-specific SMTP quirks automatically
  config = {
    service: 'gmail',
    auth: { user, pass }
  }
} else {
  // Manual SMTP configuration for other providers
  config = {
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: (port === 465),  // SSL for 465, TLS for 587
    auth: { user, pass },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' }
  }
}
```

### 2. Magic Link Service

**File:** `backend/utils/magicLinkService.js`

**Integration with Email Service:**
```javascript
class MagicLinkService {
  constructor() {
    this.emailService = new EmailService();  // Dependency injection
  }

  async sendMagicLink(eventId, stepId, vendorEmail) {
    // 1. Generate JWT token
    const token = jwt.sign({ ... }, JWT_SECRET);

    // 2. Store token metadata
    await this.saveToken(token, { ... });

    // 3. Compose magic link URL
    const magicLink = `${BASE_URL}/complete/${token}`;

    // 4. Generate HTML email
    const html = this.generateEmailHTML(magicLink, eventData);

    // 5. Send via Email Service
    await this.emailService.sendEmail(
      vendorEmail,
      'Action Required: Complete Your Step',
      html
    );
  }
}
```

### 3. Environment Variable Loading

**Pattern Used Everywhere:**
```javascript
const path = require('path');
require('dotenv').config({
  path: path.resolve(__dirname, '../.env')  // Absolute path
});
```

**Files Loading .env:**
- `backend/server.js` - Main entry point
- `backend/test-email.js` - Standalone test script
- `backend/test-end-to-end.js` - E2E test script
- `backend/test-fixes.js` - Component tests
- `backend/send-completion-email.js` - Manual email sending

**Files Inheriting Environment:**
- All `backend/utils/*.js` - Utility modules
- All `backend/routes/*.js` - Route handlers

### 4. Security Considerations

**Email Security:**
- ✅ TLS/SSL encryption for SMTP connections
- ✅ App-specific passwords (not account passwords)
- ✅ Environment variable storage (never in code)
- ✅ .env file git-ignored

**Magic Link Security:**
- ✅ JWT signed with secret key
- ✅ Token expiration (configurable per step)
- ✅ Single-use tokens (marked as used after completion)
- ✅ Email binding (token tied to specific vendor email)

### 5. Error Handling

**Email Service Error Handling:**
```javascript
async sendEmail(...) {
  if (!this.transporter) {
    throw new Error('SMTP not configured. Check .env file');
  }

  try {
    const info = await this.transporter.sendMail(mailOptions);
    console.log('✅ Email sent:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('❌ Email send failed:', error.message);
    throw new Error(`Failed to send email: ${error.message}`);
  }
}
```

**Common Error Scenarios:**
1. **Invalid Credentials** → Check SMTP_USER and SMTP_PASS
2. **Connection Timeout** → Check SMTP_HOST and SMTP_PORT
3. **SSL/TLS Errors** → Verify port (587=TLS, 465=SSL)
4. **Authentication Failed** → Use app password, not regular password

### 6. Testing Infrastructure

**Test Script:** `backend/test-email.js`

**Test Flow:**
```
1. Load .env configuration
2. Initialize EmailService
3. Test SMTP connection (verify())
4. Display connection details
5. Send test email
6. Report success/failure
7. Provide troubleshooting tips
```

**Output:**
```bash
🧪 Testing SMTP Email Configuration...

1. Testing SMTP connection...
✅ SMTP connection successful!
   Host: smtp.gmail.com
   Port: 587
   User: your@gmail.com
   From: your@gmail.com

2. Testing email sending...
✅ Email sent successfully!
📧 Check your inbox at: your@gmail.com
```

---

## Configuration

### 1. Configure SMTP in .env

Edit your `.env` file in the project root:

```bash
nano .env
```

Update these values with your email credentials:

```bash
# Email Configuration (Gmail SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@gmail.com
SMTP_PASS=your-16-character-app-password
SMTP_FROM=your@gmail.com
```

### 2. Gmail App Password Setup (Recommended)

Gmail is the easiest option for quick setup:

1. **Enable 2-Factor Authentication**
   - Go to [Google Account Security](https://myaccount.google.com/security)
   - Turn on 2-Step Verification

2. **Generate App Password**
   - Go to [App Passwords](https://myaccount.google.com/apppasswords)
   - Select "Mail" and "Other (Custom name)"
   - Enter "GitDone" as the name
   - Copy the 16-character password (e.g., `abcd efgh ijkl mnop`)
   - Remove spaces and use it as `SMTP_PASS`

3. **Update .env Configuration**
   ```bash
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=your-email@gmail.com
   SMTP_PASS=abcdefghijklmnop
   SMTP_FROM=your-email@gmail.com
   ```

### 3. Test Email Configuration

Run the test script to verify everything works:

```bash
cd /home/hamr/PycharmProjects/gitdone/backend
node test-email.js
```

Expected output:
```
🧪 Testing SMTP Email Configuration...

1. Testing SMTP connection...
✅ SMTP connection successful!
   Host: smtp.gmail.com
   Port: 587
   User: your@gmail.com
   From: your@gmail.com

2. Testing email sending...
✅ Email sent successfully!
📧 Check your inbox at: your@gmail.com
```

## 🔧 Alternative Email Providers

### Outlook/Hotmail

```bash
SMTP_HOST=smtp-mail.outlook.com
SMTP_PORT=587
SMTP_USER=your-email@outlook.com
SMTP_PASS=your-password
SMTP_FROM=your-email@outlook.com
```

### Yahoo Mail

```bash
SMTP_HOST=smtp.mail.yahoo.com
SMTP_PORT=587
SMTP_USER=your-email@yahoo.com
SMTP_PASS=your-app-password
SMTP_FROM=your-email@yahoo.com
```

**Note**: Yahoo also requires an app password. Generate one at [Yahoo Account Security](https://login.yahoo.com/account/security).

### SendGrid (Production Recommended)

```bash
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=your-sendgrid-api-key
SMTP_FROM=verified-sender@yourdomain.com
```

### Custom SMTP Server

```bash
SMTP_HOST=mail.yourdomain.com
SMTP_PORT=587
SMTP_USER=your-email@yourdomain.com
SMTP_PASS=your-password
SMTP_FROM=noreply@yourdomain.com
```

**Port Options**:
- `587` - TLS (recommended)
- `465` - SSL
- `25` - Unencrypted (not recommended)

## 🧪 Testing

### Manual Test with Script

```bash
# Test with default email (uses SMTP_USER from .env)
node backend/test-email.js

# Test with specific email
TEST_EMAIL=recipient@example.com node backend/test-email.js
```

### Through GitDone Application

1. Start the application: `./quick-start.sh`
2. Create an event at http://localhost:3000
3. Add steps with vendor emails
4. Click "Send Reminder" for any step
5. Check the vendor's email for the magic link

## 🐛 Troubleshooting

### Common Issues

**"SMTP not configured"**
- Check that all SMTP_* variables are set in `.env`
- Restart the backend server after updating `.env`
- Verify no typos in environment variable names

**"Authentication failed" (Gmail)**
- Use App Password, NOT your regular Gmail password
- Ensure 2FA is enabled on your Google account
- Check that the app password has no spaces
- Verify the email address is correct

**"Authentication failed" (Other providers)**
- Check username/password are correct
- Some providers require app-specific passwords
- Verify SMTP access is enabled for your account

**"Connection timeout" or "ECONNREFUSED"**
- Check your firewall settings
- Verify SMTP host and port are correct
- Try port 465 instead of 587 (or vice versa)
- Check if your ISP blocks SMTP ports

**"Self signed certificate" error**
- Some providers use self-signed certificates
- Add `tls: { rejectUnauthorized: false }` to transporter config (not recommended for production)

### Debug Mode

Check backend logs when starting the server:

```bash
cd backend
npm start
```

Look for:
- `✅ SMTP email service configured` - Success
- `⚠️ SMTP not configured` - Missing environment variables

### Environment Variable Check

```bash
# Check if .env is loaded properly
cd backend
node -e "require('dotenv').config({path:'../.env'}); console.log('SMTP_HOST:', process.env.SMTP_HOST)"
```

## 📋 Configuration Checklist

- [ ] `.env` file exists in project root
- [ ] `SMTP_HOST` is set
- [ ] `SMTP_PORT` is set (587 or 465)
- [ ] `SMTP_USER` is set (your email address)
- [ ] `SMTP_PASS` is set (app password for Gmail)
- [ ] `SMTP_FROM` is set (usually same as SMTP_USER)
- [ ] Gmail 2FA enabled (if using Gmail)
- [ ] App password generated (if using Gmail)
- [ ] Test email sent successfully (`node backend/test-email.js`)
- [ ] Backend server restarted
- [ ] Magic links working in application

## 🚀 Production Deployment

### Environment Variables on VPS

1. Copy your `.env` file to the server:
   ```bash
   scp .env user@your-vps:/path/to/gitdone/.env
   ```

2. Or set environment variables directly:
   ```bash
   export SMTP_HOST=smtp.gmail.com
   export SMTP_PORT=587
   export SMTP_USER=your@gmail.com
   export SMTP_PASS=your-app-password
   export SMTP_FROM=your@gmail.com
   ```

### Recommended: Use a Dedicated Email Service

For production, consider using a transactional email service:

- **SendGrid** - 100 emails/day free
- **Mailgun** - 5,000 emails/month free
- **AWS SES** - Very cheap, pay per email
- **Postmark** - Reliable, good for transactional emails

These services provide:
- Better deliverability
- Email analytics
- Higher sending limits
- Less likely to be marked as spam

### Security Best Practices

1. **Never commit `.env` to git** - Already in `.gitignore`
2. **Use app passwords** - Never use your main account password
3. **Use environment-specific credentials** - Different for dev/staging/production
4. **Rotate passwords regularly** - Update app passwords periodically
5. **Monitor email logs** - Watch for failed sends or authentication issues

## 🎯 Next Steps

Once email is configured:

1. **Test Magic Links**: Create an event and send reminders
2. **Verify Delivery**: Check spam folders if emails don't arrive
3. **Monitor Logs**: Watch backend logs for email-related errors
4. **Plan for Scale**: Consider dedicated email service for production

---

**Need Help?**

- Check backend logs: `cd backend && npm start`
- Run test script: `node backend/test-email.js`
- Verify .env file: `cat .env | grep SMTP`
- Review error messages carefully - they usually indicate the specific issue

**Common Gmail Setup Mistake**: Using your regular password instead of an app password. App passwords are required when 2FA is enabled!
