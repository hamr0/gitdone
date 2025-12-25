import nodemailer from 'nodemailer';

/**
 * Email Helper for E2E Testing
 *
 * Uses Ethereal Email (ethereal.email) to intercept test emails and extract magic tokens.
 * This enables true end-to-end testing without requiring real email delivery.
 *
 * Setup:
 * 1. Run setupEtherealAccount() once in test setup
 * 2. Configure backend .env with Ethereal credentials
 * 3. Tests can now intercept emails and extract tokens
 */
export class EmailHelper {
  private testAccount: any = null;
  private etherealBaseUrl = 'https://api.ethereal.email';

  /**
   * Create a test email account on Ethereal Email
   * This should be called once during test setup (globalSetup.ts)
   */
  async setupEtherealAccount(): Promise<void> {
    try {
      // Create test account
      this.testAccount = await nodemailer.createTestAccount();

      console.log('📧 Ethereal Email Test Account Created:');
      console.log(`   User: ${this.testAccount.user}`);
      console.log(`   Pass: ${this.testAccount.pass}`);
      console.log(`   SMTP: ${this.testAccount.smtp.host}:${this.testAccount.smtp.port}`);
      console.log(`   Web:  https://ethereal.email/messages`);

      // Set environment variables for backend to use
      process.env.SMTP_HOST = this.testAccount.smtp.host;
      process.env.SMTP_PORT = this.testAccount.smtp.port.toString();
      process.env.SMTP_USER = this.testAccount.user;
      process.env.SMTP_PASS = this.testAccount.pass;
      process.env.SMTP_SECURE = this.testAccount.smtp.secure ? 'true' : 'false';

    } catch (error) {
      console.error('❌ Failed to create Ethereal Email account:', error);
      throw error;
    }
  }

  /**
   * Get stored Ethereal credentials
   */
  getCredentials() {
    return {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT
    };
  }

  /**
   * Get all messages from Ethereal inbox
   * Note: Ethereal doesn't have a public API for fetching messages programmatically
   * Instead, we'll use the Ethereal preview URL that's returned after sending
   */
  async getLatestEmail(recipientEmail: string, maxWaitTime: number = 5000): Promise<any> {
    // Ethereal stores messages in memory and provides a preview URL
    // For testing, we'll need to use a different approach:
    // Store the preview URL from nodemailer.sendMail() response

    throw new Error(
      'Ethereal Email does not provide a public API to fetch messages. ' +
      'Use getPreviewUrl() method instead with the messageId from sendMail response.'
    );
  }

  /**
   * Extract magic token from email HTML content
   * Works with both HTML and plain text emails
   */
  extractTokenFromEmail(emailContent: string): string {
    // Pattern matches: /complete/{JWT_TOKEN}
    const tokenPattern = /\/complete\/([a-zA-Z0-9._-]+)/;
    const match = emailContent.match(tokenPattern);

    if (!match || !match[1]) {
      throw new Error('No magic token found in email content');
    }

    return match[1];
  }

  /**
   * Extract all magic links from email content
   * Returns array of complete URLs
   */
  extractMagicLinks(emailContent: string): string[] {
    const linkPattern = /https?:\/\/[^\s]+\/complete\/([a-zA-Z0-9._-]+)/g;
    const matches = [...emailContent.matchAll(linkPattern)];

    return matches.map(match => match[0]);
  }

  /**
   * Get Ethereal preview URL for a sent message
   * This is the best way to access test emails with Ethereal
   */
  getPreviewUrl(messageId: string): string {
    return nodemailer.getTestMessageUrl({ messageId } as any) || '';
  }

  /**
   * Alternative approach: Parse nodemailer info object
   * When backend sends email, it gets back an info object with messageId
   * We can use that to get the preview URL
   */
  async getTokenFromMessageInfo(info: any): Promise<string> {
    const previewUrl = this.getPreviewUrl(info.messageId);

    if (!previewUrl) {
      throw new Error('No preview URL available for message');
    }

    console.log(`📧 Email preview: ${previewUrl}`);

    // In a real scenario, we'd fetch the HTML from the preview URL
    // For now, we'll extract the token from the info.accepted recipient
    // This is a limitation of Ethereal - better approach is to use MailHog

    throw new Error(
      'Ethereal Email requires manual preview URL access. ' +
      'For automated testing, consider using MailHog instead (see docs).'
    );
  }

  /**
   * Check if email was sent successfully via Ethereal
   */
  wasEmailSent(info: any): boolean {
    return info && info.accepted && info.accepted.length > 0;
  }

  /**
   * Get email sending statistics
   */
  getEmailStats(info: any) {
    return {
      accepted: info.accepted || [],
      rejected: info.rejected || [],
      messageId: info.messageId,
      previewUrl: this.getPreviewUrl(info.messageId)
    };
  }
}

/**
 * IMPORTANT NOTE ABOUT ETHEREAL EMAIL
 *
 * Ethereal Email is great for:
 * - Verifying emails are sent without spam
 * - Getting preview URLs to manually check emails
 * - Testing SMTP configuration
 *
 * BUT it has limitations:
 * - No API to programmatically fetch message content
 * - Preview URLs require manual browser access
 * - Can't extract tokens automatically
 *
 * For true automated E2E testing with email interception, consider:
 *
 * 1. MailHog (Recommended for local testing)
 *    - Self-hosted SMTP server
 *    - Full API to fetch messages
 *    - Docker: docker run -p 1025:1025 -p 8025:8025 mailhog/mailhog
 *    - API: http://localhost:8025/api/v2/messages
 *
 * 2. Mailosaur (Paid service)
 *    - Full API support
 *    - Real email addresses
 *    - Perfect for CI/CD
 *
 * 3. Custom SMTP Mock Server
 *    - Full control
 *    - Store emails in memory/database
 *    - Access via test API
 *
 * See TEST_IMPROVEMENT_ROADMAP.md for implementation details.
 */
