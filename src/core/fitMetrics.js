// Fit accuracy metrics against a synthetic body with known geometry.
//
// Every check is expressed in % of the shoulder-joint width (sw). For an
// adult with 40 cm between the shoulder joints, 1% of sw is 4 mm.
//
//   shoulder seam      seam point within 4% sw of the shoulder cap's top-outer corner
//   shoulder top       the top of the shoulders (collar to seam) is covered,
//                      within 2.5% sw
//   neck centring      neckline centre within 2.5% sw of the body midline
//   chest contact      side seams hug the chest: no gap, at most 10% sw ease
//   waist/hip cover    side seams cover the body there, at most 25% sw drape
//   sleeve on arm      sleeve centre line within 4% sw of the arm's centre line
//   leg on leg         trouser leg centre line within 5% sw of the leg's
//   torso coverage     >= 99% of the torso the garment should cover is covered
//   spill              <= 2% of the garment hangs in the air above the hips
//                      (a collar or hood standing up round the neck is allowed)
//                      (fabric falling straight from the chest is allowed)
import { limbSectionAt, PART } from './garmentRig.js';
import { rasterizeMeshes } from './raster.js';

function distToPolyline(p, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    best = Math.min(best, Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t));
  }
  return best;
}

/**
 * @param {object} o
 * @param {object} o.body     result of makeSyntheticBody()
 * @param {object} o.rig      garment rig (garment-image coordinates)
 * @param {object} o.analysis garment analysis (mask)
 * @param {{meshes: object[], mapPoint: (gx:number, gy:number, part:number) => {x:number,y:number}}} o.fit
 */
