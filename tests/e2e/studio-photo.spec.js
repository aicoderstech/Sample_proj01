// Photo mode with the real MediaPipe body tracker on a real photo.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { countPixels, PERSON_PHOTO, requirePersonFixture, sampleCanvas, studioState, trackErrors } from './helpers.js';

const CORAL = 'r > 200 && g > 70 && g < 150 && b < 130 && r - g > 90';

async function uploadPhoto(page) {
  await page.locator('#photo-input').setInputFiles(PERSON_PHOTO);
  await expect.poll(async () => (await studioState(page)).garmentDrawn, { timeout: 45_000 }).toBe(true);
}

/** Torso point between shoulders and hips (canvas pixels). */
async function torsoPoint(page) {
  const { points } = await studioState(page);
  return {
    x: (points[11].x + points[12].x + points[23].x + points[24].x) / 4,
    y: (points[11].y + points[12].y) * 0.3 + (points[23].y + points[24].y) * 0.2,
  };
}

test.describe('studio · photo mode (real body tracking)', () => {
  test.beforeEach(async ({ page }) => {
    requirePersonFixture();
    await page.goto('/studio.html');
  });

  test('finds the person and dresses them', async ({ page }) => {
    const errors = trackErrors(page);
    await uploadPhoto(page);
    const s = await studioState(page);
    expect(s.source).toBe('photo');
    expect(['GPU', 'CPU']).toContain(s.backend);
    expect(s.webgl).toBe(true);
    expect(s.canvas).toEqual({ width: 1000, height: 667 });

    // Plausible anatomy: shoulders above hips, person's left shoulder on the image right.
    const p = s.points;
    expect(p[11].x).toBeGreaterThan(p[12].x);
    expect(p[23].y).toBeGreaterThan(p[11].y + 60);
    for (const i of [11, 12, 23, 24]) expect(p[i].v).toBeGreaterThan(0.5);

    // The default coral T-shirt is drawn over the torso.
    const [r, g, b] = await sampleCanvas(page, ...Object.values(await torsoPoint(page)));
    expect(r - g).toBeGreaterThan(70);
    expect(r - b).toBeGreaterThan(90);
    await expect(page.locator('#status')).toHaveAttribute('data-tone', 'ok');
    await expect(page.locator('#garment-info')).toHaveText('Coral Crew Tee · top');
    expect(errors).toEqual([]);
  });

  test('switches garments and removes product-photo backgrounds', async ({ page }) => {
    await uploadPhoto(page);
    await page.locator('[data-garment-id="sundress-sage"]').click();
    await expect(page.locator('#garment-info')).toContainText('Sage Sundress · dress');
    await expect(page.locator('[data-garment-id="sundress-sage"]')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => {
      const [r, g] = await sampleCanvas(page, ...Object.values(await torsoPoint(page)));
      return g - r;
    }).toBeGreaterThan(10);

    // The oxford shirt sample is a product shot on a white background.
    await page.locator('[data-garment-id="oxford-shirt"]').click();
    await expect(page.locator('#garment-info')).toHaveText('Oxford Shirt · top · background removed');
    await page.locator('#opt-bg').uncheck();
    await expect(page.locator('#garment-info')).toHaveText('Oxford Shirt · top');
    expect((await studioState(page)).garment.backgroundRemoved).toBe(false);
  });

  test('size slider and garment type change the fit', async ({ page }) => {
    await uploadPhoto(page);
    const before = await countPixels(page, CORAL);
    expect(before).toBeGreaterThan(3000);
    await page.locator('#fit-size').fill('1.4');
    await expect(page.locator('#fit-size + output')).toHaveText('140%');
    await expect.poll(() => countPixels(page, CORAL)).toBeGreaterThan(before * 1.5);

    await page.locator('#reset-fit').click();
    await expect(page.locator('#fit-size + output')).toHaveText('100%');

    await page.locator('#garment-type').selectOption('dress');
    await expect.poll(async () => (await studioState(page)).garment.type).toBe('dress');
    await expect(page.locator('#garment-info')).toContainText('dress');
  });

  test('takes a downloadable snapshot', async ({ page }) => {
    await uploadPhoto(page);
    await page.locator('#snapshot').click();
    const link = page.locator('#snapshots a').first();
    await expect(link).toHaveAttribute('download', /^mirrorfit-.*\.png$/);
    const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
    const file = readFileSync(await download.path());
    expect(file.subarray(1, 4).toString()).toBe('PNG');
    expect(file.length).toBeGreaterThan(50_000);
  });

  test('reports when there is no person in the photo', async ({ page }) => {
    // A product photo of a skirt: no person in it.
    await page.locator('#photo-input').setInputFiles('public/garments/pleated-skirt.svg');
    await expect(page.locator('#status')).toHaveAttribute('data-tone', 'error', { timeout: 45_000 });
    await expect(page.locator('#status')).toContainText('No person found');
  });
});
