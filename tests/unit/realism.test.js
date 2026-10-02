// Making a fitted garment look worn: photo matching, layering (what stays in
// front of the garment), neckline completion, pose folds, fold-over culling,
// and the failures found in real-photo dry runs.
import { describe, expect, it } from 'vitest';
import { measureBody } from '../../src/core/bodyModel.js';
import { fitGarment } from '../../src/core/fit2.js';
import { PART } from '../../src/core/garmentRig.js';
import { hairMask, untuckedTopMask } from '../../src/core/layering.js';
import { dominantWinding } from '../../src/core/mesh.js';
import { applyLook, estimateNoise, estimatePhotoLook, NEUTRAL_LOOK } from '../../src/core/photoMatch.js';
import { isSideOn, lowerBodyInView, poseFolds } from '../../src/core/renderer.js';
import { turnAcross } from '../../src/core/orientation.js';
import { makeSyntheticBody } from '../../src/core/syntheticBody.js';
import { LABEL, undress } from '../../src/core/undress.js';
import { segDist } from '../../src/core/vec.js';
import { loadGarment, POSES } from '../bench/fitBench.js';

/** A w x h RGBA image from a colour function. */
function image(w, h, colour) {
  const pix = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pix.set([...colour(x, y), 255], (y * w + x) * 4);
  return pix;
}

