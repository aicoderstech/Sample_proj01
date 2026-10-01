// Synthetic people with exactly known geometry: pose landmarks, a person
// segmentation mask and the true body outline. Used as ground truth by the
// fit benchmark and to drive the landing-page demo and `?pose=mock` mode.
//
// Body-local coordinates: origin at the midpoint between the shoulder
// joints, u points to the image right (the person's left), v points down.

export const BUILDS = {
  // Torso half-widths as fractions of half the shoulder-joint width.
  slim: { chest: 0.8, waist: 0.64, hip: 0.8 },
  average: { chest: 0.86, waist: 0.74, hip: 0.86 },
  broad: { chest: 0.95, waist: 0.9, hip: 0.95 },
};

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy || 1;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
  return { d: Math.hypot(px - ax - dx * t, py - ay - dy * t), t };
}

/**
 * @param {object} o
 * @param {number} [o.width] image width
 * @param {number} [o.height] image height
 * @param {number} [o.sw] shoulder-joint distance in pixels
 * @param {'slim'|'average'|'broad'} [o.build]
 * @param {[number, number]} [o.center] image position of the shoulder midpoint
 * @param {number} [o.lean] whole-body rotation in radians (around the hips)
 * @param {{imageLeft?:{upper:number,bend?:number}, imageRight?:{upper:number,bend?:number}}} [o.arms]
 *   upper: upper-arm angle below the outward horizontal; bend: elbow flexion
 *   bringing the forearm towards the body's midline (radians)
 * @param {{imageLeft?:{spread?:number,shin?:number}, imageRight?:{spread?:number,shin?:number}}} [o.legs]
 *   spread: thigh angle out from vertical; shin: shin angle out from vertical (radians)
 * @param {boolean} [o.withMask] rasterize the segmentation mask (default true)
 * @param {number} [o.maskScale] mask resolution relative to the image (default 1)
 */
