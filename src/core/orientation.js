// Which way the wearer is facing, from the pose landmarks.
//
//  - Yaw (turning left / right): the pose model gives each landmark a depth
//    (z, same scale as x). The shoulders' depth difference against their
//    width gives the turn. It is noisy (a person facing the camera can read
//    20-25 degrees), so small values are treated as facing the camera and
//    the rest is scaled down.
//  - Back view: seen from behind, the person's left shoulder is on the
//    image's left (from the front it is on the right) and the face isn't
//    visible.
import { LM } from './body.js';
import { clamp } from './vec.js';

const DEG = Math.PI / 180;

/** Landmark index pairs (left, right) swapped for a person seen from behind. */
const PAIRS = [
  [1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18],
  [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32],
];

/**
 * @param {{x:number,y:number,z?:number,v:number}[]} pts pixel landmarks
 * @returns {{facing: 'front'|'back', yaw: number, rawYaw: number, frontal: boolean}}
 *   yaw: the turn used for the garment (radians; positive = the image-right
 *   side of the body turned away), 0 when roughly facing the camera;
 *   rawYaw: the measured turn; frontal: near enough facing the camera (or
 *   the back) for measuring the body's width
 */
export function estimateOrientation(pts) {
  const L = pts[LM.LEFT_SHOULDER];
  const R = pts[LM.RIGHT_SHOULDER];
  const dx = L.x - R.x;
  const dz = (L.z ?? 0) - (R.z ?? 0);
  const faceSeen = Math.max(pts[LM.NOSE]?.v ?? 0, pts[2]?.v ?? 0, pts[5]?.v ?? 0);
  const width = Math.hypot(L.x - R.x, L.y - R.y);
  const back = dx < -0.15 * width && faceSeen < 0.6;
  // Seen from behind the depth ordering flips with the sides.
  const raw = Math.atan2(back ? -dz : dz, Math.abs(dx));
  const mag = Math.abs(raw) / DEG;
  const eff = clamp((mag - 20) / 55, 0, 1) * 70 * DEG;
  return { facing: back ? 'back' : 'front', yaw: Math.sign(raw) * eff, rawYaw: raw, frontal: mag < 30 };
}

/** Landmarks of a person seen from behind, relabelled as if seen from the front. */
export function asIfFromFront(pts) {
  const out = pts.slice();
  for (const [a, b] of PAIRS) {
    out[a] = pts[b];
    out[b] = pts[a];
  }
  return out;
}

/**
 * Where a point of a front-facing torso appears when the body is turned.
 * The torso is an ellipse (depth / width = 0.72); s is the frontal position
 * across it (-1 .. 1, the outline at +-1). The turn moves the centre line
 * (sternum) towards the side that turns away and foreshortens that half;
 * fabric past where that side curves out of sight is folded onto its edge.
 * The near half is stretched to the outline, so the visible side of the
 * body is covered.
 * @param {number} s   frontal position (-1 .. 1; beyond is left unchanged)
 * @param {number} yaw radians, positive = the +s side turned away
 * @returns {number}   position across the turned outline (-1 .. 1)
 */
export function turnAcross(s, yaw) {
  if (!yaw || Math.abs(s) > 1) return s;
  const a = 1;
  const b = 0.72;
  const ct = Math.cos(yaw);
  const st = Math.sin(Math.abs(yaw));
  const sign = Math.sign(yaw);
  // Work with the far side on +; flip back at the end.
  const x = (al) => a * Math.sin(al) * ct + b * Math.cos(al) * st;
  const W = Math.sqrt(a * a * ct * ct + b * b * st * st);
  const alpha = Math.asin(clamp(s * sign, -1, 1));
  let out;
  if (alpha >= 0) {
    const tangent = Math.atan2(a * ct, b * st);
    out = x(Math.min(alpha, tangent)) / W;
  } else {
    const x0 = x(0) / W;
    const xe = x(-Math.PI / 2) / W;
    const t = (x(alpha) / W - x0) / (xe - x0 || 1);
    out = x0 + t * (-1 - x0);
  }
  return out * sign;
}
