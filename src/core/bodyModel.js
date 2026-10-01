// Body model for fitting: the person's actual outline measured from the
// segmentation mask, plus limbs from the pose landmarks.
//
// The torso is measured as a half-width profile: at each level v down the
// torso axis (0 = shoulder joints, T = hip joints) we scan sideways from the
// body's centre line until we leave the person mask. Arms are excluded (each
// upper arm, forearm and hand is modelled as a capsule from the landmarks),
// so a hand resting on the hip doesn't widen the waist. Where the outline
// can't be seen (arm in front, out of frame, no mask) the profile falls back
// to the other side or to average proportions scaled to this person.
import { computeBodyFrame, LM } from './body.js';
import { clamp, lerp, normalize } from './vec.js';

// Average torso half-width profile, in units of half the shoulder-joint width.
const PRIOR = [
  [-0.3, 0.33], [-0.08, 0.36], [-0.04, 0.62], [0, 0.95], [0.1, 0.9], [0.27, 0.86],
  [0.5, 0.8], [0.72, 0.74], [1.0, 0.86], [1.2, 0.84], [1.4, 0.8],
];
const priorAt = (f) => {
  if (f <= PRIOR[0][0]) return PRIOR[0][1];
  for (let i = 1; i < PRIOR.length; i++) {
    if (f <= PRIOR[i][0]) {
      const [f0, h0] = PRIOR[i - 1];
      const [f1, h1] = PRIOR[i];
      return h0 + ((f - f0) / (f1 - f0)) * (h1 - h0);
    }
  }
  return PRIOR[PRIOR.length - 1][1];
};

const V_FROM = -0.3;
const V_TO = 1.4;
const V_STEP = 0.025;
export const ARMPIT_V = 0.27;
export const WAIST_V = 0.72;

function segDist(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy || 1;
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1);
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
}

const visible = (p) => p && p.v >= 0.5;

/**
 * @param {{x:number,y:number,v:number}[]} pts pixel landmarks
 * @param {{data: Float32Array, width: number, height: number, scale?: number}|null} mask
 *   person segmentation (0..1); scale = mask pixels per image pixel (default 1)
 */
/**
 * Rejects anatomically impossible detections (a pose model can return a
 * confident "person" on a tight crop, with the hips beside the shoulders):
 * the torso must run across the shoulder line, not along it.
 */
function plausible(pts) {
  const ls = pts[LM.LEFT_SHOULDER];
  const rs = pts[LM.RIGHT_SHOULDER];
  const lh = pts[LM.LEFT_HIP];
  const rh = pts[LM.RIGHT_HIP];
  if (!visible(lh) || !visible(rh)) return true;
  const s = { x: ls.x - rs.x, y: ls.y - rs.y };
  const t = { x: (lh.x + rh.x - ls.x - rs.x) / 2, y: (lh.y + rh.y - ls.y - rs.y) / 2 };
  const ls2 = Math.hypot(s.x, s.y) * Math.hypot(t.x, t.y);
  return ls2 < 1e-9 || Math.abs(s.x * t.x + s.y * t.y) / ls2 <= 0.9;
}

