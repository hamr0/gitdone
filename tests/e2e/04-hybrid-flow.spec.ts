import { test, expect } from '@playwright/test';
import { TestUtils } from '../helpers/test-utils';

test.describe('Hybrid Flow with Custom Sequences', () => {
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

  test('should send magic links only to sequence=1 vendors initially', async ({ page }) => {
    const eventData = TestUtils.loadEventFixture('hybrid-festival');

    const result = await utils.createEventViaAPI(eventData);
    createdEventId = result.eventId;

    // Count how many steps have sequence = 1
    const sequence1Count = eventData.steps.filter(s => s.sequence === 1).length;

    // Verify only sequence=1 vendors received magic links
    expect(result.magic_links_sent).toHaveLength(sequence1Count);
  });

  test('should trigger sequence=2 only after all sequence=1 complete', async ({ page }) => {
    const eventData = TestUtils.loadEventFixture('hybrid-festival');
    const result = await utils.createEventViaAPI(eventData);
    createdEventId = result.eventId;

    // Complete first sequence=1 step
    const token1 = await utils.getMagicToken(createdEventId, 0);
    await utils.completeStepWithMagicLink(token1, [], 'Main stage done');
    await utils.verifyStepStatus(createdEventId, 0, 'completed');

    // At this point, sequence=2 vendors should NOT have tokens yet
    let event = await utils.getEventDetails(createdEventId);
    const sequence2Steps = event.steps.filter(s => s.sequence === 2);
    for (const step of sequence2Steps) {
      expect(step.status).toBe('pending');
    }

    // Complete second sequence=1 step
    const token2 = await utils.getMagicToken(createdEventId, 0);
    await utils.completeStepWithMagicLink(token2, [], 'Secondary stage done');
    await utils.verifyStepStatus(createdEventId, 1, 'completed');

    // Now sequence=2 vendors should have received tokens
    // (Verified by being able to access magic links for sequence=2 steps)
    event = await utils.getEventDetails(createdEventId);

    // Complete sequence=2 steps
    const token3 = await utils.getMagicToken(createdEventId, 0);
    await utils.completeStepWithMagicLink(token3, [], 'Sound system 1 done');

    const token4 = await utils.getMagicToken(createdEventId, 0);
    await utils.completeStepWithMagicLink(token4, [], 'Sound system 2 done');

    // Complete sequence=3
    const token5 = await utils.getMagicToken(createdEventId, 0);
    await utils.completeStepWithMagicLink(token5, [], 'Lighting done');

    // Complete sequence=4
    const token6 = await utils.getMagicToken(createdEventId, 0);
    await utils.completeStepWithMagicLink(token6, [], 'Sound check done');

    // Verify event complete
    await utils.verifyEventComplete(createdEventId);
  });

  test('should handle multiple vendors at same sequence level', async ({ page }) => {
    const eventData = TestUtils.loadEventFixture('hybrid-festival');
    const result = await utils.createEventViaAPI(eventData);
    createdEventId = result.eventId;

    // Complete both sequence=1 steps (in any order)
    const token1 = await utils.getMagicToken(createdEventId, 0);
    await utils.completeStepWithMagicLink(token1, [], 'First seq1 done');

    const token2 = await utils.getMagicToken(createdEventId, 0);
    await utils.completeStepWithMagicLink(token2, [], 'Second seq1 done');

    // Now both sequence=2 vendors should be able to work
    // Complete sequence=2 steps in reverse order
    const token4 = await utils.getMagicToken(createdEventId, 1); // Second seq2 step
    await utils.completeStepWithMagicLink(token4, [], 'Second seq2 done first');

    const token3 = await utils.getMagicToken(createdEventId, 0); // First seq2 step
    await utils.completeStepWithMagicLink(token3, [], 'First seq2 done second');

    // Verify both completed
    const event = await utils.getEventDetails(createdEventId);
    const sequence2Steps = event.steps.filter(s => s.sequence === 2);
    for (const step of sequence2Steps) {
      expect(step.status).toBe('completed');
    }
  });
});
