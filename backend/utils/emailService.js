const nodemailer = require('nodemailer');
const fs = require('fs').promises;
const path = require('path');

class EmailService {
  constructor() {
    this.transporter = null;
    this.tempDir = path.join(__dirname, '../../data/temp');
    this.initTransporter();
  }

  initTransporter() {
    // Check if SMTP is configured
    const smtpConfigured =
      process.env.SMTP_HOST &&
      process.env.SMTP_PORT &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASS;

    if (!smtpConfigured) {
      console.warn('⚠️  SMTP not configured. Email functionality will not work.');
      console.warn('   Please configure SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS in .env');
      return;
    }

    try {
      // Check if using Gmail (use service shorthand for better compatibility)
      const isGmail = process.env.SMTP_HOST === 'smtp.gmail.com';

      const transportConfig = isGmail ? {
        service: 'gmail',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        }
      } : {
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT, 10),
        secure: parseInt(process.env.SMTP_PORT, 10) === 465, // true for 465, false for other ports
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
        tls: {
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2'
        }
      };

      this.transporter = nodemailer.createTransport(transportConfig);

      console.log('✅ SMTP email service configured');
    } catch (error) {
      console.error('❌ Failed to initialize SMTP transporter:', error.message);
    }
  }

  async ensureTempDir() {
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
    } catch (error) {
      // Directory already exists
    }
  }

  async sendEmail(to, subject, htmlBody, textBody = null) {
    if (!this.transporter) {
      throw new Error('SMTP not configured. Please set SMTP environment variables in .env');
    }

    try {
      const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER;
      const textContent = textBody || this.htmlToText(htmlBody);

      const mailOptions = {
        from: `"GitDone" <${fromEmail}>`,
        to: to,
        subject: subject,
        text: textContent,
        html: htmlBody,
      };

      const info = await this.transporter.sendMail(mailOptions);
      console.log('✅ Email sent successfully to:', to);
      console.log('   Message ID:', info.messageId);

      return {
        success: true,
        message: 'Email sent successfully',
        messageId: info.messageId
      };
    } catch (error) {
      console.error('❌ Email service error:', error);
      throw new Error(`Failed to send email: ${error.message}`);
    }
  }

  htmlToText(html) {
    // Simple HTML to text conversion
    return html
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .trim();
  }

  async testConnection() {
    if (!this.transporter) {
      throw new Error('SMTP not configured. Please set SMTP environment variables in .env');
    }

    try {
      await this.transporter.verify();
      console.log('✅ SMTP connection test successful');
      return {
        success: true,
        message: 'SMTP server is ready to send emails',
        config: {
          host: process.env.SMTP_HOST,
          port: process.env.SMTP_PORT,
          user: process.env.SMTP_USER,
          from: process.env.SMTP_FROM || process.env.SMTP_USER
        }
      };
    } catch (error) {
      console.error('❌ SMTP connection test failed:', error.message);
      throw new Error(`SMTP test failed: ${error.message}`);
    }
  }
}

module.exports = EmailService;
