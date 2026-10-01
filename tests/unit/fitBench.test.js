// Fit accuracy benchmark: every catalog garment on synthetic bodies of known
// shape (3 builds x 15 poses), scored by the checks in src/core/fitMetrics.js.
// `npm run bench` prints the full report.
import { describe, expect, it } from 'vitest';
import { runBench } from '../bench/fitBench.js';
import { v2Engine } from '../bench/v2Engine.js';

describe('fit benchmark', () => {
  it('passes >= 99.9% of fit checks with exact tracking', () => {
    const r = runBench(v2Engine);
    const failed = r.rows.flatMap((row) => row.checks.filter((c) => !c.ok).map((c) => `${row.case} | ${row.garment} | ${c.name}`));
    expect(r.total).toBeGreaterThan(4000);
    expect(r.accuracy, failed.join('\n')).toBeGreaterThanOrEqual(99.9);
  }, 120_000);

  it('passes >= 98% of fit checks with webcam-level tracking noise', () => {
    const r = runBench(v2Engine, { noise: { landmarkPct: 2, edgeFlip: 0.35 } });
    expect(r.accuracy).toBeGreaterThanOrEqual(98);
  }, 120_000);
});
