// Fit report for a real image: compares where the garment landed with the
// person's segmentation mask (there is no ground truth for real photos, so
// the pose model's own outline is the reference). Used by the studio's debug
// hook and the real-photo dry runs.
//
//   onBody      share of the garment's torso / sleeve / leg pixels that lie on
//               the person (within 4% of a shoulder width of the outline).
//               Torso fabric is only counted above the hips, where it should
//               rest on the body; skirts and loose hems may hang free below.
//   coverage    share of the person's torso (tops, dresses: chest to waist)
//               or hip band (bottoms) that the garment covers.
import { buildGrid } from './fit.js';
import { PART } from './garmentRig.js';
import { rasterizeMeshes } from './raster.js';

const GROUPS = {
  [PART.BODY]: 'torso',
  [PART.SLEEVE_LEFT]: 'sleeves',
  [PART.SLEEVE_RIGHT]: 'sleeves',
  [PART.LEG_LEFT]: 'legs',
  [PART.LEG_RIGHT]: 'legs',
};

/** Max filter with a square window of radius r (separable). */
function dilate(src, w, h, r) {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let count = 0;
    const row = y * w;
    for (let x = -r; x < w; x++) {
      if (x + r < w && src[row + x + r]) count++;
      if (x - r - 1 >= 0 && src[row + x - r - 1]) count--;
      if (x >= 0) tmp[row + x] = count > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = -r; y < h; y++) {
      if (y + r < h && tmp[(y + r) * w + x]) count++;
      if (y - r - 1 >= 0 && tmp[(y - r - 1) * w + x]) count--;
      if (y >= 0) out[y * w + x] = count > 0 ? 1 : 0;
    }
  }
  return out;
}

/**
 * @param {object} o
 * @param {object} o.body      measureBody() result used for the fit
 * @param {object} o.fit       fitGarment() result
 * @param {object} o.garment   prepareGarment() result (analysis, rig)
 * @param {{data: Float32Array, width: number, height: number}} o.mask person segmentation
 * @param {number} o.width     image width
 * @param {number} o.height    image height
 */
export function fitReport({ body, fit, garment, mask, width, height }) {
  const { analysis, rig } = garment;
  // Person mask at image resolution.
  const person = new Uint8Array(width * height);
  const sx = mask.width / width;
  const sy = mask.height / height;
  for (let y = 0; y < height; y++) {
    const my = Math.min(mask.height - 1, Math.floor(y * sy));
    for (let x = 0; x < width; x++) {
      const mx = Math.min(mask.width - 1, Math.floor(x * sx));
      person[y * width + x] = mask.data[my * mask.width + mx] >= 0.5 ? 1 : 0;
    }
  }
  const near = dilate(person, width, height, Math.max(1, Math.round(body.sw * 0.04)));

  const covered = new Uint8Array(width * height);
  const stats = {};
  for (const p of fit.parts) {
    const grid = buildGrid({ map: p.map, physicsWeight: () => 0 }, p.rect, p.cols, p.rows);
    const cover = rasterizeMeshes(width, height, [
      {
        points: grid.points,
        cols: p.cols,
        rows: p.rows,
        rect: p.rect,
        opaque: (gx, gy) => {
          const x = Math.round(gx);
          const y = Math.round(gy);
          if (x < 0 || y < 0 || x >= analysis.width || y >= analysis.height) return false;
          const i = y * analysis.width + x;
          return analysis.mask[i] === 1 && rig.parts[i] === p.part;
        },
      },
    ]);
    const group = GROUPS[p.part] || 'torso';
    const s = (stats[group] ||= { px: 0, on: 0 });
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (!cover[i]) continue;
        covered[i] = 1;
        if (group === 'torso' && body.toLocal(x + 0.5, y + 0.5).v > body.T) continue;
        s.px++;
        if (near[i]) s.on++;
      }
    }
  }

  // Coverage of the body band the garment is meant to cover.
  const bottom = rig.type === 'bottom';
  // Below the neckline: an open neckline is open by design.
  let vFrom = bottom ? 0.97 * body.T : 0.15 * body.T;
  if (!bottom && rig.kp.neckC) {
    const nc = fit.mapPoint(rig.kp.neckC.x, rig.kp.neckC.y, PART.BODY);
    vFrom = Math.max(vFrom, body.toLocal(nc.x, nc.y).v + 0.05 * body.T);
  }
  const vTo = bottom ? 1.03 * body.T : 0.7 * body.T;
  let need = 0;
  let got = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!person[i]) continue;
      const l = body.toLocal(x + 0.5, y + 0.5);
      if (l.v < vFrom || l.v > vTo) continue;
      if (Math.abs(l.u) > body.halfAt(l.v, l.u < 0 ? 'imageLeft' : 'imageRight')) continue;
      need++;
      if (covered[i]) got++;
    }
  }

  const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    shoulderWidth: Math.round(body.sw),
    // Body measurements in shoulder widths (torso length, chest / waist / hip widths).
    body: {
      torso: r1(body.T / body.sw),
      chest: r1((body.halfAt(body.armpitV, 'imageLeft') + body.halfAt(body.armpitV, 'imageRight')) / body.sw),
      waist: r1((body.halfAt(body.waistV, 'imageLeft') + body.halfAt(body.waistV, 'imageRight')) / body.sw),
      hips: r1((body.halfAt(body.T, 'imageLeft') + body.halfAt(body.T, 'imageRight')) / body.sw),
      reliability: body.reliability,
    },
    scale: { kx: r1(fit.scale.kx * 100) / 100, sLen: r1(fit.scale.sLen * 100) / 100 },
    onBody: Object.fromEntries(Object.entries(stats).map(([k, s]) => [k, pct(s.on, s.px)])),
    coverage: pct(got, need),
  };
}
