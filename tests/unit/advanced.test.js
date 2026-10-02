// Tests for the advanced fitting algorithms: clothing bulk and old-clothes
// removal, fabric folds and lighting, turned bodies and the garment's back,
// and size recommendation.
import { describe, expect, it } from 'vitest';
import { measureBody } from '../../src/core/bodyModel.js';
import { fitGarment } from '../../src/core/fit2.js';
import { makeGarmentBack } from '../../src/core/garmentBack.js';
import { PART } from '../../src/core/garmentRig.js';
import { DEFAULT_LIGHT, estimateLight } from '../../src/core/lighting.js';
import { asIfFromFront, estimateOrientation, turnAcross } from '../../src/core/orientation.js';
import { fabricSurface } from '../../src/core/renderer.js';
import {
  bodyMeasurements,
  chartFor,
  ellipseCircumference,
  fitVerdicts,
  measureScale,
  recommendSize,
  sizeFit,
} from '../../src/core/sizing.js';
import { makeSyntheticBody } from '../../src/core/syntheticBody.js';
import { LABEL, pushPullFill, skinTone, undress } from '../../src/core/undress.js';
import { buildGrid } from '../../src/core/fit.js';
import { loadGarment, loadGarmentImage, POSES } from '../bench/fitBench.js';

/** Parsing labels for a synthetic body: torso and upper arms clothed, the rest skin. */
function syntheticParsing(body, { coat = 0 } = {}) {
  const { width, height, truth } = body;
  const labels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const l = truth.toLocal(px, py);
      // A coat: the torso, widened by `coat` shoulder widths on each side.
      const inCoat = coat && l.v > -0.05 * truth.T && l.v < 1.1 * truth.T && Math.abs(l.u) <= truth.halfWidth(Math.max(l.v, 0.01)) + coat * truth.sw;
      if (truth.isTorso(px, py) || inCoat) labels[y * width + x] = LABEL.CLOTHES;
      else if (truth.isArm(px, py)) labels[y * width + x] = LABEL.BODY_SKIN;
      else if (truth.isPerson(px, py)) labels[y * width + x] = l.v < -0.2 * truth.T ? LABEL.FACE_SKIN : LABEL.BODY_SKIN;
    }
  }
  return { labels, width, height };
}

/** The mask widened to include a coat. */
function coatMask(body, parsing) {
  const data = Float32Array.from(body.mask.data);
  for (let i = 0; i < data.length; i++) if (parsing.labels[i]) data[i] = 1;
  return { ...body.mask, data };
}

describe('clothing bulk', () => {
  it('fits the body under a bulky coat, not the coat', () => {
    const body = makeSyntheticBody({ build: 'average', arms: POSES['T-pose'] });
    // A puffer jacket: 0.2 shoulder widths of padding each side.
    const parsing = syntheticParsing(body, { coat: 0.2 });
    const mask = coatMask(body, parsing);
    const v = 0.6 * body.truth.T;
    const plain = measureBody(body.points, mask);
    const parsed = measureBody(body.points, mask, parsing);
    const truth = body.truth.halfWidth(v);
    // Without parsing the coat reads as body; with it, most of the bulk goes
    // (a margin is kept on purpose, so a genuinely bigger body is never cut).
    const before = plain.halfAt(v, 'imageLeft') - truth;
    const after = parsed.halfAt(v, 'imageLeft') - truth;
    expect(before).toBeGreaterThan(0.1 * body.truth.sw);
    expect(after).toBeLessThan(before * 0.65);
    expect(parsed.bulk).toBeGreaterThan(0.05);
  });

  it('leaves a normal outline alone', () => {
    const body = makeSyntheticBody({ build: 'broad', arms: POSES['A-pose'] });
    const parsing = syntheticParsing(body);
    const a = measureBody(body.points, body.mask);
    const b = measureBody(body.points, body.mask, parsing);
    for (const f of [0.3, 0.6, 0.9]) expect(b.halfAt(f * a.T, 'imageRight')).toBeCloseTo(a.halfAt(f * a.T, 'imageRight'), 5);
  });
});

