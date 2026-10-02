// Fit engine v2: pins a garment's construction points onto the measured body.
//
//  - Torso (and skirt / trouser seat): a thin-plate spline through pairs of
//    garment points and body points: shoulder seams to the shoulder edges,
//    neckline to the neck base, armpits, side seams, waist and hem to the
//    body outline at the matching height. Each side seam point follows a
//    drape rule: the fabric rests on the body (plus a little ease) where the
//    body is wider than the garment, and keeps the garment's own width where
//    the garment is wider (a T-shirt hanging straight, a skirt flaring out).
//  - Sleeves and trouser legs: a spine warp along the real arm / leg
//    (shoulder -> elbow -> wrist -> hand, hip -> knee -> ankle), bending at
//    the joints, sized to the limb, and blended into the torso at the seam.
//
// Lengths: a flat garment is wider than it looks when worn (it wraps round
// the body), so garment lengths are scaled by the body's visible width
// divided by FLAT_TO_VISIBLE.
import { limbSectionAt, PART } from './garmentRig.js';
import { makeSpine } from './spine.js';
import { turnAcross } from './orientation.js';
import { fitTps } from './tps.js';
import { clamp, smoothstep } from './vec.js';

export const FIT2 = {
  flatToVisible: 0.66, // visible body width / flat garment width when worn
  ease: 0.035, // per-side ease at a "100%" fit, in shoulder widths
  sleeveFlatToRound: 0.64, // flat sleeve half-width -> visible sleeve radius (2/pi)
  waistRise: 0.15, // trousers / skirts sit this far (x torso length) above the hip joints
  rootBlend: 0.08, // fraction of a sleeve / leg over which it blends from the torso warp
  crotchDrop: 0.22, // trouser crotch below the hip joints, in shoulder widths
};

const lerpPt = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

function gridSize(rect, target) {
  const aspect = rect.h / Math.max(1, rect.w);
  const cols = clamp(Math.round(Math.sqrt(target / aspect)), 4, 40);
  const rows = clamp(Math.round(cols * aspect), 4, 48);
  return { cols, rows };
}

/**
 * @param body   result of measureBody()
 * @param rig    result of buildGarmentRig()
 * @param adjust { size, length, offset } user fine-tuning (1, 1, 0 = automatic fit);
 *               { easePx, lengthPx } draw a chosen size true to its measurements
 * @returns {{parts: object[], mapPoint: Function, scale: {kx:number, sLen:number}, pins: object[]}}
 */
