// Prepares e2e fixtures in tests/.fixtures (git-ignored):
//   person.jpg – a real photo of a person (downloaded once) for body tracking
//   person.y4m – that photo as a raw video, fed to Chromium's fake camera
// If the photo can't be downloaded, a plain grey video is written instead so
// the browser still starts; tests that need a real person are then skipped.
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '.fixtures');
const PHOTO_URL = 'https://storage.googleapis.com/mediapipe-assets/pose.jpg';
const WIDTH = 640;
const HEIGHT = 480;
const FRAMES = 10;

async function downloadPhoto(dest) {
  if (existsSync(dest)) return true;
  try {
    const res = await fetch(PHOTO_URL, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    return true;
  } catch (err) {
    console.warn(`[e2e] Could not download the person photo (${err.message}); real body-tracking tests will be skipped.`);
    return false;
  }
}

/** Decodes the JPEG in Chromium and letterboxes it into WIDTH x HEIGHT RGBA. */
async function decodeToRgba(jpegPath) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const dataUrl = `data:image/jpeg;base64,${readFileSync(jpegPath).toString('base64')}`;
    const rgba = await page.evaluate(
      async ({ dataUrl, W, H }) => {
        const img = new Image();
        img.src = dataUrl;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        const k = Math.min(W / img.naturalWidth, H / img.naturalHeight);
        const w = img.naturalWidth * k;
        const h = img.naturalHeight * k;
        ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
        return Array.from(ctx.getImageData(0, 0, W, H).data);
      },
      { dataUrl, W: WIDTH, H: HEIGHT },
    );
    return Uint8Array.from(rgba);
  } finally {
    await browser.close();
  }
}

/** RGBA -> YUV 4:2:0 (BT.601, full range) Y4M with FRAMES identical frames. */
function writeY4m(dest, rgba) {
  const ySize = WIDTH * HEIGHT;
  const cSize = (WIDTH / 2) * (HEIGHT / 2);
  const frame = Buffer.alloc(ySize + cSize * 2);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      frame[y * WIDTH + x] = Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]);
    }
  }
  for (let y = 0; y < HEIGHT / 2; y++) {
    for (let x = 0; x < WIDTH / 2; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const i = ((y * 2 + dy) * WIDTH + (x * 2 + dx)) * 4;
        r += rgba[i];
        g += rgba[i + 1];
        b += rgba[i + 2];
      }
      r /= 4;
      g /= 4;
      b /= 4;
      const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
      frame[ySize + y * (WIDTH / 2) + x] = clamp(128 - 0.168736 * r - 0.331264 * g + 0.5 * b);
      frame[ySize + cSize + y * (WIDTH / 2) + x] = clamp(128 + 0.5 * r - 0.418688 * g - 0.081312 * b);
    }
  }
  const header = Buffer.from(`YUV4MPEG2 W${WIDTH} H${HEIGHT} F30:1 Ip A1:1 C420jpeg\n`);
  const parts = [header];
  for (let f = 0; f < FRAMES; f++) parts.push(Buffer.from('FRAME\n'), frame);
  writeFileSync(dest, Buffer.concat(parts));
}

export default async function globalSetup() {
  mkdirSync(FIXTURES, { recursive: true });
  const photo = join(FIXTURES, 'person.jpg');
  const video = join(FIXTURES, 'person.y4m');
  const hasPhoto = await downloadPhoto(photo);
  writeFileSync(join(FIXTURES, 'status.json'), JSON.stringify({ hasPhoto }));
  if (existsSync(video) && hasPhoto) return;
  const rgba = hasPhoto ? await decodeToRgba(photo) : new Uint8Array(WIDTH * HEIGHT * 4).fill(128);
  writeY4m(video, rgba);
}
