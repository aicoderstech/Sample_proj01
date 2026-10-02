// AI try-on panel, with a stand-in model (?ai=mock): the real models run on
// Hugging Face's shared GPUs and are not called from the tests.
import { expect, test } from '@playwright/test';
import { PERSON_PHOTO, requirePersonFixture, studioState, trackErrors } from './helpers.js';

test.describe('studio · AI try-on', () => {
  test.beforeEach(async ({ page }) => {
    requirePersonFixture();
    await page.goto('/studio.html?ai=mock&garment=garments/tee-coral.svg');
    await page.locator('#photo-input').setInputFiles(PERSON_PHOTO);
    await expect.poll(async () => (await studioState(page)).garmentDrawn, { timeout: 45_000 }).toBe(true);
  });

  test('sends nothing without consent, then shows the AI result over the quick fit', async ({ page }) => {
    const errors = trackErrors(page);
    const run = page.locator('#ai-run');
    await expect(run).toBeDisabled();
    await expect(page.locator('#ai-status')).toContainText('Tick the box');
    await page.locator('#ai-consent').check();
    await expect(run).toBeEnabled();
    // Every model that handles tops is offered.
    await expect(page.locator('#ai-model option')).toHaveText(['Best available', 'Leffa', 'CatVTON', 'IDM-VTON', 'Kolors Virtual Try-On']);
    await run.click();
    await expect(page.locator('#ai-status')).toContainText(/Waiting for Leffa|drawing you/);
    await expect(page.locator('#ai-result')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#ai-status')).toContainText('Made by Leffa');
    const size = await page.locator('#ai-result').evaluate((img) => ({ w: img.naturalWidth, h: img.naturalHeight }));
    expect(size.w).toBeGreaterThan(100);
    // Switch between the AI result and the quick fit.
    const toggle = page.locator('#ai-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await toggle.click();
    await expect(page.locator('#ai-result')).toBeHidden();
    await toggle.click();
    await expect(page.locator('#ai-result')).toBeVisible();
    // A snapshot saves the AI picture.
    await page.locator('#snapshot').click();
    await expect(page.locator('#snapshots a')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('drops the result when the garment changes, and offers the models for that garment', async ({ page }) => {
    await page.locator('#ai-consent').check();
    await page.locator('#ai-run').click();
    await expect(page.locator('#ai-result')).toBeVisible({ timeout: 15_000 });
    await page.locator('[data-garment-id="jeans-indigo"]').click();
    await expect(page.locator('#ai-result')).toBeHidden();
    await expect(page.locator('#ai-toggle')).toBeHidden();
    await expect(page.locator('#ai-model option')).toHaveText(['Best available', 'Leffa', 'CatVTON']);
  });

  test('can be cancelled', async ({ page }) => {
    await page.locator('#ai-consent').check();
    await page.locator('#ai-run').click();
    await page.locator('#ai-cancel').click();
    await expect(page.locator('#ai-status')).toHaveText('Cancelled.');
    await expect(page.locator('#ai-result')).toBeHidden();
    await expect(page.locator('#ai-run')).toBeEnabled();
  });
});