export function makeSyntheticBody(o = {}) {
  const width = o.width ?? 480;
  const height = o.height ?? 640;
  const sw = o.sw ?? 120;
  const build = BUILDS[o.build || 'average'];
  const [cx, cy] = o.center ?? [width / 2, height * 0.3];
  const lean = o.lean ?? 0;
  const half = sw / 2;
  const T = 1.3 * sw; // shoulder line to hip joints
  const hipC = { u: 0, v: T };
  const cosL = Math.cos(lean);
  const sinL = Math.sin(lean);
  const toImage = (u, v) => {
    const du = u - hipC.u;
    const dv = v - hipC.v;
    return { x: cx + hipC.u + du * cosL - dv * sinL, y: cy + hipC.v + du * sinL + dv * cosL };
  };
  const toLocal = (x, y) => {
    const dx = x - cx - hipC.u;
    const dy = y - cy - hipC.v;
    return { u: hipC.u + dx * cosL + dy * sinL, v: hipC.v - dx * sinL + dy * cosL };
  };

  // Torso half-width profile (without arms), v as a fraction of T.
  const PROFILE = [
    [-0.08, 0.36],
    [-0.04, 0.62],
    [0.0, 0.95],
    [0.1, build.chest + 0.04],
    [0.27, build.chest],
    [0.5, (build.chest + build.waist) / 2],
    [0.72, build.waist],
    [1.0, build.hip],
    [1.2, build.hip * 0.98],
  ];
  const halfWidth = (v) => {
    const f = v / T;
    if (f < PROFILE[0][0] || f > PROFILE[PROFILE.length - 1][0]) return 0;
    for (let i = 1; i < PROFILE.length; i++) {
      if (f <= PROFILE[i][0]) {
        const [f0, h0] = PROFILE[i - 1];
        const [f1, h1] = PROFILE[i];
        return (h0 + ((f - f0) / (f1 - f0)) * (h1 - h0)) * half;
      }
    }
    return 0;
  };
  const neckHalf = 0.33 * half;
  const neckBaseV = -0.08 * T;

  // Limbs (local coordinates).
  const rU = 0.12 * sw;
  const rF = 0.09 * sw;
  const rH = 0.08 * sw;
  const arms = {};
  for (const [side, out] of [['imageLeft', -1], ['imageRight', 1]]) {
    const cfg = o.arms?.[side] ?? { upper: 1.35, bend: 0 };
    const th = cfg.upper;
    const bend = cfg.bend ?? 0;
    const du = { u: out * Math.cos(th), v: Math.sin(th) };
    // Elbow flexion turns the forearm towards the midline (-out direction).
    const phi = out * bend;
    const df = { u: du.u * Math.cos(phi) - du.v * Math.sin(phi), v: du.u * Math.sin(phi) + du.v * Math.cos(phi) };
    const joint = { u: out * half, v: 0 };
    const elbow = { u: joint.u + du.u * 0.82 * sw, v: joint.v + du.v * 0.82 * sw };
    const wrist = { u: elbow.u + df.u * 0.7 * sw, v: elbow.v + df.v * 0.7 * sw };
    const hand = { u: wrist.u + df.u * 0.42 * sw, v: wrist.v + df.v * 0.42 * sw };
    arms[side] = { out, joint, elbow, wrist, hand, upperDir: du, foreDir: df };
  }
  const legs = {};
  for (const [side, out] of [['imageLeft', -1], ['imageRight', 1]]) {
    const lg = o.legs?.[side] ?? {};
    const spread = lg.spread ?? 0.0088;
    const shin = lg.shin ?? 0;
    const hip = { u: out * 0.3 * sw, v: T };
    const knee = { u: hip.u + out * Math.sin(spread) * 1.13 * sw, v: T + Math.cos(spread) * 1.13 * sw };
    const ankle = { u: knee.u + out * Math.sin(shin) * 1.07 * sw, v: knee.v + Math.cos(shin) * 1.07 * sw };
    const foot = { u: ankle.u + out * 0.05 * sw, v: ankle.v + 0.1 * sw };
    legs[side] = { hip, knee, ankle, foot };
  }
  const head = { u: 0, v: -0.5 * T, ru: 0.27 * sw, rv: 0.36 * sw };

  const insideArmLocal = (u, v) => {
    for (const a of Object.values(arms)) {
      const s1 = segDist(u, v, a.joint.u, a.joint.v, a.elbow.u, a.elbow.v);
      if (s1.d <= rU + (rF - rU) * s1.t * 0.4) return true;
      const s2 = segDist(u, v, a.elbow.u, a.elbow.v, a.wrist.u, a.wrist.v);
      if (s2.d <= rF * (1 - 0.15 * s2.t)) return true;
      const s3 = segDist(u, v, a.wrist.u, a.wrist.v, a.hand.u, a.hand.v);
      if (s3.d <= rH) return true;
    }
    return false;
  };
  const insideLegLocal = (u, v) => {
    for (const l of Object.values(legs)) {
      const s1 = segDist(u, v, l.hip.u, l.hip.v, l.knee.u, l.knee.v);
      if (s1.d <= 0.17 * sw - 0.05 * sw * s1.t) return true;
      const s2 = segDist(u, v, l.knee.u, l.knee.v, l.ankle.u, l.ankle.v);
      if (s2.d <= 0.12 * sw - 0.03 * sw * s2.t) return true;
      const s3 = segDist(u, v, l.ankle.u, l.ankle.v, l.foot.u, l.foot.v);
      if (s3.d <= 0.07 * sw) return true;
    }
    return false;
  };
  const insideTorsoLocal = (u, v) => Math.abs(u) <= halfWidth(v);
  const insideNeckHeadLocal = (u, v) =>
    (v >= -0.35 * T && v <= neckBaseV + 2 && Math.abs(u) <= neckHalf) ||
    ((u - head.u) / head.ru) ** 2 + ((v - head.v) / head.rv) ** 2 <= 1;

  const truth = {
    sw,
    T,
    build: o.build || 'average',
    lean,
    toImage,
    toLocal,
    halfWidth,
    neckHalf,
    neckBaseV,
    rU,
    rF,
    /** True torso edge (no arms) at local level v, as an image point. */
    edgeAt: (v, side) => toImage((side === 'imageLeft' ? -1 : 1) * halfWidth(v), v),
    shoulderOuter: {
      imageLeft: toImage(-(half + rU), 0),
      imageRight: toImage(half + rU, 0),
    },
    neckBaseCenter: toImage(0, neckBaseV),
    head: { center: toImage(head.u, head.v), ru: head.ru, rv: head.rv, angle: lean },
    legRadii: { thigh: 0.17 * sw, knee: 0.12 * sw, ankle: 0.09 * sw },
    /** Where a dress strap rests: on the shoulder surface, 45% of the way from neck to shoulder edge. */
    strapPoint: (() => {
      const u = neckHalf + (half + rU - neckHalf) * 0.45;
      let v = neckBaseV;
      while (v < 0 && halfWidth(v) < u) v += 0.25;
      return { imageLeft: toImage(-u, v), imageRight: toImage(u, v) };
    })(),
    legs: Object.fromEntries(
      Object.entries(legs).map(([k, l]) => [k, { hip: toImage(l.hip.u, l.hip.v), knee: toImage(l.knee.u, l.knee.v), ankle: toImage(l.ankle.u, l.ankle.v) }]),
    ),
    arms: Object.fromEntries(
      Object.entries(arms).map(([k, a]) => [k, { joint: toImage(a.joint.u, a.joint.v), elbow: toImage(a.elbow.u, a.elbow.v), wrist: toImage(a.wrist.u, a.wrist.v), hand: toImage(a.hand.u, a.hand.v) }]),
    ),
    /** Pixel classification in image coordinates. */
    isTorso: (x, y) => {
      const p = toLocal(x, y);
      return insideTorsoLocal(p.u, p.v) && !insideArmLocal(p.u, p.v);
    },
    isArm: (x, y) => {
      const p = toLocal(x, y);
      return insideArmLocal(p.u, p.v);
    },
    isPerson: (x, y) => {
      const p = toLocal(x, y);
      return insideTorsoLocal(p.u, p.v) || insideArmLocal(p.u, p.v) || insideLegLocal(p.u, p.v) || insideNeckHeadLocal(p.u, p.v);
    },
  };

  // MediaPipe-style landmarks in pixels.
  const L = (u, v) => {
    const p = toImage(u, v);
    const inside = p.x >= 0 && p.x < width && p.y >= 0 && p.y < height;
    return { x: p.x, y: p.y, v: inside ? 0.99 : 0.05 };
  };
  const hv = head.v + 0.06 * sw;
  const pts = [
    L(0, hv), L(0.05 * sw, hv - 0.05 * sw), L(0.08 * sw, hv - 0.05 * sw), L(0.11 * sw, hv - 0.05 * sw),
    L(-0.05 * sw, hv - 0.05 * sw), L(-0.08 * sw, hv - 0.05 * sw), L(-0.11 * sw, hv - 0.05 * sw),
    L(0.2 * sw, hv - 0.02 * sw), L(-0.2 * sw, hv - 0.02 * sw), L(0.05 * sw, hv + 0.08 * sw), L(-0.05 * sw, hv + 0.08 * sw),
  ];
  const al = arms.imageRight; // person's left arm (odd indices)
  const ar = arms.imageLeft;
  pts[11] = L(al.joint.u, al.joint.v);
  pts[12] = L(ar.joint.u, ar.joint.v);
  pts[13] = L(al.elbow.u, al.elbow.v);
  pts[14] = L(ar.elbow.u, ar.elbow.v);
  pts[15] = L(al.wrist.u, al.wrist.v);
  pts[16] = L(ar.wrist.u, ar.wrist.v);
  pts[17] = L(al.hand.u, al.hand.v);
  pts[18] = L(ar.hand.u, ar.hand.v);
  pts[19] = L(al.hand.u, al.hand.v);
  pts[20] = L(ar.hand.u, ar.hand.v);
  pts[21] = L((al.wrist.u + al.hand.u) / 2, (al.wrist.v + al.hand.v) / 2);
  pts[22] = L((ar.wrist.u + ar.hand.u) / 2, (ar.wrist.v + ar.hand.v) / 2);
  const ll = legs.imageRight;
  const lr = legs.imageLeft;
  pts[23] = L(ll.hip.u, ll.hip.v);
  pts[24] = L(lr.hip.u, lr.hip.v);
  pts[25] = L(ll.knee.u, ll.knee.v);
  pts[26] = L(lr.knee.u, lr.knee.v);
  pts[27] = L(ll.ankle.u, ll.ankle.v);
  pts[28] = L(lr.ankle.u, lr.ankle.v);
  pts[29] = L(ll.ankle.u, ll.ankle.v + 0.05 * sw);
  pts[30] = L(lr.ankle.u, lr.ankle.v + 0.05 * sw);
  pts[31] = L(ll.foot.u, ll.foot.v);
  pts[32] = L(lr.foot.u, lr.foot.v);

  let mask = null;
  if (o.withMask !== false) {
    const scale = o.maskScale ?? 1;
    const mw = Math.round(width * scale);
    const mh = Math.round(height * scale);
    const data = new Float32Array(mw * mh);
    for (let y = 0; y < mh; y++) {
      for (let x = 0; x < mw; x++) {
        if (truth.isPerson((x + 0.5) / scale, (y + 0.5) / scale)) data[y * mw + x] = 1;
      }
    }
    mask = { data, width: mw, height: mh, scale };
  }
  return { width, height, points: pts, mask, truth };
}
