import { describe, expect, it } from 'vitest';
import { analyzeGarment, defaultAnchors, deriveAnchors, guessGarmentType, removeBackground } from '../../src/core/garment.js';
import { DRESS, rasterize, SKIRT, TEE, TROUSERS } from './shapes.js';

const alphaAt = (img, x, y) => img.data[(y * img.width + x) * 4 + 3];

describe('removeBackground', () => {
  it('removes a plain white product-photo background', () => {
    const img = rasterize(TEE);
    const out = removeBackground(img);
    expect(out.removed).toBe(true);
    expect(alphaAt(out, 0, 0)).toBe(0);
    expect(alphaAt(out, 599, 499)).toBe(0);
    expect(alphaAt(out, 300, 300)).toBe(255);
    expect(alphaAt(out, 300, 40)).toBe(0); // neck opening is background too
    expect(out.background.map(Math.round)).toEqual([255, 255, 255]);
  });

  it('keeps white areas inside the garment that are not connected to the border', () => {
    const img = rasterize(TEE, {
      extra: (data, i, x, y) => {
        if (x > 270 && x < 330 && y > 250 && y < 300) data.set([255, 255, 255, 255], i);
      },
    });
    const out = removeBackground(img);
    expect(alphaAt(out, 300, 275)).toBe(255);
  });

  it('leaves images that already have transparency untouched', () => {
    const img = rasterize(TEE, { background: [0, 0, 0, 0] });
    const out = removeBackground(img);
    expect(out.removed).toBe(false);
    expect(out.reason).toBe('already-transparent');
    expect(Buffer.from(out.data).equals(Buffer.from(img.data))).toBe(true);
  });

  it('refuses busy (non-uniform) backgrounds', () => {
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const img = rasterize(TEE);
    for (let i = 0; i < img.data.length; i += 4) {
      if (img.data[i] === 255) img.data.set([rand() * 255, rand() * 255, rand() * 255, 255], i);
    }
    const out = removeBackground(img);
    expect(out.removed).toBe(false);
    expect(out.reason).toBe('busy-background');
  });

  it('does not modify the input buffer', () => {
    const img = rasterize(TEE);
    const copy = new Uint8ClampedArray(img.data);
    removeBackground(img);
    expect(Buffer.from(img.data).equals(Buffer.from(copy))).toBe(true);
  });
});

describe('analyzeGarment + guessGarmentType', () => {
  const prepare = (shape) => analyzeGarment(removeBackground(rasterize(shape)));

  it('returns null for an empty image', () => {
    expect(analyzeGarment(rasterize({ width: 50, height: 50, polygons: [] }, { background: [0, 0, 0, 0] }))).toBeNull();
  });

  it('measures the bounding box', () => {
    const a = prepare(TEE);
    expect(a.bbox.x).toBeCloseTo(57, -1);
    expect(a.bbox.y).toBeCloseTo(30, -1);
    expect(a.bbox.w).toBeGreaterThan(470);
    expect(a.bbox.h).toBeGreaterThan(430);
  });

  it.each([
    ['T-shirt', TEE, 'top'],
    ['sundress', DRESS, 'dress'],
    ['skirt', SKIRT, 'bottom'],
    ['trousers', TROUSERS, 'bottom'],
  ])('classifies a %s as %s', (_name, shape, type) => {
    expect(guessGarmentType(prepare(shape))).toBe(type);
  });
});

describe('deriveAnchors', () => {
  it('finds the torso, shoulder line and both sleeves of a T-shirt', () => {
    const anchors = deriveAnchors(analyzeGarment(removeBackground(rasterize(TEE))), 'top');
    expect(anchors.fitWidth).toBeGreaterThan(295);
    expect(anchors.fitWidth).toBeLessThan(320);
    expect(anchors.centerX).toBeCloseTo(300, -1);
    expect(anchors.anchorY).toBeGreaterThan(55);
    expect(anchors.anchorY).toBeLessThan(80);
    for (const side of ['imageLeft', 'imageRight']) {
      const s = anchors.sleeves[side];
      expect(s).toBeDefined();
      // Seen from the armhole pivot, T-shirt sleeves point out and down.
      expect(s.angle).toBeGreaterThan(0.4);
      expect(s.angle).toBeLessThan(1.3);
      expect(s.minAngle).toBeLessThan(s.angle);
      expect(s.maxAngle).toBeGreaterThan(s.angle);
    }
    expect(anchors.sleeves.imageLeft.pivot.x).toBeLessThan(anchors.centerX);
    expect(anchors.sleeves.imageRight.pivot.x).toBeGreaterThan(anchors.centerX);
  });

  it('anchors a strappy dress at the top of its straps and measures the bust', () => {
    const anchors = deriveAnchors(analyzeGarment(removeBackground(rasterize(DRESS))), 'dress');
    expect(anchors.anchorY).toBeLessThan(40);
    expect(anchors.fitWidth).toBeGreaterThan(240);
    expect(anchors.fitWidth).toBeLessThan(290);
    expect(anchors.sleeves).toEqual({});
  });

  it('anchors a skirt at its waistband', () => {
    const anchors = deriveAnchors(analyzeGarment(removeBackground(rasterize(SKIRT))), 'bottom');
    expect(anchors.anchorY).toBe(20);
    expect(anchors.fitWidth).toBeCloseTo(250, -1);
  });

  it('falls back to proportional anchors when pixels are unreadable', () => {
    const anchors = defaultAnchors(400, 500, 'top');
    expect(anchors).toMatchObject({ type: 'top', centerX: 200, sleeves: {} });
    expect(anchors.fitWidth).toBeGreaterThan(0);
    expect(deriveAnchors(null, 'dress').type).toBe('dress');
  });
});