describe('old-clothes removal', () => {
  it('fills holes smoothly from the known pixels (push-pull)', () => {
    const w = 16;
    const h = 8;
    const rgb = new Float32Array(w * h * 3);
    const known = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (x < 4 || x >= 12) {
          known[i] = 1;
          rgb.fill(x < 4 ? 0 : 200, i * 3, i * 3 + 3);
        }
      }
    }
    pushPullFill(rgb, known, w, h);
    const mid = (x) => rgb[(4 * w + x) * 3];
    expect(mid(5)).toBeGreaterThan(0);
    expect(mid(10)).toBeLessThan(200);
    expect(mid(10)).toBeGreaterThan(mid(5));
  });

  it('finds the skin tone from face and body skin', () => {
    const pix = new Uint8ClampedArray(100 * 4);
    const labels = new Uint8Array(100);
    for (let i = 0; i < 100; i++) {
      labels[i] = i < 50 ? LABEL.FACE_SKIN : LABEL.CLOTHES;
      pix.set(i < 50 ? [200, 150, 120, 255] : [20, 20, 20, 255], i * 4);
    }
    expect(skinTone(pix, labels)).toEqual([200, 150, 120]);
  });

  it('turns an old long sleeve under a new T-shirt into a bare arm, and coat bulk into background', () => {
    const body = makeSyntheticBody({ build: 'average', arms: POSES['A-pose'] });
    const { width: w, height: h, truth } = body;
    const parsing = syntheticParsing(body, { coat: 0.1 });
    // Old clothes everywhere on the arms too (a long-sleeved coat).
    for (let i = 0; i < w * h; i++) if (parsing.labels[i] === LABEL.BODY_SKIN && truth.isArm((i % w) + 0.5, Math.floor(i / w) + 0.5)) parsing.labels[i] = LABEL.CLOTHES;
    const mask = coatMask(body, parsing);
    const model = measureBody(body.points, mask, parsing);
    const pix = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) pix.set(parsing.labels[i] === LABEL.CLOTHES ? [30, 30, 30, 255] : parsing.labels[i] ? [205, 160, 130, 255] : [240, 240, 240, 255], i * 4);
    // Pretend the new T-shirt covers the torso exactly (not the sleeves or the bulk).
    const cover = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (truth.isTorso(x + 0.5, y + 0.5) && truth.toLocal(x + 0.5, y + 0.5).v < 0.8 * truth.T) cover[y * w + x] = 1;
    const res = undress({ pix, labels: parsing.labels, cover, w, h, k: 1, body: model, type: 'top' });
    expect(res.skinCount).toBeGreaterThan(200);
    expect(res.background).toBeGreaterThan(200);
    // A point on the forearm is now skin coloured.
    const fa = truth.arms.imageLeft;
    const p = { x: Math.round((fa.elbow.x + fa.wrist.x) / 2), y: Math.round((fa.elbow.y + fa.wrist.y) / 2) };
    const i = p.y * w + p.x;
    expect(res.changed[i]).toBe(1);
    expect(res.pix[i * 4]).toBeGreaterThan(120);
    // Trousers: nothing to take off (legs are left alone).
    expect(undress({ pix, labels: parsing.labels, cover, w, h, k: 1, body: model, type: 'bottom' })).toBeNull();
  });
});

describe('fabric folds and lighting', () => {
  it('gives the torso a rounded surface and finds drape where the garment stands off the body', () => {
    const body = makeSyntheticBody({ build: 'slim', arms: POSES['A-pose'] });
    const g = loadGarment('sundress-sage');
    const model = measureBody(body.points, body.mask);
    const fit = fitGarment(model, g.rig);
    const part = fit.parts.find((p) => p.part === PART.BODY);
    const grid = buildGrid({ map: part.map, physicsWeight: () => 0 }, part.rect, part.cols, part.rows);
    const s = fabricSurface(part, grid.points, part.cols, part.rows, model, g);
    const cols = part.cols;
    const mid = Math.floor(part.rows * 0.5) * (cols + 1);
    // Surface normal: sideways at the edges, facing the viewer in the middle.
    expect(Math.abs(s.nrm[(mid + Math.floor(cols / 2)) * 4])).toBeLessThan(0.2);
    expect(Math.abs(s.nrm[(mid + 1) * 4])).toBeGreaterThan(0.4);
    // The skirt flares away from the legs: drape near the hem, none at the bust.
    expect(s.fold[(part.rows - 1) * (cols + 1) * 4]).toBeGreaterThan(0.5);
    expect(s.fold[Math.floor(part.rows * 0.15) * (cols + 1) * 4]).toBeLessThan(0.2);
  });

  it('finds compression where the fabric is squeezed', () => {
    const part = { rect: { x: 0, y: 0, w: 100, h: 100 }, normal: () => ({ x: 0, y: 0 }) };
    const cols = 10;
    const rows = 10;
    const points = new Float32Array((cols + 1) * (rows + 1) * 2);
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) {
        // The right half squeezed to 40% horizontally.
        const x = i <= 5 ? i * 10 : 50 + (i - 5) * 4;
        points.set([x, j * 10], (j * (cols + 1) + i) * 2);
      }
    }
    const s = fabricSurface(part, points, cols, rows, null, {});
    const at = (i, j) => s.fold[(j * (cols + 1) + i) * 4 + 1];
    expect(at(8, 5)).toBeGreaterThan(0.9);
    expect(at(2, 5)).toBe(0);
    expect(s.fold[(5 * (cols + 1) + 8) * 4 + 2]).toBe(0); // squeezed along garment x
  });

  it('finds the light from the shading across a face', () => {
    const w = 40;
    const h = 40;
    const pix = new Uint8ClampedArray(w * h * 4);
    const labels = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (Math.hypot(x - 20, y - 20) > 12) continue;
        labels[y * w + x] = LABEL.FACE_SKIN;
        const l = 120 + (x - 20) * 5; // brighter to the right
        pix.set([l, l * 0.8, l * 0.7, 255], (y * w + x) * 4);
      }
    }
    const light = estimateLight(pix, labels, w, h);
    expect(light.x).toBeGreaterThan(0.3);
    expect(Math.hypot(light.x, light.y, light.z)).toBeCloseTo(1, 5);
    expect(estimateLight(pix, new Uint8Array(w * h), w, h)).toBe(DEFAULT_LIGHT);
  });
});