export function fitGarment(body, rig, adjust = {}, { followArms = true } = {}) {
  const size = adjust.size ?? 1;
  // A bigger size is longer as well as wider.
  const lengthK = (adjust.length ?? 1) * size;
  const vOff = (adjust.offset ?? 0) * body.T;
  const { sw, T } = body;
  // Ease per side; a chosen size drawn true to its measurements sets it in
  // pixels (adjust.easePx; a size too small sits tight on the body).
  const e = adjust.easePx != null ? clamp(adjust.easePx, -0.01 * sw, 0.35 * sw) : sw * Math.max(0, FIT2.ease + 0.25 * (size - 1));
  const cx = rig.centerX;
  const kp = rig.kp;
  const L = 'imageLeft';
  const R = 'imageRight';
  const half = (v, side) => body.halfAt(v, side);

  const src = [];
  const dst = [];
  const pin = (g, u, v) => {
    if (!g) return;
    src.push({ x: g.x, y: g.y });
    dst.push({ x: u, y: v + vOff });
  };
  /** Drape rule for a side seam point at body level v. */
  const sideU = (v, side, garmentHalf, kx) => Math.max(half(v, side) + e, garmentHalf * kx);

  let kx;
  let sLen;
  let vOfY;
  if (rig.type !== 'bottom') {
    const yAp = (kp.armpitL.y + kp.armpitR.y) / 2;
    const gChest = Math.max(1, kp.armpitR.x - kp.armpitL.x);
    const bChest = half(body.armpitV, L) + half(body.armpitV, R);
    kx = (bChest + 2 * e) / gChest;
    sLen = (bChest / FIT2.flatToVisible / gChest) * lengthK;
    // True length for a chosen size: shoulder to hem.
    if (adjust.lengthPx) sLen = adjust.lengthPx / Math.max(1, kp.hemC.y - (kp.shoulderL.y + kp.shoulderR.y) / 2);
    const hasSleeves = Object.keys(rig.sleeves).length > 0;
    const straps = !hasSleeves && !!kp.neckL;

    // The top of the shoulders: neck base, sloping down to the shoulder edge.
    const shoulderReach = (side) => Math.abs(body.toLocal(body.shoulderOuter[side].x, body.shoulderOuter[side].y).u);
    // Measured from the outline: the highest level at which the body is at
    // least u wide (the curve of the trapezius), between neck base and joints.
    // Never above the base of the neck (a jacket collar can widen the outline there).
    const topLineV = (u, side) => {
      if (u <= body.neckHalf) return body.neckBaseV;
      const step = T * 0.005;
      const lift = body.neckBaseV * clamp(1 - (u - body.neckHalf) / Math.max(1, shoulderReach(side) - body.neckHalf), 0, 1);
      for (let v = body.neckBaseV; v < 0; v += step) if (body.halfAt(v, side) >= u) return Math.max(v, lift);
      return 0;
    };
    const strapU = (side) => body.neckHalf + (shoulderReach(side) - body.neckHalf) * 0.45;

    // Shoulder seams sit on the top-outer corner of each shoulder cap
    // (slightly outside it, so the fabric covers the outline).
    const cornerAt = (side) => {
      const c = body.toLocal(body.shoulderCorner[side].x, body.shoulderCorner[side].y);
      return { u: c.u + Math.sign(c.u) * 0.01 * sw, v: c.v - 0.012 * sw };
    };
    const cL = cornerAt(L);
    const cR = cornerAt(R);
    const ySh = (kp.shoulderL.y + kp.shoulderR.y) / 2;
    const vSh = straps ? (topLineV(strapU(L), L) + topLineV(strapU(R), R)) / 2 : (cL.v + cR.v) / 2;
    // A loose armhole may hang a little below the armpit, never far below it.
    const vAp = clamp(vSh + (yAp - ySh) * sLen, body.armpitV, body.armpitV + 0.2 * sw);
    const upperSlope = (vAp - vSh) / Math.max(1, yAp - ySh);
    vOfY = (y) => (y >= yAp ? vAp + (y - yAp) * sLen : vSh + (y - ySh) * upperSlope);

    // Shoulders.
    if (straps) {
      pin(kp.shoulderL, -strapU(L), topLineV(strapU(L), L));
      pin(kp.shoulderR, strapU(R), topLineV(strapU(R), R));
    } else {
      pin(kp.shoulderL, cL.u, cL.v);
      pin(kp.shoulderR, cR.u, cR.v);
    }
    // The top of the shoulders, measured from the outline; never above the
    // base of the neck.
    const shoulderTop = (u, side) => (straps || !body.shoulderTopV ? topLineV(u, side) : u <= body.neckHalf ? body.neckBaseV : body.shoulderTopV(u, side) - 0.012 * sw);
    // Neckline.
    if (kp.neckL && kp.neckR) {
      let uL = Math.max(body.neckHalf * 1.05, (cx - kp.neckL.x) * kx);
      let uR = Math.max(body.neckHalf * 1.05, (kp.neckR.x - cx) * kx);
      if (straps) {
        uL = Math.max(body.neckHalf * 1.05, strapU(L) - (kp.neckL.x - kp.shoulderL.x) * kx);
        uR = Math.max(body.neckHalf * 1.05, strapU(R) - (kp.shoulderR.x - kp.neckR.x) * kx);
      }
      const vL = shoulderTop(uL, L);
      const vR = shoulderTop(uR, R);
      if (!straps && rig.topAt) {
        // The top edge of the collar rests on the shoulder line, the
        // neckline opening one collar-depth below it (pinning the opening
        // itself to the line would leave the collar sticking up).
        const depth = (g) => Math.max(0, g.y - rig.topAt(g.x)) * sLen;
        pin({ x: kp.neckL.x, y: rig.topAt(kp.neckL.x) }, -uL, vL);
        pin({ x: kp.neckR.x, y: rig.topAt(kp.neckR.x) }, uR, vR);
        pin(kp.neckL, -uL, vL + depth(kp.neckL));
        pin(kp.neckR, uR, vR + depth(kp.neckR));
      } else {
        pin(kp.neckL, -uL, vL);
        pin(kp.neckR, uR, vR);
      }
      // The top edge between collar and shoulder corner follows the shoulder
      // line, so no strip of the wearer's own clothes shows above it.
      if (!straps && rig.topAt) {
        for (const [gN, gS, uN, c, side] of [[kp.neckL, kp.shoulderL, uL, cL, L], [kp.neckR, kp.shoulderR, uR, cR, R]]) {
          for (const t of [0.45, 0.8]) {
            const gx = gN.x + (gS.x - gN.x) * t;
            const bu = uN + (Math.abs(c.u) - uN) * t;
            pin({ x: gx, y: rig.topAt(gx) }, Math.sign(c.u) * bu, shoulderTop(bu, side));
          }
        }
      }
      pin(kp.neckC, 0, Math.min(vAp, (vL + vR) / 2 + (kp.neckC.y - (kp.neckL.y + kp.neckR.y) / 2) * sLen));
    } else {
      pin(kp.neckC, 0, Math.min(body.neckBaseV, vOfY(kp.neckC.y)));
    }
    // Armpits. A loose armhole hangs below the armpit while the arm is down;
    // raising the arm lifts the armpit and the garment's armhole with it.
    const armpitPinV = (side) => {
      const bodyAp = body.armpitSide?.[side] ?? body.armpitV;
      const down = smoothstep(Math.PI / 9, Math.PI / 3, body.armElevation?.[side] ?? Math.PI / 2);
      return bodyAp + Math.max(0, vAp - bodyAp) * down;
    };
    const apL = armpitPinV(L);
    const apR = armpitPinV(R);
    pin(kp.armpitL, -(half(apL, L) + e), apL);
    pin(kp.armpitR, half(apR, R) + e, apR);
    // Side seams, waist, hem.
    const sidePins = [...rig.sides.map((s) => [s.y, s.l, s.r]), [kp.waistL.y, kp.waistL.x, kp.waistR.x], [kp.hemL.y, kp.hemL.x, kp.hemR.x]];
    for (const [y, l, r] of sidePins) {
      const v = vOfY(y);
      pin({ x: l, y }, -sideU(v, L, cx - l, kx), v);
      pin({ x: r, y }, sideU(v, R, r - cx, kx), v);
    }
    pin(kp.hemC, 0, vOfY(kp.hemC.y));
    pin({ x: cx, y: yAp }, 0, vAp);
    pin({ x: cx, y: (yAp + kp.hemC.y) / 2 }, 0, vOfY((yAp + kp.hemC.y) / 2));
  } else {
    const gHip = Math.max(1, kp.hipR.x - kp.hipL.x);
    const bHip = half(T, L) + half(T, R);
    kx = (bHip + 2 * e) / gHip;
    sLen = (bHip / FIT2.flatToVisible / gHip) * lengthK;
    // True length for a chosen size: waist to hem.
    if (adjust.lengthPx) sLen = adjust.lengthPx / Math.max(1, (kp.hemC ?? kp.hemL).y - kp.waistL.y);
    const vW = T * (1 - FIT2.waistRise);
    vOfY = (y) => vW + (y - kp.waistL.y) * sLen;
    if (kp.crotch) {
      // Trousers: the crotch sits just below the hip joints whatever the
      // garment's proportions, so the rise is scaled to land it there; the
      // legs then hang from the hips.
      const vC = T + FIT2.crotchDrop * sw;
      const rise = Math.max(1, kp.crotch.y - kp.waistL.y);
      const seat = (vC - vW) / rise;
      vOfY = (y) => (y <= kp.crotch.y ? vW + (y - kp.waistL.y) * seat : vC + (y - kp.crotch.y) * sLen);
    }
    for (const [g, side, sgn] of [[kp.waistL, L, -1], [kp.waistR, R, 1]]) {
      pin(g, sgn * sideU(vW, side, Math.abs(g.x - cx), kx), vW);
    }
    for (const [g, side, sgn] of [[kp.hipL, L, -1], [kp.hipR, R, 1]]) {
      const v = vOfY(g.y);
      pin(g, sgn * sideU(v, side, Math.abs(g.x - cx), kx), v);
    }
    for (const s of rig.sides) {
      const v = vOfY(s.y);
      pin({ x: s.l, y: s.y }, -sideU(v, L, cx - s.l, kx), v);
      pin({ x: s.r, y: s.y }, sideU(v, R, s.r - cx, kx), v);
    }
    pin({ x: cx, y: kp.waistL.y }, 0, vW);
    if (kp.crotch) {
      pin(kp.crotch, 0, vOfY(kp.crotch.y));
    } else {
      for (const [g, side, sgn] of [[kp.hemL, L, -1], [kp.hemR, R, 1]]) {
        const v = vOfY(g.y);
        pin(g, sgn * sideU(v, side, Math.abs(g.x - cx), kx), v);
      }
      pin(kp.hemC, 0, vOfY(kp.hemC.y));
    }
  }

  const fitted = fitTps(src, dst, 1e-6);
  // A turned body: the garment wraps round a turned torso (see turnAcross).
  const yaw = body.yaw || 0;
  const tps = !yaw
    ? fitted
    : (gx, gy) => {
        const p = fitted(gx, gy);
        const H = (side) => half(clamp(p.y, body.neckBaseV, 1.3 * T), side) + e;
        const s = p.x / H(p.x < 0 ? L : R);
        if (Math.abs(s) > 1) return p;
        const t = turnAcross(s, yaw);
        return { x: t * H(t < 0 ? L : R), y: p.y };
      };
  const torsoMap = (gx, gy) => {
    const p = tps(gx, gy);
    return body.toImage(p.x, p.y);
  };

  // Torso surface normal: the body as a rounded cylinder (facing sideways
  // at its outline), turning upwards over the tops of the shoulders.
  const torsoNormal = (gx, gy) => {
    const p = tps(gx, gy);
    const side = p.x < 0 ? L : R;
    const across = clamp(p.x / Math.max(1, half(clamp(p.y, body.neckBaseV, 1.3 * T), side) + e), -1, 1) * 0.92;
    const up = rig.type === 'bottom' ? 0 : -0.55 * clamp((body.armpitV * 0.6 - p.y) / Math.max(1, body.armpitV * 0.6 - body.neckBaseV), 0, 1);
    const o = body.toImage(p.x, p.y);
    const ax = body.toImage(p.x + 1, p.y);
    const dn = body.toImage(p.x, p.y + 1);
    return { x: (ax.x - o.x) * across + (dn.x - o.x) * up, y: (ax.y - o.y) * across + (dn.y - o.y) * up };
  };

  // Limbs: sleeves along the arms, trouser legs along the legs.
  const limbMaps = {};
  const limbNormals = {};
  // Per limb: how much of the garment's natural length is drawn (below 1 when
  // it is longer than the arm or leg and bunches up at the end).
  const limbSquash = {};
  const limbs = rig.type === 'bottom' ? rig.legs : rig.sleeves;
  for (const [side, limb] of Object.entries(limbs)) {
    const bodyLimb = rig.type === 'bottom' ? body.legs[side] : followArms ? body.arms[side] : null;
    if (!bodyLimb) continue;
    const spine = makeSpine(bodyLimb.chain);
    // The seam where the limb joins the body is usually slanted (a sleeve's
    // top starts at the shoulder, its underside at the armpit). Measure each
    // point's distance along the limb from that seam line, and start it on the
    // body where its end of the seam lands.
    const [seamA, seamB] = limb.seam;
    const gA = { s: (seamA.x - limb.root.x) * limb.dir.x + (seamA.y - limb.root.y) * limb.dir.y, t: (seamA.x - limb.root.x) * limb.nrm.x + (seamA.y - limb.root.y) * limb.nrm.y };
    const gB = { s: (seamB.x - limb.root.x) * limb.dir.x + (seamB.y - limb.root.y) * limb.dir.y, t: (seamB.x - limb.root.x) * limb.nrm.x + (seamB.y - limb.root.y) * limb.nrm.y };
    const bA = spine.project(torsoMap(seamA.x, seamA.y));
    const bB = spine.project(torsoMap(seamB.x, seamB.y));
    // A limb never runs past the end of the body's limb (ankle or hand): a
    // garment drawn longer than the person's leg would hang in the air.
    let limbLen = sLen;
    const sbStart = (bA + bB) / 2;
    const gRest = limb.length - (gA.s + gB.s) / 2;
    if (bodyLimb.complete && gRest > 0) {
      const end = spine.length + (rig.type === 'bottom' ? bodyLimb.r * 0.15 : 0);
      limbLen = Math.min(sLen, Math.max(0, end - sbStart) / gRest);
    }
    limbSquash[side] = sLen > 0 ? limbLen / sLen : 1;
    const firstLen = Math.hypot(bodyLimb.chain[1].x - bodyLimb.chain[0].x, bodyLimb.chain[1].y - bodyLimb.chain[0].y);
    const radius = (sb) => (rig.type === 'bottom' ? bodyLimb.r * (1 - 0.25 * clamp(sb / (firstLen * 2), 0, 1)) : sb < firstLen ? bodyLimb.rU : bodyLimb.rF);
    // Surface normal across the limb (a tube): image-plane part of the
    // normal, from -1 at one side to +1 at the other.
    limbNormals[side] = (gx, gy) => {
      const dx = gx - limb.root.x;
      const dy = gy - limb.root.y;
      const s = dx * limb.dir.x + dy * limb.dir.y;
      const t = dx * limb.nrm.x + dy * limb.nrm.y;
      const frac = clamp((t - gA.t) / (gB.t - gA.t || 1), 0, 1);
      const fromSeam = s - (gA.s + (gB.s - gA.s) * frac);
      const sec = limbSectionAt(limb, clamp(s, 0, limb.length));
      const across = clamp((t - (sec.lo + sec.hi) / 2) / Math.max(1, (sec.hi - sec.lo) / 2), -1, 1);
      const sb = bA + (bB - bA) * frac + fromSeam * limbLen;
      const p0 = spine.place(sb, 0, sw * 0.2);
      const p1 = spine.place(sb, 1, sw * 0.2);
      const tube = { x: (p1.x - p0.x) * across * 0.92, y: (p1.y - p0.y) * across * 0.92 };
      // Where the limb grows out of the body the surface turns from the
      // body's into the limb's, as the shape does (see limbMaps): no
      // shading seam between a trouser seat and its legs.
      const w = smoothstep(0, FIT2.rootBlend * limb.length, fromSeam);
      if (w >= 1) return tube;
      const tn = torsoNormal(gx, gy);
      return { x: tn.x + (tube.x - tn.x) * w, y: tn.y + (tube.y - tn.y) * w };
    };
    limbMaps[side] = (gx, gy) => {
      const dx = gx - limb.root.x;
      const dy = gy - limb.root.y;
      const s = dx * limb.dir.x + dy * limb.dir.y;
      const t = dx * limb.nrm.x + dy * limb.nrm.y;
      const frac = clamp((t - gA.t) / (gB.t - gA.t || 1), 0, 1);
      const fromSeam = s - (gA.s + (gB.s - gA.s) * frac);
      const sec = limbSectionAt(limb, clamp(s, 0, limb.length));
      const c = (sec.lo + sec.hi) / 2;
      const h = Math.max(1, (sec.hi - sec.lo) / 2);
      const sb = bA + (bB - bA) * frac + fromSeam * limbLen;
      const Hb = Math.max(radius(sb) * 1.12, h * kx * FIT2.sleeveFlatToRound);
      const p = spine.place(sb, ((t - c) / h) * Hb, Hb * 1.5);
      const w = smoothstep(0, FIT2.rootBlend * limb.length, fromSeam);
      return w >= 1 ? p : lerpPt(torsoMap(gx, gy), p, w);
    };
  }

  const parts = [];
  const torsoPart = PART.BODY;
  const torsoRect = rig.partRects[torsoPart];
  const hemV = vOfY(rig.type === 'bottom' ? (kp.hemC ?? kp.hemL).y : kp.hemC.y);
  const startV = rig.type === 'bottom' ? vOfY(kp.hipL.y) : vOfY((kp.armpitL.y + kp.armpitR.y) / 2);
  if (torsoRect) {
    parts.push({
      part: torsoPart,
      rect: torsoRect,
      ...gridSize(torsoRect, 520),
      map: torsoMap,
      normal: torsoNormal,
      sway: (gx, gy) => smoothstep(startV, hemV, vOfY(gy)),
    });
  }
  const limbPart = (side) =>
    rig.type === 'bottom' ? (side === L ? PART.LEG_LEFT : PART.LEG_RIGHT) : side === L ? PART.SLEEVE_LEFT : PART.SLEEVE_RIGHT;
  for (const [side, limb] of Object.entries(limbs)) {
    const part = limbPart(side);
    const rect = rig.partRects[part];
    if (!rect) continue;
    const map = limbMaps[side] || torsoMap;
    parts.push({
      part,
      rect,
      ...gridSize(rect, 220),
      map,
      normal: limbNormals[side] || torsoNormal,
      limb: { side, root: limb.root, dir: limb.dir, length: limb.length, squash: limbSquash[side] ?? 1, followed: !!limbMaps[side] },
      sway: (gx, gy) => (rig.type === 'bottom' ? 0 : 0.35 * smoothstep(0.6, 1, ((gx - limb.root.x) * limb.dir.x + (gy - limb.root.y) * limb.dir.y) / limb.length)),
    });
  }

  return {
    parts,
    kx,
    sLen,
    mapPoint: (gx, gy, part) => (parts.find((p) => p.part === part)?.map ?? torsoMap)(gx, gy),
    scale: { kx, sLen },
    pins: src.map((g, i) => ({ garment: g, image: body.toImage(dst[i].x, dst[i].y) })),
  };
}
