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
//    a clean plate of the background learnt over earlier frames;
//  - inside the new top's neckline (an old shirt collar, a tie): the neck,
//    and beside it the inside of the new garment's back collar, in shadow.
// Made skin carries a faint mottle, as real skin does at this scale; smooth
// skin reads as plastic.
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
 * Softens the patch's edge over about a pixel each way (the photo's own
 * edges are never hard): colours are carried one pixel out, and alpha is
 * the changed mask blurred.
 */
function feather(out, changed, w, h) {
  const src = Uint8ClampedArray.from(out);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let n = 0;
      let a = 0;
      const c = [0, 0, 0];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          n++;
          if (!changed[j]) continue;
          a++;
          c[0] += src[j * 4];
          c[1] += src[j * 4 + 1];
          c[2] += src[j * 4 + 2];
        }
      }
      if (!a) continue;
      if (!changed[i]) out.set([c[0] / a, c[1] / a, c[2] / a], i * 4);
      // Fully changed inside; a ramp across the edge.
      out[i * 4 + 3] = changed[i] ? 255 * Math.min(1, 0.5 + a / n) : (255 * a) / n / 2;
    }
  }
}

/** Point in polygon (even-odd). */
function inside(poly, x, y) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

/** Faint, stable mottle (about +-3%) for made skin. */
function mottle(x, y) {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  const m = Math.sin(Math.floor(x / 3) * 7.13 + Math.floor(y / 3) * 3.71) * 9631.17;
  return 1 + ((n - Math.floor(n)) - 0.5) * 0.03 + ((m - Math.floor(m)) - 0.5) * 0.035;
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
 * @param {{x:number,y:number}[]} [o.neckline] the new top's neckline opening (image coordinates)
 * @param {number[]} [o.inner]           colour of the inside of its back collar
 * @returns {{pix: Uint8ClampedArray, changed: Uint8Array, removed: Uint8Array, skin: Uint8Array, skinCount: number, background: number}|null}
 *   pix: the patch (RGBA, alpha 255 where changed); removed: 1 where the
 *   person is now background (no longer part of the outline); skin: 1 where
 *   the old clothes became skin
 */
export function undress({ pix, labels, cover, w, h, k, body, type, plate = null, plateKnown = null, neckline = null, inner = null }) {
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
      // The renderer draws the arm from halfway down the upper arm to the hand
      // in front of the new garment's body (see TryOnRenderer.frontLayer).
      limbs.push({ a: c[i - 1], b: c[i], r: (t) => prof(t) * sw * build, outer: Math.max(outer, prof(0) * sw * build) * 1.7, front: (t) => i >= 2 || t >= 0.55 });
    }
  }
  const tone = skinTone(pix, labels);
  const out = new Uint8ClampedArray(w * h * 4);
  const changed = new Uint8Array(w * h);
  const skinPx = new Uint8Array(w * h);
  const removed = new Uint8Array(w * h);
  const toBg = new Uint8Array(w * h);
  let skin = 0;
  let background = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (labels[i] !== LABEL.CLOTHES) continue;
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
          limb = { d, s, r: s.r(t), front: s.front(t) };
        }
      }
      // Under the new garment nothing shows, except an arm in front of it
      // (a forearm across the body): that one is bared too.
      if (cover[i] && !(limb && limb.front && limb.d <= limb.r)) continue;
      if (neckline && !(limb && limb.d <= limb.r) && inside(neckline, P.x, P.y)) {
        // The neck (a cylinder, darker at its sides and under the jaw), the
        // chest below the collarbones, or beside the neck the inside of the
        // new garment's back collar.
        const neckHalf = (body.neckSkinHalf ?? 0.17 * sw) * 1.08;
        let c = null;
        const bodyHalf = body.halfAt(Math.max(l.v, body.neckBaseV), l.u < 0 ? 'imageLeft' : 'imageRight');
        if (Math.abs(l.u) > bodyHalf && Math.abs(l.u) >= neckHalf) {
          // Outside the body under the old clothes (a jacket's padding);
          // only measurable facing the camera (turned, the outline includes
          // the side of the body).
          if (body.frontal !== false) toBg[i] = 1;
          continue;
        }
        if (Math.abs(l.u) < neckHalf && tone) {
          const t = l.u / neckHalf;
          const jaw = Math.min(1, Math.max(0, (l.v - (body.neckBaseV - 0.22 * T)) / (0.1 * T)));
          const shade = (0.74 + 0.26 * Math.sqrt(Math.max(0, 1 - t * t))) * (0.8 + 0.2 * jaw) * mottle(x, y);
          c = tone.map((v) => v * shade);
        } else if (l.v > body.neckBaseV + 0.06 * T && tone) {
          // Chest and shoulders: rounded, darker towards the sides.
          const t = Math.min(1, Math.abs(l.u) / bodyHalf);
          c = tone.map((v) => v * (0.78 + 0.18 * Math.sqrt(1 - t * t)) * mottle(x, y));
        } else if (l.v > body.neckBaseV - 0.05 * T) {
          // Just above the neck base: the inside of the back collar, or for a
          // strappy dress the shoulders.
          c = inner ?? (tone && tone.map((v) => v * 0.9 * mottle(x, y)));
        } else {
          // Higher up beside the neck (an old collar standing up) there is
          // nothing of the new garment: the scenery behind.
          if (body.frontal !== false) toBg[i] = 1;
          continue;
        }
        if (c) {
          out.set([c[0], c[1], c[2], 255], i * 4);
          changed[i] = 1;
          if (c !== inner) skinPx[i] = 1;
          skin++;
        }
        continue;
      }
      const inTorsoBand = l.v > -0.1 * T && l.v < T;
      if (limb) {
        if (limb.d <= limb.r) {
          if (!tone) continue;
          // A rounded limb: lit along its axis, darker towards its sides.
          const t = limb.d / limb.r;
          const shade = (0.72 + 0.28 * Math.sqrt(Math.max(0, 1 - t * t))) * mottle(x, y);
          out.set([tone[0] * shade, tone[1] * shade, tone[2] * shade, 255], i * 4);
          changed[i] = 1;
          skinPx[i] = 1;
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
    // The labels are coarser than the picture: background pixels bordering
    // the removed clothes may still show their edge (a dark fringe). They
    // are repainted too, and not used as a sample of the background.
    const fringe = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (labels[i] !== LABEL.BACKGROUND || cover[i]) continue;
        for (let dy = -2; dy <= 2 && !fringe[i]; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < w && yy < h && toBg[yy * w + xx]) {
              fringe[i] = 1;
              break;
            }
          }
        }
      }
    }
    const rgb = new Float32Array(w * h * 3);
    const known = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      rgb[i * 3] = pix[i * 4];
      rgb[i * 3 + 1] = pix[i * 4 + 1];
      rgb[i * 3 + 2] = pix[i * 4 + 2];
      known[i] = labels[i] === LABEL.BACKGROUND && !fringe[i] ? 1 : 0;
      if (plate && plateKnown?.[i] && !known[i]) {
        rgb[i * 3] = plate[i * 3];
        rgb[i * 3 + 1] = plate[i * 3 + 1];
        rgb[i * 3 + 2] = plate[i * 3 + 2];
        known[i] = 1;
      }
    }
    pushPullFill(rgb, known, w, h);
    for (let i = 0; i < w * h; i++) {
      if (!toBg[i] && !fringe[i]) continue;
      out.set([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], 255], i * 4);
      changed[i] = 1;
      if (toBg[i]) {
        removed[i] = 1;
        background++;
      }
    }
  }
  if (!skin && !background) return null;
  feather(out, changed, w, h);
  return { pix: out, changed, removed, skin: skinPx, skinCount: skin, background };
}
