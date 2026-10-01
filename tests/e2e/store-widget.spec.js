// The embeddable widget on the demo store, end to end.
import { expect, test } from '@playwright/test';
import { trackErrors } from './helpers.js';

test.describe('demo store · try-on widget', () => {
  test('adds try-on buttons, opens the studio and adds to cart', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/demo-store.html');
    const buttons = page.locator('.mf-tryon-btn');
    await expect(buttons).toHaveCount(8);
    await expect(buttons.first()).toHaveText('Try it on');

    await buttons.first().click();
    const dialog = page.getByRole('dialog', { name: 'Virtual try-on' });
    await expect(dialog).toBeVisible();
    const src = new URL(await dialog.locator('iframe').getAttribute('src'));
    expect(src.pathname).toBe('/studio.html');
    expect(Object.fromEntries(src.searchParams)).toMatchObject({ embed: '1', type: 'top', product: 'tee-coral', name: 'Coral Crew Tee' });
    expect(src.searchParams.get('garment')).toMatch(/\/garments\/tee-coral\.svg$/);

    // Inside the embedded studio: compact layout, garment preloaded, add-to-cart.
    const studio = page.frameLocator('.mf-overlay iframe');
    await expect(studio.locator('#garment-info')).toHaveText('Coral Crew Tee · top');
    await expect(studio.locator('.topbar')).toBeHidden();
    await studio.getByRole('button', { name: 'Add to cart' }).click();
    await expect(page.locator('#cart-count')).toHaveText('1');
    await expect(page.locator('#toast')).toHaveText('Added Coral Crew Tee to your cart');

    // Escape closes the overlay and returns focus to the button.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(buttons.first()).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('closes with the close button and hides add-to-cart without a product', async ({ page }) => {
    await page.goto('/demo-store.html');
    await page.locator('.mf-tryon-btn').nth(5).click();
    const studio = page.frameLocator('.mf-overlay iframe');
    await expect(studio.locator('#garment-info')).toHaveText('Sage Sundress · dress');
    await page.getByRole('button', { name: 'Close try-on' }).click();
    await expect(page.locator('.mf-overlay')).toHaveCount(0);

    await page.evaluate(() => window.Mirrorfit.open({ garment: new URL('garments/pleated-skirt.svg', location.href).href }));
    await expect(studio.locator('#garment-info')).toContainText('skirt / trousers (auto)');
    await expect(studio.getByRole('button', { name: 'Add to cart' })).toBeHidden();
  });

  test('the store cart works on its own too', async ({ page }) => {
    await page.goto('/demo-store.html');
    await page.locator('[data-add="hoodie-grey"]').click();
    await expect(page.locator('#cart-count')).toHaveText('1');
  });
});
