// Garment "rig": the construction points of a flat garment image (collar,
// shoulder seams, armpits, waist, hem, sleeve and leg axes) plus a part
// label per pixel, measured from its silhouette. The fit engine pins these
// points to the matching points on the body.
//
// All coordinates are garment-image pixels. "imageLeft"/"imageRight" are the
// sides of the image (a garment photographed from the front).
import { deriveAnchors } from './garment.js';

export const PART = { NONE: 0, BODY: 1, SLEEVE_LEFT: 2, SLEEVE_RIGHT: 3, LEG_LEFT: 4, LEG_RIGHT: 5 };

function rowRun(a, y) {
  const r = Math.round(y) - a.bbox.y;
  if (r < 0 || r >= a.bbox.h || !a.rows.width[r]) return null;
  return { l: a.rows.left[r], r: a.rows.right[r], w: a.rows.width[r] };
}

/** Lowest opaque pixel in column x (the hem at that column). */
function bottomAt(a, x) {
  const xi = Math.round(x);
  for (let y = a.bbox.y + a.bbox.h - 1; y >= a.bbox.y; y--) if (a.mask[y * a.width + xi]) return { x: xi, y };
  return { x: xi, y: a.bbox.y + a.bbox.h - 1 };
}

/** Bounding box of each part label. */
function partRects(a, parts) {
  const rects = {};
  for (let y = a.bbox.y; y < a.bbox.y + a.bbox.h; y++) {
    for (let x = a.bbox.x; x < a.bbox.x + a.bbox.w; x++) {
      const p = parts[y * a.width + x];
      if (!p) continue;
      const r = (rects[p] ||= { x0: x, y0: y, x1: x, y1: y });
      if (x < r.x0) r.x0 = x;
      if (x > r.x1) r.x1 = x;
      if (y < r.y0) r.y0 = y;
      if (y > r.y1) r.y1 = y;
    }
  }
  return Object.fromEntries(Object.entries(rects).map(([k, r]) => [k, { x: r.x0 - 2, y: r.y0 - 2, w: r.x1 - r.x0 + 5, h: r.y1 - r.y0 + 5 }]));
}

/** Widest run among the last `frac` of the garment's rows (curved hems). */
function widestRunNearBottom(a, frac = 0.06) {
  let best = null;
  const end = a.bbox.y + a.bbox.h - 1;
  for (let y = end; y >= end - Math.max(3, a.bbox.h * frac); y--) {
    const run = rowRun(a, y);
    if (run && (!best || run.w > best.w)) best = { ...run, y };
  }
  return best;
}

/** Nearest row at or around y (searching up to `span` rows) that has a run. */
function runNear(a, y, span = 6) {
  for (let d = 0; d <= span; d++) {
    const r1 = rowRun(a, y - d);
    if (r1) return { ...r1, y: Math.round(y) - d };
    const r2 = rowRun(a, y + d);
    if (r2) return { ...r2, y: Math.round(y) + d };
  }
  return null;
}

const opaque = (a, x, y) => {
  const xi = Math.round(x);
  const yi = Math.round(y);
  return xi >= 0 && yi >= 0 && xi < a.width && yi < a.height && a.mask[yi * a.width + xi] === 1;
};

/**
 * Describes a limb part (sleeve or trouser leg) from its pixels: an axis
 * from the middle of the seam where it joins the body (seamA-seamB) towards
 * its cuff or hem, and the part's extent on each side along that axis.
 */
