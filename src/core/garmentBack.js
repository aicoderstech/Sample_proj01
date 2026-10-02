// The back of a garment, made from a front product photo (which is all a
// shop shows). Seen from behind:
//  - the garment is mirrored (its left side is on the image's left);
//  - front-only details disappear: prints, text, pockets, buttons and
//    placket, hood strings. Candidate pixels differ clearly from the local
//    fabric colour or belong to a rare colour; they are grouped into blobs
//    by colour. A colour whose blobs repeat across most of the garment is a
//    pattern (stripes, an all-over print) and stays; anything else is a
//    detail, repainted from the surrounding fabric (push-pull fill keeps its
//    shading);
//  - the neckline of a sleeved top is much shallower than at the front.
import { pushPullFill } from './undress.js';

/** k-means on RGB of opaque pixels; returns cluster per pixel (-1 = transparent) and cluster sizes. */
function clusterColours(data, alpha, k = 5, iterations = 8) {
  const n = alpha.length;
  const idx = [];
  for (let i = 0; i < n; i++) if (alpha[i]) idx.push(i);
  if (!idx.length) return null;
  // Initial centres: the median brightness, then repeatedly the colour
  // farthest from all centres so far (on a sample of pixels), so a small
  // print on a large plain body gets a centre of its own; spreading them
  // over the brightness range would spend them all on the body's shades.
  const lum = (i) => 0.3 * data[i * 4] + 0.59 * data[i * 4 + 1] + 0.11 * data[i * 4 + 2];
  const sample = idx.filter((_, j) => j % Math.max(1, Math.floor(idx.length / 4000)) === 0);
  const sorted = sample.slice().sort((a, b) => lum(a) - lum(b));
  const rgbOf = (i) => [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
  let centres = [rgbOf(sorted[sorted.length >> 1])];
  const nearest = sample.map((i) => (data[i * 4] - centres[0][0]) ** 2 + (data[i * 4 + 1] - centres[0][1]) ** 2 + (data[i * 4 + 2] - centres[0][2]) ** 2);
  while (centres.length < k) {
    let far = 0;
    for (let j = 1; j < sample.length; j++) if (nearest[j] > nearest[far]) far = j;
    const c = rgbOf(sample[far]);
    centres.push(c);
    for (let j = 0; j < sample.length; j++) {
      const i = sample[j];
      nearest[j] = Math.min(nearest[j], (data[i * 4] - c[0]) ** 2 + (data[i * 4 + 1] - c[1]) ** 2 + (data[i * 4 + 2] - c[2]) ** 2);
    }
  }
  const assign = new Int8Array(n).fill(-1);
  for (let it = 0; it < iterations; it++) {
    const sums = centres.map(() => [0, 0, 0, 0]);
    for (const i of idx) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < k; c++) {
        const d = (data[i * 4] - centres[c][0]) ** 2 + (data[i * 4 + 1] - centres[c][1]) ** 2 + (data[i * 4 + 2] - centres[c][2]) ** 2;
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      assign[i] = best;
      const s = sums[best];
      s[0] += data[i * 4];
      s[1] += data[i * 4 + 1];
      s[2] += data[i * 4 + 2];
      s[3]++;
    }
    centres = sums.map((s, c) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : centres[c]));
  }
  const sizes = new Array(k).fill(0);
  for (const i of idx) sizes[assign[i]]++;
  return { assign, sizes, total: idx.length, centres };
}

/**
 * @param {{data: Uint8ClampedArray, width: number, height: number}} img garment texture (RGBA)
 * @param {object|null} rig  the front's rig (for the neckline)
 * @returns {{data: Uint8ClampedArray, width: number, height: number, removed: number}}
 */
