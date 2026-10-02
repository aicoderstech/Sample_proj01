// How the photo looks, so the garment can be made to look the same: a
// garment image is clean and evenly exposed, a photo is not. Its blacks may
// be lifted (haze, a cheap lens, compression), its light tinted (warm indoor
// bulbs, shade), its highlights dull (under-exposed), its colours absent (a
// black-and-white photo) and it carries sensor noise. A garment drawn
// without any of these looks pasted on.

/** Leaves the garment as it is. */
export const NEUTRAL_LOOK = Object.freeze({ lift: 0, gain: Object.freeze([1, 1, 1]), sat: 1, grain: 0 });

const LUMA = [0.299, 0.587, 0.114];

/**
 * @param {Uint8ClampedArray} pix  RGBA of the whole frame at reduced size (w x h)
 * @param {{data: Uint8ClampedArray, width: number, height: number}|null} crop
 *   a full-resolution crop (for noise, which reducing the size removes)
 * @returns {{lift: number, gain: number[], sat: number, grain: number}}
 *   lift: black level (0-1); gain: per-channel multiplier (tint and
 *   exposure); sat: colour saturation (1 = unchanged); grain: noise standard
 *   deviation (0-1)
 */
export function estimatePhotoLook(pix, w, h, crop = null) {
  const n = w * h;
  if (!n) return NEUTRAL_LOOK;
  const hist = new Uint32Array(256);
  let chroma = 0;
  for (let i = 0; i < n; i++) {
    const r = pix[i * 4];
    const g = pix[i * 4 + 1];
    const b = pix[i * 4 + 2];
    hist[Math.round(LUMA[0] * r + LUMA[1] * g + LUMA[2] * b)]++;
    chroma += (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
  }
  const pct = (q) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= q * n) return v / 255;
    }
    return 1;
  };
  const p01 = pct(0.01);
  const p95 = pct(0.95);
  const p995 = pct(0.995);
  // The light's colour: the brightest near-neutral surfaces (white walls,
  // shirts, highlights) take on its tint. Clipped pixels have lost it.
  const sum = [0, 0, 0];
  let count = 0;
  for (let i = 0; i < n; i++) {
    const r = pix[i * 4];
    const g = pix[i * 4 + 1];
    const b = pix[i * 4 + 2];
    const l = (LUMA[0] * r + LUMA[1] * g + LUMA[2] * b) / 255;
    const mx = Math.max(r, g, b);
    if (l < p95 || mx >= 254 || l < 0.2) continue;
    if ((mx - Math.min(r, g, b)) / mx > 0.3) continue;
    sum[0] += r;
    sum[1] += g;
    sum[2] += b;
    count++;
  }
  let tint = [1, 1, 1];
  if (count >= 12) {
    const mean = sum.map((s) => s / count);
    const grey = LUMA[0] * mean[0] + LUMA[1] * mean[1] + LUMA[2] * mean[2] || 1;
    tint = mean.map((m) => 1 + (Math.min(1.15, Math.max(0.85, m / grey)) - 1) * 0.5);
  }
  // Exposure: nothing in the garment is brighter than the photo's whites.
  const white = Math.min(1, Math.max(0.72, p995 + 0.03));
  const lift = Math.min(0.12, Math.max(0, p01 - 0.015));
  // Saturation: only a (nearly) black-and-white photo changes it.
  const meanChroma = chroma / n;
  const sat = Math.min(1, Math.max(0, (meanChroma - 0.008) / 0.025));
  return { lift, gain: tint.map((t) => t * white), sat, grain: crop ? estimateNoise(crop) : 0 };
}

/**
 * Sensor / compression noise: the median absolute Laplacian of the
 * luminance is mostly noise (edges are few); for white noise of deviation s
 * the Laplacian's deviation is s * sqrt(20).
 */
export function estimateNoise({ data, width, height }) {
  if (width < 3 || height < 3) return 0;
  const lum = new Float32Array(width * height);
  for (let i = 0; i < lum.length; i++) lum[i] = (LUMA[0] * data[i * 4] + LUMA[1] * data[i * 4 + 1] + LUMA[2] * data[i * 4 + 2]) / 255;
  const hist = new Uint32Array(512);
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap = Math.abs(lum[i - 1] + lum[i + 1] + lum[i - width] + lum[i + width] - 4 * lum[i]);
      hist[Math.min(511, Math.floor(lap * 1024))]++;
      n++;
    }
  }
  let acc = 0;
  let med = 0;
  for (let v = 0; v < 512; v++) {
    acc += hist[v];
    if (acc >= n / 2) {
      med = (v + 0.5) / 1024;
      break;
    }
  }
  // Some of it is fine texture rather than noise: count three quarters.
  return Math.min(0.025, (0.75 * 1.4826 * med) / Math.sqrt(20));
}
