import { describe, expect, it } from 'vitest';
import { BodyFilter, measureBody } from '../../src/core/bodyModel.js';
import { FIT2, fitGarment } from '../../src/core/fit2.js';
import { evaluateFit } from '../../src/core/fitMetrics.js';
import { fitReport } from '../../src/core/fitReport.js';
import { PART } from '../../src/core/garmentRig.js';
import { mockBodyFrame, normalizedLandmarks } from '../../src/core/mockBody.js';
import { headOutline } from '../../src/core/renderer.js';
import { makeSpine } from '../../src/core/spine.js';
import { makeSyntheticBody } from '../../src/core/syntheticBody.js';
import { fitTps } from '../../src/core/tps.js';
import { loadGarment, POSES } from '../bench/fitBench.js';
import { v2Engine } from '../bench/v2Engine.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

describe('fitTps', () => {
  const src = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 0, y: 100 },
    { x: 100, y: 100 },
    { x: 50, y: 40 },
  ];

  it('moves every control point exactly onto its target', () => {
    const dst = [
      { x: 10, y: 5 },
      { x: 120, y: -3 },
      { x: -4, y: 110 },
      { x: 95, y: 130 },
      { x: 60, y: 45 },
    ];
    const tps = fitTps(src, dst);
    src.forEach((p, i) => {
      const q = tps(p.x, p.y);
      expect(q.x).toBeCloseTo(dst[i].x, 6);
      expect(q.y).toBeCloseTo(dst[i].y, 6);
    });
  });

  it('reproduces an affine map everywhere (no bending when none is needed)', () => {
    const affine = (p) => ({ x: 1.5 * p.x + 0.2 * p.y + 7, y: -0.1 * p.x + 0.8 * p.y - 3 });
    const tps = fitTps(src, src.map(affine));
    for (const p of [{ x: 25, y: 75 }, { x: -40, y: 200 }, { x: 70, y: 10 }]) {
      const q = tps(p.x, p.y);
      expect(dist(q, affine(p))).toBeLessThan(1e-6);
    }
  });
});