function limbFromPixels(pixels, seamA, seamB, isPart) {
  const n = pixels.xs.length;
  if (n < 30) return null;
  const root = { x: (seamA.x + seamB.x) / 2, y: (seamA.y + seamB.y) / 2 };
  let sx = seamB.x - seamA.x;
  let sy = seamB.y - seamA.y;
  const sl = Math.hypot(sx, sy) || 1;
  sx /= sl;
  sy /= sl;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += pixels.xs[i];
    my += pixels.ys[i];
  }
  mx /= n;
  my /= n;
  // Seam normal pointing into the limb.
  let out = { x: -sy, y: sx };
  if ((mx - root.x) * out.x + (my - root.y) * out.y < 0) out = { x: -out.x, y: -out.y };
  // The axis runs from the seam midpoint to the centre of the cuff (or hem):
  // the outline points farthest from the seam midpoint. Their centroid sits
  // in the middle of the opening even when the cuff is cut at a slant.
  let maxR = 0;
  const outline = [];
  for (let i = 0; i < n; i++) {
    const x = pixels.xs[i];
    const y = pixels.ys[i];
    if (isPart(x - 1, y) && isPart(x + 1, y) && isPart(x, y - 1) && isPart(x, y + 1)) continue;
    const r = Math.hypot(x - root.x, y - root.y);
    outline.push([x, y, r]);
    if (r > maxR) maxR = r;
  }
  let fx = 0;
  let fy = 0;
  let fn = 0;
  for (const [x, y, r] of outline) {
    if (r >= maxR * 0.8) {
      fx += x;
      fy += y;
      fn++;
    }
  }
  const far = fn ? { x: fx / fn, y: fy / fn } : { x: mx, y: my };
  const dl = Math.hypot(far.x - root.x, far.y - root.y) || 1;
  const dir = dl > 1 ? { x: (far.x - root.x) / dl, y: (far.y - root.y) / dl } : out;
  const nrm = { x: -dir.y, y: dir.x };
  let maxS = 0;
  const ss = new Float64Array(n);
  const tt = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const dx = pixels.xs[i] - root.x;
    const dy = pixels.ys[i] - root.y;
    ss[i] = dx * dir.x + dy * dir.y;
    tt[i] = dx * nrm.x + dy * nrm.y;
    if (ss[i] > maxS) maxS = ss[i];
  }
  const length = Math.max(1, maxS);
  const BINS = 12;
  const lo = new Array(BINS).fill(Infinity);
  const hi = new Array(BINS).fill(-Infinity);
  for (let i = 0; i < n; i++) {
    if (ss[i] < 0) continue;
    const b = Math.min(BINS - 1, Math.floor((ss[i] / length) * BINS));
    if (tt[i] < lo[b]) lo[b] = tt[i];
    if (tt[i] > hi[b]) hi[b] = tt[i];
  }
  for (let b = 0; b < BINS; b++) {
    if (!(hi[b] > lo[b])) {
      let k = 1;
      while (k < BINS && !(hi[b - k] > lo[b - k]) && !(hi[b + k] > lo[b + k])) k++;
      const src = hi[b - k] > lo[b - k] ? b - k : b + k;
      lo[b] = lo[src] ?? -length * 0.2;
      hi[b] = hi[src] ?? length * 0.2;
    }
  }
  return {
    root,
    end: far,
    dir,
    nrm,
    length,
    lo,
    hi,
    halfWidth: lo.map((l, b) => (hi[b] - l) / 2),
    seam: [seamA, seamB],
    count: n,
  };
}

/** Interpolated cross-section of a limb part at axis position s: { lo, hi } offsets. */
export function limbSectionAt(limb, s) {
  const BINS = limb.lo.length;
  const f = Math.min(BINS - 1, Math.max(0, (s / limb.length) * BINS - 0.5));
  const i = Math.floor(f);
  const j = Math.min(BINS - 1, i + 1);
  const k = f - i;
  return { lo: limb.lo[i] + (limb.lo[j] - limb.lo[i]) * k, hi: limb.hi[i] + (limb.hi[j] - limb.hi[i]) * k };
}

