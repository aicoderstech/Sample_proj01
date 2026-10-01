import { test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES } from './global-setup.js';

export const PERSON_PHOTO = join(FIXTURES, 'person.jpg');

export function hasPersonFixture() {
  try {
    return JSON.parse(readFileSync(join(FIXTURES, 'status.json'), 'utf8')).hasPhoto && existsSync(PERSON_PHOTO);
  } catch {
    return false;
  }
}

export function requirePersonFixture() {
  test.skip(!hasPersonFixture(), 'Person photo fixture could not be downloaded (no network?)');
}

// MediaPipe logs its own informational messages through console.error
// (e.g. "INFO: Created TensorFlow Lite XNNPACK delegate for CPU.").
const BENIGN = [/^INFO: /, /XNNPACK/, /GL Driver Message/, /GroupMarkerNotSet/];

/** Collects uncaught page errors and console errors for a page. */
export function trackErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !BENIGN.some((re) => re.test(msg.text()))) errors.push(`console: ${msg.text()}`);
  });
  return errors;
}

export const studioState = (page) => page.evaluate(() => window.__mirrorfit.state());

/** Average RGB in a small square of the studio canvas (canvas pixel coords). */
export function sampleCanvas(page, x, y, r = 4) {
  return page.evaluate(
    ({ x, y, r }) => {
      const c = document.getElementById('view');
      const d = c.getContext('2d').getImageData(Math.round(x - r), Math.round(y - r), r * 2, r * 2).data;
      const sum = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) sum[k] += d[i + k];
      return sum.map((s) => Math.round(s / (d.length / 4)));
    },
    { x, y, r },
  );
}

/** Counts canvas pixels matching a colour predicate given as a function body string. */
export function countPixels(page, predicate) {
  return page.evaluate((predicate) => {
    const fn = new Function('r', 'g', 'b', `return ${predicate};`);
    const c = document.getElementById('view');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (fn(d[i], d[i + 1], d[i + 2])) n++;
    return n;
  }, predicate);
}
