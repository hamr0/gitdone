const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const fs = require('fs').promises;
const path = require('path');
const EmailService = require('../utils/emailService');
const MagicLinkService = require('../utils/magicLinkService');

const EVENTS_DIR = path.join(__dirname, '../../data/events');
const TOKENS_FILE = path.join(__dirname, '../../data/magic_tokens.json');

// Email service
let emailService;
try {
  emailService = new EmailService();
  emailService.testConnection().then(() => {
    console.log('✅ SMTP email service initialized successfully');
  }).catch((error) => {
    console.warn('⚠️ SMTP email service not configured:', error.message);
    console.warn('   Please configure SMTP settings in .env file');
  });
} catch (error) {
  console.warn('⚠️ Email service initialization failed:', error.message);
}

// Ensure tokens file exists
async function ensureTokensFile() {
  try {
    await fs.access(TOKENS_FILE);
  } catch {
    await fs.mkdir(path.dirname(TOKENS_FILE), { recursive: true });
    await fs.writeFile(TOKENS_FILE, JSON.stringify({ tokens: {} }, null, 2));
  }
}

// Load tokens
async function loadTokens() {
  try {
    const data = await fs.readFile(TOKENS_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return { tokens: {} };
  }
}

// Save tokens
async function saveTokens(tokensData) {
  await fs.writeFile(TOKENS_FILE, JSON.stringify(tokensData, null, 2));
}

// POST /api/magic/send - Send magic link
router.post('/send', async (req, res) => {
  try {
    const { event_id, step_id, vendor_email } = req.body;
    
    if (!event_id || !step_id || !vendor_email) {
      return res.status(400).json({ error: 'Missing required fields: event_id, step_id, vendor_email' });
    }
    
    // Use the magic link service
    const magicLinkService = new MagicLinkService();
    const result = await magicLinkService.sendMagicLink(event_id, step_id, vendor_email);
    
    res.json(result);
  } catch (error) {
    console.error('Error sending magic link:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/magic/send-all - Send magic links to all pending steps
router.post('/send-all', async (req, res) => {
  try {
    const { event_id } = req.body;
    
    if (!event_id) {
      return res.status(400).json({ error: 'Missing required field: event_id' });
    }
    
    // Read event
    const eventPath = path.join(EVENTS_DIR, `${event_id}.json`);
    const eventData = await fs.readFile(eventPath, 'utf8');
    const event = JSON.parse(eventData);
    
    const pendingSteps = event.steps.filter(step => step.status === 'pending');
    const results = [];
    
    for (const step of pendingSteps) {
      try {
        const response = await fetch(`${req.protocol}://${req.get('host')}/api/magic/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event_id,
            step_id: step.id,
            vendor_email: step.vendor_email
          })
        });
        
        const result = await response.json();
        results.push({
          step_id: step.id,
          step_name: step.name,
          vendor_email: step.vendor_email,
          success: result.success,
          error: result.error
        });
      } catch (error) {
        results.push({
          step_id: step.id,
          step_name: step.name,
          vendor_email: step.vendor_email,
          success: false,
          error: error.message
        });
      }
    }
    
    res.json({ 
      success: true, 
      message: `Processed ${results.length} steps`,
      results 
    });
  } catch (error) {
    console.error('Error sending all magic links:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/magic/status/:token - Check token status
router.get('/status/:token', async (req, res) => {
  try {
    const tokensData = await loadTokens();
    const tokenData = tokensData.tokens[req.params.token];
    
    if (!tokenData) {
      return res.status(404).json({ error: 'Token not found' });
    }
    
    res.json({
      valid: !tokenData.used && (!tokenData.expires_at || new Date(tokenData.expires_at) > new Date()),
      used: tokenData.used,
      expires_at: tokenData.expires_at,
      created_at: tokenData.created_at
    });
  } catch (error) {
    console.error('Error checking token status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper function to parse time limits
function parseTimeLimit(timeLimit) {
  const units = {
    'hours': 60 * 60 * 1000,
    'days': 24 * 60 * 60 * 1000,
    'weeks': 7 * 24 * 60 * 60 * 1000
  };
  
  const match = timeLimit.match(/(\d+)\s*(hours?|days?|weeks?)/i);
  if (match) {
    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    return value * (units[unit] || units['days']);
  }
  
  return 30 * units['days']; // Default to 30 days
}

module.exports = router;