function topRig(a, type) {
  const anchors = deriveAnchors(a, type);
  const { bbox } = a;
  const fw = anchors.fitWidth;
  const cx = anchors.centerX;
  const shoulderRow = anchors.anchorY;
  const bottom = bbox.y + bbox.h - 1;

  // Sleeves: below the armhole they separate from the torso, so rows there
  // have opaque pixels outside the central (torso) run. The armpit is the
  // last row where a sleeve still touches the torso.
  const gapRow = { imageLeft: -1, imageRight: -1 };
  for (let y = Math.round(shoulderRow + fw * 0.05); y < bbox.y + bbox.h * 0.85; y++) {
    const run = rowRun(a, y);
    // Only rows where the torso is at full width (not straps or a collar).
    if (!run || run.w < fw * 0.85) continue;
    const row = y * a.width;
    if (gapRow.imageLeft < 0) {
      for (let x = bbox.x; x < run.l - 2; x++) if (a.mask[row + x]) { gapRow.imageLeft = y; break; }
    }
    if (gapRow.imageRight < 0) {
      for (let x = run.r + 3; x < bbox.x + bbox.w; x++) if (a.mask[row + x]) { gapRow.imageRight = y; break; }
    }
    if (gapRow.imageLeft >= 0 && gapRow.imageRight >= 0) break;
  }
  const gapRows = [gapRow.imageLeft, gapRow.imageRight].filter((y) => y >= 0);
  let armpitY = gapRows.length ? Math.round(gapRows.reduce((s, y) => s + y, 0) / gapRows.length) - 1 : -1;
  const hasSleeves = armpitY > 0;
  if (!hasSleeves) {
    // Sleeveless: the armhole bottom is where the body reaches full width.
    let firstFull = -1;
    for (let y = bbox.y; y < bottom; y++) {
      const run = rowRun(a, y);
      if (run && run.w >= fw * 0.85) {
        firstFull = y;
        break;
      }
    }
    armpitY = firstFull > shoulderRow + fw * 0.2 ? firstFull : Math.min(bottom - 2, shoulderRow + fw * 0.45);
  }
  const armRun = runNear(a, armpitY + 1) || { l: cx - fw / 2, r: cx + fw / 2, y: armpitY };
  const armpitL = { x: armRun.l, y: armRun.y };
  const armpitR = { x: armRun.r, y: armRun.y };

  const hemRun = widestRunNearBottom(a) || { l: cx - fw / 2, r: cx + fw / 2, y: bottom };
  const hemL = { x: hemRun.l, y: hemRun.y };
  const hemR = { x: hemRun.r, y: hemRun.y };

  // Waist: narrowest point between armpit and hem (if the garment is shaped).
  const span = hemRun.y - armRun.y;
  let waistY = armRun.y + span * 0.6;
  let minW = Infinity;
  for (let y = armRun.y + span * 0.25; y <= hemRun.y - span * 0.15; y++) {
    const run = rowRun(a, y);
    if (run && run.w < minW) {
      minW = run.w;
      waistY = y;
    }
  }
  if (!(minW < armRun.r - armRun.l - fw * 0.03)) waistY = armRun.y + span * 0.6;
  const waistRun = runNear(a, waistY) || armRun;
  const waistL = { x: waistRun.l, y: waistRun.y };
  const waistR = { x: waistRun.r, y: waistRun.y };

  // Side seam samples between armpit and hem.
  const sides = [];
  for (let i = 1; i <= 7; i++) {
    const run = runNear(a, armRun.y + (span * i) / 8, 3);
    if (run) sides.push({ y: run.y, l: run.l, r: run.r });
  }

  // Neckline: a transparent gap around the centre at the top.
  const topY = bbox.y;
  let neckL = null;
  let neckR = null;
  let neckC = { x: cx, y: topY };
  const probeY = topY + Math.max(2, Math.round(bbox.h * 0.02));
  if (!opaque(a, cx, probeY)) {
    let xl = cx;
    while (xl > bbox.x && !opaque(a, xl, probeY)) xl--;
    let xr = cx;
    while (xr < bbox.x + bbox.w && !opaque(a, xr, probeY)) xr++;
    if (xl > bbox.x && xr < bbox.x + bbox.w) {
      neckL = { x: xl, y: probeY };
      neckR = { x: xr, y: probeY };
      let dropY = probeY;
      while (dropY < armRun.y && !opaque(a, cx, dropY)) dropY++;
      neckC = { x: cx, y: dropY };
    }
  }

  // Shoulder seam ends. The top outline runs gently down from the collar
  // along the shoulder, then turns steeply down the sleeve: the shoulder
  // point is that corner.
  const topContour = (x) => {
    for (let y = topY; y <= bottom; y++) if (opaque(a, x, y)) return y;
    return bottom;
  };
  const shoulderCorner = (dir, startX, fallbackX) => {
    const w = Math.max(3, Math.round(fw * 0.03));
    const limit = dir < 0 ? bbox.x + w : bbox.x + bbox.w - 1 - w;
    for (let x = Math.round(startX); dir < 0 ? x > limit : x < limit; x += dir) {
      const slope = (topContour(x + dir * w) - topContour(x)) / w;
      if (slope > 0.6) return { x, y: topContour(x) };
    }
    return { x: fallbackX, y: topContour(fallbackX) };
  };
  let shoulderL;
  let shoulderR;
  if (!hasSleeves && neckL) {
    // Straps / tank top: outer edge of each strap at the top.
    let xl = neckL.x;
    while (xl > bbox.x && opaque(a, xl - 1, probeY)) xl--;
    let xr = neckR.x;
    while (xr < bbox.x + bbox.w && opaque(a, xr + 1, probeY)) xr++;
    shoulderL = { x: xl, y: topContour(xl) };
    shoulderR = { x: xr, y: topContour(xr) };
  } else if (hasSleeves) {
    // Start outside the collar / hood, which have steep edges of their own.
    const startL = Math.min(neckL ? neckL.x - fw * 0.05 : Infinity, cx - fw * 0.33);
    const startR = Math.max(neckR ? neckR.x + fw * 0.05 : -Infinity, cx + fw * 0.33);
    shoulderL = shoulderCorner(-1, startL, armpitL.x + fw * 0.03);
    shoulderR = shoulderCorner(1, startR, armpitR.x - fw * 0.03);
  } else {
    shoulderL = { x: armpitL.x + fw * 0.03, y: topContour(armpitL.x + fw * 0.03) };
    shoulderR = { x: armpitR.x - fw * 0.03, y: topContour(armpitR.x - fw * 0.03) };
  }

  // Part labels and sleeve axes.
  const parts = new Uint8Array(a.width * a.height);
  const sleevePx = { imageLeft: { xs: [], ys: [] }, imageRight: { xs: [], ys: [] } };
  const seamX = (p0, p1, y) => (p1.y === p0.y ? p0.x : p0.x + ((p1.x - p0.x) * (y - p0.y)) / (p1.y - p0.y));
  for (let y = bbox.y; y < bbox.y + bbox.h; y++) {
    const run = rowRun(a, y);
    for (let x = bbox.x; x < bbox.x + bbox.w; x++) {
      const i = y * a.width + x;
      if (!a.mask[i]) continue;
      let part = PART.BODY;
      if (hasSleeves) {
        if (y <= armRun.y) {
          if (x < seamX(shoulderL, armpitL, y) - 1) part = PART.SLEEVE_LEFT;
          else if (x > seamX(shoulderR, armpitR, y) + 1) part = PART.SLEEVE_RIGHT;
        } else if (run) {
          if (x < run.l - 1) part = PART.SLEEVE_LEFT;
          else if (x > run.r + 1) part = PART.SLEEVE_RIGHT;
        }
      }
      parts[i] = part;
      if (part === PART.SLEEVE_LEFT) {
        sleevePx.imageLeft.xs.push(x);
        sleevePx.imageLeft.ys.push(y);
      } else if (part === PART.SLEEVE_RIGHT) {
        sleevePx.imageRight.xs.push(x);
        sleevePx.imageRight.ys.push(y);
      }
    }
  }
  const sleeves = {};
  if (hasSleeves) {
    const is = (part) => (x, y) => x >= 0 && y >= 0 && x < a.width && y < a.height && parts[y * a.width + x] === part;
    const rl = limbFromPixels(sleevePx.imageLeft, shoulderL, armpitL, is(PART.SLEEVE_LEFT));
    const rr = limbFromPixels(sleevePx.imageRight, shoulderR, armpitR, is(PART.SLEEVE_RIGHT));
    if (rl) sleeves.imageLeft = rl;
    if (rr) sleeves.imageRight = rr;
  }

  return {
    type,
    kind: type === 'dress' ? 'dress' : 'top',
    centerX: cx,
    fitWidth: fw,
    chestWidth: armRun.r - armRun.l,
    kp: { neckL, neckR, neckC, shoulderL, shoulderR, armpitL, armpitR, waistL, waistR, hemL, hemR, hemC: bottomAt(a, cx) },
    sides,
    sleeves,
    legs: {},
    parts,
    partRects: partRects(a, parts),
    anchors,
  };
}

