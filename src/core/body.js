// Turns MediaPipe pose landmarks into a "body frame": the shoulder/hip lines
// and torso axis the garment is fitted to. Missing hips/legs (common with a
// laptop webcam) are estimated from the shoulders.
import { add, length, mid, normalize, perpDown, scale, sub } from './vec.js';

export const LM = {
  NOSE: 0,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
};

// Average adult proportions used when a body part is out of frame.
const TORSO_PER_SHOULDER = 1.3; // shoulder-to-hip length / shoulder width
const HIP_PER_SHOULDER = 0.62; // hip landmark distance / shoulder landmark distance
const LEG_PER_TORSO = 1.65; // hip-to-ankle length / torso length

/** Normalized landmarks (0..1) -> pixel points with visibility `v`. */
export function toPixels(landmarks, width, height) {
  return landmarks.map((p) => ({ x: p.x * width, y: p.y * height, z: (p.z ?? 0) * width, v: p.visibility ?? 1 }));
}

const visible = (p, minVis) => p && p.v >= minVis && Number.isFinite(p.x) && Number.isFinite(p.y);

/**
 * @param {{x:number,y:number,v:number}[]} pts pixel landmarks (33 points)
 * @returns {null | object} null when the shoulders are not both visible
 */
export function computeBodyFrame(pts, { minVisibility = 0.5 } = {}) {
  if (!pts || pts.length < 29) return null;
  const ls = pts[LM.LEFT_SHOULDER];
  const rs = pts[LM.RIGHT_SHOULDER];
  if (!visible(ls, minVisibility) || !visible(rs, minVisibility)) return null;

  // In the raw (unmirrored) camera image a person facing the camera has their
  // right shoulder on the image's left, so this vector points image-left -> image-right.
  const shoulderVec = sub(ls, rs);
  let shoulderWidth = length(shoulderVec);
  const shoulderMid = mid(ls, rs);
  const shoulderDir = normalize(shoulderVec);

  const lh = pts[LM.LEFT_HIP];
  const rh = pts[LM.RIGHT_HIP];
  let hipMid;
  let hipVec;
  let hipsEstimated = false;
  if (visible(lh, minVisibility) && visible(rh, minVisibility)) {
    hipMid = mid(lh, rh);
    hipVec = sub(lh, rh);
  } else {
    hipsEstimated = true;
    hipMid = add(shoulderMid, scale(perpDown(shoulderDir), shoulderWidth * TORSO_PER_SHOULDER));
    hipVec = scale(shoulderVec, HIP_PER_SHOULDER);
  }

  let torsoVec = sub(hipMid, shoulderMid);
  let torsoLength = length(torsoVec);
  // Side-on poses collapse the shoulder width; keep the garment from vanishing.
  if (!hipsEstimated && shoulderWidth < torsoLength * 0.35) shoulderWidth = torsoLength * 0.35;
  if (torsoLength < shoulderWidth * 0.4) {
    torsoLength = shoulderWidth * 0.4;
    torsoVec = scale(perpDown(shoulderDir), torsoLength);
    hipMid = add(shoulderMid, torsoVec);
  }
  const down = normalize(torsoVec);

  const legPoint = (leftIdx, rightIdx, fallbackT) => {
    const l = pts[leftIdx];
    const r = pts[rightIdx];
    if (visible(l, minVisibility) && visible(r, minVisibility)) return { point: mid(l, r), estimated: false };
    return { point: add(hipMid, scale(down, torsoLength * LEG_PER_TORSO * fallbackT)), estimated: true };
  };
  const knee = legPoint(LM.LEFT_KNEE, LM.RIGHT_KNEE, 0.5);
  const ankle = legPoint(LM.LEFT_ANKLE, LM.RIGHT_ANKLE, 1);

  return {
    shoulderMid,
    shoulderDir,
    shoulderWidth,
    hipMid,
    hipDir: normalize(hipVec),
    hipWidth: Math.max(length(hipVec), shoulderWidth * 0.35),
    hipsEstimated,
    down,
    torsoLength,
    kneeMid: knee.point,
    ankleMid: ankle.point,
    legsEstimated: ankle.estimated,
    // Upper arms, keyed by the side of the raw image they appear on.
    arms: {
      imageLeft: armInfo(rs, pts[LM.RIGHT_ELBOW], minVisibility),
      imageRight: armInfo(ls, pts[LM.LEFT_ELBOW], minVisibility),
    },
  };
}

function armInfo(shoulder, elbow, minVisibility) {
  if (!visible(elbow, minVisibility)) return null;
  return { shoulder: { x: shoulder.x, y: shoulder.y }, elbow: { x: elbow.x, y: elbow.y } };
}

