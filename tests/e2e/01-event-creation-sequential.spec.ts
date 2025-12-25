import { test, expect } from '@playwright/test';
import { TestUtils } from '../helpers/test-utils';

test.describe('Sequential Flow Event Creation', () => {
  let utils: TestUtils;
  let createdEventId: string;

  test.beforeEach(async ({ page }) => {
    utils = new TestUtils(page);
  });

  test.afterEach(async () => {
    if (createdEventId) {
      await TestUtils.cleanupTestData(createdEventId);
    }
  });

  test('should create sequential event with valid data', async ({ page }) => {
    const eventData = TestUtils.loadEventFixture('sequential-wedding');

    // Create event via UI
    createdEventId = await utils.createEventViaUI(eventData);

    // Verify event was created
    expect(createdEventId).toBeTruthy();
    expect(createdEventId).toMatch(/^[a-f0-9-]+$/);

    // Verify we're on the event page
    await expect(page).toHaveURL(`/event/${createdEventId}`);
    await expect(page.locator('h1')).toContainText(eventData.name);
  });

  test('should send magic link only to first vendor in sequential flow', async ({ page }) => {
    const eventData = TestUtils.loadEventFixture('sequential-wedding');

    // Create event via API for faster execution
    const result = await utils.createEventViaAPI(eventData);
    createdEventId = result.eventId;

    // Verify only one magic link was sent (to first vendor)
    expect(result.magic_links_sent).toHaveLength(1);
    expect(result.magic_links_sent[0].vendor_email).toBe(eventData.steps[0].vendor_email);
    expect(result.magic_links_sent[0].success).toBeTruthy();
  });

  test('should display event in stats after creation', async ({ page }) => {
    const eventData = TestUtils.loadEventFixture('sequential-wedding');

    const result = await utils.createEventViaAPI(eventData);
    createdEventId = result.eventId;

    // Verify stats include the new event
    await utils.verifyStatsUpdated(1, 0);
  });

  test('should show error when creating event without name', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Try to create without filling name
    await page.fill('[data-testid="owner-email-input"]', 'test@example.com');

    // Fill in step details
    await page.fill('[data-testid="step-0-name-input"]', 'Test Step');
    await page.fill('[data-testid="step-0-email-input"]', 'vendor@example.com');

    await page.click('[data-testid="create-event-button"]');

    // Should show error modal with specific error message
    await expect(page.locator('text=Error')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('p.text-gray-700:has-text("event name")')).toBeVisible();
  });

  test('should show error when creating event without owner email', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.fill('[data-testid="event-name-input"]', 'Test Event');
    // Don't fill owner email

    // Fill in step details
    await page.fill('[data-testid="step-0-name-input"]', 'Test Step');
    await page.fill('[data-testid="step-0-email-input"]', 'vendor@example.com');

    await page.click('[data-testid="create-event-button"]');

    // Should show error modal with specific error message
    await expect(page.locator('text=Error')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('p.text-gray-700:has-text("your email")')).toBeVisible();
  });

  test('should show error when creating event without steps', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.fill('[data-testid="event-name-input"]', 'Test Event');
    await page.fill('[data-testid="owner-email-input"]', 'test@example.com');

    // Remove all steps
    const removeButtons = await page.locator('button:has-text("Remove")').all();
    for (const button of removeButtons) {
      await button.click();
      await page.waitForTimeout(300);
    }

    await page.click('[data-testid="create-event-button"]');

    // Should show error modal with specific error message
    await expect(page.locator('text=Error')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('p.text-gray-700:has-text("step")')).toBeVisible();
  });

  test('should create event and navigate to event view page', async ({ page }) => {
    const eventData = TestUtils.loadEventFixture('sequential-wedding');

    createdEventId = await utils.createEventViaUI(eventData);

    // Verify event page elements
    await expect(page.locator('h1')).toContainText(eventData.name);
    await expect(page.locator('text=Sequential Flow')).toBeVisible();
    await expect(page.locator('text=Progress')).toBeVisible();

    // Verify all steps are listed
    for (const step of eventData.steps) {
      await expect(page.locator(`text=${step.name}`)).toBeVisible();
    }
  });

  test('should display correct initial progress (0%)', async ({ page }) => {
    const eventData = TestUtils.loadEventFixture('sequential-wedding');
    const result = await utils.createEventViaAPI(eventData);
    createdEventId = result.eventId;

    await utils.navigateToEventPage(createdEventId);

    // Verify progress is 0%
    await expect(page.locator('text=0% complete')).toBeVisible();
    await expect(page.locator('text=0 of 3 steps completed')).toBeVisible();
  });
});
