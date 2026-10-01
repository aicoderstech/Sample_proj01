// Live camera mode: Chromium's fake camera plays a video of a real person
// (tests/.fixtures/person.y4m) and the real MediaPipe tracker follows them.
import { expect, test } from '@playwright/test';
import { requirePersonFixture, sampleCanvas, studioState, trackErrors } from './helpers.js';

test.describe('studio · live camera (real body tracking)', () => {
  test('tracks the person live and keeps rendering', async ({ page }) => {
    requirePersonFixture();
    const errors = trackErrors(page);
    await page.goto('/studio.html');
    await page.getByRole('button', { name: 'Start camera' }).click();

    await expect.poll(async () => (await studioState(page)).poseFrames, { timeout: 45_000 }).toBeGreaterThan(10);
    await expect(page.locator('#status')).toContainText(/^Live · \d+ fps$/);
    const s = await studioState(page);
    expect(s.source).toBe('camera');
    expect(s.mirror).toBe(true);
    expect(s.garmentDrawn).toBe(true);
    expect(s.canvas).toEqual({ width: 640, height: 480 });
    await expect(page.locator('#empty-state')).toBeHidden();

    // Frames keep coming.
    const frames = s.framesRendered;
    await expect.poll(async () => (await studioState(page)).framesRendered).toBeGreaterThan(frames + 5);

    // The canvas is mirrored, so the torso appears at (width - x).
    const p = (await studioState(page)).points;
    const x = 640 - (p[11].x + p[12].x + p[23].x + p[24].x) / 4;
    const y = (p[11].y + p[12].y) * 0.3 + (p[23].y + p[24].y) * 0.2;
    const [r, g, b] = await sampleCanvas(page, x, y);
    expect(r - g).toBeGreaterThan(60);
    expect(r - b).toBeGreaterThan(80);

    // Turning the mirror off flips the view.
    await page.locator('#toggle-mirror').click();
    await expect(page.locator('#toggle-mirror')).toHaveAttribute('aria-pressed', 'false');
    expect((await studioState(page)).mirror).toBe(false);

    // "Change source" stops the camera and returns to the start screen.
    await page.locator('#switch-source').click();
    await expect(page.locator('#empty-state')).toBeVisible();
    expect(await page.evaluate(() => document.getElementById('camera').srcObject)).toBeNull();
    expect(errors).toEqual([]);
  });
});
