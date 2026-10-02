// Fit benchmark: every sample garment on synthetic people of three builds in
// a range of poses (including a webcam-style upper-body crop), scored with
// src/core/fitMetrics.js. Used by tests/unit/fitBenchmark.test.js and by
// `npm run bench`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { computeBodyFrame } from '../../src/core/body.js';
import { buildGrid, createGarmentMapper, DEFAULT_ADJUST } from '../../src/core/fit.js';
import { evaluateFit } from '../../src/core/fitMetrics.js';
import { analyzeGarment, deriveAnchors, removeBackground } from '../../src/core/garment.js';
import { buildGarmentRig } from '../../src/core/garmentRig.js';
import { makeSyntheticBody } from '../../src/core/syntheticBody.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'garments');
export const GARMENT_IDS = [
  'tee-coral', 'tee-graphic', 'breton-longsleeve', 'hoodie-grey', 'oxford-shirt', 'sundress-sage', 'pleated-skirt', 'jeans-indigo',
];

const cache = new Map();
/** A fixture garment's pixels (background removed), as RGBA. */
export function loadGarmentImage(id) {
  const meta = JSON.parse(readFileSync(join(FIXTURES, `${id}.json`), 'utf8'));
  const data = new Uint8ClampedArray(gunzipSync(readFileSync(join(FIXTURES, `${id}.rgba.gz`))));
  return removeBackground({ data, width: meta.width, height: meta.height });
}

export function loadGarment(id) {
  if (cache.has(id)) return cache.get(id);
  const meta = JSON.parse(readFileSync(join(FIXTURES, `${id}.json`), 'utf8'));
  const data = new Uint8ClampedArray(gunzipSync(readFileSync(join(FIXTURES, `${id}.rgba.gz`))));
  const processed = removeBackground({ data, width: meta.width, height: meta.height });
  const analysis = analyzeGarment(processed);
  const rig = buildGarmentRig(analysis, meta.type);
  const g = { id, type: meta.type, analysis, rig };
  cache.set(id, g);
  return g;
}

const both = (upper, bend = 0) => ({ imageLeft: { upper, bend }, imageRight: { upper, bend } });
export const POSES = {
  'arms down': both(1.35),
  'relaxed A': both(1.0),
  'A-pose': both(0.75),
  'T-pose': both(0.05),
  'arms raised': both(-0.45),
  'hands on hips': both(1.15, 1.9),
  'arms crossed': both(1.45, 1.55),
  'one arm up': { imageLeft: { upper: -0.4 }, imageRight: { upper: 1.3 } },
};

export function bodyCases({ builds = ['slim', 'average', 'broad'] } = {}) {
  const cases = [];
  for (const build of builds) {
    for (const [pose, arms] of Object.entries(POSES)) cases.push({ name: `${build} · ${pose}`, opts: { build, arms } });
    cases.push({ name: `${build} · leaning right`, opts: { build, arms: POSES['arms down'], lean: 0.2 } });
    cases.push({ name: `${build} · leaning left`, opts: { build, arms: POSES['A-pose'], lean: -0.2 } });
    cases.push({ name: `${build} · wide stance`, opts: { build, arms: POSES['relaxed A'], legs: { imageLeft: { spread: 0.35, shin: 0.15 }, imageRight: { spread: 0.35, shin: 0.15 } } } });
    cases.push({ name: `${build} · lunge`, opts: { build, arms: POSES['T-pose'], legs: { imageLeft: { spread: 1.1, shin: 0.1 }, imageRight: { spread: 0.6, shin: 0.6 } } } });
    cases.push({
      name: `${build} · webcam upper body`,
      opts: { build, arms: POSES['arms down'], width: 480, height: 360, sw: 190, center: [240, 105] },
    });
  }
  return cases;
}

/** The original engine: uniform scaling from the shoulder landmarks. */
export function v1Engine(body, g) {
  const frame = computeBodyFrame(body.points);
  if (!frame) return null;
  const anchors = deriveAnchors(g.analysis, g.type);
  const mapper = createGarmentMapper(frame, anchors, DEFAULT_ADJUST);
  const rect = g.analysis.bbox;
  const grid = buildGrid(mapper, rect, 16, 22);
  return { meshes: [{ points: grid.points, cols: 16, rows: 22, rect, part: null }], mapPoint: (x, y) => mapper.map(x, y) };
}

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Simulates real-world tracking: Gaussian landmark jitter (sigma in % of the
 * shoulder width) and a ragged segmentation edge (boundary pixels flipped
 * with probability `edgeFlip`). The ground truth is left untouched.
 */
export function addTrackingNoise(body, { landmarkPct = 2, edgeFlip = 0.35, seed = 1 } = {}) {
  const rand = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const sigma = (landmarkPct / 100) * body.truth.sw;
  const points = body.points.map((p) => ({ ...p, x: p.x + gauss() * sigma, y: p.y + gauss() * sigma }));
  const { width, height, data } = body.mask;
  const noisy = Float32Array.from(data);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const edge = data[i] !== data[i - 1] || data[i] !== data[i + 1] || data[i] !== data[i - width] || data[i] !== data[i + width];
      if (edge && rand() < edgeFlip) noisy[i] = 1 - data[i];
    }
  }
  return { ...body, points, mask: { width, height, data: noisy } };
}

/**
 * @param {(body, garment) => object|null} engine
 * @returns {{rows: object[], passed: number, total: number, accuracy: number}}
 */
export function runBench(engine, { builds, garments = GARMENT_IDS, noise = null } = {}) {
  const rows = [];
  let passed = 0;
  let total = 0;
  let seed = 1;
  for (const c of bodyCases({ builds })) {
    const clean = makeSyntheticBody(c.opts);
    const body = noise ? addTrackingNoise(clean, { ...noise, seed: seed++ }) : clean;
    for (const id of garments) {
      const g = loadGarment(id);
      const fit = engine(body, g);
      let result;
      if (!fit) result = { checks: [{ name: 'no fit', ok: false, err: 100 }], passed: 0, total: 1, coveragePct: 0, spillPct: 0 };
      // Score against the true (noise-free) body.
      else result = evaluateFit({ body: clean, rig: g.rig, analysis: g.analysis, fit });
      passed += result.passed;
      total += result.total;
      rows.push({ case: c.name, garment: id, ...result });
    }
  }
  return { rows, passed, total, accuracy: (passed / total) * 100 };
}
