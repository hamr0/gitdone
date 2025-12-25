import { test, expect } from '@playwright/test';
import { TestUtils } from '../helpers/test-utils';

test.describe('Magic Link Error Scenarios', () => {
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

  test('should reject access with already-used token', async ({ page }) => {
    const eventData = TestUtils.loadEventFixture('sequential-wedding');
    const result = await utils.createEventViaAPI(eventData);
    createdEventId = result.eventId;

    // Get token and use it
    const token = await utils.getMagicToken(createdEventId, 0);
    await utils.completeStepWithMagicLink(token, [], 'First use');

    // Try to use the same token again
    await page.goto(`/complete/${token}`);

    // Should show access denied error
    await expect(page.locator('text=Access Denied')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=already used')).toBeVisible();
  });

  test('should reject access with malformed token', async ({ page }) => {
    await page.goto('/complete/invalid-malformed-token-12345');

    // Should show access denied error
    await expect(page.locator('text=Access Denied')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Invalid')).toBeVisible();
  });

  test('should reject access with non-existent token', async ({ page }) => {
    // Generate a JWT-like token that doesn't exist in database
    const fakeToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

    await page.goto(`/complete/${fakeToken}`);

    // Should show access denied error
    await expect(page.locator('text=Access Denied')).toBeVisible({ timeout: 5000 });
  });

  test('should reject submission without files and without comments', async ({ page }) => {
    const eventData = TestUtils.loadEventFixture('sequential-wedding');
    const result = await utils.createEventViaAPI(eventData);
    createdEventId = result.eventId;

    const token = await utils.getMagicToken(createdEventId, 0);
    await page.goto(`/complete/${token}`);

    // Wait for page load
    await page.waitForSelector('text=Complete Your Task');

    // Try to submit without adding files or comments
    await page.click('button:has-text("Mark Step Complete")');

    // Should show error
    await expect(page.locator('text=upload files or add comments')).toBeVisible({ timeout: 3000 });
  });

  test('should prevent double submission with same token', async ({ page }) => {
    const eventData = TestUtils.loadEventFixture('sequential-wedding');
    const result = await utils.createEventViaAPI(eventData);
    createdEventId = result.eventId;

    const token = await utils.getMagicToken(createdEventId, 0);
    await page.goto(`/complete/${token}`);

    await page.waitForSelector('text=Complete Your Task');

    // Add comments
    await page.fill('textarea', 'Test completion');

    // Click submit button
    await page.click('button:has-text("Mark Step Complete")');

    // Wait for first submission to complete
    await page.waitForSelector('text=Success!', { timeout: 15000 });

    // Close modal and try to submit again by clicking button again
    // (button should be disabled after submission)
    const submitButton = page.locator('button:has-text("Submitted")');
    await expect(submitButton).toBeDisabled();
  });

  test('should handle network error during submission gracefully', async ({ page }) => {
    const eventData = TestUtils.loadEventFixture('sequential-wedding');
    const result = await utils.createEventViaAPI(eventData);
    createdEventId = result.eventId;

    const token = await utils.getMagicToken(createdEventId, 0);
    await page.goto(`/complete/${token}`);

    await page.waitForSelector('text=Complete Your Task');

    // Simulate network failure
    await page.route('**/api/complete/**', route => route.abort());

    // Try to submit
    await page.fill('textarea', 'Test with network error');
    await page.click('button:has-text("Mark Step Complete")');

    // Should show error message (not crash)
    await expect(page.locator('text=Error')).toBeVisible({ timeout: 5000 });
  });

  test('should validate file size limit (25MB)', async ({ page }) => {
    // Note: This test requires a large file fixture
    // For now, we'll just verify the UI shows the limit
    const eventData = TestUtils.loadEventFixture('sequential-wedding');
    const result = await utils.createEventViaAPI(eventData);
    createdEventId = result.eventId;

    const token = await utils.getMagicToken(createdEventId, 0);
    await page.goto(`/complete/${token}`);

    // Verify file size limit is displayed
    await expect(page.locator('text=Max 25MB')).toBeVisible();
  });
});
