import { describe, expect, it } from 'vitest';
import { OneEuroFilter, PointSmoother } from '../../src/core/filters.js';
import { affineFromTriangles } from '../../src/core/mesh.js';
import { ClothSway } from '../../src/core/physics.js';

describe('ClothSway', () => {
  const targets = Float32Array.from([0, 0, 100, 0, 0, 100, 100, 100]);
  const weights = Float32Array.from([0, 0, 1, 1]);

  it('starts at the targets and keeps rigid vertices pinned', () => {
    const sway = new ClothSway();
    expect(Array.from(sway.step(targets, weights, 1 / 60, 100))).toEqual(Array.from(targets));
    const moved = Float32Array.from(targets.map((v, i) => (i % 2 === 0 ? v + 10 : v)));
    const out = sway.step(moved, weights, 1 / 60, 100);
    expect(out[0]).toBe(10);
    expect(out[2]).toBe(110);
  });

  it('lags behind a moving body, then settles', () => {
    const sway = new ClothSway();
    sway.step(targets, weights, 1 / 60, 100);
    const moved = Float32Array.from(targets.map((v, i) => (i % 2 === 0 ? v + 20 : v)));
    const first = sway.step(moved, weights, 1 / 60, 100);
    expect(first[4]).toBeLessThan(20); // hem still catching up
    let out;
    for (let i = 0; i < 300; i++) out = sway.step(moved, weights, 1 / 60, 100);
    expect(out[4]).toBeCloseTo(20, 2);
    expect(out[6]).toBeCloseTo(120, 2);
  });

  it('stays stable with huge or invalid time steps', () => {
    const sway = new ClothSway();
    sway.step(targets, weights, 1 / 60, 100);
    const moved = Float32Array.from(targets.map((v) => v + 15));
    for (const dt of [5, -1, 0, Number.NaN, 0.2]) {
      const out = sway.step(moved, weights, dt, 100);
      for (const v of out) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('never drifts further than its limit and snaps on tracking jumps', () => {
    const sway = new ClothSway({ maxOffset: 0.1 });
    sway.step(targets, weights, 1 / 60, 100);
    const far = Float32Array.from(targets.map((v) => v + 30));
    let out = sway.step(far, weights, 1 / 60, 100);
    expect(Math.hypot(out[6] - far[6], out[7] - far[7])).toBeLessThanOrEqual(10 + 1e-3);
    const jump = Float32Array.from(targets.map((v) => v + 5000));
    out = sway.step(jump, weights, 1 / 60, 100);
    expect(out[6]).toBeCloseTo(jump[6]);
  });
});

describe('OneEuroFilter', () => {
  it('passes a constant signal through', () => {
    const f = new OneEuroFilter();
    for (let i = 0; i < 20; i++) expect(f.filter(5, i / 30)).toBeCloseTo(5);
  });

  it('reduces jitter on a still target', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0 });
    let seed = 3;
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 10;
    let rawVar = 0;
    let outVar = 0;
    for (let i = 0; i < 300; i++) {
      const raw = 100 + noise();
      const out = f.filter(raw, i / 30);
      if (i > 30) {
        rawVar += (raw - 100) ** 2;
        outVar += (out - 100) ** 2;
      }
    }
    expect(outVar).toBeLessThan(rawVar / 4);
  });

  it('catches up with a step change', () => {
    const f = new OneEuroFilter();
    f.filter(0, 0);
    let out = 0;
    for (let i = 1; i <= 60; i++) out = f.filter(100, i / 30);
    expect(out).toBeGreaterThan(95);
  });

  it('ignores repeated timestamps', () => {
    const f = new OneEuroFilter();
    f.filter(1, 1);
    expect(f.filter(50, 1)).toBe(1);
  });
});

describe('PointSmoother', () => {
  it('smooths x/y and keeps visibility', () => {
    const s = new PointSmoother();
    s.smooth([{ x: 0, y: 0, v: 0.9 }], 0);
    const [p] = s.smooth([{ x: 10, y: 10, v: 0.4 }], 1 / 30);
    expect(p.x).toBeGreaterThan(0);
    expect(p.x).toBeLessThan(10);
    expect(p.v).toBe(0.4);
  });
});

describe('affineFromTriangles', () => {
  it('maps source vertices onto destination vertices', () => {
    const s = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
    const d = [{ x: 5, y: 5 }, { x: 25, y: 9 }, { x: 1, y: 30 }];
    const [a, b, c, dd, e, f] = affineFromTriangles(...s, ...d);
    s.forEach((p, i) => {
      expect(a * p.x + c * p.y + e).toBeCloseTo(d[i].x);
      expect(b * p.x + dd * p.y + f).toBeCloseTo(d[i].y);
    });
  });

  it('returns null for a degenerate source triangle', () => {
    const p = { x: 1, y: 1 };
    expect(affineFromTriangles(p, p, { x: 2, y: 2 }, p, p, p)).toBeNull();
  });
});
