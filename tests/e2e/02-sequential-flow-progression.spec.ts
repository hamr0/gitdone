import { test, expect } from '@playwright/test';
import { TestUtils } from '../helpers/test-utils';

test.describe('Sequential Flow Progression', () => {
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

  test('should complete steps in sequence and trigger next step', async ({ page }) => {
    const eventData = TestUtils.loadEventFixture('sequential-wedding');

    // Create event
    const result = await utils.createEventViaAPI(eventData);
    createdEventId = result.eventId;

    // Step 1: Complete first vendor's task
    const token1 = await utils.getMagicToken(createdEventId, 0);
    await utils.completeStepWithMagicLink(token1, [], 'Venue setup completed!');

    // Verify first step is completed
    await utils.verifyStepStatus(createdEventId, 0, 'completed');

    // Verify progress updated
    const eventAfterStep1 = await utils.getEventDetails(createdEventId);
    expect(eventAfterStep1.progress).toBeGreaterThan(0);
    expect(eventAfterStep1.completed_steps).toBe(1);

    // Step 2: Complete second vendor's task
    const token2 = await utils.getMagicToken(createdEventId, 0); // Get next available token
    await utils.completeStepWithMagicLink(token2, [], 'Catering ready!');

    // Verify second step is completed
    await utils.verifyStepStatus(createdEventId, 1, 'completed');

    // Step 3: Complete final vendor's task
    const token3 = await utils.getMagicToken(createdEventId, 0);
    await utils.completeStepWithMagicLink(token3, [], 'Photography setup done!');

    // Verify all steps completed
    await utils.verifyStepStatus(createdEventId, 2, 'completed');

    // Verify event is marked as completed
    await utils.verifyEventComplete(createdEventId);
  });

  test('should show correct progress after each step completion', async ({ page }) => {
    const eventData = TestUtils.loadEventFixture('sequential-wedding');
    const result = await utils.createEventViaAPI(eventData);
    createdEventId = result.eventId;

    // Complete first step
    const token1 = await utils.getMagicToken(createdEventId, 0);
    await utils.completeStepWithMagicLink(token1, [], 'Step 1 done');

    // Check progress
    await utils.navigateToEventPage(createdEventId);
    await expect(page.locator('text=33% complete')).toBeVisible();
    await expect(page.locator('text=1 of 3 steps completed')).toBeVisible();

    // Complete second step
    const token2 = await utils.getMagicToken(createdEventId, 0);
    await utils.completeStepWithMagicLink(token2, [], 'Step 2 done');

    // Check progress again
    await page.reload();
    await expect(page.locator('text=67% complete')).toBeVisible();
    await expect(page.locator('text=2 of 3 steps completed')).toBeVisible();

    // Complete final step
    const token3 = await utils.getMagicToken(createdEventId, 0);
    await utils.completeStepWithMagicLink(token3, [], 'Step 3 done');

    // Verify 100% complete
    await page.reload();
    await expect(page.locator('text=100% complete')).toBeVisible();
    await expect(page.locator('text=3 of 3 steps completed')).toBeVisible();
  });

  test('should create Git commits for each step completion', async ({ page }) => {
    const eventData = TestUtils.loadEventFixture('sequential-wedding');
    const result = await utils.createEventViaAPI(eventData);
    createdEventId = result.eventId;

    // Complete first step
    const token1 = await utils.getMagicToken(createdEventId, 0);
    await utils.completeStepWithMagicLink(token1, [], 'Git commit test');

    // Verify commit was created
    const event = await utils.getEventDetails(createdEventId);
    expect(event.commits).toHaveLength(1);
    expect(event.commits[0].comments).toBe('Git commit test');
    expect(event.commits[0].vendor_email).toBe(eventData.steps[0].vendor_email);
    expect(event.commits[0].commit_hash).toBeTruthy();
  });

  test('should display completed steps with checkmarks', async ({ page }) => {
    const eventData = TestUtils.loadEventFixture('sequential-wedding');
    const result = await utils.createEventViaAPI(eventData);
    createdEventId = result.eventId;

    // Complete first step
    const token1 = await utils.getMagicToken(createdEventId, 0);
    await utils.completeStepWithMagicLink(token1, [], 'Done');

    // Navigate to event page
    await utils.navigateToEventPage(createdEventId);

    // Verify first step shows as completed
    const firstStepContainer = page.locator('.border').first();
    await expect(firstStepContainer.locator('text=completed')).toBeVisible();

    // Verify subsequent steps still show as pending
    await expect(page.locator('text=pending').first()).toBeVisible();
  });

  test('should send completion email when all steps done', async ({ page }) => {
    const eventData = TestUtils.loadEventFixture('sequential-wedding');
    const result = await utils.createEventViaAPI(eventData);
    createdEventId = result.eventId;

    // Complete all steps
    for (let i = 0; i < eventData.steps.length; i++) {
      const token = await utils.getMagicToken(createdEventId, 0);
      await utils.completeStepWithMagicLink(token, [], `Step ${i + 1} completed`);
    }

    // Wait for completion email to be sent
    await utils.waitForEmail(eventData.owner_email);

    // Verify event is complete
    await utils.verifyEventComplete(createdEventId);
  });

  test('should update stats after event completion', async ({ page }) => {
    const eventData = TestUtils.loadEventFixture('sequential-wedding');
    const result = await utils.createEventViaAPI(eventData);
    createdEventId = result.eventId;

    // Complete all steps
    for (let i = 0; i < eventData.steps.length; i++) {
      const token = await utils.getMagicToken(createdEventId, 0);
      await utils.completeStepWithMagicLink(token, [], `Completed ${i + 1}`);
    }

    // Verify stats show completed event
    await utils.verifyStatsUpdated(1, 1);
  });
});
