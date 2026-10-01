// Automated accessibility audit (axe-core) of every page, light and dark.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

for (const url of ['/', '/studio.html', '/demo-store.html']) {
  for (const colorScheme of ['light', 'dark']) {
    test(`no accessibility violations on ${url} (${colorScheme})`, async ({ browser, baseURL }) => {
      const context = await browser.newContext({ baseURL, colorScheme });
      const page = await context.newPage();
      await page.goto(url);
      if (url === '/demo-store.html') await expect(page.locator('.mf-tryon-btn')).toHaveCount(8);
      await page.addScriptTag({ content: AXE });
      const violations = await page.evaluate(async () =>
        (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map(
          (v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`,
        ),
      );
      expect(violations).toEqual([]);
      await context.close();
    });
  }
}

test('no accessibility violations in the studio while trying something on', async ({ browser, baseURL }) => {
  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ baseURL, colorScheme });
    const page = await context.newPage();
    await page.goto('/studio.html?pose=mock&autostart=camera');
    await expect.poll(() => page.evaluate(() => window.__mirrorfit.state().garmentDrawn)).toBe(true);
    await page.locator('#snapshot').click();
    await expect(page.locator('#snapshots a')).toHaveCount(1);
    await page.addScriptTag({ content: AXE });
    const violations = await page.evaluate(async () =>
      (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map(
        (v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`,
      ),
    );
    expect(violations, colorScheme).toEqual([]);
    await context.close();
  }
});
