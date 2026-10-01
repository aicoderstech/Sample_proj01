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
      if (url === '/demo-store.html') await expect(page.locator('.mf-tryon-btn')).toHaveCount(7);
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