/** Deterministic Gaussian noise (Box-Muller on a small LCG). */
function gaussian(seed = 1) {
  let s = seed;
  const u = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return (s + 0.5) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

describe('photo matching', () => {
  // A scene: a wall (top), a floor, something dark and something coloured.
  const scene = (wall, { colour = [180, 60, 60], floor = [120, 110, 100], scale = 1 } = {}) =>
    image(120, 90, (x, y) => {
      const c = y < 40 ? wall : x < 30 ? [2, 2, 2] : x < 60 ? colour : floor;
      return c.map((v) => v * scale);
    });

  it('leaves a neutral, well exposed photo nearly alone', () => {
    const look = estimatePhotoLook(scene([245, 245, 245]), 120, 90);
    for (const g of look.gain) expect(g).toBeGreaterThan(0.95);
    expect(Math.max(...look.gain) - Math.min(...look.gain)).toBeLessThan(0.02);
    expect(look.sat).toBe(1);
    expect(look.lift).toBeLessThan(0.03);
  });

  it('takes on warm indoor light from the white wall', () => {
    const look = estimatePhotoLook(scene([250, 225, 180]), 120, 90);
    expect(look.gain[0]).toBeGreaterThan(look.gain[2] + 0.1);
  });

  it('dulls the garment in an under-exposed photo and greys it in a black-and-white one', () => {
    const dark = estimatePhotoLook(scene([245, 245, 245], { scale: 0.55 }), 120, 90);
    expect(Math.max(...dark.gain)).toBeLessThan(0.75);
    const bw = estimatePhotoLook(scene([235, 235, 235], { colour: [90, 90, 90], floor: [120, 120, 120] }), 120, 90);
    expect(bw.sat).toBe(0);
  });

  it('lifts the blacks of a hazy photo', () => {
    const hazy = image(100, 100, (x, y) => [40 + (x + y) * 0.9, 40 + (x + y) * 0.9, 40 + (x + y) * 0.9]);
    expect(estimatePhotoLook(hazy, 100, 100).lift).toBeGreaterThan(0.1);
  });

  it('measures sensor noise', () => {
    const n = gaussian(7);
    const sigma = 0.02;
    const noisy = image(128, 128, () => {
      const v = 128 + n() * sigma * 255;
      return [v, v, v];
    });
    const clean = image(128, 128, (x) => [x, x, x]);
    const est = estimateNoise({ data: noisy, width: 128, height: 128 });
    // Three quarters of the measured deviation is counted as noise.
    expect(est).toBeGreaterThan(sigma * 0.6);
    expect(est).toBeLessThan(sigma * 0.9);
    expect(estimateNoise({ data: clean, width: 128, height: 128 })).toBeLessThan(0.002);
  });
});

describe('layering', () => {
  it('keeps hair attached to the head in front, not stray hair-coloured bits', () => {
    const w = 60;
    const h = 60;
    const labels = new Uint8Array(w * h);
    for (let y = 5; y < 40; y++) for (let x = 20; x < 30; x++) labels[y * w + x] = LABEL.HAIR; // head and a long lock
    for (let y = 50; y < 55; y++) for (let x = 50; x < 55; x++) labels[y * w + x] = LABEL.HAIR; // elsewhere
    const m = hairMask(labels, w, h, { x: 25, y: 10, rx: 6, ry: 6, angle: 0 });
    expect(m[35 * w + 25]).toBe(1);
    expect(m[52 * w + 52]).toBe(0);
    expect(hairMask(labels, w, h, null)).toBeNull();
  });

  /** A body in a red top and blue trousers; the top hangs `drop` shoulder widths below the waist. */
  function dressed(drop, top = [200, 40, 40]) {
    const body = makeSyntheticBody({ build: 'average', arms: POSES['A-pose'] });
    const { width: w, height: h, truth } = body;
    const labels = new Uint8Array(w * h);
    const pix = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const l = truth.toLocal(x + 0.5, y + 0.5);
        if (!truth.isPerson(x + 0.5, y + 0.5) || truth.isArm(x + 0.5, y + 0.5)) {
          pix.set(truth.isArm(x + 0.5, y + 0.5) ? [205, 160, 130, 255] : [235, 235, 235, 255], i * 4);
          labels[i] = truth.isArm(x + 0.5, y + 0.5) ? LABEL.BODY_SKIN : 0;
          continue;
        }
        if (l.v < 0) {
          labels[i] = LABEL.FACE_SKIN;
          pix.set([205, 160, 130, 255], i * 4);
        } else if (l.v < truth.T + drop * truth.sw && Math.abs(l.u) <= truth.halfWidth(Math.min(l.v, truth.T)) + 2) {
          labels[i] = LABEL.CLOTHES;
          pix.set([...top, 255], i * 4);
        } else {
          labels[i] = LABEL.CLOTHES;
          pix.set([40, 60, 160, 255], i * 4);
        }
      }
    }
    return { body, model: measureBody(body.points, body.mask), labels, pix, w, h };
  }

  it('finds an untucked top hanging over the waist, down to its hem', () => {
    const d = dressed(0.15);
    const m = untuckedTopMask({ pix: d.pix, labels: d.labels, w: d.w, h: d.h, k: 1, body: d.model });
    expect(m).not.toBeNull();
    const { truth } = d.body;
    const at = (u, v) => {
      const p = truth.toImage(u, v);
      return m[Math.floor(p.y) * d.w + Math.floor(p.x)];
    };
    expect(at(0, truth.T + 0.08 * truth.sw)).toBe(1);
    expect(at(0, truth.T + 0.3 * truth.sw)).toBe(0);
    // Above the waist the new trousers don't reach: not part of the mask.
    expect(at(0, 0.3 * truth.T)).toBe(0);
  });

  it('draws nothing in front when top and trousers are the same colour', () => {
    const d = dressed(0.15, [40, 60, 160]);
    expect(untuckedTopMask({ pix: d.pix, labels: d.labels, w: d.w, h: d.h, k: 1, body: d.model })).toBeNull();
  });
});

