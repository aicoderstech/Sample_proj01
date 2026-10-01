import { expect, test } from '@playwright/test';
import { trackErrors } from './helpers.js';

test.describe('landing page', () => {
  test('renders the hero demo and key sections without errors', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/');
    await expect(page).toHaveTitle('Mirrorfit · Live Try-On');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('See it on you');
    for (const id of ['how', 'stores', 'faq']) await expect(page.locator(`#${id}`)).toBeVisible();

    // The hero canvas animates a figure wearing the showcase garments (coral
    // tee, green sundress, black tee, ...): wait until one is clearly drawn.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const c = document.getElementById('hero-canvas');
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let garment = 0;
          for (let i = 0; i < d.length; i += 16) {
            const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
            const coral = r > 200 && r - g > 90 && b < 130;
            const green = g > r + 15 && g > b;
            const dark = r < 70 && g < 70 && b < 80;
            if (coral || green || dark) garment++;
          }
          return garment;
        }),
      )
      .toBeGreaterThan(2000);
    await expect(page.locator('#hero-caption')).toContainText('Now wearing');
    expect(errors).toEqual([]);
  });

  test('shows a copyable install snippet pointing at this site', async ({ page, context, baseURL }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    await expect(page.locator('#snippet')).toContainText(`${baseURL}/widget.js`);
    await page.locator('#copy-snippet').click();
    await expect(page.locator('#copy-snippet')).toHaveText('Copied!');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('data-tryon');
  });

  test('navigates to the studio and the demo store', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Try it on now' }).click();
    await expect(page).toHaveURL(/studio\.html$/);
    await page.goto('/');
    await page.getByRole('link', { name: 'Demo store' }).first().click();
    await expect(page).toHaveURL(/demo-store\.html$/);
  });

  test('fits a phone screen without sideways scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto('/');
    await expect(page.locator('#hero-canvas')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('serves a 404 page for unknown URLs', async ({ page }) => {
    const res = await page.goto('/no-such-page');
    expect(res.status()).toBe(404);
    await expect(page.getByRole('heading')).toContainText("doesn't exist");
  });
});
