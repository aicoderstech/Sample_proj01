// Removes the wearer's own clothes where the new garment won't cover them,
// before the garment is drawn. Works on a reduced-resolution copy of the
// frame (it is smooth by nature) and returns a patch to lay over it.
//
// Using the human-parsing labels (clothes / skin / hair / ...), every pixel
// of the old clothes that the new garment leaves visible on the upper body
// (for a top or a dress) becomes:
//  - skin, where it lies on the real arm (an old long sleeve under a new
//    T-shirt): the wearer's own skin tone, shaded as a rounded, tapering arm;
//  - background, where it lies outside the body (bulk: a coat or a loose
//    top wider than the body the new garment is fitted to): filled from the
//    surrounding background (push-pull inpainting) or, for live video, from
//    a clean plate of the background learnt over earlier frames.
import { segDist } from './vec.js';

export const LABEL = { BACKGROUND: 0, HAIR: 1, BODY_SKIN: 2, FACE_SKIN: 3, CLOTHES: 4, OTHER: 5 };

/**
 * Hole filling by push-pull: average the known pixels down a pyramid, then
 * fill each unknown pixel from the coarser level above it. Smooth and fast.
 * @param {Float32Array} rgb  w*h*3, modified in place
 * @param {Uint8Array} known  1 where rgb is valid
 */
export function pushPullFill(rgb, known, w, h) {
  const levels = [{ w, h, rgb: Float32Array.from(rgb), wt: Float32Array.from(known) }];
  for (let i = 0; i < w * h; i++) {
    if (!known[i]) levels[0].rgb.fill(0, i * 3, i * 3 + 3);
  }
  while (levels[levels.length - 1].w > 1 || levels[levels.length - 1].h > 1) {
    const a = levels[levels.length - 1];
    const bw = Math.max(1, Math.ceil(a.w / 2));
    const bh = Math.max(1, Math.ceil(a.h / 2));
    const b = { w: bw, h: bh, rgb: new Float32Array(bw * bh * 3), wt: new Float32Array(bw * bh) };
    for (let y = 0; y < a.h; y++) {
      for (let x = 0; x < a.w; x++) {
        const i = y * a.w + x;
        const j = (y >> 1) * bw + (x >> 1);
        const wt = a.wt[i];
        if (!wt) continue;
        b.wt[j] += wt;
        b.rgb[j * 3] += a.rgb[i * 3] * wt;
        b.rgb[j * 3 + 1] += a.rgb[i * 3 + 1] * wt;
        b.rgb[j * 3 + 2] += a.rgb[i * 3 + 2] * wt;
      }
    }
    for (let j = 0; j < bw * bh; j++) {
      if (b.wt[j]) {
        b.rgb[j * 3] /= b.wt[j];
        b.rgb[j * 3 + 1] /= b.wt[j];
        b.rgb[j * 3 + 2] /= b.wt[j];
        b.wt[j] = Math.min(1, b.wt[j]);
      }
    }
    levels.push(b);
  }
  // Pull: fill holes at each level from the (bilinear) level above.
  for (let l = levels.length - 2; l >= 0; l--) {
    const a = levels[l];
    const b = levels[l + 1];
    for (let y = 0; y < a.h; y++) {
      for (let x = 0; x < a.w; x++) {
        const i = y * a.w + x;
        if (a.wt[i] >= 1) continue;
        const fx = Math.min(b.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
        const fy = Math.min(b.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const x1 = Math.min(b.w - 1, x0 + 1);
        const y1 = Math.min(b.h - 1, y0 + 1);
        const tx = fx - x0;
        const ty = fy - y0;
        const wa = a.wt[i];
        for (let c = 0; c < 3; c++) {
          const v =
            (b.rgb[(y0 * b.w + x0) * 3 + c] * (1 - tx) + b.rgb[(y0 * b.w + x1) * 3 + c] * tx) * (1 - ty) +
            (b.rgb[(y1 * b.w + x0) * 3 + c] * (1 - tx) + b.rgb[(y1 * b.w + x1) * 3 + c] * tx) * ty;
          a.rgb[i * 3 + c] = a.rgb[i * 3 + c] * wa + v * (1 - wa);
        }
        a.wt[i] = 1;
      }
    }
  }
  for (let i = 0; i < w * h; i++) {
    if (!known[i]) {
      rgb[i * 3] = levels[0].rgb[i * 3];
      rgb[i * 3 + 1] = levels[0].rgb[i * 3 + 1];
      rgb[i * 3 + 2] = levels[0].rgb[i * 3 + 2];
    }
  }
}

/** Median skin colour from face and body skin pixels (null if too few). */
export function skinTone(pix, labels) {
  const rs = [];
  const gs = [];
  const bs = [];
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] !== LABEL.FACE_SKIN && labels[i] !== LABEL.BODY_SKIN) continue;
    const r = pix[i * 4];
    const g = pix[i * 4 + 1];
    const b = pix[i * 4 + 2];
    const l = 0.3 * r + 0.59 * g + 0.11 * b;
    if (l < 35 || l > 245) continue; // deep shadow or highlight
    rs.push(r);
    gs.push(g);
    bs.push(b);
  }
  if (rs.length < 12) return null;
  const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
  return [med(rs), med(gs), med(bs)];
}

