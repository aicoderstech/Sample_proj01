import { describe, expect, it } from 'vitest';
import { computeBodyFrame, toPixels } from '../../src/core/body.js';
import { armAngle, buildGrid, createGarmentMapper, TUNING } from '../../src/core/fit.js';
import { analyzeGarment, deriveAnchors, removeBackground } from '../../src/core/garment.js';
import { makePose, rasterize, TEE } from './shapes.js';

const teeAnalysis = analyzeGarment(removeBackground(rasterize(TEE)));
const teeAnchors = deriveAnchors(teeAnalysis, 'top');
const deg = (d) => (d * Math.PI) / 180;

describe('computeBodyFrame', () => {
  it('builds shoulder/hip lines and the torso axis', () => {
    const f = computeBodyFrame(makePose());
    expect(f.shoulderWidth).toBeCloseTo(200);
    expect(f.shoulderMid).toEqual({ x: 300, y: 300 });
    expect(f.hipMid).toEqual({ x: 300, y: 560 });
    expect(f.down.x).toBeCloseTo(0);
    expect(f.down.y).toBeCloseTo(1);
    expect(f.shoulderDir.x).toBeCloseTo(1);
    expect(f.torsoLength).toBeCloseTo(260);
    expect(f.hipsEstimated).toBe(false);
    expect(f.legsEstimated).toBe(false);
  });

  it('returns null when the shoulders are not visible', () => {
    expect(computeBodyFrame(makePose({ shoulderVis: 0.2 }))).toBeNull();
    expect(computeBodyFrame(null)).toBeNull();
    expect(computeBodyFrame([])).toBeNull();
  });

  it('estimates hips and legs when only the upper body is in frame', () => {
    const f = computeBodyFrame(makePose({ hips: false }));
    expect(f.hipsEstimated).toBe(true);
    expect(f.legsEstimated).toBe(true);
    expect(f.hipMid.x).toBeCloseTo(300);
    expect(f.hipMid.y).toBeGreaterThan(500);
    expect(f.ankleMid.y).toBeGreaterThan(f.hipMid.y);
  });

  it('follows a leaning body', () => {
    const f = computeBodyFrame(makePose({ rotate: deg(20) }));
    expect(Math.atan2(f.shoulderDir.y, f.shoulderDir.x)).toBeCloseTo(deg(20), 5);
    expect(Math.atan2(f.down.y, f.down.x)).toBeCloseTo(deg(110), 5);
  });

  it('converts normalized landmarks to pixels', () => {
    expect(toPixels([{ x: 0.5, y: 0.25, visibility: 0.7 }], 640, 480)).toEqual([{ x: 320, y: 120, v: 0.7 }]);
  });
});

describe('armAngle', () => {
  it('measures each upper arm below the outward horizontal', () => {
    const f = computeBodyFrame(makePose({ armAngleLeftImage: deg(30), armAngleRightImage: deg(-10) }));
    expect(armAngle(f, 'imageLeft')).toBeCloseTo(deg(30), 5);
    expect(armAngle(f, 'imageRight')).toBeCloseTo(deg(-10), 5);
  });
});