describe('neckline', () => {
  it('shows the neck inside a new crew neck instead of the old collar, and the back collar beside it', () => {
    const body = makeSyntheticBody({ build: 'average', arms: POSES['A-pose'] });
    const { width: w, height: h, truth } = body;
    const model = measureBody(body.points, body.mask);
    const labels = new Uint8Array(w * h);
    const pix = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const x = (i % w) + 0.5;
      const y = Math.floor(i / w) + 0.5;
      if (!truth.isPerson(x, y)) continue;
      const l = truth.toLocal(x, y);
      // An old shirt up to the chin; skin above.
      labels[i] = l.v > model.neckBaseV - 0.12 * truth.T ? LABEL.CLOTHES : LABEL.FACE_SKIN;
      pix.set(labels[i] === LABEL.CLOTHES ? [250, 250, 250, 255] : [200, 150, 120, 255], i * 4);
    }
    // The new top's neckline opening: a band around the neck base.
    const sw = truth.sw;
    const opening = [
      [-0.32, -0.5],
      [0.32, -0.5],
      [0.32, 0.06],
      [-0.32, 0.06],
    ].map(([u, v]) => model.toImage(u * sw, model.neckBaseV + v * truth.T));
    const res = undress({ pix, labels, cover: new Uint8Array(w * h), w, h, k: 1, body: model, type: 'top', neckline: opening, inner: [90, 30, 20] });
    const at = (u, v) => {
      const p = model.toImage(u, v);
      return Math.floor(p.y) * w + Math.floor(p.x);
    };
    const neck = at(0, model.neckBaseV - 0.03 * truth.T);
    expect(res.changed[neck]).toBe(1);
    expect(res.pix[neck * 4]).toBeGreaterThan(150); // skin, not the white collar
    expect(res.pix[neck * 4 + 2]).toBeLessThan(150);
    const beside = at(0.28 * sw, model.neckBaseV - 0.02 * truth.T);
    expect(res.pix[beside * 4]).toBeLessThan(110); // the inside of the back collar
  });
});

describe('pose folds', () => {
  it('places knee folds at the knee and bunches long trousers at the ankle', () => {
    const body = makeSyntheticBody({ build: 'average', arms: POSES['A-pose'] });
    const model = measureBody(body.points, body.mask);
    const g = loadGarment('jeans-indigo');
    const fit = fitGarment(model, g.rig);
    const leg = fit.parts.find((p) => p.part === PART.LEG_LEFT);
    const f = poseFolds(leg, g.rig, model);
    expect(f.kind).toBe(4);
    const [kneeS, length, bend] = f.limb;
    expect(kneeS / length).toBeGreaterThan(0.3);
    expect(kneeS / length).toBeLessThan(0.7);
    expect(bend).toBeLessThan(0.1);
    // Whiskers from the crotch, on the seat as well as the legs.
    expect(f.amt[2]).toBeGreaterThan(0.2);
    expect(poseFolds(fit.parts.find((p) => p.part === PART.BODY), g.rig, model).kind).toBe(3);
  });

  it('bends with the knee', () => {
    const straight = makeSyntheticBody({ build: 'average', arms: POSES['A-pose'] });
    const bent = makeSyntheticBody({ build: 'average', arms: POSES['A-pose'], legs: { imageLeft: { spread: 0.9, shin: 0.1 } } });
    const g = loadGarment('jeans-indigo');
    const bendOf = (b) => {
      const model = measureBody(b.points, b.mask);
      const leg = fitGarment(model, g.rig).parts.find((p) => p.part === PART.LEG_LEFT);
      return poseFolds(leg, g.rig, model).limb[2];
    };
    expect(bendOf(bent)).toBeGreaterThan(bendOf(straight) + 0.3);
  });

  it('drags folds from the armpits when the arms hang down', () => {
    const g = loadGarment('tee-coral');
    const drag = (pose) => {
      const b = makeSyntheticBody({ build: 'average', arms: POSES[pose] });
      const model = measureBody(b.points, b.mask);
      const torso = fitGarment(model, g.rig).parts.find((p) => p.part === PART.BODY);
      const f = poseFolds(torso, g.rig, model);
      expect(f.kind).toBe(1);
      return f.amt[0];
    };
    expect(drag('arms down')).toBeGreaterThan(drag('T-pose') + 0.2);
  });
});

describe('fold-over culling', () => {
  it('finds which way a warped grid faces', () => {
    const cols = 4;
    const rows = 3;
    const grid = (flip) => {
      const p = new Float32Array((cols + 1) * (rows + 1) * 2);
      for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) p.set([flip ? -i * 10 : i * 10, j * 10], (j * (cols + 1) + i) * 2);
      return p;
    };
    expect(dominantWinding(grid(false), cols, rows)).toBe(1);
    expect(dominantWinding(grid(true), cols, rows)).toBe(-1);
  });
});

