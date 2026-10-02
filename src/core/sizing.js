// Body measurements and size recommendation.
//
// Scale (pixels per cm) comes from the wearer's height:
//  - whole body in view: head top (person outline) to heel, along the body;
//  - otherwise: head height (top of the head to the chin) is about 1/7.5 of
//    adult stature;
//  - with no height given, the shoulder joints (about 35 cm apart on an
//    average adult) set a rough scale, and the result says it is rough.
// Circumferences: the body's cross-section at chest, waist and hips is close
// to an ellipse. Its width is measured (the body model, after taking off
// clothing bulk); its depth is the width times an average depth ratio, or is
// measured from a side view when there is one.
import { LM } from './body.js';

export const DEPTH_RATIO = { chest: 0.72, waist: 0.78, hips: 0.72 };
// The outline in a photo includes the clothes worn and the mask's soft
// edge: about this much per side (cm) is taken off the measured widths.
export const CLOTHING_CM = 1.2;
const HEADS_PER_STATURE = 7.5;
const SHOULDER_JOINTS_CM = 35;

/** Ellipse perimeter (Ramanujan), from the two semi-axes. */
export function ellipseCircumference(a, b) {
  const h = ((a - b) / (a + b)) ** 2;
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

/**
 * @param {object} body  measureBody() result
 * @param {object[]} pts pixel landmarks
 * @param {{data: Float32Array, width: number, height: number}|null} mask
 * @param {number|null} heightCm the wearer's height
 * @returns {{pxPerCm: number, method: 'stature'|'head'|'shoulders', confidence: 'good'|'fair'|'rough'}}
 */
export function measureScale(body, pts, mask, heightCm) {
  const up = { x: -body.frame.down.x, y: -body.frame.down.y };
  const nose = pts[LM.NOSE];
  // Top of the head: scan up from the nose until the person's outline ends.
  let headTop = null;
  if (mask && nose && nose.v >= 0.5) {
    // mask.scale: mask pixels per image pixel (1 when the mask is image-sized).
    const at = (p) => {
      const x = Math.floor(p.x * (mask.scale ?? 1));
      const y = Math.floor(p.y * (mask.scale ?? 1));
      return x >= 0 && y >= 0 && x < mask.width && y < mask.height ? mask.data[y * mask.width + x] : 0;
    };
    for (let d = 0; d < body.sw * 2; d += 1) {
      const p = { x: nose.x + up.x * d, y: nose.y + up.y * d };
      if (at(p) < 0.5) {
        headTop = p;
        break;
      }
    }
  }
  const heels = [pts[29], pts[30]].filter((p) => p && p.v >= 0.5);
  if (heightCm && headTop && heels.length) {
    const heel = { x: heels.reduce((s, p) => s + p.x, 0) / heels.length, y: heels.reduce((s, p) => s + p.y, 0) / heels.length };
    const stature = (headTop.x - heel.x) * up.x + (headTop.y - heel.y) * up.y;
    if (stature > body.T * 2) return { pxPerCm: stature / heightCm, method: 'stature', confidence: 'good' };
  }
  if (heightCm && headTop && nose) {
    // Chin: about as far below the nose as the nose is below the eyes, doubled.
    const eyes = pts[2] && pts[5] ? { x: (pts[2].x + pts[5].x) / 2, y: (pts[2].y + pts[5].y) / 2 } : null;
    if (eyes) {
      const eyeToNose = Math.hypot(nose.x - eyes.x, nose.y - eyes.y);
      const chin = { x: nose.x - up.x * eyeToNose * 2, y: nose.y - up.y * eyeToNose * 2 };
      const head = (headTop.x - chin.x) * up.x + (headTop.y - chin.y) * up.y;
      if (head > 0) return { pxPerCm: (head * HEADS_PER_STATURE) / heightCm, method: 'head', confidence: 'fair' };
    }
  }
  return { pxPerCm: body.frame.shoulderWidth / SHOULDER_JOINTS_CM, method: 'shoulders', confidence: 'rough' };
}

/**
 * Body measurements in cm.
 * @param {object} body  measureBody() result
 * @param {number} pxPerCm
 * @param {object|null} side  optional depths measured from a side view, in cm ({chest, waist, hips})
 * @param {{clothing?: number, statureCm?: number|null}} options clothing: allowance per side (cm)
 */
export function bodyMeasurements(body, pxPerCm, side = null, { clothing = CLOTHING_CM, statureCm = null } = {}) {
  const width = (v) => Math.max(1, (body.halfAt(v, 'imageLeft') + body.halfAt(v, 'imageRight')) / pxPerCm - 2 * clothing);
  const levels = { chest: body.armpitV, waist: body.waistV, hips: body.T };
  const out = {};
  for (const [k, v] of Object.entries(levels)) {
    const w = width(v);
    const d = side?.[k] ?? w * DEPTH_RATIO[k];
    out[k] = Math.round(ellipseCircumference(w / 2, d / 2));
    out[`${k}Width`] = Math.round(w);
  }
  const L = body.shoulderCorner?.imageLeft;
  const R = body.shoulderCorner?.imageRight;
  if (L && R) out.shoulders = Math.round(Math.hypot(L.x - R.x, L.y - R.y) / pxPerCm);
  const arm = body.arms.imageLeft ?? body.arms.imageRight;
  if (arm?.chain.length >= 3) {
    const c = arm.chain;
    out.arm = Math.round((Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y) + Math.hypot(c[2].x - c[1].x, c[2].y - c[1].y)) / pxPerCm);
  }
  const leg = body.legs.imageLeft ?? body.legs.imageRight;
  if (leg?.complete) {
    const c = leg.chain;
    // Inseam: from the crotch (a little below the hip joint) to the floor
    // (the ankle joint is about 3.5% of stature above it).
    const legPx = Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y) + Math.hypot(c[2].x - c[1].x, c[2].y - c[1].y) - 0.12 * body.sw;
    out.inseam = Math.round(legPx / pxPerCm + 0.035 * (statureCm ?? (body.T / pxPerCm) * 3.2));
  }
  out.torso = Math.round(body.T / pxPerCm);
  return out;
}

