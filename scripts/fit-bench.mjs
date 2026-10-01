// Fit accuracy benchmark: the original engine (v1) against the current one
// (v2) on synthetic bodies of known shape, with exact and noisy tracking.
// Usage: npm run bench [-- --failures]
import { runBench, v1Engine } from '../tests/bench/fitBench.js';
import { v2Engine } from '../tests/bench/v2Engine.js';

const LEVELS = [
  ['exact tracking', null],
  ['webcam-level noise', { landmarkPct: 2, edgeFlip: 0.35 }],
  ['heavy noise', { landmarkPct: 4, edgeFlip: 0.5 }],
];
const showFailures = process.argv.includes('--failures');

const byCheck = (r) => {
  const out = {};
  for (const row of r.rows) {
    for (const c of row.checks) {
      const k = c.name.replace(/ \(image(Left|Right)\)/, '').replace(/ \d+%/, '');
      out[k] ??= [0, 0];
      out[k][1]++;
      if (c.ok) out[k][0]++;
    }
  }
  return out;
};

for (const [label, noise] of LEVELS) {
  const v1 = runBench(v1Engine, { noise });
  const v2 = runBench(v2Engine, { noise });
  console.log(`\n${label}`);
  console.log(`  v1 ${v1.accuracy.toFixed(1).padStart(5)}%  (${v1.passed}/${v1.total} checks)`);
  console.log(`  v2 ${v2.accuracy.toFixed(1).padStart(5)}%  (${v2.passed}/${v2.total} checks)`);
  const weak = Object.entries(byCheck(v2)).filter(([, [p, t]]) => p < t);
  if (weak.length) console.log(`     below 100%: ${weak.map(([k, [p, t]]) => `${k} ${((100 * p) / t).toFixed(0)}%`).join(', ')}`);
  if (showFailures) {
    for (const row of v2.rows) for (const c of row.checks) if (!c.ok) console.log(`     ✗ ${row.case} | ${row.garment} | ${c.name} (${c.err.toFixed(1)}% sw)`);
  }
}