describe('dry-run fixes', () => {
  it('eases fabric onto the far edge of a turned body without collapsing it', () => {
    for (const yaw of [0.6, -0.9, 1.2]) {
      // Strictly increasing up to the outline: no band of the garment is
      // squashed to nothing (which showed the clothes underneath).
      let prev = -Infinity;
      for (let s = -1; s <= 0.999; s += 0.02) {
        const t = turnAcross(s, yaw);
        expect(t).toBeGreaterThan(prev);
        prev = t;
      }
      expect(turnAcross(Math.sign(yaw), yaw)).toBeCloseTo(Math.sign(yaw), 6);
    }
  });

  it('only draws skirts and trousers when the hips are in the picture', () => {
    const body = { sw: 100 };
    const pts = [];
    pts[23] = { x: 0, y: 500, v: 0.9 };
    pts[24] = { x: 0, y: 500, v: 0.9 };
    expect(lowerBodyInView(pts, body, 900)).toBe(true);
    expect(lowerBodyInView(pts, body, 520)).toBe(false); // cut off just below the hips
    pts[23] = { x: 0, y: 500, v: 0.1 };
    pts[24] = { x: 0, y: 500, v: 0.1 };
    expect(lowerBodyInView(pts, body, 900)).toBe(false); // hips not seen
  });

  /** A body in an old long-sleeved top; arms crossed in front of the torso. */
  function crossedArms() {
    const body = makeSyntheticBody({ build: 'average', arms: POSES['arms crossed'] });
    const { width: w, height: h, truth } = body;
    const model = measureBody(body.points, body.mask);
    const labels = new Uint8Array(w * h);
    const pix = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const x = (i % w) + 0.5;
      const y = Math.floor(i / w) + 0.5;
      if (!truth.isPerson(x, y)) continue;
      const face = truth.toLocal(x, y).v < model.neckBaseV - 0.12 * truth.T;
      labels[i] = face ? LABEL.FACE_SKIN : LABEL.CLOTHES;
      pix.set(face ? [200, 150, 120, 255] : [20, 30, 60, 255], i * 4);
    }
    return { body, model, labels, pix, w, h, truth };
  }

  it('bares a forearm crossing in front of the new garment', () => {
    const { model, labels, pix, w, h, truth } = crossedArms();
    // The new top covers the whole torso, forearms included.
    const cover = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const l = truth.toLocal((i % w) + 0.5, Math.floor(i / w) + 0.5);
      if (l.v > 0 && l.v < truth.T && Math.abs(l.u) <= truth.halfWidth(l.v)) cover[i] = 1;
    }
    const res = undress({ pix, labels, cover, w, h, k: 1, body: model, type: 'top' });
    const fa = truth.arms.imageLeft;
    const p = { x: Math.round((fa.elbow.x + fa.wrist.x) / 2), y: Math.round((fa.elbow.y + fa.wrist.y) / 2) };
    expect(cover[p.y * w + p.x]).toBe(1);
    expect(res.skin[p.y * w + p.x]).toBe(1);
  });

  it('repaints the dark edge an old sleeve leaves on the background beside a bare arm', () => {
    const body = makeSyntheticBody({ build: 'average', arms: POSES['arms down'] });
    const { width: w, height: h, truth } = body;
    const model = measureBody(body.points, body.mask);
    const chain = model.arms.imageLeft.chain;
    const armDist = (x, y) => Math.min(...chain.slice(1).map((b, j) => segDist({ x, y }, chain[j], b)));
    // A wall, the face, and a thin dark sleeve whose edge spills a pixel or
    // two past the labels (which are coarser than the picture).
    const sleeve = 0.045 * truth.sw;
    const labels = new Uint8Array(w * h);
    const pix = new Uint8ClampedArray(w * h * 4);
    const fringe = [];
    for (let i = 0; i < w * h; i++) {
      const x = (i % w) + 0.5;
      const y = Math.floor(i / w) + 0.5;
      const d = armDist(x, y);
      if (truth.isPerson(x, y) && truth.toLocal(x, y).v < model.neckBaseV - 0.12 * truth.T) {
        labels[i] = LABEL.FACE_SKIN;
        pix.set([200, 150, 120, 255], i * 4);
      } else if (d <= sleeve) {
        labels[i] = LABEL.CLOTHES;
        pix.set([20, 30, 60, 255], i * 4);
      } else if (d <= sleeve + 1.5) {
        // Some of the edge is left out of the wearer's mask.
        if (fringe.length % 3 === 0) labels[i] = LABEL.OTHER_PERSON;
        pix.set([35, 40, 65, 255], i * 4);
        fringe.push(i);
      } else pix.set([200, 200, 200, 255], i * 4);
    }
    const res = undress({ pix, labels, cover: new Uint8Array(w * h), w, h, k: 1, body: model, type: 'top' });
    expect(res.background).toBe(0); // the sleeve is all arm: nothing removed
    expect(fringe.length).toBeGreaterThan(20);
    for (const i of fringe) {
      expect(res.changed[i]).toBe(1);
      expect(res.pix[i * 4]).toBeGreaterThan(150); // the wall, not the sleeve's edge
    }
  });

  it('turns an old collar standing beside the neck into background, and jacket padding outside the body', () => {
    const { model, labels, pix, w, h, truth } = crossedArms();
    const sw = truth.sw;
    const opening = [
      [-0.9, -0.6],
      [0.9, -0.6],
      [0.9, 0.06],
      [-0.9, 0.06],
    ].map(([u, v]) => model.toImage(u * sw, model.neckBaseV + v * truth.T));
    // Old clothes above the neck base beside the neck, and wider than the body.
    for (let i = 0; i < w * h; i++) {
      const l = model.toLocal((i % w) + 0.5, Math.floor(i / w) + 0.5);
      if (l.v > model.neckBaseV - 0.3 * truth.T && l.v < model.neckBaseV + 0.05 * truth.T && Math.abs(l.u) < 0.8 * sw) {
        labels[i] = LABEL.CLOTHES;
        pix.set([20, 30, 60, 255], i * 4);
      }
    }
    const res = undress({ pix, labels, cover: new Uint8Array(w * h), w, h, k: 1, body: model, type: 'top', neckline: opening, inner: [90, 30, 20] });
    const at = (u, v) => {
      const p = model.toImage(u, v);
      return Math.floor(p.y) * w + Math.floor(p.x);
    };
    expect(res.removed[at(0.3 * sw, model.neckBaseV - 0.2 * truth.T)]).toBe(1); // collar standing up
    expect(res.removed[at(0.75 * sw, model.neckBaseV + 0.02 * truth.T)]).toBe(1); // padding past the shoulders
    expect(res.skin[at(0, model.neckBaseV - 0.03 * truth.T)]).toBe(1); // the neck
  });

  it('declines side-on poses but fits bodies turned three-quarters', () => {
    expect(isSideOn({ T: 150, sw: 100 })).toBe(false); // facing the camera
    expect(isSideOn({ T: 200, sw: 100 })).toBe(false); // turned 3/4
    expect(isSideOn({ T: 290, sw: 100 })).toBe(true); // side-on: shoulders overlap
  });

  it('grades a garment colour like the photo (the inside of a collar in a black-and-white photo is grey)', () => {
    expect(applyLook([200, 40, 40], NEUTRAL_LOOK)).toEqual([200, 40, 40]);
    const grey = applyLook([200, 40, 40], { lift: 0, gain: [1, 1, 1], sat: 0, grain: 0 });
    expect(grey[0]).toBe(grey[1]);
    expect(grey[1]).toBe(grey[2]);
    const hazy = applyLook([0, 0, 0], { lift: 0.1, gain: [1, 1, 1], sat: 1, grain: 0 });
    expect(hazy[0]).toBeGreaterThan(20);
  });
});
