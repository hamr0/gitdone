/**
 * MailHog Email Helper for E2E Testing
 *
 * MailHog is a local SMTP server with an API for automated email testing.
 * Perfect for E2E tests - emails are captured locally and accessible via HTTP API.
 *
 * Setup:
 * 1. Start MailHog: docker run -d -p 1025:1025 -p 8025:8025 mailhog/mailhog
 * 2. Configure backend .env for test mode:
 *    SMTP_HOST=localhost
 *    SMTP_PORT=1025
 *    SMTP_SECURE=false
 * 3. Access web UI: http://localhost:8025
 * 4. API: http://localhost:8025/api/v2/messages
 */
export class MailHogHelper {
  private apiUrl: string;
  private smtpHost: string;
  private smtpPort: number;

  constructor(
    apiUrl: string = 'http://localhost:8025/api/v2',
    smtpHost: string = 'localhost',
    smtpPort: number = 1025
  ) {
    this.apiUrl = apiUrl;
    this.smtpHost = smtpHost;
    this.smtpPort = smtpPort;
  }

  /**
   * Check if MailHog is running and accessible
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.apiUrl}/messages?limit=1`);
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get all messages from MailHog
   */
  async getAllMessages(): Promise<any[]> {
    try {
      const response = await fetch(`${this.apiUrl}/messages`);

      if (!response.ok) {
        throw new Error(`MailHog API error: ${response.status}`);
      }

      const data = await response.json();
      return data.items || [];
    } catch (error) {
      console.error('Error fetching messages from MailHog:', error);
      throw error;
    }
  }

  /**
   * Get latest email sent to a specific recipient
   * Waits up to maxWaitTime milliseconds for email to arrive
   */
  async getLatestEmail(
    recipientEmail: string,
    maxWaitTime: number = 10000,
    pollInterval: number = 500
  ): Promise<any> {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      const messages = await this.getAllMessages();

      // Find message for this recipient
      const message = messages.find(msg => {
        const to = msg.To || [];
        return to.some((recipient: any) =>
          recipient.Mailbox && recipient.Domain &&
          `${recipient.Mailbox}@${recipient.Domain}` === recipientEmail
        );
      });

      if (message) {
        return message;
      }

      // Wait before polling again
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    throw new Error(
      `No email found for ${recipientEmail} after ${maxWaitTime}ms. ` +
      `Check that MailHog is running at ${this.apiUrl}`
    );
  }