export function makeGarmentBack(img, rig = null) {
  const { width: w, height: h } = img;
  // Mirror.
  const data = new Uint8ClampedArray(img.data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + (w - 1 - x)) * 4;
      data.set(img.data.subarray(s, s + 4), (y * w + x) * 4);
    }
  }
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = data[i * 4 + 3] > 128 ? 1 : 0;
  // Garment extent per row (for "spans most of the width").
  const rowL = new Int32Array(h).fill(-1);
  const rowR = new Int32Array(h).fill(-1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!alpha[y * w + x]) continue;
      if (rowL[y] < 0) rowL[y] = x;
      rowR[y] = x;
    }
  }
  const cl = clusterColours(data, alpha);
  const detail = new Uint8Array(w * h);
  let removed = 0;
  if (cl) {
    // Local fabric colour: mean of opaque pixels in a box ~4% of the
    // garment's width (summed-area table).
    let gw = 0;
    for (let y = 0; y < h; y++) if (rowR[y] > rowL[y]) gw = Math.max(gw, rowR[y] - rowL[y]);
    const r = Math.max(2, Math.round(gw * 0.04));
    const sat = new Float64Array((w + 1) * (h + 1) * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const o = ((y + 1) * (w + 1) + x + 1) * 4;
        const up = (y * (w + 1) + x + 1) * 4;
        const left = ((y + 1) * (w + 1) + x) * 4;
        const ul = (y * (w + 1) + x) * 4;
        const a = alpha[i];
        const v = [data[i * 4] * a, data[i * 4 + 1] * a, data[i * 4 + 2] * a, a];
        for (let c = 0; c < 4; c++) sat[o + c] = v[c] + sat[up + c] + sat[left + c] - sat[ul + c];
      }
    }
    const boxMean = (x, y, c) => {
      const x0 = Math.max(0, x - r);
      const y0 = Math.max(0, y - r);
      const x1 = Math.min(w, x + r + 1);
      const y1 = Math.min(h, y + r + 1);
      const S = (xx, yy, cc) => sat[(yy * (w + 1) + xx) * 4 + cc];
      const n = S(x1, y1, 3) - S(x0, y1, 3) - S(x1, y0, 3) + S(x0, y0, 3);
      return n ? (S(x1, y1, c) - S(x0, y1, c) - S(x1, y0, c) + S(x0, y0, c)) / n : 0;
    };
    const fabric = cl.sizes.map((sz) => sz / cl.total >= 0.18);
    const cand = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!alpha[i]) continue;
        const d = Math.hypot(data[i * 4] - boxMean(x, y, 0), data[i * 4 + 1] - boxMean(x, y, 1), data[i * 4 + 2] - boxMean(x, y, 2));
        if (d > 30 || !fabric[cl.assign[i]]) cand[i] = 1;
      }
    }
    // Connected blobs of candidate pixels, with their colour group and centre.
    const seen = new Uint8Array(w * h);
    const blobs = [];
    const stack = [];
    for (let start = 0; start < w * h; start++) {
      if (!cand[start] || seen[start]) continue;
      const px = [];
      let sx = 0;
      let sy = 0;
      const votes = new Array(cl.centres.length).fill(0);
      stack.push(start);
      seen[start] = 1;
      while (stack.length) {
        const i = stack.pop();
        px.push(i);
        const x = i % w;
        sx += x;
        sy += (i - x) / w;
        votes[cl.assign[i]]++;
        for (const j of [i - 1, i + 1, i - w, i + w]) {
          if (j < 0 || j >= w * h || seen[j] || !cand[j] || Math.abs((j % w) - x) > 1) continue;
          seen[j] = 1;
          stack.push(j);
        }
      }
      if (px.length < 3) continue;
      let bx0 = w;
      let bx1 = 0;
      let by0 = h;
      let by1 = 0;
      for (const i of px) {
        const x = i % w;
        const y = (i - x) / w;
        bx0 = Math.min(bx0, x);
        bx1 = Math.max(bx1, x);
        by0 = Math.min(by0, y);
        by1 = Math.max(by1, y);
      }
      blobs.push({ px, cx: sx / px.length, cy: sy / px.length, bw: bx1 - bx0, bh: by1 - by0, group: votes.indexOf(Math.max(...votes)) });
    }
    // A pattern repeats across most of the garment: many blobs of one
    // colour whose centres spread over most of its width and height
    // (stripes, an all-over print). Anything else is a detail.
    const box = { x0: w, x1: 0, y0: h, y1: 0 };
    for (let y = 0; y < h; y++) {
      if (rowL[y] < 0) continue;
      box.x0 = Math.min(box.x0, rowL[y]);
      box.x1 = Math.max(box.x1, rowR[y]);
      box.y0 = Math.min(box.y0, y);
      box.y1 = Math.max(box.y1, y);
    }
    const gw2 = Math.max(1, box.x1 - box.x0);
    const gh2 = Math.max(1, box.y1 - box.y0);
    // A blob covering most of the garment is its fabric (two-colour stripes
    // touch each other and join into one), not a detail.
    const keep = new Set(blobs.filter((b) => b.px.length > 0.2 * cl.total || (b.bw > 0.6 * gw2 && b.bh > 0.6 * gh2)));
    for (let gi = 0; gi < cl.centres.length; gi++) {
      const gb = blobs.filter((b) => b.group === gi && !keep.has(b));
      if (gb.length < 6) continue;
      // Pattern elements are alike in size (dots, stripes); a collar,
      // cuffs and buttons are not.
      const areas = gb.map((b) => b.px.length).sort((a, b) => a - b);
      const med = areas[areas.length >> 1];
      const alike = gb.filter((b) => b.px.length >= med * 0.4 && b.px.length <= med * 2.5);
      if (alike.length < 6) continue;
      const xs = alike.map((b) => b.cx);
      const ys = alike.map((b) => b.cy);
      const spreadX = (Math.max(...xs) - Math.min(...xs)) / gw2;
      const spreadY = (Math.max(...ys) - Math.min(...ys)) / gh2;
      if (spreadX > 0.4 && spreadY > 0.4) for (const b of alike) keep.add(b);
    }
    for (const b of blobs) {
      if (keep.has(b)) continue;
      for (const i of b.px) {
        // Grow by a pixel: anti-aliased rims would leave a ghost.
        for (const j of [i, i - 1, i + 1, i - w, i + w]) {
          if (j >= 0 && j < w * h && alpha[j] && !detail[j]) {
            detail[j] = 1;
            removed++;
          }
        }
      }
    }
  }
  // The back's neckline: about a quarter as deep as the front's.
  const kp = rig?.kp;
  const sleeved = rig ? Object.keys(rig.sleeves ?? {}).length > 0 : false;
  if (sleeved && kp?.neckL && kp?.neckR && kp?.neckC) {
    const xl = w - 1 - kp.neckR.x;
    const xr = w - 1 - kp.neckL.x;
    const cx = (xl + xr) / 2;
    const hw = Math.max(1, (xr - xl) / 2);
    const top = Math.min(kp.neckL.y, kp.neckR.y);
    const depth = Math.max(0, kp.neckC.y - top) * 0.25;
    for (let y = top; y <= kp.neckC.y + 2 && y < h; y++) {
      for (let x = Math.ceil(xl); x <= xr; x++) {
        const i = y * w + x;
        if (alpha[i]) continue;
        const arc = top + depth * (1 - ((x - cx) / hw) ** 2);
        if (y > arc) {
          alpha[i] = 1;
          detail[i] = 1;
          removed++;
        }
      }
    }
  }
  if (removed) {
    const rgb = new Float32Array(w * h * 3);
    const known = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      rgb[i * 3] = data[i * 4];
      rgb[i * 3 + 1] = data[i * 4 + 1];
      rgb[i * 3 + 2] = data[i * 4 + 2];
      known[i] = alpha[i] && !detail[i] ? 1 : 0;
    }
    pushPullFill(rgb, known, w, h);
    for (let i = 0; i < w * h; i++) {
      if (!detail[i]) continue;
      data[i * 4] = rgb[i * 3];
      data[i * 4 + 1] = rgb[i * 3 + 1];
      data[i * 4 + 2] = rgb[i * 3 + 2];
      data[i * 4 + 3] = 255;
    }
  }
  return { data, width: w, height: h, removed };
}
