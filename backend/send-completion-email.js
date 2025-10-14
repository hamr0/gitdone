#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');

// Load environment variables
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const CompletionEmailService = require('./utils/completionEmail');

async function sendCompletionEmail() {
  const eventId = process.argv[2];
  
  if (!eventId) {
    console.log('Usage: node send-completion-email.js <event-id>');
    console.log('Example: node send-completion-email.js 6f9e2519-f18b-4a4f-8b3d-31222cc33486');
    process.exit(1);
  }

  try {
    console.log(`📧 Sending completion email for event: ${eventId}`);
    
    // Read event data
    const eventPath = path.join(__dirname, '../data/events', `${eventId}.json`);
    const eventData = await fs.readFile(eventPath, 'utf8');
    const event = JSON.parse(eventData);
    
    console.log(`📋 Event: ${event.name}`);
    console.log(`👤 Organizer: ${event.owner_email}`);
    console.log(`📊 Steps: ${event.steps.length} completed`);
    console.log(`📁 Files: ${event.steps.reduce((total, step) => total + (step.files ? step.files.length : 0), 0)} uploaded`);
    
    // Check if Git repository exists
    const gitRepoPath = path.join(__dirname, '../data/git_repos', eventId);
    let gitHash = null;
    
    try {
      await fs.access(gitRepoPath);
      // Get latest commit hash if repo exists
      const { exec } = require('child_process');
      gitHash = await new Promise((resolve, reject) => {
        exec(`cd ${gitRepoPath} && git log --oneline -1 --format="%H"`, (error, stdout, stderr) => {
          if (error) {
            resolve(null);
          } else {
            resolve(stdout.trim());
          }
        });
      });
    } catch (error) {
      console.log('⚠️  Git repository not found - will create one');
    }
    
    // Send completion email
    const completionEmailService = new CompletionEmailService();
    await completionEmailService.sendEventCompletionEmail(event, gitHash);
    
    console.log('✅ Completion email sent successfully!');
    console.log(`📧 Check inbox at: ${event.owner_email}`);
    
  } catch (error) {
    console.error('❌ Error sending completion email:', error.message);
    process.exit(1);
  }
}

// Run the script
sendCompletionEmail().catch(console.error);