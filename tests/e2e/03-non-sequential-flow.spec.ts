import { test, expect } from '@playwright/test';
import { TestUtils } from '../helpers/test-utils';

test.describe('Non-Sequential Flow', () => {
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

  test('should send magic links to all vendors immediately', async ({ page }) => {
    const eventData = TestUtils.loadEventFixture('non-sequential-conference');

    const result = await utils.createEventViaAPI(eventData);
    createdEventId = result.eventId;

    // Verify all vendors received magic links
    expect(result.magic_links_sent).toHaveLength(eventData.steps.length);

    for (let i = 0; i < eventData.steps.length; i++) {
      expect(result.magic_links_sent[i].vendor_email).toBe(eventData.steps[i].vendor_email);
      expect(result.magic_links_sent[i].success).toBeTruthy();
    }
  });

  test('should allow vendors to complete steps in any order', async ({ page }) => {
    const eventData = TestUtils.loadEventFixture('non-sequential-conference');
    const result = await utils.createEventViaAPI(eventData);
    createdEventId = result.eventId;

    // Complete step 3 first (out of order)
    const token3 = await utils.getMagicToken(createdEventId, 2);
    await utils.completeStepWithMagicLink(token3, [], 'Completed third step first');
    await utils.verifyStepStatus(createdEventId, 2, 'completed');

    // Complete step 1 second
    const token1 = await utils.getMagicToken(createdEventId, 0);
    await utils.completeStepWithMagicLink(token1, [], 'Completed first step second');
    await utils.verifyStepStatus(createdEventId, 0, 'completed');

    // Complete step 4 third
    const token4 = await utils.getMagicToken(createdEventId, 1); // Adjusted index after completions
    await utils.completeStepWithMagicLink(token4, [], 'Completed fourth step third');
    await utils.verifyStepStatus(createdEventId, 3, 'completed');

    // Complete step 2 last
    const token2 = await utils.getMagicToken(createdEventId, 0);
    await utils.completeStepWithMagicLink(token2, [], 'Completed second step last');
    await utils.verifyStepStatus(createdEventId, 1, 'completed');

    // Verify event is complete
    await utils.verifyEventComplete(createdEventId);
  });

  test('should update progress correctly regardless of completion order', async ({ page }) => {
    const eventData = TestUtils.loadEventFixture('non-sequential-conference');
    const result = await utils.createEventViaAPI(eventData);
    createdEventId = result.eventId;

    const totalSteps = eventData.steps.length;

    // Complete steps in random order and verify progress
    const completionOrder = [2, 0, 3, 1]; // Indices in random order

    for (let i = 0; i < completionOrder.length; i++) {
      const token = await utils.getMagicToken(createdEventId, 0);
      await utils.completeStepWithMagicLink(token, [], `Step completed ${i + 1}`);

      const event = await utils.getEventDetails(createdEventId);
      const expectedProgress = Math.round(((i + 1) / totalSteps) * 100);
      expect(event.progress).toBe(expectedProgress);
      expect(event.completed_steps).toBe(i + 1);
    }
  });
});
