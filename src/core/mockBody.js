// An animated synthetic person (landmarks + segmentation mask) for the
// landing-page demo and the `?pose=mock` mode used by automated tests.
import { makeSyntheticBody } from './syntheticBody.js';

/**
 * @param {number} t seconds
 * @param {{width:number, height:number, motion?:number, withMask?:boolean, maskScale?:number}} o
 *   Landscape frames show the upper body (like a laptop webcam), portrait
 *   frames the whole body.
 */
export function mockBodyFrame(t, { width, height, motion = 1, withMask = true, maskScale = 0.5 }) {
  const landscape = width > height;
  const sw = landscape ? height * 0.4 : height * 0.17;
  const cy = landscape ? height * 0.38 : height * 0.06 + 1.1 * sw;
  const m = motion;
  const swing = Math.sin(t * 1.6) * m;
  return makeSyntheticBody({
    width,
    height,
    sw,
    build: 'average',
    center: [width / 2 + 0.03 * sw * Math.sin(t * 1.1) * m, cy],
    lean: 0.035 * Math.sin(t * 0.8) * m,
    arms: {
      imageLeft: { upper: 1.22 + 0.22 * swing, bend: 0.25 + 0.2 * Math.sin(t * 1.3 + 1) * m },
      imageRight: { upper: 1.22 - 0.22 * Math.sin(t * 1.6 + 0.6) * m, bend: 0.25 + 0.2 * Math.sin(t * 1.2) * m },
    },
    withMask,
    maskScale,
  });
}

/** MediaPipe-style normalized landmarks for a synthetic body. */
export function normalizedLandmarks(body) {
  return body.points.map((p) => ({ x: p.x / body.width, y: p.y / body.height, z: 0, visibility: p.v }));
}