export function evaluateFit({ body, rig, analysis, fit }) {
  const { truth, width, height } = body;
  const sw = truth.sw;
  const T = truth.T;
  const pct = (px) => (px / sw) * 100;
  const checks = [];
  const add = (name, errPx, tolPct) => checks.push({ name, err: pct(errPx), ok: pct(errPx) <= tolPct + 1e-9 });

  // Render garment part labels into the image.
  const labels = new Uint8Array(width * height);
  for (const m of fit.meshes) {
    const cover = rasterizeMeshes(width, height, [
      {
        ...m,
        opaque: (gx, gy) => {
          const x = Math.round(gx);
          const y = Math.round(gy);
          if (x < 0 || y < 0 || x >= analysis.width || y >= analysis.height) return false;
          const i = y * analysis.width + x;
          return analysis.mask[i] === 1 && (m.part == null || rig.parts[i] === m.part);
        },
      },
    ]);
    for (let i = 0; i < cover.length; i++) {
      if (cover[i] && !labels[i]) labels[i] = 1;
    }
  }
  const inImage = (p) => p.x >= 0 && p.y >= 0 && p.x < width && p.y < height;
  const labelAt = (p) => (inImage(p) ? labels[Math.floor(p.y) * width + Math.floor(p.x)] : 0);

  /** Outermost garment pixel from the body midline at level v (local units). */
  // Torso-only extent: stop at the arm so sleeves don't count as torso.
  const torsoGarmentEdge = (v, side) => {
    const dir = side === 'imageLeft' ? -1 : 1;
    let last = -1;
    let gap = 0;
    for (let u = 0; u <= sw * 1.6; u += 0.5) {
      const p = truth.toImage(dir * u, v);
      if (!inImage(p)) return null;
      if (truth.isArm(p.x, p.y) && u > truth.halfWidth(v) * 0.8) break;
      if (labelAt(p)) {
        last = u;
        gap = 0;
      } else if (++gap > sw * 0.03) break;
    }
    return last;
  };
  // Outer edge of torso + legs (not arms) along a row: in a lunge the thigh
  // leaves the hip sideways, and trousers rightly cover it there.
  const lowerBodyHalf = (v, side) => {
    const dir = side === 'imageLeft' ? -1 : 1;
    let last = truth.halfWidth(v);
    for (let u = last; u <= sw * 1.6; u += 0.5) {
      const p = truth.toImage(dir * u, v);
      if (!inImage(p) || truth.isArm(p.x, p.y) || !truth.isPerson(p.x, p.y)) break;
      last = u;
    }
    return last;
  };
  const bandCheck = (name, v, side, lo, hi, tolPct, withLegs = false) => {
    const h = truth.halfWidth(v);
    const hOut = withLegs ? lowerBodyHalf(v, side) : h;
    // Not measurable where an arm hides the body's edge.
    const edge = truth.edgeAt(v, side);
    if (truth.isArm(edge.x, edge.y)) return;
    const e = torsoGarmentEdge(v, side);
    if (e === null) return;
    const err = e < h + lo ? h + lo - e : e > hOut + hi ? e - (hOut + hi) : 0;
    add(name, err, tolPct);
  };
  // How far down the garment reaches at the body centre.
  let bottomV = -T;
  for (let v = -0.3 * T; v <= 3.5 * T; v += 1) {
    const p = truth.toImage(0, v);
    if (!inImage(p)) break;
    if (labelAt(p)) bottomV = v;
  }
  let topV = 3.5 * T;
  for (let v = 3.5 * T; v >= -0.6 * T; v -= 1) {
    const p = truth.toImage(0, v);
    if (inImage(p) && labelAt(p)) topV = v;
  }

  const tol = 2.5;
  if (rig.type !== 'bottom') {
    const hasSleeves = Object.keys(rig.sleeves).length > 0;
    for (const side of ['imageLeft', 'imageRight']) {
      const kp = side === 'imageLeft' ? rig.kp.shoulderL : rig.kp.shoulderR;
      const target = hasSleeves || rig.type === 'top' ? truth.shoulderCorner[side] : truth.strapPoint[side];
      const p = fit.mapPoint(kp.x, kp.y, PART.BODY);
      if (inImage(target)) add(`shoulder seam (${side})`, Math.hypot(p.x - target.x, p.y - target.y), 4);
    }
    // The tops of the shoulders, collar to shoulder corner, are covered: no
    // strip of the wearer's own clothes shows above the garment.
    if (hasSleeves || rig.type === 'top') {
      for (const side of ['imageLeft', 'imageRight']) {
        const c = truth.cornerLocal[side];
        const sgn = Math.sign(c.u);
        for (const t of [0.3, 0.55, 0.8]) {
          const u = sgn * (truth.neckHalf * 1.4 + (Math.abs(c.u) - truth.neckHalf * 1.4) * t);
          const top = truth.topV(u);
          if (top < c.v - 0.1 * sw) continue; // a raised arm above the shoulder, not its top
          // Distance from the body's top surface down to the first covered pixel.
          let gap = 0;
          while (gap < 0.3 * sw && !labelAt(truth.toImage(u, top + 0.5 + gap))) gap += 0.5;
          add(`shoulder top covered (${side})`, gap, 2.5);
        }
      }
    }
    const nc = fit.mapPoint(rig.kp.neckC.x, rig.kp.neckC.y, PART.BODY);
    const local = truth.toLocal(nc.x, nc.y);
    add('neck centring', Math.abs(local.u), tol);
    for (const side of ['imageLeft', 'imageRight']) {
      // Chest contact just below where the garment starts at the centre front
      // (a strap dress begins lower than a T-shirt).
      bandCheck(`chest contact (${side})`, Math.max(0.27 * T, topV + 0.08 * T), side, -0.005 * sw, 0.1 * sw, tol);
      if (bottomV > 0.75 * T) bandCheck(`waist cover (${side})`, 0.72 * T, side, -0.005 * sw, 0.25 * sw, tol);
      if (bottomV > 1.03 * T) bandCheck(`hip cover (${side})`, T, side, -0.005 * sw, 0.25 * sw, tol);
    }
    for (const [side, sleeve] of Object.entries(rig.sleeves)) {
      const arm = truth.arms[side];
      const poly = [arm.joint, arm.elbow, arm.wrist, arm.hand];
      const part = side === 'imageLeft' ? PART.SLEEVE_LEFT : PART.SLEEVE_RIGHT;
      for (const f of [0.35, 0.65, 1]) {
        // A point on the sleeve's centre line.
        const s = sleeve.length * f;
        const sec = limbSectionAt(sleeve, s);
        const c = (sec.lo + sec.hi) / 2;
        const g = { x: sleeve.root.x + sleeve.dir.x * s + sleeve.nrm.x * c, y: sleeve.root.y + sleeve.dir.y * s + sleeve.nrm.y * c };
        const p = fit.mapPoint(g.x, g.y, part);
        if (inImage(p)) add(`sleeve on arm ${Math.round(f * 100)}% (${side})`, distToPolyline(p, poly), 4);
      }
    }
  } else {
    for (const side of ['imageLeft', 'imageRight']) {
      bandCheck(`waistband contact (${side})`, topV + 0.04 * T, side, -0.005 * sw, 0.1 * sw, tol);
      if (bottomV > 1.03 * T) bandCheck(`hip cover (${side})`, T, side, -0.005 * sw, 0.2 * sw, tol, rig.kind === 'trousers');
    }
    for (const [side, leg] of Object.entries(rig.legs)) {
      const tl = truth.legs[side];
      const part = side === 'imageLeft' ? PART.LEG_LEFT : PART.LEG_RIGHT;
      for (const f of [0.3, 0.6, 0.95]) {
        const s = leg.length * f;
        const sec = limbSectionAt(leg, s);
        const c = (sec.lo + sec.hi) / 2;
        const g = { x: leg.root.x + leg.dir.x * s + leg.nrm.x * c, y: leg.root.y + leg.dir.y * s + leg.nrm.y * c };
        const p = fit.mapPoint(g.x, g.y, part);
        if (inImage(p)) add(`leg on leg ${Math.round(f * 100)}% (${side})`, distToPolyline(p, [tl.hip, tl.knee, tl.ankle]), 5);
      }
    }
  }

  // Coverage of the torso band the garment is meant to cover.
  // Below the neckline / waistband: open necklines are open by design.
  const vFrom = rig.type === 'bottom' ? topV + 0.05 * T : Math.max(0.04 * T, topV + 0.04 * T);
  const vTo = Math.min(bottomV - 0.03 * T, T);
  let need = 0;
  let got = 0;
  let garmentPx = 0;
  let spill = 0;
  const r = sw * 0.06;
  // Fabric may hang straight down from the widest part of the torso above
  // (a shirt falling from the chest past a narrower waist): not spill.
  const hull = [];
  let widest = 0;
  for (let v = 0; v <= T; v += 1) {
    widest = Math.max(widest, v >= 0.2 * T ? truth.halfWidth(v) : 0);
    hull.push(widest);
  }
  const inDrape = (px, py) => {
    const p = truth.toLocal(px, py);
    if (p.v < 0.2 * T || p.v >= T) return false;
    return Math.abs(p.u) <= hull[Math.round(p.v)] + r;
  };
  // A collar or hood stands up round the neck, above the shoulder line: not spill.
  const inCollar = (px, py) => {
    const p = truth.toLocal(px, py);
    return p.v < 0.05 * T && Math.abs(p.u) <= truth.neckHalf * 2.2;
  };
  const ring = Array.from({ length: 8 }, (_, k) => [Math.cos((k * Math.PI) / 4) * r, Math.sin((k * Math.PI) / 4) * r]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const lv = truth.toLocal(px, py).v;
      const covered = labels[y * width + x] === 1;
      if (lv >= vFrom && lv <= vTo && truth.isTorso(px, py)) {
        need++;
        if (covered) got++;
      }
      if (covered && lv < T) {
        garmentPx++;
        if (!truth.isPerson(px, py) && !ring.some(([dx, dy]) => truth.isPerson(px + dx, py + dy)) && !inDrape(px, py) && !inCollar(px, py)) spill++;
      }
    }
  }
  const coveragePct = need ? (got / need) * 100 : 100;
  const spillPct = garmentPx ? (spill / garmentPx) * 100 : 0;
  if (need > 50) checks.push({ name: 'torso coverage', err: 100 - coveragePct, ok: coveragePct >= 99 });
  if (garmentPx > 50) checks.push({ name: 'spill', err: spillPct, ok: spillPct <= 2 });

  return { checks, coveragePct, spillPct, passed: checks.filter((c) => c.ok).length, total: checks.length };
}