/**
 * @param {object} o
 * @param {Uint8ClampedArray} o.pix      RGBA of the frame at low resolution (w x h)
 * @param {Uint8Array} o.labels          parsing labels at w x h
 * @param {Uint8Array} o.cover           1 where the new garment will be drawn (w x h)
 * @param {number} o.w
 * @param {number} o.h
 * @param {number} o.k                   low-res pixels per image pixel
 * @param {object} o.body                measureBody() result (image coordinates)
 * @param {'top'|'dress'|'bottom'} o.type
 * @param {Float32Array} [o.plate]       learnt background (w*h*3) for live video
 * @param {Uint8Array} [o.plateKnown]    1 where the plate is known
 * @returns {{pix: Uint8ClampedArray, changed: Uint8Array, removed: Uint8Array, skin: number, background: number}|null}
 *   pix: the patch (RGBA, alpha 255 where changed); removed: 1 where the
 *   person is now background (no longer part of the outline)
 */
export function undress({ pix, labels, cover, w, h, k, body, type, plate = null, plateKnown = null }) {
  const { T, sw } = body;
  // Upper body only: the arms and the torso's bulk. (Bare legs synthesised
  // under a dress or skirt look far less natural than the wearer's own
  // trousers or tights showing below the hem, so the legs are left alone.)
  if (type === 'bottom') return null;
  // Bare arms taper: radius along each segment (t = 0..1 from its upper
  // joint: upper arm, forearm, hand), in shoulder widths, scaled by build.
  const build = body.build ?? 1;
  const ARM = [(t) => 0.1 - 0.02 * t, (t) => 0.082 - 0.03 * t + 0.012 * Math.sin(Math.PI * Math.min(1, t * 1.6)), () => 0.05];
  const limbs = [];
  for (const a of Object.values(body.arms)) {
    const c = a.chain;
    for (let i = 1; i < c.length; i++) {
      const outer = i === 1 ? a.rUOuter ?? a.rU : a.rFOuter ?? a.rF;
      const prof = ARM[Math.min(i - 1, ARM.length - 1)];
      limbs.push({ a: c[i - 1], b: c[i], r: (t) => prof(t) * sw * build, outer: Math.max(outer, prof(0) * sw * build) * 1.7 });
    }
  }
  const tone = skinTone(pix, labels);
  const out = new Uint8ClampedArray(w * h * 4);
  const changed = new Uint8Array(w * h);
  const removed = new Uint8Array(w * h);
  const toBg = new Uint8Array(w * h);
  let skin = 0;
  let background = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (labels[i] !== LABEL.CLOTHES || cover[i]) continue;
      const P = { x: (x + 0.5) / k, y: (y + 0.5) / k };
      const l = body.toLocal(P.x, P.y);
      // Which limb (if any) this pixel belongs to, and how far from its axis.
      let limb = null;
      let best = Infinity;
      for (const s of limbs) {
        const d = segDist(P, s.a, s.b);
        if (d < s.outer && d / s.outer < best) {
          best = d / s.outer;
          const dx = s.b.x - s.a.x;
          const dy = s.b.y - s.a.y;
          const t = Math.max(0, Math.min(1, ((P.x - s.a.x) * dx + (P.y - s.a.y) * dy) / (dx * dx + dy * dy || 1)));
          limb = { d, s, r: s.r(t) };
        }
      }
      const inTorsoBand = l.v > -0.1 * T && l.v < T;
      if (limb) {
        if (limb.d <= limb.r) {
          if (!tone) continue;
          // A rounded limb: lit along its axis, darker towards its sides.
          const t = limb.d / limb.r;
          const shade = 0.72 + 0.28 * Math.sqrt(Math.max(0, 1 - t * t));
          out.set([tone[0] * shade, tone[1] * shade, tone[2] * shade, 255], i * 4);
          changed[i] = 1;
          skin++;
        } else if (body.frontal !== false && Math.abs(l.u) > (body.outlineHalfAt ?? body.halfAt)(l.v, l.u < 0 ? 'imageLeft' : 'imageRight')) {
          // Old sleeve outside the arm and outside the body's outline.
          toBg[i] = 1;
        }
        continue;
      }
      if (!inTorsoBand || body.frontal === false) continue;
      // The torso: only the bulk outside the body the garment is fitted to.
      const half = body.halfAt(l.v, l.u < 0 ? 'imageLeft' : 'imageRight');
      if (Math.abs(l.u) > half + 0.02 * sw) toBg[i] = 1;
    }
  }
  if (toBg.some((v) => v)) {
    const rgb = new Float32Array(w * h * 3);
    const known = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      rgb[i * 3] = pix[i * 4];
      rgb[i * 3 + 1] = pix[i * 4 + 1];
      rgb[i * 3 + 2] = pix[i * 4 + 2];
      known[i] = labels[i] === LABEL.BACKGROUND ? 1 : 0;
      if (plate && plateKnown?.[i] && !known[i]) {
        rgb[i * 3] = plate[i * 3];
        rgb[i * 3 + 1] = plate[i * 3 + 1];
        rgb[i * 3 + 2] = plate[i * 3 + 2];
        known[i] = 1;
      }
    }
    pushPullFill(rgb, known, w, h);
    for (let i = 0; i < w * h; i++) {
      if (!toBg[i]) continue;
      out.set([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], 255], i * 4);
      changed[i] = 1;
      removed[i] = 1;
      background++;
    }
  }
  if (!skin && !background) return null;
  return { pix: out, changed, removed, skin, background };
}
