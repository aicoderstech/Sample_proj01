// Copies the MediaPipe WebAssembly runtime out of node_modules into public/
// so the app serves it itself (no third-party CDN at runtime).
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const dest = join(root, 'public', 'mediapipe', 'wasm');

if (!existsSync(src)) {
  console.error('[mirrorfit] @mediapipe/tasks-vision is not installed. Run `npm install` first.');
  process.exit(1);
}

mkdirSync(dest, { recursive: true });
for (const file of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']) {
  cpSync(join(src, file), join(dest, file));
}
console.log('[mirrorfit] MediaPipe wasm runtime copied to public/mediapipe/wasm');