describe('turned bodies', () => {
  it('reads facing and turn from the landmarks', () => {
    const body = makeSyntheticBody({ build: 'average' });
    expect(estimateOrientation(body.points)).toMatchObject({ facing: 'front', yaw: 0, frontal: true });
    // Left shoulder further away by 1.5 shoulder widths: well turned.
    const turned = body.points.map((p, i) => (i === 11 ? { ...p, z: 180 } : i === 12 ? { ...p, z: 0 } : p));
    const o = estimateOrientation(turned);
    expect(o.yaw).toBeGreaterThan(0.6);
    expect(o.frontal).toBe(false);
    // From behind: sides swapped, face hidden.
    const back = asIfFromFront(body.points).map((p, i) => (i <= 10 ? { ...p, v: 0.1 } : p));
    expect(estimateOrientation(back).facing).toBe('back');
    expect(measureBody(back, body.mask).facing).toBe('back');
  });

  it('wraps a garment round a turned torso', () => {
    for (const yaw of [0.3, -0.7, 1.1]) {
      // The outline stays the outline; the centre moves to the side turning away.
      expect(turnAcross(-1, yaw)).toBeCloseTo(-1, 6);
      expect(turnAcross(1, yaw)).toBeCloseTo(1, 6);
      expect(Math.sign(turnAcross(0, yaw))).toBe(Math.sign(yaw));
      // Order across the body is kept.
      let prev = -Infinity;
      for (let s = -1; s <= 1.0001; s += 0.1) {
        const t = turnAcross(s, yaw);
        expect(t).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = t;
      }
    }
    expect(turnAcross(0.4, 0)).toBe(0.4);
  });

  it('makes the back of a garment: no print, stripes kept, pattern kept, higher neckline', () => {
    const count = (img, test) => {
      let n = 0;
      for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3] > 128 && test(img.data[i], img.data[i + 1], img.data[i + 2])) n++;
      return n;
    };
    const orange = (r, g, b) => r > 180 && g > 60 && b < 120 && r - b > 100;
    const tee = loadGarmentImage('tee-graphic');
    const teeBack = makeGarmentBack(tee, loadGarment('tee-graphic').rig);
    expect(count(tee, orange)).toBeGreaterThan(5000);
    expect(count(teeBack, orange)).toBeLessThan(count(tee, orange) * 0.03);

    const navy = (r, g, b) => b > 80 && r < 80;
    const breton = loadGarmentImage('breton-longsleeve');
    expect(count(makeGarmentBack(breton, loadGarment('breton-longsleeve').rig), navy)).toBeGreaterThan(count(breton, navy) * 0.85);

    const white = (r, g, b) => r > 220 && g > 220 && b > 220;
    const dress = loadGarmentImage('sundress-sage');
    expect(count(makeGarmentBack(dress, loadGarment('sundress-sage').rig), white)).toBeGreaterThan(count(dress, white) * 0.7);

    const hoodie = loadGarmentImage('hoodie-grey');
    expect(count(makeGarmentBack(hoodie, loadGarment('hoodie-grey').rig), white)).toBeLessThan(count(hoodie, white) * 0.3);

    // Neckline: the T-shirt's back is opaque where its front neckline dips.
    const coral = loadGarmentImage('tee-coral');
    const rig = loadGarment('tee-coral').rig;
    const back = makeGarmentBack(coral, rig);
    const x = coral.width - 1 - Math.round(rig.kp.neckC.x);
    const y = Math.round(rig.kp.neckC.y - 3);
    expect(coral.data[(y * coral.width + Math.round(rig.kp.neckC.x)) * 4 + 3]).toBeLessThan(128);
    expect(back.data[(y * back.width + x) * 4 + 3]).toBe(255);
  });
});

