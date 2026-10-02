// Photo mode with the real MediaPipe body tracker on a real photo.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { countPixels, ODD_WIDTH_PHOTO, PERSON_PHOTO, requireOddWidthFixture, requirePersonFixture, sampleCanvas, studioState, trackErrors } from './helpers.js';

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
    // Photos use the accurate pose model, and the fit engine measures the
    // person's outline from the segmentation mask.
    expect(s.model).toBe('full');
    expect(s.hasMask).toBe(true);
    expect(s.engine).toBe('v2');

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
    // Wider and longer; the armholes stay near the armpits, so not quite 1.4 x 1.4.
    await expect.poll(() => countPixels(page, CORAL)).toBeGreaterThan(before * 1.35);

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

  test('fits every garment on a photo whose width is not a multiple of 4', async ({ page }) => {
    // MediaPipe's segmentation used to abort ("Check failed: 1 == ChannelSize()")
    // on such images, killing body tracking for the rest of the session.
    requireOddWidthFixture();
    const errors = trackErrors(page);
    await page.locator('#photo-input').setInputFiles(ODD_WIDTH_PHOTO);
    await expect.poll(async () => (await studioState(page)).garmentDrawn, { timeout: 45_000 }).toBe(true);
    const s = await studioState(page);
    expect(s.canvas.width % 4).not.toBe(0);
    expect(s.hasMask).toBe(true);
    for (const id of ['hoodie-grey', 'sundress-sage', 'jeans-indigo']) {
      await page.locator(`[data-garment-id="${id}"]`).click();
      await expect.poll(async () => (await studioState(page)).garment?.name).toBeTruthy();
      await expect.poll(async () => (await studioState(page)).garmentDrawn).toBe(true);
      // The garment sits on the person: >= 95% of its fabric above the hips
      // lies on the segmentation mask, and it covers the torso.
      const report = await page.evaluate(() => window.__mirrorfit.fitReport());
      expect(report.onBody.torso).toBeGreaterThanOrEqual(95);
      expect(report.coverage).toBeGreaterThanOrEqual(95);
    }
    expect(errors).toEqual([]);

    // And the first photo still works afterwards.
    await page.locator('#photo-input').setInputFiles(PERSON_PHOTO);
    await expect.poll(async () => (await studioState(page)).canvas.width).toBe(1000);
    await expect.poll(async () => (await studioState(page)).garmentDrawn, { timeout: 45_000 }).toBe(true);
  });

  test('parses clothes and skin, and recommends a size from the height', async ({ page }) => {
    const errors = trackErrors(page);
    await uploadPhoto(page);
    await expect.poll(async () => (await studioState(page)).hasParsing, { timeout: 60_000 }).toBe(true);
    const s = await studioState(page);
    // Labels: clothes and skin both found on this person.
    expect(s.parsingCounts[4]).toBeGreaterThan(5000);
    expect(s.parsingCounts[2] + s.parsingCounts[3]).toBeGreaterThan(2000);
    expect(s.light).not.toBeNull();
    // The garment is matched to the photo's tone, tint and grain.
    expect(s.look.gain).toHaveLength(3);
    expect(s.look.sat).toBeGreaterThan(0.5);
    expect(s.look.grain).toBeGreaterThanOrEqual(0);
    // Without a height the size is rough; with it, measured from stature.
    await expect.poll(async () => (await studioState(page)).sizing?.scale.method).toBe('shoulders');
    await page.locator('#height-cm').fill('178');
    await page.locator('#height-cm').dispatchEvent('change');
    await expect.poll(async () => (await studioState(page)).sizing?.scale.method).toBe('stature');
    const sizing = (await studioState(page)).sizing;
    expect(['S', 'M', 'L', 'XL']).toContain(sizing.size);
    expect(sizing.measures.chest).toBeGreaterThan(70);
    expect(sizing.measures.chest).toBeLessThan(130);
    await expect(page.locator('#size-advice')).toContainText(`Recommended size: ${sizing.size}`);
    // A bigger size is drawn bigger.
    await page.locator('#size-chips button[data-size="XS"]').click();
    await expect(page.locator('#size-advice')).toContainText('Showing size XS');
    await page.waitForTimeout(300);
    const small = await countPixels(page, CORAL);
    await page.locator('#size-chips button[data-size="XXL"]').click();
    await expect.poll(() => countPixels(page, CORAL)).toBeGreaterThan(small * 1.15);
    expect(errors).toEqual([]);
  });

  test('reports when there is no person in the photo', async ({ page }) => {
    // A product photo of a skirt: no person in it.
    await page.locator('#photo-input').setInputFiles('public/garments/pleated-skirt.svg');
    await expect(page.locator('#status')).toHaveAttribute('data-tone', 'error', { timeout: 45_000 });
    await expect(page.locator('#status')).toContainText('No person found');
  });
});
