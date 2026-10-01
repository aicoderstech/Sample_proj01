// Garment input paths (drag & drop, paste, URL, cross-origin) using the
// deterministic mock tracker (?pose=mock), so these don't depend on ML.
import { expect, test } from '@playwright/test';
import { studioState, trackErrors } from './helpers.js';

const start = async (page, extra = '') => {
  await page.goto(`/studio.html?pose=mock&autostart=camera${extra}`);
  await expect.poll(async () => (await studioState(page)).garmentDrawn).toBe(true);
};

/** Dispatches a drop event carrying a file fetched from this site. */
async function dropFile(page, path, name, type) {
  await page.evaluate(
    async ({ path, name, type }) => {
      const blob = await (await fetch(path)).blob();
      const dt = new DataTransfer();
      dt.items.add(new File([blob], name, { type }));
      document.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
      document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    { path, name, type },
  );
}

test.describe('studio · garments', () => {
  test('renders with the mock tracker and the 2D fallback renderer', async ({ page }) => {
    const errors = trackErrors(page);
    await start(page, '&webgl=0');
    const s = await studioState(page);
    expect(s.backend).toBe('mock');
    expect(s.webgl).toBe(false);
    await expect(page.locator('#status')).toContainText('Live');
    expect(errors).toEqual([]);
  });

  test('accepts a dropped image file and removes its background', async ({ page }) => {
    await start(page);
    await dropFile(page, 'garments/oxford-shirt.svg', 'my-shirt.svg', 'image/svg+xml');
    await expect(page.locator('#garment-info')).toHaveText('my-shirt.svg · top (auto) · background removed');
    await expect(page.locator('#drop-overlay')).toBeHidden();
    const s = await studioState(page);
    expect(s.garment).toMatchObject({ name: 'my-shirt.svg', type: 'top', guessedType: 'top', readable: true, via: 'file' });
    expect(s.garmentDrawn).toBe(true);
  });

  test('auto-detects dresses and skirts', async ({ page }) => {
    await start(page);
    await dropFile(page, 'garments/sundress-sage.svg', 'dress.svg', 'image/svg+xml');
    await expect(page.locator('#garment-info')).toContainText('dress (auto)');
    await dropFile(page, 'garments/pleated-skirt.svg', 'skirt.svg', 'image/svg+xml');
    await expect(page.locator('#garment-info')).toContainText('skirt / trousers (auto)');
  });

  test('accepts an image dragged from another web page', async ({ page, baseURL }) => {
    await start(page);
    await page.evaluate((url) => {
      const dt = new DataTransfer();
      dt.setData('text/html', `<a href="https://shop.example/p/1"><img src="${url}"></a>`);
      dt.setData('text/uri-list', 'https://shop.example/p/1');
      document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, `${baseURL}/garments/tee-graphic.svg`);
    await expect(page.locator('#garment-info')).toHaveText('127.0.0.1 · top (auto)');
    expect((await studioState(page)).garment.via).toBe('direct');
  });

  test('rejects drops without an image', async ({ page }) => {
    await start(page);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'just some words');
      document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect(page.locator('#garment-info')).toHaveAttribute('data-tone', 'error');
  });

  test('loads a garment from a pasted URL and from the clipboard', async ({ page, baseURL }) => {
    await start(page);
    await page.locator('#garment-url').fill(`${baseURL}/garments/breton-longsleeve.svg`);
    await page.getByRole('button', { name: 'Load' }).click();
    await expect(page.locator('#garment-info')).toContainText('127.0.0.1 · top');

    await page.evaluate(async () => {
      const blob = await (await fetch('garments/hoodie-grey.svg')).blob();
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'pasted-hoodie.svg', { type: 'image/svg+xml' }));
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    });
    await expect(page.locator('#garment-info')).toContainText('pasted-hoodie.svg');
  });

  test('handles shops that block image access (cross-origin, no CORS)', async ({ page }) => {
    await start(page);
    // "localhost" is a different origin from 127.0.0.1 and our static files
    // send no CORS headers; the proxy refuses local addresses, so the studio
    // must fall back to a display-only garment and explain why.
    await page.locator('#garment-url').fill('http://localhost:4319/garments/tee-coral.svg');
    await page.getByRole('button', { name: 'Load' }).click();
    await expect(page.locator('#garment-info')).toHaveAttribute('data-tone', 'warn');
    await expect(page.locator('#garment-info')).toContainText('blocks image access');
    const s = await studioState(page);
    expect(s.garment).toMatchObject({ readable: false, via: 'tainted' });
    expect(s.garmentDrawn).toBe(true);
    expect(s.webgl).toBe(false);

    await page.locator('#snapshot').click();
    await expect(page.locator('#garment-info')).toContainText('Snapshots are unavailable');
    await expect(page.locator('#snapshots a')).toHaveCount(0);
  });

  test('reports links that are not images', async ({ page }) => {
    await start(page);
    await page.locator('#garment-url').fill('http://127.0.0.1:4319/no-such-image.png');
    await page.getByRole('button', { name: 'Load' }).click();
    await expect(page.locator('#garment-info')).toHaveText('Could not load an image from that link.');
  });

  test('works on a phone-sized screen', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await start(page);
    await expect(page.locator('#view')).toBeVisible();
    await expect(page.locator('#garment-grid')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('explains when the camera is not allowed', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, permissions: [] });
    const page = await context.newPage();
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
    });
    await page.goto('/studio.html?pose=mock');
    await page.getByRole('button', { name: 'Start camera' }).click();
    await expect(page.locator('#status')).toContainText('Camera permission was denied');
    await expect(page.locator('#status')).toHaveAttribute('data-tone', 'error');
    await expect(page.getByRole('button', { name: 'Start camera' })).toBeEnabled();
    await context.close();
  });
});
