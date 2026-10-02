// Scene light direction from the wearer's own face. A face is roughly a
// sphere, so across it the brightness rises towards the light: fitting a
// plane L = a + b*x + c*y to its brightness gives the light's direction in
// the picture (b, c) and, relative to a, how strongly it comes from the side.

const FACE_SKIN = 3;
const BODY_SKIN = 2;

/** Default: soft light from above and slightly in front (typical indoors). */
export const DEFAULT_LIGHT = Object.freeze({ x: 0, y: -0.35, z: 0.94, confidence: 0 });

/**
 * @param {Uint8ClampedArray} pix  RGBA, w x h
 * @param {Uint8Array} labels      parsing labels, w x h
 * @param {Uint8Array|null} mine   1 for the person being dressed (or null for all)
 * @returns {{x:number, y:number, z:number, confidence:number}} unit vector in
 *   image space (x right, y down, z towards the viewer)
 */
export function estimateLight(pix, labels, w, h, mine = null) {
  for (const label of [FACE_SKIN, BODY_SKIN]) {
    let n = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] !== label || (mine && !mine[i])) continue;
      n++;
      sx += i % w;
      sy += Math.floor(i / w);
    }
    if (n < 40) continue;
    const cx = sx / n;
    const cy = sy / n;
    // Least squares on centred coordinates (normalised by the region's size).
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] !== label || (mine && !mine[i])) continue;
      const dx = (i % w) - cx;
      const dy = Math.floor(i / w) - cy;
      sxx += dx * dx;
      syy += dy * dy;
    }
    const r = Math.sqrt((sxx + syy) / n) || 1;
    let sl = 0;
    let slx = 0;
    let sly = 0;
    let txx = 0;
    let tyy = 0;
    let txy = 0;
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] !== label || (mine && !mine[i])) continue;
      const x = ((i % w) - cx) / r;
      const y = (Math.floor(i / w) - cy) / r;
      const l = (0.299 * pix[i * 4] + 0.587 * pix[i * 4 + 1] + 0.114 * pix[i * 4 + 2]) / 255;
      sl += l;
      slx += l * x;
      sly += l * y;
      txx += x * x;
      tyy += y * y;
      txy += x * y;
    }
    const a = sl / n;
    if (a < 0.08) continue;
    // Solve [txx txy; txy tyy] [b c] = [slx sly].
    const det = txx * tyy - txy * txy || 1;
    const b = (slx * tyy - sly * txy) / det;
    const c = (sly * txx - slx * txy) / det;
    // Side light strength: brightness change across the face relative to its mean.
    const g = Math.hypot(b, c) / a;
    const side = Math.min(0.8, g * 1.6);
    const dirX = g > 1e-6 ? b / Math.hypot(b, c) : 0;
    const dirY = g > 1e-6 ? c / Math.hypot(b, c) : -1;
    // Keep some light from above: faces are usually lit from higher up.
    const x = dirX * side;
    const y = Math.min(dirY * side, -0.15);
    const z = Math.sqrt(Math.max(0.05, 1 - x * x - y * y));
    const len = Math.hypot(x, y, z);
    return { x: x / len, y: y / len, z: z / len, confidence: Math.min(1, n / 400) };
  }
  return DEFAULT_LIGHT;
}
