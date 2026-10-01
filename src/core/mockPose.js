// Synthetic, gently moving pose in MediaPipe's 33-landmark format. Powers the
// landing-page demo and the `?pose=mock` mode used by automated tests.

// Standing pose in "height units" (x: 0 = body centre, +x = image right; y: 0 = top).
// The person's left side is on the image right, as with a real camera.
const BASE = [
  [0, 0.16], [0.012, 0.145], [0.022, 0.145], [0.03, 0.146], [-0.012, 0.145], [-0.022, 0.145], [-0.03, 0.146],
  [0.048, 0.156], [-0.048, 0.156], [0.014, 0.188], [-0.014, 0.188],
  [0.1, 0.3], [-0.1, 0.3], // shoulders 11, 12
  [0.13, 0.44], [-0.13, 0.44], // elbows 13, 14
  [0.145, 0.57], [-0.145, 0.57], // wrists 15, 16
  [0.15, 0.6], [-0.15, 0.6], [0.145, 0.605], [-0.145, 0.605], [0.135, 0.59], [-0.135, 0.59], // hands 17-22
  [0.062, 0.56], [-0.062, 0.56], // hips 23, 24
  [0.066, 0.74], [-0.066, 0.74], // knees 25, 26
  [0.066, 0.92], [-0.066, 0.92], // ankles 27, 28
  [0.06, 0.94], [-0.06, 0.94], [0.08, 0.955], [-0.08, 0.955], // feet 29-32
];

const rotateAround = (p, c, a) => {
  const s = Math.sin(a);
  const k = Math.cos(a);
  const dx = p[0] - c[0];
  const dy = p[1] - c[1];
  return [c[0] + dx * k - dy * s, c[1] + dx * s + dy * k];
};

/**
 * @param {number} t seconds
 * @param {{aspect?:number, zoom?:number, offsetY?:number, centerX?:number, motion?:number}} opts
 *   aspect = frame width / height; zoom > 1 frames the upper body only.
 * @returns {{x:number,y:number,z:number,visibility:number}[]} normalized landmarks
 */
export function mockPose(t, { aspect = 0.75, zoom = 1, offsetY = 0.02, centerX = 0.5, motion = 1 } = {}) {
  const pts = BASE.map((p) => [p[0], p[1]]);
  const m = motion;
  const sway = 0.025 * Math.sin(t * 1.1) * m;
  const tilt = 0.05 * Math.sin(t * 0.8) * m;
  const hipC = [0, 0.56];

  // Upper body (0..22) leans around the hips.
  for (let i = 0; i <= 22; i++) pts[i] = rotateAround(pts[i], hipC, tilt);
  // Arms swing around the shoulders.
  const swing = (shoulder, idx, a) => {
    for (const i of idx) pts[i] = rotateAround(pts[i], pts[shoulder], a);
  };
  swing(11, [13, 15, 17, 19, 21], -0.35 * Math.sin(t * 1.6) * m - 0.08);
  swing(12, [14, 16, 18, 20, 22], 0.35 * Math.sin(t * 1.6 + 0.6) * m + 0.08);

  return pts.map(([x, y]) => {
    const ny = (y - 0.5) * zoom + 0.5 + offsetY;
    const nx = centerX + ((x + sway) * zoom) / aspect;
    const inside = nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1;
    return { x: nx, y: ny, z: 0, visibility: inside ? 0.99 : 0.05 };
  });
}
