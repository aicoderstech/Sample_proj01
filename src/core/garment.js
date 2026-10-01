// Garment image processing on plain RGBA buffers ({ data, width, height }),
// so it runs (and is unit tested) without a browser.
//
//  removeBackground  – flood-fills a uniform product-photo background to alpha 0
//  analyzeGarment    – bounding box + per-row "central run" widths of the cut-out
//  guessGarmentType  – top / dress / bottom from the silhouette
//  deriveAnchors     – where the garment's shoulder (or waist) line and torso
//                      width are, plus sleeve angles, for fitting to a body
import { clamp } from './vec.js';

const ALPHA_ON = 40;

function borderIndices(width, height) {
  const out = [];
  const step = Math.max(1, Math.floor((2 * (width + height)) / 4000));
  for (let x = 0; x < width; x += step) out.push(x, (height - 1) * width + x);
  for (let y = 0; y < height; y += step) out.push(y * width, y * width + width - 1);
  return out;
}

function median(values) {
  if (values.length === 0) return 0;
  const s = Float64Array.from(values).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Makes a uniform background transparent. Images that already have a
 * transparent border are returned unchanged.
 * @returns {{data:Uint8ClampedArray,width:number,height:number,removed:boolean,reason?:string}}
 */
export function removeBackground(img, { tolerance = 42 } = {}) {
  const { width, height } = img;
  const src = img.data;
  const data = new Uint8ClampedArray(src);
  const border = borderIndices(width, height);

  const transparent = border.filter((i) => src[i * 4 + 3] < 200).length;
  if (transparent / border.length > 0.3) {
    return { data, width, height, removed: false, reason: 'already-transparent' };
  }

  const bg = [0, 1, 2].map((c) => median(border.map((i) => src[i * 4 + c])));
  const tol2 = tolerance * tolerance;
  const dist2 = (i) => {
    const dr = src[i * 4] - bg[0];
    const dg = src[i * 4 + 1] - bg[1];
    const db = src[i * 4 + 2] - bg[2];
    return dr * dr + dg * dg + db * db;
  };

  const nearBg = border.filter((i) => dist2(i) < tol2).length;
  if (nearBg / border.length < 0.55) {
    return { data, width, height, removed: false, reason: 'busy-background' };
  }

  // Flood fill from the border through pixels close to the background colour.
  const n = width * height;
  const isBg = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const seed = (i) => {
    if (!isBg[i] && dist2(i) < tol2) {
      isBg[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let x = 0; x < width; x++) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    seed(y * width);
    seed(y * width + width - 1);
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    if (x > 0) seed(i - 1);
    if (x < width - 1) seed(i + 1);
    if (i >= width) seed(i - width);
    if (i < n - width) seed(i + width);
  }

  let cleared = 0;
  for (let i = 0; i < n; i++) {
    if (isBg[i]) {
      data[i * 4 + 3] = 0;
      cleared++;
      continue;
    }
    // Soften the edge: pixels touching the background that are still close
    // to its colour are anti-aliasing blends, so fade them out.
    const x = i % width;
    const touchesBg =
      (x > 0 && isBg[i - 1]) || (x < width - 1 && isBg[i + 1]) || (i >= width && isBg[i - width]) || (i < n - width && isBg[i + width]);
    if (touchesBg) {
      const d = Math.sqrt(dist2(i));
      const f = clamp((d - tolerance * 0.5) / (tolerance * 2), 0.25, 1);
      data[i * 4 + 3] = Math.round(data[i * 4 + 3] * f);
    }
  }
  if (cleared === 0) return { data, width, height, removed: false, reason: 'nothing-to-remove' };
  return { data, width, height, removed: true, background: bg };
}

/**
 * Measures the opaque silhouette of a cut-out garment.
 * @returns {null | {width,height,bbox,centerX,mask,rows:{width,left,right,count,centerHit}}}
 */
export function analyzeGarment(img) {
  const { width, height, data } = img;
  const mask = new Uint8Array(width * height);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  let sumX = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (data[i * 4 + 3] > ALPHA_ON) {
        mask[i] = 1;
        count++;
        sumX += x;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (count < Math.max(50, width * height * 0.002)) return null;
  const bbox = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  if (bbox.w < 8 || bbox.h < 8) return null;

  const centerX = Math.round(sumX / count);
  const rows = {
    width: new Float64Array(bbox.h),
    left: new Float64Array(bbox.h),
    right: new Float64Array(bbox.h),
    count: new Float64Array(bbox.h),
    centerHit: new Uint8Array(bbox.h),
  };
  const searchRadius = Math.max(2, Math.round(bbox.w * 0.1));
  for (let r = 0; r < bbox.h; r++) {
    const y = minY + r;
    const rowOff = y * width;
    let c = 0;
    for (let x = minX; x <= maxX; x++) c += mask[rowOff + x];
    rows.count[r] = c;

    let start = -1;
    if (mask[rowOff + centerX]) {
      start = centerX;
      rows.centerHit[r] = 1;
    } else {
      for (let d = 1; d <= searchRadius && start < 0; d++) {
        if (centerX - d >= 0 && mask[rowOff + centerX - d]) start = centerX - d;
        else if (centerX + d < width && mask[rowOff + centerX + d]) start = centerX + d;
      }
    }
    if (start < 0) continue;
    let l = start;
    let rr = start;
    while (l > 0 && mask[rowOff + l - 1]) l--;
    while (rr < width - 1 && mask[rowOff + rr + 1]) rr++;
    rows.left[r] = l;
    rows.right[r] = rr;
    rows.width[r] = rr - l + 1;
  }
  return { width, height, bbox, centerX, mask, rows };
}

function bandRows(a, from, to) {
  const lo = clamp(Math.round(a.bbox.h * from), 0, a.bbox.h - 1);
  const hi = clamp(Math.round(a.bbox.h * to), lo, a.bbox.h - 1);
  const out = [];
  for (let r = lo; r <= hi; r++) if (a.rows.width[r] > 0) out.push(r);
  return out;
}

const bandWidth = (a, from, to) => median(bandRows(a, from, to).map((r) => a.rows.width[r]));
const bandCenter = (a, from, to) => median(bandRows(a, from, to).map((r) => (a.rows.left[r] + a.rows.right[r]) / 2));

export const GARMENT_TYPES = ['top', 'dress', 'bottom'];

export function guessGarmentType(a) {
  if (!a || !a.rows) return 'top';
  const r1 = Math.max(1, Math.round(a.bbox.h * 0.03));
  const r0 = Math.max(0, Math.round(a.bbox.h * 0.015));
  // Skirts and trousers start with a solid waistband right at the top edge;
  // tops start with a collar/neck opening, straps or a hood.
  if (a.rows.centerHit[r0] && a.rows.centerHit[r1] && a.rows.width[r1] >= a.bbox.w * 0.45) return 'bottom';
  const lower = bandWidth(a, 0.45, 0.75) || a.bbox.w;
  const upper = bandWidth(a, 0.15, 0.3) || lower;
  const aspect = a.bbox.h / lower;
  // Dresses flare out below the bust; very long straight shapes are dresses too.
  if (aspect >= 2.0 || (aspect >= 1.3 && lower / upper >= 1.15)) return 'dress';
  return 'top';
}

/** Fallback anchors for images whose pixels can't be read (cross-origin). */
export function defaultAnchors(width, height, type) {
  if (type === 'bottom') {
    return { type, fitWidth: width * 0.55, anchorY: height * 0.04, centerX: width / 2, bottomY: height * 0.97, sleeves: {} };
  }
  return { type, fitWidth: width * 0.6, anchorY: height * 0.12, centerX: width / 2, bottomY: height * 0.97, sleeves: {} };
}

/**
 * Anchor measurements (in garment image pixels) used by the fitter.
 * fitWidth  – width that maps onto the body (torso for tops, bust for dresses, waistband for bottoms)
 * anchorY   – row that sits on the shoulder line (tops/dresses) or waist (bottoms)
 * sleeves   – { imageLeft?, imageRight? }: pivot, centroid and angles (radians
 *             below the outward horizontal: centroid angle, min/max extent)
 */
export function deriveAnchors(a, type) {
  if (!a || !a.rows) return defaultAnchors(a?.width ?? 1, a?.height ?? 1, type);
  const { bbox } = a;
  const bottomY = bbox.y + bbox.h - 1;

  if (type === 'bottom') {
    const fitWidth = bandWidth(a, 0.01, 0.06) || bbox.w;
    return { type, fitWidth, anchorY: bbox.y, centerX: bandCenter(a, 0.01, 0.06) || a.centerX, bottomY, sleeves: {} };
  }

  const fitWidth = (type === 'dress' ? bandWidth(a, 0.15, 0.3) : bandWidth(a, 0.45, 0.75)) || bbox.w * 0.6;
  const centerX = (type === 'dress' ? bandCenter(a, 0.15, 0.3) : bandCenter(a, 0.45, 0.75)) || a.centerX;

  // Shoulder line: first row where the garment reaches (nearly) full width,
  // below a collar or hood. Thin straps above that row mean the straps
  // themselves rest on the shoulders.
  let firstFull = -1;
  for (let r = 0; r < bbox.h; r++) {
    if (a.rows.width[r] >= fitWidth * 0.85) {
      firstFull = r;
      break;
    }
  }
  if (firstFull < 0) firstFull = Math.round(bbox.h * 0.1);
  let coverage = 0;
  for (let r = 0; r < firstFull; r++) coverage += a.rows.count[r] / fitWidth;
  const straps = firstFull > 2 && coverage / firstFull < 0.3;
  const shoulderRow = straps ? Math.min(firstFull, Math.round(fitWidth * 0.04)) : firstFull;
  const anchorY = bbox.y + shoulderRow;

  const sleeves = {};
  const torsoL = centerX - fitWidth / 2;
  const torsoR = centerX + fitWidth / 2;
  const margin = fitWidth * 0.05;
  const yEnd = Math.min(bottomY, anchorY + fitWidth * 1.3);
  // Measures one sleeve: centroid plus its angular extent around the pivot
  // (angles below the outward horizontal), so the fitter can rotate the whole
  // sleeve rigidly and only stretch the gap between sleeve and torso.
  const measure = (fromX, toX, pivot, out) => {
    let n = 0;
    let sx = 0;
    let sy = 0;
    const angles = [];
    for (let y = anchorY; y <= yEnd; y++) {
      for (let x = Math.max(0, Math.floor(fromX)); x <= Math.min(a.width - 1, Math.ceil(toX)); x++) {
        if (a.mask[y * a.width + x]) {
          n++;
          sx += x;
          sy += y;
          if ((x + y) % 3 === 0) angles.push(Math.atan2(y - pivot.y, out * (x - pivot.x)));
        }
      }
    }
    if (n <= fitWidth * fitWidth * 0.01) return null;
    angles.sort((p, q) => p - q);
    const pct = (f) => angles[Math.min(angles.length - 1, Math.floor(angles.length * f))];
    const centroid = { x: sx / n, y: sy / n };
    return {
      pivot,
      centroid,
      angle: Math.atan2(centroid.y - pivot.y, out * (centroid.x - pivot.x)),
      minAngle: pct(0.03),
      maxAngle: pct(0.97),
    };
  };
  // Dress skirts flare out past the bodice; that is not a sleeve.
  if (type === 'top') {
    const left = measure(0, torsoL - margin, { x: torsoL, y: anchorY }, -1);
    if (left) sleeves.imageLeft = left;
    const right = measure(torsoR + margin, a.width - 1, { x: torsoR, y: anchorY }, 1);
    if (right) sleeves.imageRight = right;
  }
  return { type, fitWidth, anchorY, centerX, bottomY, sleeves };
}