describe('createGarmentMapper', () => {
  const frame = computeBodyFrame(makePose());

  it('puts the garment shoulder line just above the shoulders', () => {
    const m = createGarmentMapper(frame, teeAnchors);
    const p = m.map(teeAnchors.centerX, teeAnchors.anchorY);
    expect(p.x).toBeCloseTo(300, 5);
    expect(p.y).toBeCloseTo(300 - TUNING.top.raise * frame.torsoLength, 5);
  });

  it('scales the torso width to the body', () => {
    const m = createGarmentMapper(frame, teeAnchors, { size: 1, length: 1, offset: 0 }, { followArms: false });
    const y = teeAnchors.anchorY + 200;
    const l = m.map(teeAnchors.centerX - teeAnchors.fitWidth / 2, y);
    const r = m.map(teeAnchors.centerX + teeAnchors.fitWidth / 2, y);
    expect(r.x - l.x).toBeCloseTo(frame.shoulderWidth * TUNING.top.widthPerShoulder, 3);
  });

  it('applies size, length and position adjustments', () => {
    const base = createGarmentMapper(frame, teeAnchors, { size: 1, length: 1, offset: 0 });
    const bigger = createGarmentMapper(frame, teeAnchors, { size: 1.5, length: 1, offset: 0 });
    const longer = createGarmentMapper(frame, teeAnchors, { size: 1, length: 1.3, offset: 0 });
    const lower = createGarmentMapper(frame, teeAnchors, { size: 1, length: 1, offset: 0.2 });
    expect(bigger.sx / base.sx).toBeCloseTo(1.5);
    expect(longer.sy / base.sy).toBeCloseTo(1.3);
    expect(longer.sx).toBeCloseTo(base.sx);
    const a = base.map(teeAnchors.centerX, teeAnchors.anchorY);
    const b = lower.map(teeAnchors.centerX, teeAnchors.anchorY);
    expect(b.y - a.y).toBeCloseTo(0.2 * frame.torsoLength);
  });

  it('places skirts at the waist', () => {
    const anchors = { type: 'bottom', fitWidth: 250, anchorY: 20, centerX: 300, bottomY: 530, sleeves: {} };
    const m = createGarmentMapper(frame, anchors);
    const p = m.map(300, 20);
    expect(p.x).toBeCloseTo(300);
    expect(p.y).toBeCloseTo(560 - (560 - 300) * TUNING.bottom.waistAbove);
  });

  const sleeveAngles = (angleDeg) => {
    const f = computeBodyFrame(makePose({ armAngleLeftImage: deg(angleDeg), armAngleRightImage: deg(angleDeg) }));
    const m = createGarmentMapper(f, teeAnchors);
    return [['imageLeft', -1], ['imageRight', 1]].map(([side, out]) => {
      const s = teeAnchors.sleeves[side];
      const pivot = m.map(s.pivot.x, s.pivot.y);
      const c = m.map(s.centroid.x, s.centroid.y);
      return Math.atan2(c.y - pivot.y, out * (c.x - pivot.x));
    });
  };

  it.each([-20, 0, 20, 45])('points the sleeves along an arm at %i degrees', (angleDeg) => {
    for (const got of sleeveAngles(angleDeg)) expect(Math.abs(got - deg(angleDeg))).toBeLessThan(deg(4));
  });

  it('follows raised and lowered arms as far as the sleeve shape allows', () => {
    // The whole sleeve must stay on the outer side of its armhole, so very
    // steep poses are followed partially: still clearly raised / lowered.
    for (const got of sleeveAngles(-70)) expect(got).toBeLessThan(deg(-20));
    for (const got of sleeveAngles(80)) expect(got).toBeGreaterThan(deg(45));
  });

  it('never folds the mesh, whatever the arm pose', () => {
    const cols = 16;
    const rows = 22;
    const area = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    for (let left = -90; left <= 100; left += 10) {
      for (const right of [-90, -40, 0, 40, 100]) {
        for (const rotate of [0, deg(-25), deg(25)]) {
          const f = computeBodyFrame(makePose({ armAngleLeftImage: deg(left), armAngleRightImage: deg(right), rotate }));
          const { points } = buildGrid(createGarmentMapper(f, teeAnchors), teeAnalysis.bbox, cols, rows);
          const P = (i, j) => ({ x: points[(j * (cols + 1) + i) * 2], y: points[(j * (cols + 1) + i) * 2 + 1] });
          for (let j = 0; j < rows; j++) {
            for (let i = 0; i < cols; i++) {
              expect(area(P(i, j), P(i + 1, j), P(i + 1, j + 1))).toBeGreaterThan(0);
              expect(area(P(i, j), P(i + 1, j + 1), P(i, j + 1))).toBeGreaterThan(0);
            }
          }
        }
      }
    }
  });

  it('only lets the lower part of the garment sway', () => {
    const m = createGarmentMapper(frame, teeAnchors);
    expect(m.physicsWeight(teeAnchors.anchorY)).toBe(0);
    expect(m.physicsWeight(teeAnchors.bottomY)).toBe(1);
  });
});

describe('buildGrid', () => {
  it('samples the mapper over the source rect', () => {
    const mapper = { map: (x, y) => ({ x: x * 2, y: y + 1 }), physicsWeight: (y) => (y > 5 ? 1 : 0) };
    const { points, weights } = buildGrid(mapper, { x: 0, y: 0, w: 10, h: 10 }, 2, 2);
    expect(points.length).toBe(18);
    expect([points[0], points[1]]).toEqual([0, 1]);
    expect([points[16], points[17]]).toEqual([20, 11]);
    expect(Array.from(weights)).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1]);
  });
});