export function measureBody(pts, mask = null) {
  const frame = computeBodyFrame(pts);
  if (!frame || !plausible(pts)) return null;
  const sw = frame.shoulderWidth;
  const T = frame.torsoLength;
  const half = sw / 2;
  // The body's own coordinates: origin between the shoulder joints, u along
  // the shoulder line, v down the torso. The origin starts at the landmarks
  // and is then re-anchored to the outline (see below).
  let origin = { ...frame.shoulderMid };
  const axisAt = (v) => normalize(lerp(frame.shoulderDir, frame.hipDir, clamp(v / T, 0, 1)));
  const toImage = (u, v) => {
    const ax = axisAt(v);
    return { x: origin.x + frame.down.x * v + ax.x * u, y: origin.y + frame.down.y * v + ax.y * u };
  };
  /** Inverse of toImage (two fixed-point refinements of the shoulder/hip axis blend). */
  const toLocal = (x, y) => {
    const dx = x - origin.x;
    const dy = y - origin.y;
    let v = dx * frame.down.x + dy * frame.down.y;
    let u = 0;
    for (let k = 0; k < 3; k++) {
      const ax = axisAt(v);
      const det = frame.down.x * ax.y - frame.down.y * ax.x || 1e-9;
      v = (dx * ax.y - dy * ax.x) / det;
      u = (frame.down.x * dy - frame.down.y * dx) / det;
    }
    return { u, v };
  };

  // The mask may be lower resolution than the image (mask.scale = mask px per image px).
  const W = mask?.width ?? 0;
  const H = mask?.height ?? 0;
  const ms = mask?.scale ?? 1;
  const inFrame = (p) => p.x >= 0 && p.y >= 0 && p.x * ms < W && p.y * ms < H;
  const maskAt = (p) => mask.data[Math.floor(p.y * ms) * W + Math.floor(p.x * ms)];

  // Outward scan from a point along a direction until the mask ends.
  const scan = (from, dir, maxLen, stop) => {
    for (let d = 0; d <= maxLen; d += 0.75) {
      const p = { x: from.x + dir.x * d, y: from.y + dir.y * d };
      if (!inFrame(p)) return { d, reason: 'frame' };
      if (maskAt(p) < 0.5) return { d, reason: 'edge' };
      if (stop && stop(p)) return { d, reason: 'stop' };
    }
    return { d: maxLen, reason: 'limit' };
  };

  // Limbs. imageLeft = the person's right side (landmarks 12, 14, 16, 20).
  const limbSides = {
    imageLeft: { s: LM.RIGHT_SHOULDER, e: LM.RIGHT_ELBOW, w: LM.RIGHT_WRIST, h: 20, hip: LM.RIGHT_HIP, k: LM.RIGHT_KNEE, a: LM.RIGHT_ANKLE, f: 32 },
    imageRight: { s: LM.LEFT_SHOULDER, e: LM.LEFT_ELBOW, w: LM.LEFT_WRIST, h: 19, hip: LM.LEFT_HIP, k: LM.LEFT_KNEE, a: LM.LEFT_ANKLE, f: 31 },
  };
  // max: the widest this limb plausibly is (with clothing), in shoulder widths.
  // A limb in front of the torso has no outline edge nearby; the scan then
  // runs on across the body, so a reading well past the maximum is discarded.
  const radiusAcross = (a, b, fallback, awayFrom, max) => {
    if (!mask) return fallback;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (!inFrame(mid) || maskAt(mid) < 0.5) return fallback;
    const d = normalize({ x: b.x - a.x, y: b.y - a.y });
    let n = { x: -d.y, y: d.x };
    // Measure on the side facing away from the torso, which is never blocked.
    if ((mid.x - awayFrom.x) * n.x + (mid.y - awayFrom.y) * n.y < 0) n = { x: -n.x, y: -n.y };
    const r = scan(mid, n, sw * max * 1.4);
    if (r.reason !== 'edge') return fallback;
    return clamp(r.d, sw * 0.05, sw * max);
  };
  const centre = toImage(0, T * 0.4);
  const arms = {};
  const legs = {};
  for (const [side, ix] of Object.entries(limbSides)) {
    const joint = pts[ix.s];
    const elbow = pts[ix.e];
    const wrist = pts[ix.w];
    const handPt = pts[ix.h];
    if (visible(elbow)) {
      const rU = radiusAcross(joint, elbow, sw * 0.12, centre, 0.17);
      const chain = [joint, elbow];
      let rF = sw * 0.09;
      if (visible(wrist)) {
        rF = radiusAcross(elbow, wrist, sw * 0.09, centre, 0.13);
        chain.push(wrist);
        if (visible(handPt)) chain.push({ x: wrist.x + (handPt.x - wrist.x) * 1.3, y: wrist.y + (handPt.y - wrist.y) * 1.3 });
      }
      arms[side] = { chain: chain.map((p) => ({ x: p.x, y: p.y })), rU, rF, complete: chain.length >= 3 };
    }
    const hip = pts[ix.hip];
    const knee = pts[ix.k];
    if (visible(hip) && visible(knee)) {
      const chain = [hip, knee];
      // The foot points forward / sideways, so the leg ends at the ankle.
      if (visible(pts[ix.a])) chain.push(pts[ix.a]);
      legs[side] = { chain: chain.map((p) => ({ x: p.x, y: p.y })), r: radiusAcross(hip, knee, sw * 0.16, centre, 0.26), complete: chain.length === 3 };
    }
  }
  /** True when this upper arm hangs down (> 55 deg below horizontal), so the
   * top of the shoulder and its outer edge are clearly visible. */
  const armDown = (side) => {
    const a = arms[side];
    if (!a) return false;
    const d = { x: a.chain[1].x - a.chain[0].x, y: a.chain[1].y - a.chain[0].y };
    const along = Math.abs(d.x * frame.shoulderDir.x + d.y * frame.shoulderDir.y);
    const downward = d.x * frame.down.x + d.y * frame.down.y;
    return downward > 0 && Math.atan2(downward, along) > (55 * Math.PI) / 180;
  };
  const inArm = (p) => {
    for (const a of Object.values(arms)) {
      const c = a.chain;
      if (segDist(p, c[0], c[1]) <= a.rU * 1.12 + 1) return true;
      for (let i = 2; i < c.length; i++) if (segDist(p, c[i - 1], c[i]) <= a.rF * 1.15 + 1) return true;
    }
    return false;
  };

  // A torso half-width far wider or narrower than any build means the scan
  // ran into something else (an arm the landmarks missed, a dark background
  // merging with dark clothes, a gap between objects on the lap).
  const plausibleHalf = (d, f) => f < 0.1 || (d <= priorAt(f) * half * 1.55 && d >= priorAt(f) * half * 0.6);

  // Re-anchor the origin to the outline, which is far steadier than the
  // joint landmarks: centre it between the torso's sides, and set the
  // shoulder line one upper-arm radius below the top of the shoulders.
  if (mask) {
    // Torso centre at several heights; a line through them, extended up to
    // the shoulder line, also absorbs a slightly tilted body axis.
    const vs = [];
    const offsets = [];
    for (let f = 0.25; f <= 0.95; f += 0.05) {
      const c = toImage(0, f * T);
      if (!inFrame(c) || maskAt(c) < 0.5) continue;
      const ax = axisAt(f * T);
      const l = scan(c, { x: -ax.x, y: -ax.y }, sw * 1.3, inArm);
      const r = scan(c, ax, sw * 1.3, inArm);
      if (l.reason === 'edge' && r.reason === 'edge' && plausibleHalf(l.d, f) && plausibleHalf(r.d, f)) {
        vs.push(f * T);
        offsets.push((r.d - l.d) / 2);
      }
    }
    if (offsets.length >= 4) {
      const n0 = offsets.length;
      const mv = vs.reduce((a, b) => a + b, 0) / n0;
      const mo = offsets.reduce((a, b) => a + b, 0) / n0;
      let sxy = 0;
      let sxx = 0;
      for (let i = 0; i < n0; i++) {
        sxy += (vs[i] - mv) * (offsets[i] - mo);
        sxx += (vs[i] - mv) ** 2;
      }
      const slope = sxx ? sxy / sxx : 0;
      const du = clamp(mo - slope * mv, -sw * 0.1, sw * 0.1);
      const ax = axisAt(0);
      origin = { x: origin.x + ax.x * du, y: origin.y + ax.y * du };
    }
    const lifts = [];
    for (const [side, sgn] of [['imageLeft', -1], ['imageRight', 1]]) {
      if (!armDown(side)) continue;
      const top = toImage(sgn * half, 0);
      if (!inFrame(top) || maskAt(top) < 0.5) continue;
      const hit = scan(top, { x: -frame.down.x, y: -frame.down.y }, sw * 0.5);
      const rU = arms[side]?.rU ?? sw * 0.12;
      if (hit.reason === 'edge') lifts.push(rU - hit.d);
    }
    if (lifts.length) {
      const dv = clamp(lifts.reduce((a, b) => a + b, 0) / lifts.length, -sw * 0.08, sw * 0.08);
      origin = { x: origin.x + frame.down.x * dv, y: origin.y + frame.down.y * dv };
    }
  }

  // Torso half-width profile.
  const n = Math.round((V_TO - V_FROM) / V_STEP) + 1;
  const levels = new Float64Array(n);
  const raw = { imageLeft: new Float64Array(n), imageRight: new Float64Array(n) };
  const ok = { imageLeft: new Uint8Array(n), imageRight: new Uint8Array(n) };
  for (let i = 0; i < n; i++) {
    const v = (V_FROM + i * V_STEP) * T;
    levels[i] = v;
    if (!mask) continue;
    const c = toImage(0, v);
    if (!inFrame(c) || maskAt(c) < 0.5) continue;
    const ax = axisAt(v);
    for (const [side, sgn] of [['imageLeft', -1], ['imageRight', 1]]) {
      const r = scan(c, { x: ax.x * sgn, y: ax.y * sgn }, sw * 1.3, inArm);
      raw[side][i] = r.d;
      // Implausible widths count as unmeasured.
      ok[side][i] = r.reason === 'edge' && plausibleHalf(r.d, v / T) ? 1 : 0;
    }
  }
  // Scale the prior to this person from the reliable chest-to-hip samples.
  const ratios = [];
  for (let i = 0; i < n; i++) {
    const f = levels[i] / T;
    if (f < 0.15 || f > 1.05) continue;
    for (const side of ['imageLeft', 'imageRight']) if (ok[side][i]) ratios.push(raw[side][i] / (priorAt(f) * half));
  }
  ratios.sort((a, b) => a - b);
  const priorScale = ratios.length >= 4 ? ratios[ratios.length >> 1] : 1;
  const profile = { imageLeft: new Float64Array(n), imageRight: new Float64Array(n) };
  let reliable = 0;
  for (let i = 0; i < n; i++) {
    for (const [side, other] of [['imageLeft', 'imageRight'], ['imageRight', 'imageLeft']]) {
      if (ok[side][i]) {
        profile[side][i] = raw[side][i];
        reliable++;
      } else if (ok[other][i]) profile[side][i] = raw[other][i];
      // The neck and shoulder tops don't scale with chest width.
      else profile[side][i] = priorAt(levels[i] / T) * half * (levels[i] < 0.05 * T ? 1 : priorScale);
    }
  }
  // Light smoothing across levels (3-tap median) to drop single-pixel noise.
  for (const side of ['imageLeft', 'imageRight']) {
    const p = profile[side];
    const copy = Float64Array.from(p);
    for (let i = 1; i < n - 1; i++) {
      const a = copy[i - 1];
      const b = copy[i];
      const c = copy[i + 1];
      p[i] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
    }
  }
  // Below the upper hips the outline may include the thighs (legs apart, a
  // lunge, a step). Garments hang from the hips, so cap the lower profile to
  // the measured upper-hip width grown by average hip proportions.
  const refF = 0.85;
  const refI = Math.round((refF - V_FROM) / V_STEP);
  for (const side of ['imageLeft', 'imageRight']) {
    const ref = profile[side][refI];
    for (let i = refI + 1; i < n; i++) {
      const cap = ref * (priorAt(levels[i] / T) / priorAt(refF)) * 1.06;
      if (profile[side][i] > cap) profile[side][i] = cap;
    }
  }
  const halfAt = (v, side) => {
    const f = clamp((v / T - V_FROM) / V_STEP, 0, n - 1);
    const i = Math.floor(f);
    const j = Math.min(n - 1, i + 1);
    return profile[side][i] + (profile[side][j] - profile[side][i]) * (f - i);
  };

  // Neck: the narrowest part between the head and the shoulders.
  let neckHalf = 0.33 * half * priorScale;
  if (mask) {
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const f = levels[i] / T;
      if (f < -0.22 || f > -0.05 || !ok.imageLeft[i] || !ok.imageRight[i]) continue;
      best = Math.min(best, (raw.imageLeft[i] + raw.imageRight[i]) / 2);
    }
    if (Number.isFinite(best)) neckHalf = best;
  }
  let neckBaseV = -0.08 * T;
  for (let i = 0; i < n; i++) {
    const f = levels[i] / T;
    if (f < -0.2 || f > 0) continue;
    if ((profile.imageLeft[i] + profile.imageRight[i]) / 2 > neckHalf * 1.25) {
      neckBaseV = levels[Math.max(0, i - 1)];
      break;
    }
  }
  // A high collar or hair merging with the shoulders in the mask can't move
  // the base of the neck outside its anatomical range.
  neckBaseV = clamp(neckBaseV, -0.18 * sw, -0.04 * sw);

  // Shoulder edges: the outline along the shoulder line when it can be seen
  // (much steadier than the joint landmarks), else joint + upper-arm radius.
  // Armpits: where the underside of the arm meets the side of the torso.
  // Going up the side of the torso, the outline is the torso's own until
  // the arm takes over. With the arm hanging down that point is hidden, so
  // we use the average height; raising the arm lifts it.
  const elevation = {};
  const armpitSide = {};
  for (const [side, sgn] of [['imageLeft', -1], ['imageRight', 1]]) {
    const a = arms[side];
    let angle = Math.PI / 2;
    if (a) {
      const d = { x: a.chain[1].x - a.chain[0].x, y: a.chain[1].y - a.chain[0].y };
      const along = Math.abs(d.x * frame.shoulderDir.x + d.y * frame.shoulderDir.y);
      angle = Math.atan2(d.x * frame.down.x + d.y * frame.down.y, along);
    }
    elevation[side] = angle;
    let level = ARMPIT_V * T;
    if (mask && a && !armDown(side)) {
      for (let f = 0.5; f >= 0.04; f -= 0.01) {
        const c = toImage(0, f * T);
        if (!inFrame(c) || maskAt(c) < 0.5) break;
        const ax = axisAt(f * T);
        const r = scan(c, { x: ax.x * sgn, y: ax.y * sgn }, sw * 1.3, inArm);
        if (r.reason === 'stop') {
          level = (f + 0.01) * T;
          break;
        }
      }
    } else if (!mask && a) {
      level = (0.1 + 0.17 * clamp(angle / (Math.PI / 3), 0, 1)) * T;
    }
    armpitSide[side] = clamp(level, 0.06 * T, ARMPIT_V * T);
  }

  const shoulderOuter = {};
  const ax0 = axisAt(0);
  for (const [side, sgn, idx] of [['imageLeft', -1, LM.RIGHT_SHOULDER], ['imageRight', 1, LM.LEFT_SHOULDER]]) {
    const j = pts[idx];
    const r = arms[side]?.rU ?? sw * 0.12;
    let point = { x: j.x + ax0.x * sgn * r, y: j.y + ax0.y * sgn * r };
    if (mask && armDown(side)) {
      const c = toImage(0, 0);
      if (inFrame(c) && maskAt(c) >= 0.5) {
        const hit = scan(c, { x: ax0.x * sgn, y: ax0.y * sgn }, half + r * 2.2);
        if (hit.reason === 'edge' && hit.d >= half + r * 0.4) point = { x: c.x + ax0.x * sgn * hit.d, y: c.y + ax0.y * sgn * hit.d };
      }
    }
    shoulderOuter[side] = point;
  }

  return {
    frame,
    sw,
    T,
    toImage,
    toLocal,
    halfAt,
    levels,
    profile,
    neckHalf,
    neckBaseV,
    armpitV: ARMPIT_V * T,
    armpitSide,
    armElevation: elevation,
    waistV: WAIST_V * T,
    hipV: T,
    shoulderOuter,
    arms,
    legs,
    hasMask: !!mask,
    reliability: mask ? reliable / (2 * n) : 0,
  };
}