  /**
   * Get email by message ID
   */
  async getMessageById(messageId: string): Promise<any> {
    try {
      const response = await fetch(`${this.apiUrl}/messages/${messageId}`);

      if (!response.ok) {
        throw new Error(`Message not found: ${messageId}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`Error fetching message ${messageId}:`, error);
      throw error;
    }
  }

  /**
   * Extract plain text body from email
   */
  getPlainTextBody(message: any): string {
    if (!message.Content || !message.Content.Body) {
      return '';
    }

    // Decode base64 if needed
    const body = message.Content.Body;
    try {
      return Buffer.from(body, 'base64').toString('utf-8');
    } catch {
      return body;
    }
  }

  /**
   * Extract HTML body from email
   */
  getHtmlBody(message: any): string {
    if (!message.MIME || !message.MIME.Parts) {
      return '';
    }

    // Find HTML part
    const htmlPart = message.MIME.Parts.find(
      (part: any) => part.Headers && part.Headers['Content-Type'] &&
      part.Headers['Content-Type'][0].includes('text/html')
    );

    if (!htmlPart || !htmlPart.Body) {
      return '';
    }

    // Decode base64
    try {
      return Buffer.from(htmlPart.Body, 'base64').toString('utf-8');
    } catch {
      return htmlPart.Body;
    }
  }

  /**
   * Extract magic token from email content
   * Works with both HTML and plain text
   */
  extractMagicToken(message: any): string {
    // Try HTML first, then plain text
    const htmlBody = this.getHtmlBody(message);
    const plainBody = this.getPlainTextBody(message);
    const content = htmlBody || plainBody;

    if (!content) {
      throw new Error('Email has no content to extract token from');
    }

    // Pattern matches: /complete/{JWT_TOKEN}
    const tokenPattern = /\/complete\/([a-zA-Z0-9._-]+)/;
    const match = content.match(tokenPattern);

    if (!match || !match[1]) {
      console.error('Email content:', content.substring(0, 500));
      throw new Error('No magic token found in email content');
    }

    return match[1];
  }

  /**
   * Extract all magic tokens from email (for multi-step events)
   */
  extractAllMagicTokens(message: any): string[] {
    const htmlBody = this.getHtmlBody(message);
    const plainBody = this.getPlainTextBody(message);
    const content = htmlBody || plainBody;

    const tokenPattern = /\/complete\/([a-zA-Z0-9._-]+)/g;
    const matches = [...content.matchAll(tokenPattern)];

    return matches.map(match => match[1]);
  }

  /**
   * Get email subject
   */
  getSubject(message: any): string {
    return message.Content?.Headers?.Subject?.[0] || '';
  }

  /**
   * Get email sender
   */
  getFrom(message: any): string {
    const from = message.From;
    if (from && from.Mailbox && from.Domain) {
      return `${from.Mailbox}@${from.Domain}`;
    }
    return '';
  }

  /**
   * Get email recipients
   */
  getRecipients(message: any): string[] {
    const to = message.To || [];
    return to.map((recipient: any) =>
      `${recipient.Mailbox}@${recipient.Domain}`
    );
  }

  /**
   * Delete a message
   */
  async deleteMessage(messageId: string): Promise<void> {
    try {
      await fetch(`${this.apiUrl}/messages/${messageId}`, {
        method: 'DELETE'
      });
    } catch (error) {
      console.error(`Error deleting message ${messageId}:`, error);
    }
  }

  /**
   * Delete all messages (clean up after tests)
   */
  async deleteAllMessages(): Promise<void> {
    try {
      await fetch(`${this.apiUrl}/messages`, {
        method: 'DELETE'
      });
      console.log('🧹 Cleared all MailHog messages');
    } catch (error) {
      console.error('Error clearing MailHog messages:', error);
    }
  }

  /**
   * Get SMTP configuration for backend
   */
  getSMTPConfig() {
    return {
      host: this.smtpHost,
      port: this.smtpPort,
      secure: false, // MailHog doesn't use TLS
      auth: undefined // MailHog doesn't require auth
    };
  }

  /**
   * Wait for email and extract token in one step
   * This is the most common use case in tests
   */
  async waitForEmailAndExtractToken(
    recipientEmail: string,
    maxWaitTime: number = 10000
  ): Promise<string> {
    const message = await this.getLatestEmail(recipientEmail, maxWaitTime);
    return this.extractMagicToken(message);
  }

  /**
   * Get message count for debugging
   */
  async getMessageCount(): Promise<number> {
    const messages = await this.getAllMessages();
    return messages.length;
  }

  /**
   * Print all messages for debugging
   */
  async printAllMessages(): Promise<void> {
    const messages = await this.getAllMessages();

    console.log(`📧 MailHog Messages (${messages.length}):`);
    messages.forEach((msg, index) => {
      console.log(`  ${index + 1}. To: ${this.getRecipients(msg).join(', ')}`);
      console.log(`     Subject: ${this.getSubject(msg)}`);
      console.log(`     From: ${this.getFrom(msg)}`);
    });
  }
}

/**
 * Example usage in tests:
 *
 * const mailhog = new MailHogHelper();
 *
 * // Wait for email and get token
 * const token = await mailhog.waitForEmailAndExtractToken('vendor@example.com');
 *
 * // Use token to complete step
 * await page.goto(`/complete/${token}`);
 */
