// Maps garment-image pixels onto the body. A flat product photo is wider
// than the garment looks when worn (it wraps around the body), so the
// horizontal scale comes from the body width and the vertical scale is
// stretched by a "wrap" factor. Sleeves are rotated to follow the upper arms.
import { add, clamp, dot, lerp, normalize, scale, smoothstep, sub } from './vec.js';

export const TUNING = {
  // raise: how far above the shoulder joints the garment's shoulder line sits (x torso length)
  top: { widthPerShoulder: 1.2, wrap: 1.18, raise: 0.06 },
  dress: { widthPerShoulder: 1.18, wrap: 1.12, raise: 0.05 },
  bottom: { widthPerHip: 1.75, wrap: 1.1, waistAbove: 0.12 },
  sleeve: { minDelta: -1.7, maxDelta: 1.2 },
};

export const DEFAULT_ADJUST = Object.freeze({ size: 1, length: 1, offset: 0 });

/** Angle of the upper arm below the outward horizontal, in body-local axes. */
export function armAngle(frame, side) {
  const arm = frame.arms?.[side];
  if (!arm) return null;
  const d = sub(arm.elbow, arm.shoulder);
  const outward = side === 'imageLeft' ? scale(frame.shoulderDir, -1) : frame.shoulderDir;
  return Math.atan2(dot(d, frame.down), dot(d, outward));
}

/**
 * @param frame   body frame from computeBodyFrame()
 * @param anchors from deriveAnchors()
 * @param adjust  { size, length, offset } user fine-tuning
 * @returns {{ map(gx:number, gy:number):{x:number,y:number}, sx:number, sy:number, physicsWeight(gy:number):number }}
 */
export function createGarmentMapper(frame, anchors, adjust = DEFAULT_ADJUST, { followArms = true } = {}) {
  const size = adjust.size ?? 1;
  const lengthK = adjust.length ?? 1;
  const offset = adjust.offset ?? 0;
  const span = Math.max(1, anchors.bottomY - anchors.anchorY);
  const physicsWeight = (gy) => smoothstep(0.3, 1, (gy - anchors.anchorY) / span);

  if (anchors.type === 'bottom') {
    const T = TUNING.bottom;
    const sx = (frame.hipWidth * T.widthPerHip * size) / anchors.fitWidth;
    const sy = sx * T.wrap * lengthK;
    const origin = add(lerp(frame.hipMid, frame.shoulderMid, T.waistAbove), scale(frame.down, offset * frame.torsoLength));
    const map = (gx, gy) => {
      const h = (gx - anchors.centerX) * sx;
      const v = (gy - anchors.anchorY) * sy;
      return add(origin, add(scale(frame.hipDir, h), scale(frame.down, v)));
    };
    return { map, sx, sy, physicsWeight };
  }

  const T = TUNING[anchors.type] || TUNING.top;
  const sx = (frame.shoulderWidth * T.widthPerShoulder * size) / anchors.fitWidth;
  const sy = sx * T.wrap * lengthK;
  const origin = add(frame.shoulderMid, scale(frame.down, (offset - T.raise) * frame.torsoLength));

  // Sleeves follow the upper arms. Around each armhole pivot, mesh points
  // are re-mapped by angle (radius unchanged): the sleeve's own angular range
  // rotates rigidly by delta, the gaps above it (towards the collar) and
  // below it (towards the side seam) are stretched or squeezed linearly, and
  // the inner half-plane (the torso) is untouched. The angle map is strictly
  // increasing, so the mesh can never fold over itself.
  const toScaled = (theta) => Math.atan2(Math.sin(theta) * sy, Math.cos(theta) * sx);
  const HALF = Math.PI / 2;
  const sleeves = [];
  if (followArms) {
    for (const side of ['imageLeft', 'imageRight']) {
      const sleeve = anchors.sleeves?.[side];
      const actual = armAngle(frame, side);
      if (!sleeve || actual === null) continue;
      const a = clamp(toScaled(sleeve.minAngle ?? sleeve.angle), -HALF + 0.05, HALF - 0.1);
      const b = clamp(toScaled(sleeve.maxAngle ?? sleeve.angle), a + 0.02, HALF - 0.05);
      const delta = clamp(actual - toScaled(sleeve.angle), Math.max(TUNING.sleeve.minDelta, -HALF - a + 0.05), Math.min(TUNING.sleeve.maxDelta, HALF - b - 0.05));
      sleeves.push({
        out: side === 'imageLeft' ? -1 : 1,
        hp: (sleeve.pivot.x - anchors.centerX) * sx,
        vp: (sleeve.pivot.y - anchors.anchorY) * sy,
        a,
        b,
        delta,
      });
    }
  }
  const remapAngle = (theta, s) => {
    if (theta <= -HALF || theta >= HALF) return theta;
    if (theta < s.a) return -HALF + ((theta + HALF) * (s.a + s.delta + HALF)) / (s.a + HALF);
    if (theta <= s.b) return theta + s.delta;
    return s.b + s.delta + ((theta - s.b) * (HALF - s.b - s.delta)) / (HALF - s.b);
  };

  const map = (gx, gy) => {
    let h = (gx - anchors.centerX) * sx;
    let v = (gy - anchors.anchorY) * sy;
    for (const s of sleeves) {
      const dx = s.out * (h - s.hp);
      const dy = v - s.vp;
      if (dx <= 0) continue; // inner half-plane: torso
      const r = Math.hypot(dx, dy);
      const theta = remapAngle(Math.atan2(dy, dx), s);
      h = s.hp + s.out * r * Math.cos(theta);
      v = s.vp + r * Math.sin(theta);
    }
    const t = clamp(v / frame.torsoLength, 0, 1);
    const xAxis = normalize(lerp(frame.shoulderDir, frame.hipDir, t));
    return add(origin, add(scale(xAxis, h), scale(frame.down, v)));
  };
  return { map, sx, sy, physicsWeight };
}

/**
 * Samples the mapper on a (cols+1) x (rows+1) grid over the source rect.
 * @returns {{ points: Float32Array, weights: Float32Array }}
 */
export function buildGrid(mapper, src, cols, rows) {
  const points = new Float32Array((cols + 1) * (rows + 1) * 2);
  const weights = new Float32Array((cols + 1) * (rows + 1));
  let k = 0;
  for (let j = 0; j <= rows; j++) {
    const gy = src.y + (src.h * j) / rows;
    const w = mapper.physicsWeight(gy);
    for (let i = 0; i <= cols; i++) {
      const p = mapper.map(src.x + (src.w * i) / cols, gy);
      points[k * 2] = p.x;
      points[k * 2 + 1] = p.y;
      weights[k] = w;
      k++;
    }
  }
  return { points, weights };
}
