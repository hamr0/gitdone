import { Page, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { MailHogHelper } from './mailhog-helper';

export interface TestEvent {
  name: string;
  owner_email: string;
  flow_type: 'sequential' | 'non_sequential' | 'hybrid';
  steps: TestStep[];
}

export interface TestStep {
  name: string;
  vendor_email: string;
  description?: string;
  time_limit?: string;
  sequence?: number;
}

export interface CreatedEvent {
  eventId: string;
  event: any;
  magic_links_sent?: any[];
}

/**
 * Test Utilities for GitDone E2E Tests
 */
export class TestUtils {
  private mailhog: MailHogHelper;

  constructor(public page: Page) {
    this.mailhog = new MailHogHelper();
  }

  /**
   * Load event fixture from JSON file
   */
  static loadEventFixture(fixtureName: string): TestEvent {
    const fixturePath = path.join(__dirname, '../fixtures/events', `${fixtureName}.json`);
    const fixtureData = fs.readFileSync(fixturePath, 'utf-8');
    return JSON.parse(fixtureData);
  }

  /**
   * Create an event via the UI
   */
  async createEventViaUI(eventData: TestEvent): Promise<string> {
    await this.page.goto('/');

    // Wait for page to load
    await this.page.waitForLoadState('networkidle');

    // Fill in event details using data-testid
    await this.page.fill('[data-testid="event-name-input"]', eventData.name);
    await this.page.fill('[data-testid="owner-email-input"]', eventData.owner_email);

    // Select flow type
    await this.page.selectOption('[data-testid="flow-type-select"]', eventData.flow_type);

    // Clear default step if needed
    const removeButtons = await this.page.locator('button:has-text("Remove")').all();
    if (removeButtons.length > 0) {
      await removeButtons[0].click();
      await this.page.waitForTimeout(500); // Brief wait for removal
    }

    // Add each step
    for (let i = 0; i < eventData.steps.length; i++) {
      const step = eventData.steps[i];

      if (i > 0) {
        await this.page.click('[data-testid="add-step-button"]');
        await this.page.waitForTimeout(500); // Wait for new step to be added
      }

      // Fill step details using data-testid
      await this.page.fill(`[data-testid="step-${i}-name-input"]`, step.name);
      await this.page.fill(`[data-testid="step-${i}-email-input"]`, step.vendor_email);

      if (step.description) {
        await this.page.fill(`[data-testid="step-${i}-description-input"]`, step.description);
      }

      if (step.time_limit) {
        // Find the select within the step container and select time limit
        const stepContainer = this.page.locator('.border.border-gray-200').nth(i);
        const timeSelect = stepContainer.locator('select').first();

        // Wait for select to be visible
        await timeSelect.waitFor({ state: 'visible', timeout: 5000 });
        await timeSelect.selectOption(step.time_limit);
      }

      if (step.sequence && eventData.flow_type === 'hybrid') {
        await this.page.fill(`[data-testid="step-${i}-sequence-input"]`, step.sequence.toString());
      }
    }

    // Submit the form
    await this.page.click('[data-testid="create-event-button"]');

    // Wait for success modal
    await this.page.waitForSelector('text=Success!', { timeout: 15000 });

    // Extract event ID from the "View Event" button
    const viewEventButton = this.page.locator('button:has-text("View Event")');
    await viewEventButton.waitFor({ state: 'visible', timeout: 10000 });

    // Wait a moment for React hydration to complete
    await this.page.waitForTimeout(500);

    // Click to navigate and extract ID from URL (with navigation promise)
    await Promise.all([
      this.page.waitForURL(/\/event\/[a-f0-9-]+/, { timeout: 15000 }),
      viewEventButton.click()
    ]);

    const url = this.page.url();
    const eventId = url.split('/event/')[1];

    return eventId;
  }

  /**
   * Create an event via API
   */
  async createEventViaAPI(eventData: TestEvent): Promise<CreatedEvent> {
    const response = await this.page.request.post('http://localhost:3001/api/events', {
      data: eventData,
    });

    expect(response.ok()).toBeTruthy();
    const result = await response.json();
    expect(result.success).toBeTruthy();

    return result;
  }

  /**
   * Extract magic link token from email via MailHog
   *
   * This is the GOLD STANDARD approach for E2E testing:
   * - Tests exactly like production (via email)
   * - Validates email delivery works
   * - Catches email template bugs
   * - No coupling to storage implementation
   *
   * Requires MailHog running: docker run -d -p 1025:1025 -p 8025:8025 mailhog/mailhog
   *
   * @param eventIdOrEmail - Either event ID (legacy) or vendor email address
   * @param stepIndex - Step index (0-based) to get token for (when using event ID)
   */
  async getMagicToken(eventIdOrEmail: string, stepIndex: number = 0): Promise<string> {
    try {
      // Check if MailHog is available
      const isAvailable = await this.mailhog.isAvailable();
      if (!isAvailable) {
        throw new Error(
          'MailHog is not running! Start it with: docker run -d -p 1025:1025 -p 8025:8025 mailhog/mailhog'
        );
      }

      // Determine if parameter is email or event ID
      let vendorEmail: string;

      if (eventIdOrEmail.includes('@')) {
        // It's an email address - use directly
        vendorEmail = eventIdOrEmail;
      } else {
        // It's an event ID - get vendor email from event
        const event = await this.getEventDetails(eventIdOrEmail);

        // Find the next pending step or use step index
        const pendingSteps = event.steps.filter((s: any) => s.status === 'pending');

        if (pendingSteps.length === 0) {
          throw new Error(`No pending steps found for event ${eventIdOrEmail}`);
        }

        // Use the first pending step or the step at index
        const targetStep = pendingSteps[stepIndex] || pendingSteps[0];
        vendorEmail = targetStep.vendor_email;
      }

      // Wait for email to arrive and extract token
      console.log(`📧 Waiting for email to ${vendorEmail}...`);
      const token = await this.mailhog.waitForEmailAndExtractToken(vendorEmail, 10000);
      console.log(`✅ Got magic token from email for ${vendorEmail}`);

      return token;
    } catch (error) {
      console.error(`❌ Failed to get magic token from email:`, error);

      // Print debug info
      const messageCount = await this.mailhog.getMessageCount();
      console.log(`📧 MailHog currently has ${messageCount} messages`);

      if (messageCount > 0) {
        console.log('📧 All messages in MailHog:');
        await this.mailhog.printAllMessages();
      }

      throw error;
    }
  }

  /**
   * Complete a step via magic link
   */
  async completeStepWithMagicLink(token: string, files: string[] = [], comments: string = 'Test completion'): Promise<void> {
    await this.page.goto(`/complete/${token}`);

    // Wait for page to load
    await this.page.waitForSelector('text=Complete Your Task', { timeout: 10000 });

    // Upload files if provided
    if (files.length > 0) {
      const fileInput = this.page.locator('input[type="file"]');
      await fileInput.setInputFiles(files.map(f => path.join(__dirname, '../fixtures/files', f)));
    }

    // Add comments
    if (comments) {
      await this.page.fill('textarea', comments);
    }

    // Submit
    await this.page.click('button:has-text("Mark Step Complete")');

    // Wait for success modal
    await this.page.waitForSelector('text=Success!', { timeout: 15000 });
  }

  /**
   * Get event details via API
   */
  async getEventDetails(eventId: string): Promise<any> {
    const response = await this.page.request.get(`http://localhost:3001/api/events/${eventId}`);
    expect(response.ok()).toBeTruthy();
    return await response.json();
  }

  /**
   * Verify step status
   */
  async verifyStepStatus(eventId: string, stepIndex: number, expectedStatus: string): Promise<void> {
    const event = await this.getEventDetails(eventId);
    expect(event.steps[stepIndex].status).toBe(expectedStatus);
  }

  /**
   * Verify event completion
   */
  async verifyEventComplete(eventId: string): Promise<void> {
    const event = await this.getEventDetails(eventId);
    expect(event.status).toBe('completed');
    expect(event.progress).toBe(100);
    expect(event.completed_steps).toBe(event.total_steps);
  }

  /**
   * Clean up test data
   */
  static async cleanupTestData(eventId?: string): Promise<void> {
    if (eventId) {
      // Delete specific event
      const eventPath = path.join(__dirname, '../../data/events', `${eventId}.json`);
      if (fs.existsSync(eventPath)) {
        fs.unlinkSync(eventPath);
      }

      // Delete event's Git repo
      const repoPath = path.join(__dirname, '../../data/repos', eventId);
      if (fs.existsSync(repoPath)) {
        fs.rmSync(repoPath, { recursive: true, force: true });
      }

      // Delete uploaded files for this event
      const uploadsPath = path.join(__dirname, '../../data/uploads');
      if (fs.existsSync(uploadsPath)) {
        // Note: Files don't have event ID in name, so we can't selectively delete
        // In a real scenario, you'd track files by event ID
      }
    }

    // Clean up test magic tokens
    const tokensPath = path.join(__dirname, '../../data/magic_tokens.json');
    if (fs.existsSync(tokensPath)) {
      const tokensData = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));

      // Remove tokens for test emails
      const testEmails = ['@example.com', '@techconf.com', '@festival.com'];
      const filteredTokens = {};

      for (const [token, data] of Object.entries(tokensData.tokens)) {
        const tokenData = data as any;
        if (!testEmails.some(domain => tokenData.vendor_email?.includes(domain))) {
          filteredTokens[token] = data;
        }
      }

      fs.writeFileSync(tokensPath, JSON.stringify({ tokens: filteredTokens }, null, 2));
    }
  }

  /**
   * Wait for email to be sent (mock check)
   * Note: SMTP errors are expected in test environment and don't fail the event creation
   */
  async waitForEmail(recipientEmail: string, timeout: number = 2000): Promise<void> {
    // In a real scenario, you'd check email delivery via test SMTP (like Ethereal Email)
    // For now, we'll just wait a bit to ensure async email sending completes
    // Email failures are logged but don't stop the workflow
    await this.page.waitForTimeout(timeout);
  }

  /**
   * Verify stats updated
   */
  async verifyStatsUpdated(expectedTotalEvents: number, expectedCompletedEvents: number): Promise<void> {
    const response = await this.page.request.get('http://localhost:3001/api/stats');
    expect(response.ok()).toBeTruthy();

    const stats = await response.json();
    expect(stats.current_metrics.total_events).toBeGreaterThanOrEqual(expectedTotalEvents);
    expect(stats.current_metrics.completed_events).toBeGreaterThanOrEqual(expectedCompletedEvents);
  }

  /**
   * Navigate to event page and verify display
   */
  async navigateToEventPage(eventId: string): Promise<void> {
    await this.page.goto(`/event/${eventId}`);
    await this.page.waitForSelector('h1', { timeout: 5000 });
  }

  /**
   * Request management link
   */
  async requestManagementLink(ownerEmail: string): Promise<void> {
    await this.page.goto('/');

    // Find and fill the "Edit Existing Event" section
    await this.page.fill('input[type="email"][placeholder="planner@email.com"]', ownerEmail);
    await this.page.click('button:has-text("Send Management Link")');

    // Wait for success modal
    await this.page.waitForSelector('text=Success!', { timeout: 10000 });
  }
}
