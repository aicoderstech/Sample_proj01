// CPU rasterizer for warped garment meshes. Produces a coverage map (which
// image pixels the garment covers) without a browser; used to measure fit
// accuracy in tests and benchmarks.

/**
 * @param {number} width image width
 * @param {number} height image height
 * @param {Array<{points: Float32Array|number[], cols: number, rows: number, rect: {x,y,w,h}, opaque: (gx:number, gy:number) => boolean}>} meshes
 * @returns {Uint8Array} 1 where an opaque garment pixel lands
 */
export function rasterizeMeshes(width, height, meshes) {
  const out = new Uint8Array(width * height);
  for (const m of meshes) {
    const { points, cols, rows, rect, opaque } = m;
    const P = (i, j) => {
      const k = (j * (cols + 1) + i) * 2;
      return [points[k], points[k + 1]];
    };
    const S = (i, j) => [rect.x + (rect.w * i) / cols, rect.y + (rect.h * j) / rows];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const tris = [
          [P(i, j), P(i + 1, j), P(i + 1, j + 1), S(i, j), S(i + 1, j), S(i + 1, j + 1)],
          [P(i, j), P(i + 1, j + 1), P(i, j + 1), S(i, j), S(i + 1, j + 1), S(i, j + 1)],
        ];
        for (const [d0, d1, d2, s0, s1, s2] of tris) {
          const minX = Math.max(0, Math.floor(Math.min(d0[0], d1[0], d2[0])));
          const maxX = Math.min(width - 1, Math.ceil(Math.max(d0[0], d1[0], d2[0])));
          const minY = Math.max(0, Math.floor(Math.min(d0[1], d1[1], d2[1])));
          const maxY = Math.min(height - 1, Math.ceil(Math.max(d0[1], d1[1], d2[1])));
          const den = (d1[1] - d2[1]) * (d0[0] - d2[0]) + (d2[0] - d1[0]) * (d0[1] - d2[1]);
          if (Math.abs(den) < 1e-9) continue;
          for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
              const px = x + 0.5;
              const py = y + 0.5;
              const a = ((d1[1] - d2[1]) * (px - d2[0]) + (d2[0] - d1[0]) * (py - d2[1])) / den;
              const b = ((d2[1] - d0[1]) * (px - d2[0]) + (d0[0] - d2[0]) * (py - d2[1])) / den;
              const c = 1 - a - b;
              if (a < -1e-6 || b < -1e-6 || c < -1e-6) continue;
              const gx = a * s0[0] + b * s1[0] + c * s2[0];
              const gy = a * s0[1] + b * s1[1] + c * s2[1];
              if (opaque(gx, gy)) out[y * width + x] = 1;
            }
          }
        }
      }
    }
  }
  return out;
}