/**
 * Temporal smoothing for live video: the outline measured from each camera
 * frame flickers by a pixel or two, which would make the garment's edges
 * shimmer. Blends each new measurement with the previous one.
 */
export class BodyFilter {
  constructor(alpha = 0.4) {
    this.alpha = alpha;
    this.prev = null;
  }

  reset() {
    this.prev = null;
  }

  apply(body) {
    if (!body) {
      this.prev = null;
      return null;
    }
    const p = this.prev;
    if (!p || p.levels.length !== body.levels.length || Math.abs(p.sw - body.sw) > body.sw * 0.25) {
      this.prev = body;
      return body;
    }
    const a = this.alpha;
    const mix = (x, y) => y + (x - y) * a;
    for (const side of ['imageLeft', 'imageRight']) {
      const cur = body.profile[side];
      const old = p.profile[side];
      for (let i = 0; i < cur.length; i++) cur[i] = mix(cur[i], old[i]);
      const so = body.shoulderOuter[side];
      const po = p.shoulderOuter[side];
      body.shoulderOuter[side] = { x: mix(so.x, po.x), y: mix(so.y, po.y) };
      if (body.armpitSide && p.armpitSide) body.armpitSide[side] = mix(body.armpitSide[side], p.armpitSide[side]);
      for (const key of ['rU', 'rF']) {
        if (body.arms[side] && p.arms[side]) body.arms[side][key] = mix(body.arms[side][key], p.arms[side][key]);
      }
      if (body.legs[side] && p.legs[side]) body.legs[side].r = mix(body.legs[side].r, p.legs[side].r);
    }
    body.neckHalf = mix(body.neckHalf, p.neckHalf);
    body.neckBaseV = mix(body.neckBaseV, p.neckBaseV);
    this.prev = body;
    return body;
  }
}
