// The v2 engine for the benchmark: measured body model + garment rig + fit2.
import { measureBody } from '../../src/core/bodyModel.js';
import { buildGrid } from '../../src/core/fit.js';
import { fitGarment } from '../../src/core/fit2.js';

export function v2Engine(body, g) {
  const model = measureBody(body.points, body.mask);
  if (!model) return null;
  const fit = fitGarment(model, g.rig);
  return {
    meshes: fit.parts.map((p) => ({
      points: buildGrid({ map: p.map, physicsWeight: () => 0 }, p.rect, p.cols, p.rows).points,
      cols: p.cols,
      rows: p.rows,
      rect: p.rect,
      part: p.part,
    })),
    mapPoint: fit.mapPoint,
  };
}
