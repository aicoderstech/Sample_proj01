// Renders the sample garments (public/garments/*.svg) to raw RGBA files so
// the fit benchmark can run in Node without a browser:
//   node scripts/render-garment-fixtures.mjs
// Output: tests/fixtures/garments/<id>.rgba.gz (+ <id>.json with the size).
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'tests', 'fixtures', 'garments');
mkdirSync(out, { recursive: true });
const catalog = readFileSync(join(root, 'src', 'lib', 'catalog.js'), 'utf8');
const items = [...catalog.matchAll(/id: '([^']+)', name: '[^']+', type: '([^']+)'.*?file: '([^']+)'/g)].map((m) => ({ id: m[1], type: m[2], file: m[3] }));

const browser = await chromium.launch();
const page = await browser.newPage();
for (const item of items) {
  const svg = readFileSync(join(root, 'public', item.file), 'utf8');
  const { width, height, data } = await page.evaluate(async (svg) => {
    const img = new Image();
    img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return { width: c.width, height: c.height, data: Array.from(ctx.getImageData(0, 0, c.width, c.height).data) };
  }, svg);
  writeFileSync(join(out, `${item.id}.rgba.gz`), gzipSync(Buffer.from(Uint8Array.from(data)), { level: 9 }));
  writeFileSync(join(out, `${item.id}.json`), JSON.stringify({ id: item.id, type: item.type, width, height }) + '\n');
  console.log(`rendered ${item.id} (${width}x${height})`);
}
await browser.close();