describe('makeSpine', () => {
  it('places points along a straight limb and projects them back', () => {
    const spine = makeSpine([{ x: 0, y: 0 }, { x: 0, y: 100 }]);
    expect(spine.length).toBeCloseTo(100);
    const p = spine.place(40, 10, 5);
    expect(p.x).toBeCloseTo(-10); // right of travel (downwards) is -x on screen
    expect(p.y).toBeCloseTo(40);
    expect(spine.project({ x: 3, y: 60 })).toBeCloseTo(60);
  });

  it('follows a bent elbow and keeps going straight past the end', () => {
    const spine = makeSpine([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
    expect(spine.length).toBeCloseTo(200);
    expect(dist(spine.pointAt(150), { x: 100, y: 50 })).toBeLessThan(1e-9);
    expect(dist(spine.pointAt(230), { x: 100, y: 130 })).toBeLessThan(1e-9);
  });
});

describe('buildGarmentRig', () => {
  it('finds sleeves, shoulders and armpits on a T-shirt', () => {
    const { rig } = loadGarment('tee-coral');
    expect(rig.kind).toBe('top');
    expect(Object.keys(rig.sleeves).sort()).toEqual(['imageLeft', 'imageRight']);
    const { kp } = rig;
    expect(kp.shoulderL.x).toBeLessThan(kp.neckL.x);
    expect(kp.shoulderR.x).toBeGreaterThan(kp.neckR.x);
    expect(kp.armpitL.y).toBeGreaterThan(kp.shoulderL.y);
    expect(kp.hemC.y).toBeGreaterThan(kp.armpitL.y);
    expect(rig.partRects[PART.SLEEVE_LEFT]).toBeTruthy();
    expect(rig.partRects[PART.SLEEVE_RIGHT]).toBeTruthy();
  });

  it('treats a strap dress as straps, not sleeves', () => {
    const { rig } = loadGarment('sundress-sage');
    expect(rig.kind).toBe('dress');
    expect(Object.keys(rig.sleeves)).toEqual([]);
  });

  it('splits trousers into a seat and two legs that start at the hips', () => {
    const { rig } = loadGarment('jeans-indigo');
    expect(rig.kind).toBe('trousers');
    expect(rig.kp.crotch).toBeTruthy();
    expect(Object.keys(rig.legs).sort()).toEqual(['imageLeft', 'imageRight']);
    // The leg seam runs from the crotch up to the outer hip.
    const [a, b] = rig.legs.imageLeft.seam;
    expect(Math.min(a.y, b.y)).toBeCloseTo(rig.kp.hipL.y, 0);
    expect(Math.max(a.y, b.y)).toBe(rig.kp.crotch.y);
  });

  it('keeps a skirt in one piece', () => {
    const { rig } = loadGarment('pleated-skirt');
    expect(rig.kind).toBe('skirt');
    expect(rig.legs).toEqual({});
  });
});

describe('measureBody', () => {
  const body = makeSyntheticBody({ build: 'broad', arms: POSES['A-pose'] });
  const { truth } = body;
  const model = measureBody(body.points, body.mask);

  it('measures the torso outline from the segmentation mask', () => {
    expect(model.hasMask).toBe(true);
    for (const f of [0.3, 0.6, 0.9]) {
      const v = f * model.T;
      for (const side of ['imageLeft', 'imageRight']) {
        expect(Math.abs(model.halfAt(v, side) - truth.halfWidth(v))).toBeLessThan(0.03 * truth.sw);
      }
    }
  });

  it('finds the outer shoulder edges', () => {
    for (const side of ['imageLeft', 'imageRight']) {
      expect(dist(model.shoulderOuter[side], truth.shoulderOuter[side])).toBeLessThan(0.04 * truth.sw);
    }
  });

  it('ends each leg at the ankle (the foot points elsewhere)', () => {
    expect(model.legs.imageLeft.chain).toHaveLength(3);
    expect(model.legs.imageLeft.complete).toBe(true);
    expect(dist(model.legs.imageLeft.chain[2], truth.legs.imageLeft.ankle)).toBeLessThan(1);
  });

  it('falls back to average proportions without a mask', () => {
    const noMask = measureBody(body.points, null);
    expect(noMask.hasMask).toBe(false);
    expect(noMask.halfAt(0.6 * noMask.T, 'imageLeft')).toBeGreaterThan(0.25 * truth.sw);
  });

  it('needs both shoulders', () => {
    const pts = body.points.map((p, i) => (i === 11 ? { ...p, v: 0 } : p));
    expect(measureBody(pts, body.mask)).toBeNull();
  });
});

describe('measureBody on difficult real-photo cases', () => {
  it('does not mistake a forearm across the torso for a thick arm', () => {
    const body = makeSyntheticBody({ build: 'average', arms: POSES['arms crossed'] });
    const model = measureBody(body.points, body.mask);
    for (const side of ['imageLeft', 'imageRight']) {
      expect(model.arms[side].rF).toBeLessThanOrEqual(0.13 * body.truth.sw + 1e-9);
      expect(model.arms[side].rU).toBeLessThanOrEqual(0.17 * body.truth.sw + 1e-9);
    }
  });

  it('ignores an object merged into the outline beside the chest', () => {
    const body = makeSyntheticBody({ build: 'average', arms: POSES['T-pose'] });
    const { truth, mask } = body;
    // A dark background merging with dark clothes: a blob 0.8 sw wide stuck
    // to the right side of the chest and waist.
    for (let v = 0.2 * truth.T; v <= 0.8 * truth.T; v += 0.5) {
      for (let u = 0; u <= truth.halfWidth(v) + 0.8 * truth.sw; u += 0.5) {
        const p = truth.toImage(u, v);
        mask.data[Math.floor(p.y) * mask.width + Math.floor(p.x)] = 1;
      }
    }
    const model = measureBody(body.points, mask);
    const v = 0.5 * model.T;
    expect(Math.abs(model.halfAt(v, 'imageRight') - truth.halfWidth(v))).toBeLessThan(0.08 * truth.sw);
  });

  it('rejects an anatomically impossible detection (hips beside the shoulders)', () => {
    const body = makeSyntheticBody({ build: 'average' });
    const pts = body.points.map((p) => ({ ...p }));
    const mid = { x: (pts[11].x + pts[12].x) / 2, y: (pts[11].y + pts[12].y) / 2 };
    pts[23] = { ...pts[23], x: mid.x - 200, y: mid.y + 4 };
    pts[24] = { ...pts[24], x: mid.x - 190, y: mid.y + 6 };
    expect(measureBody(pts, body.mask)).toBeNull();
    // A side-on pose is still accepted.
    const side = body.points.map((p) => ({ ...p }));
    side[11] = { ...side[11], x: mid.x + 15 };
    side[12] = { ...side[12], x: mid.x - 15 };
    expect(measureBody(side, body.mask)).not.toBeNull();
  });
});

describe('headOutline', () => {
  it('covers the head down to the chin and stops above the neck base', () => {
    const body = makeSyntheticBody({ build: 'average' });
    const head = headOutline(body.points);
    const inside = (p) => {
      const c = Math.cos(-head.angle);
      const s = Math.sin(-head.angle);
      const dx = p.x - head.x;
      const dy = p.y - head.y;
      const x = dx * c - dy * s;
      const y = dx * s + dy * c;
      return (x / head.rx) ** 2 + (y / head.ry) ** 2 <= 1;
    };
    expect(inside(body.truth.head.center)).toBe(true);
    expect(inside(body.truth.toImage(0, body.truth.neckBaseV + 2))).toBe(false);
  });

  it('needs a visible face', () => {
    const body = makeSyntheticBody({ build: 'average' });
    expect(headOutline(body.points.map((p, i) => (i === 0 ? { ...p, v: 0.1 } : p)))).toBeNull();
    expect(headOutline(null)).toBeNull();
  });
});

describe('fitReport', () => {
  it('scores a good fit as on the body and covering the torso', () => {
    const body = makeSyntheticBody({ build: 'average', arms: POSES['A-pose'] });
    const g = loadGarment('tee-coral');
    const model = measureBody(body.points, body.mask);
    const fit = fitGarment(model, g.rig);
    const r = fitReport({ body: model, fit, garment: g, mask: body.mask, width: body.width, height: body.height });
    // A T-shirt hangs straight from the chest past the waist and its short
    // sleeves flare, so not every pixel lies on the body.
    expect(r.onBody.torso).toBeGreaterThanOrEqual(95);
    expect(r.onBody.sleeves).toBeGreaterThanOrEqual(95);
    expect(r.coverage).toBeGreaterThanOrEqual(99);
    expect(r.body.chest).toBeCloseTo((2 * body.truth.halfWidth(model.armpitV)) / body.truth.sw, 1);
  });
});

describe('BodyFilter', () => {
  it('smooths the measured outline between frames', () => {
    const filter = new BodyFilter(0.5);
    const a = makeSyntheticBody({ build: 'slim' });
    const b = makeSyntheticBody({ build: 'broad' });
    const first = filter.apply(measureBody(a.points, a.mask));
    const v = 0.6 * first.T;
    const slim = first.halfAt(v, 'imageLeft');
    const broadRaw = measureBody(b.points, b.mask).halfAt(v, 'imageLeft');
    const second = filter.apply(measureBody(b.points, b.mask));
    const mixed = second.halfAt(v, 'imageLeft');
    expect(mixed).toBeGreaterThan(slim);
    expect(mixed).toBeLessThan(broadRaw);
  });
});

describe('fitGarment', () => {
  it('pins shirt shoulder seams onto the shoulder edges', () => {
    const body = makeSyntheticBody({ build: 'average', arms: POSES['relaxed A'] });
    const g = loadGarment('oxford-shirt');
    const fit = fitGarment(measureBody(body.points, body.mask), g.rig);
    for (const [kp, side] of [[g.rig.kp.shoulderL, 'imageLeft'], [g.rig.kp.shoulderR, 'imageRight']]) {
      const p = fit.mapPoint(kp.x, kp.y, PART.BODY);
      expect(dist(p, body.truth.shoulderOuter[side])).toBeLessThan(0.04 * body.truth.sw);
    }
  });

  it('sits the trouser crotch just below the hip joints and stops the legs at the ankles', () => {
    const body = makeSyntheticBody({ build: 'slim', arms: POSES['arms down'] });
    const g = loadGarment('jeans-indigo');
    const model = measureBody(body.points, body.mask);
    const fit = fitGarment(model, g.rig);
    const crotch = body.truth.toLocal(...Object.values(fit.mapPoint(g.rig.kp.crotch.x, g.rig.kp.crotch.y, PART.BODY)));
    expect(crotch.v).toBeCloseTo(model.T + FIT2.crotchDrop * model.sw, 0);
    const leg = g.rig.legs.imageLeft;
    const hem = fit.mapPoint(leg.end.x, leg.end.y, PART.LEG_LEFT);
    expect(hem.y).toBeLessThan(body.truth.legs.imageLeft.ankle.y + 0.1 * body.truth.sw);
  });

  it('follows a lunge with the trouser legs', () => {
    const body = makeSyntheticBody({
      build: 'average',
      arms: POSES['T-pose'],
      legs: { imageLeft: { spread: 1.1, shin: 0.1 }, imageRight: { spread: 0.6, shin: 0.6 } },
    });
    const g = loadGarment('jeans-indigo');
    const r = evaluateFit({ body, rig: g.rig, analysis: g.analysis, fit: v2Engine(body, g) });
    expect(r.checks.filter((c) => c.name.startsWith('leg on leg')).length).toBeGreaterThan(3);
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('makes the garment looser with a bigger size', () => {
    const body = makeSyntheticBody({ build: 'average' });
    const g = loadGarment('tee-coral');
    const model = measureBody(body.points, body.mask);
    const regular = fitGarment(model, g.rig, { size: 1 });
    const large = fitGarment(model, g.rig, { size: 1.15 });
    expect(large.scale.kx).toBeGreaterThan(regular.scale.kx);
  });
});

describe('mockBodyFrame', () => {
  it('returns normalized landmarks and a person mask', () => {
    const body = mockBodyFrame(1.2, { width: 640, height: 480 });
    const lm = normalizedLandmarks(body);
    expect(lm).toHaveLength(33);
    for (const p of lm.slice(0, 25)) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
    }
    expect(body.mask.width).toBeGreaterThan(0);
    expect(body.mask.data.some((x) => x > 0.5)).toBe(true);
  });
});