describe('size recommendation', () => {
  it('computes ellipse circumferences', () => {
    expect(ellipseCircumference(10, 10)).toBeCloseTo(2 * Math.PI * 10, 6);
    expect(ellipseCircumference(20, 10)).toBeCloseTo(96.88, 1);
  });

  it('measures scale and widths from the height on bodies of known size', () => {
    for (const build of ['slim', 'average', 'broad']) {
      const body = makeSyntheticBody({ build, arms: POSES['A-pose'], height: 760, center: [240, 150] });
      const t = body.truth;
      const truePxPerCm = t.sw / 35;
      const headTop = t.toLocal(t.head.center.x, t.head.center.y).v - t.head.rv;
      const heelV = t.toLocal(body.points[29].x, body.points[29].y).v;
      const statureCm = (heelV - headTop) / truePxPerCm;
      const model = measureBody(body.points, body.mask);
      const scale = measureScale(model, body.points, body.mask, statureCm);
      expect(scale.method).toBe('stature');
      expect(Math.abs(scale.pxPerCm / truePxPerCm - 1)).toBeLessThan(0.02);
      const m = bodyMeasurements(model, scale.pxPerCm, null, { clothing: 0, statureCm });
      for (const [k, v] of [['chestWidth', model.armpitV], ['waistWidth', model.waistV]]) {
        expect(Math.abs(m[k] - (2 * t.halfWidth(v)) / truePxPerCm)).toBeLessThanOrEqual(2);
      }
    }
  });

  it('falls back to a rough scale without a height', () => {
    const body = makeSyntheticBody({ build: 'average' });
    const scale = measureScale(measureBody(body.points, body.mask), body.points, body.mask, null);
    expect(scale.confidence).toBe('rough');
  });

  it('recommends bigger sizes for bigger bodies and says how each size fits', () => {
    const chart = chartFor('top');
    const sizes = [80, 90, 98, 106, 114].map((chest) => recommendSize({ chest, waist: chest - 10 }, chart).size);
    expect(sizes).toEqual(['XS', 'S', 'M', 'L', 'XL']);
    expect(fitVerdicts({ chest: 98, waist: 88 }, chart, 'S').chest).toBe('too tight');
    expect(fitVerdicts({ chest: 98, waist: 84 }, chart, 'M').chest).toBe('regular');
    expect(fitVerdicts({ chest: 98, waist: 84 }, chart, 'XXL').chest).toBe('loose');
    expect(recommendSize({ waist: 81, hips: 100 }, chartFor('trousers')).size).toBe('32');
  });

  it('draws a chosen size true to its measurements', () => {
    const chart = chartFor('top');
    const m = { chest: 100, waist: 88 };
    const s = sizeFit(chart, 'S', m, 4, 'top');
    const xl = sizeFit(chart, 'XL', m, 4, 'top');
    expect(s.tight).toBe(false);
    expect(xl.easePx).toBeGreaterThan(s.easePx);
    expect(xl.lengthPx).toBeGreaterThan(s.lengthPx);
    expect(sizeFit(chart, 'XS', m, 4, 'top').tight).toBe(true);
    // And the fit honours it.
    const body = makeSyntheticBody({ build: 'average' });
    const g = loadGarment('tee-coral');
    const model = measureBody(body.points, body.mask);
    const small = fitGarment(model, g.rig, { easePx: 0, lengthPx: 200 });
    const big = fitGarment(model, g.rig, { easePx: 20, lengthPx: 260 });
    expect(big.scale.kx).toBeGreaterThan(small.scale.kx);
    expect(big.scale.sLen / small.scale.sLen).toBeCloseTo(260 / 200, 5);
  });
});