// Size charts: body measurements (cm) each size is made for, and the
// garment's own dimensions (cm): length from the shoulder (tops) or waist
// (bottoms) to the hem, and its circumference at chest / waist / hips.
const TOP = {
  measures: ['chest', 'waist'],
  sizes: {
    XS: { chest: [81, 86], waist: [66, 71], garment: { chest: 92, length: 66 } },
    S: { chest: [86, 94], waist: [71, 79], garment: { chest: 100, length: 69 } },
    M: { chest: [94, 102], waist: [79, 87], garment: { chest: 108, length: 72 } },
    L: { chest: [102, 110], waist: [87, 95], garment: { chest: 116, length: 74 } },
    XL: { chest: [110, 118], waist: [95, 103], garment: { chest: 124, length: 76 } },
    XXL: { chest: [118, 126], waist: [103, 111], garment: { chest: 132, length: 78 } },
  },
};
const DRESS = {
  measures: ['chest', 'waist', 'hips'],
  sizes: {
    XS: { chest: [80, 84], waist: [62, 66], hips: [88, 92], garment: { chest: 86, length: 100 } },
    S: { chest: [84, 88], waist: [66, 70], hips: [92, 96], garment: { chest: 90, length: 102 } },
    M: { chest: [88, 94], waist: [70, 76], hips: [96, 102], garment: { chest: 96, length: 104 } },
    L: { chest: [94, 100], waist: [76, 82], hips: [102, 108], garment: { chest: 102, length: 106 } },
    XL: { chest: [100, 106], waist: [82, 88], hips: [108, 114], garment: { chest: 108, length: 108 } },
  },
};
const SKIRT = {
  measures: ['waist', 'hips'],
  sizes: {
    XS: { waist: [62, 66], hips: [88, 92], garment: { waist: 64, length: 70 } },
    S: { waist: [66, 70], hips: [92, 96], garment: { waist: 68, length: 71 } },
    M: { waist: [70, 76], hips: [96, 102], garment: { waist: 73, length: 72 } },
    L: { waist: [76, 82], hips: [102, 108], garment: { waist: 79, length: 73 } },
    XL: { waist: [82, 88], hips: [108, 114], garment: { waist: 85, length: 74 } },
  },
};
const JEANS = {
  measures: ['waist', 'hips'],
  sizes: {
    28: { waist: [70, 74], hips: [88, 93], garment: { waist: 72, length: 104 } },
    30: { waist: [74, 79], hips: [93, 98], garment: { waist: 77, length: 105 } },
    32: { waist: [79, 84], hips: [98, 103], garment: { waist: 82, length: 106 } },
    34: { waist: [84, 89], hips: [103, 108], garment: { waist: 87, length: 107 } },
    36: { waist: [89, 95], hips: [108, 114], garment: { waist: 92, length: 108 } },
    38: { waist: [95, 101], hips: [114, 120], garment: { waist: 98, length: 109 } },
  },
};
export const SIZE_CHARTS = { top: TOP, dress: DRESS, skirt: SKIRT, trousers: JEANS };

/** The chart for a garment kind ('top' | 'dress' | 'skirt' | 'trousers'). */
export const chartFor = (kind) => SIZE_CHARTS[kind] ?? TOP;

/**
 * @returns {{size: string, fits: Object<string, {size: string, verdict: string}>, ranked: string[]}}
 *   verdict per measurement: 'too tight' | 'snug' | 'regular' | 'relaxed' | 'loose'
 */
export function recommendSize(measures, chart) {
  const names = Object.keys(chart.sizes);
  const score = (name) => {
    let s = 0;
    for (const m of chart.measures) {
      const v = measures[m];
      if (v == null) continue;
      const [lo, hi] = chart.sizes[name][m];
      // Too tight costs more than too loose.
      if (v > hi) s += (v - hi) * 2;
      else if (v < lo) s += lo - v;
    }
    return s;
  };
  const ranked = names.slice().sort((a, b) => score(a) - score(b) || names.indexOf(a) - names.indexOf(b));
  return { size: ranked[0], ranked, fits: fitVerdicts(measures, chart, ranked[0]) };
}

/** How each measurement sits in a given size. */
export function fitVerdicts(measures, chart, size) {
  const out = {};
  for (const m of chart.measures) {
    const v = measures[m];
    if (v == null) continue;
    const [lo, hi] = chart.sizes[size][m];
    const t = (v - lo) / (hi - lo);
    out[m] = v > hi + 2 ? 'too tight' : t > 0.75 ? 'snug' : t >= 0.25 ? 'regular' : v < lo - 4 ? 'loose' : 'relaxed';
  }
  return out;
}

/**
 * How a size of the garment sits on this body, for drawing it true to size:
 * ease per side in pixels (from the circumference difference: extra
 * circumference C adds C / 2pi to the radius) and length in pixels.
 */
export function sizeFit(chart, size, measures, pxPerCm, kind) {
  const g = chart.sizes[size].garment;
  const at = kind === 'top' || kind === 'dress' ? 'chest' : 'waist';
  const extra = (g[at] ?? measures[at]) - measures[at];
  return { easePx: (extra / (2 * Math.PI)) * pxPerCm, lengthPx: g.length * pxPerCm, tight: extra < 0 };
}
