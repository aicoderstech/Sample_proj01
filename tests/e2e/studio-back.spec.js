// Seen from behind (synthetic person from the mock tracker): the studio
// detects the back view and draws the garment's generated back.
import { expect, test } from '@playwright/test';
import { PERSON_PHOTO, requirePersonFixture, studioState, trackErrors } from './helpers.js';

test('draws the back of the garment for a person seen from behind', async ({ page }) => {
  requirePersonFixture();
  const errors = trackErrors(page);
  for (const view of ['front', 'back']) {
    await page.goto(`/studio.html?pose=mock&view=${view}&parsing=0&garment=garments/tee-graphic.svg`);
    await page.locator('#photo-input').setInputFiles(PERSON_PHOTO);
    await expect.poll(async () => (await studioState(page)).garmentDrawn, { timeout: 45_000 }).toBe(true);
    expect((await studioState(page)).facing).toBe(view);
  }
  expect(errors).toEqual([]);
});
