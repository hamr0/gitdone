#!/usr/bin/env node

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const EmailService = require('./utils/emailService');

async function testEmail() {
  console.log('🧪 Testing SMTP Email Configuration...\n');

  try {
    // Initialize email service
    const emailService = new EmailService();

    // Test connection
    console.log('1. Testing SMTP connection...');
    const connectionTest = await emailService.testConnection();
    console.log('✅ SMTP connection successful!');
    console.log('   Host:', connectionTest.config.host);
    console.log('   Port:', connectionTest.config.port);
    console.log('   User:', connectionTest.config.user);
    console.log('   From:', connectionTest.config.from);

    // Test email sending
    console.log('\n2. Testing email sending...');
    const testEmail = process.env.TEST_EMAIL || process.env.SMTP_USER || 'test@example.com';

    const htmlBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #333;">🎉 GitDone Email Test</h2>
        <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>Status:</strong> Email configuration is working!</p>
          <p><strong>Service:</strong> SMTP via Nodemailer</p>
          <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
        </div>
        <p style="color: #666; font-size: 14px;">
          If you received this email, your GitDone email setup is working correctly.
        </p>
      </div>
    `;

    const textBody = `
GitDone Email Test

Status: Email configuration is working!
Service: SMTP via Nodemailer
Time: ${new Date().toLocaleString()}

If you received this email, your GitDone email setup is working correctly.
    `;

    const result = await emailService.sendEmail(
      testEmail,
      'GitDone Email Test - Configuration Working!',
      htmlBody,
      textBody
    );

    console.log('✅ Email sent successfully!');
    console.log('📧 Check your inbox at:', testEmail);
    console.log('\n🎯 Next steps:');
    console.log('1. Go to your event dashboard');
    console.log('2. Click "Send Reminder" for any step');
    console.log('3. Check vendor emails for magic links');

  } catch (error) {
    console.error('❌ Email test failed:', error.message);
    console.log('\n🔧 Troubleshooting:');
    console.log('1. Check .env file for SMTP configuration');
    console.log('2. Verify SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS are set');
    console.log('3. For Gmail: ensure you are using an app password (not regular password)');
    console.log('4. For Gmail: ensure 2FA is enabled on your Google account');
    console.log('5. Check that your email provider allows SMTP access');
    console.log('\n📝 Example .env configuration:');
    console.log('   SMTP_HOST=smtp.gmail.com');
    console.log('   SMTP_PORT=587');
    console.log('   SMTP_USER=your@gmail.com');
    console.log('   SMTP_PASS=your-16-character-app-password');
    console.log('   SMTP_FROM=your@gmail.com');
  }
}

// Run the test
testEmail().catch(console.error);