function bottomRig(a) {
  const anchors = deriveAnchors(a, 'bottom');
  const { bbox } = a;
  const cx = anchors.centerX;
  const bottom = bbox.y + bbox.h - 1;
  const waistRun = runNear(a, bbox.y + Math.max(1, bbox.h * 0.01)) || { l: bbox.x, r: bbox.x + bbox.w, y: bbox.y };
  const waistW = waistRun.r - waistRun.l;

  // Trousers: the centre column becomes transparent between the legs.
  let crotchY = -1;
  for (let y = bottom; y > bbox.y + bbox.h * 0.15; y--) {
    if (opaque(a, cx, y)) {
      crotchY = y + 1;
      break;
    }
  }
  const legGap = crotchY > 0 && crotchY < bottom - bbox.h * 0.2;
  const hipY = Math.min(bbox.y + bbox.h * 0.4, waistRun.y + waistW * 0.45, legGap ? crotchY - 2 : Infinity);
  const hipRun = runNear(a, hipY) || waistRun;

  const parts = new Uint8Array(a.width * a.height);
  const legPx = { imageLeft: { xs: [], ys: [] }, imageRight: { xs: [], ys: [] } };
  for (let y = bbox.y; y < bbox.y + bbox.h; y++) {
    for (let x = bbox.x; x < bbox.x + bbox.w; x++) {
      const i = y * a.width + x;
      if (!a.mask[i]) continue;
      let part = PART.BODY;
      if (legGap && y >= crotchY) part = x < cx ? PART.LEG_LEFT : PART.LEG_RIGHT;
      else if (legGap && y > hipRun.y) {
        // Each leg starts at a seam running from the crotch up to the outer
        // hip, so the whole thigh pivots at the hip joint (a lunge, a step).
        const f = (y - hipRun.y) / Math.max(1, crotchY - hipRun.y);
        if (x < hipRun.l + (cx - hipRun.l) * f) part = PART.LEG_LEFT;
        else if (x > hipRun.r + (cx - hipRun.r) * f) part = PART.LEG_RIGHT;
      }
      parts[i] = part;
      if (part === PART.LEG_LEFT) {
        legPx.imageLeft.xs.push(x);
        legPx.imageLeft.ys.push(y);
      } else if (part === PART.LEG_RIGHT) {
        legPx.imageRight.xs.push(x);
        legPx.imageRight.ys.push(y);
      }
    }
  }
  const legs = {};
  if (legGap) {
    const is = (part) => (x, y) => x >= 0 && y >= 0 && x < a.width && y < a.height && parts[y * a.width + x] === part;
    const crotch = { x: cx, y: crotchY };
    const rl = limbFromPixels(legPx.imageLeft, crotch, { x: hipRun.l, y: hipRun.y }, is(PART.LEG_LEFT));
    const rr = limbFromPixels(legPx.imageRight, { x: hipRun.r, y: hipRun.y }, crotch, is(PART.LEG_RIGHT));
    if (rl) legs.imageLeft = rl;
    if (rr) legs.imageRight = rr;
  }
  const hemRun = widestRunNearBottom(a);
  // For trousers, hem points are the outer edges of each leg at the bottom.
  let hemL;
  let hemR;
  if (legGap) {
    const y = bottom - 2;
    let xl = bbox.x;
    while (xl < cx && !opaque(a, xl, y)) xl++;
    let xr = bbox.x + bbox.w;
    while (xr > cx && !opaque(a, xr, y)) xr--;
    hemL = { x: xl, y };
    hemR = { x: xr, y };
  } else {
    hemL = { x: hemRun ? hemRun.l : bbox.x, y: hemRun ? hemRun.y : bottom };
    hemR = { x: hemRun ? hemRun.r : bbox.x + bbox.w, y: hemRun ? hemRun.y : bottom };
  }
  const span = bottom - waistRun.y;
  const sides = [];
  const sideEnd = legGap ? hipRun.y : hemL.y;
  for (let i = 1; i <= 6; i++) {
    const y = waistRun.y + ((sideEnd - waistRun.y) * i) / 7;
    if (legGap) {
      let xl = bbox.x;
      while (xl < cx && !opaque(a, xl, y)) xl++;
      let xr = bbox.x + bbox.w;
      while (xr > cx && !opaque(a, xr, y)) xr--;
      sides.push({ y: Math.round(y), l: xl, r: xr });
    } else {
      const run = runNear(a, y, 3);
      if (run) sides.push({ y: run.y, l: run.l, r: run.r });
    }
  }
  return {
    type: 'bottom',
    kind: legGap ? 'trousers' : 'skirt',
    centerX: cx,
    fitWidth: waistW,
    kp: {
      waistL: { x: waistRun.l, y: waistRun.y },
      waistR: { x: waistRun.r, y: waistRun.y },
      hipL: { x: hipRun.l, y: hipRun.y },
      hipR: { x: hipRun.r, y: hipRun.y },
      crotch: legGap ? { x: cx, y: crotchY } : null,
      hemL,
      hemR,
      hemC: legGap ? null : bottomAt(a, cx),
    },
    span,
    sides,
    sleeves: {},
    legs,
    parts,
    partRects: partRects(a, parts),
    anchors,
  };
}

/**
 * @param analysis result of analyzeGarment() (with mask)
 * @param {'top'|'dress'|'bottom'} type
 */
export function buildGarmentRig(analysis, type) {
  if (!analysis || !analysis.rows) return null;
  return type === 'bottom' ? bottomRig(analysis) : topRig(analysis, type);
}

