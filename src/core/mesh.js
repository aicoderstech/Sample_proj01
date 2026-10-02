// Draws an image warped onto a grid of points using affine-mapped triangles
// on a 2D canvas (each cell = 2 triangles).

/**
 * Affine transform taking source triangle (s0,s1,s2) onto (d0,d1,d2),
 * as canvas transform arguments [a, b, c, d, e, f]. Null if degenerate.
 */
export function affineFromTriangles(s0, s1, s2, d0, d1, d2) {
  const sx1 = s1.x - s0.x;
  const sy1 = s1.y - s0.y;
  const sx2 = s2.x - s0.x;
  const sy2 = s2.y - s0.y;
  const den = sx1 * sy2 - sx2 * sy1;
  if (Math.abs(den) < 1e-9) return null;
  const dx1 = d1.x - d0.x;
  const dy1 = d1.y - d0.y;
  const dx2 = d2.x - d0.x;
  const dy2 = d2.y - d0.y;
  const a = (dx1 * sy2 - dx2 * sy1) / den;
  const c = (dx2 * sx1 - dx1 * sx2) / den;
  const b = (dy1 * sy2 - dy2 * sy1) / den;
  const d = (dy2 * sx1 - dy1 * sx2) / den;
  const e = d0.x - a * s0.x - c * s0.y;
  const f = d0.y - b * s0.x - d * s0.y;
  return [a, b, c, d, e, f];
}

/**
 * The way most of a warped grid's triangles wind (+1 or -1: the sign of
 * their area in image coordinates). Where a bend folds the fabric over,
 * the triangles on the fold's far side wind the other way: they are the
 * back of the cloth, drawn first so the front lies over them.
 */
export function dominantWinding(points, cols, rows) {
  let sum = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = (j * (cols + 1) + i) * 2;
      const b = a + 2;
      const d = a + (cols + 1) * 2 + 2;
      const area = (points[b] - points[a]) * (points[d + 1] - points[a + 1]) - (points[b + 1] - points[a + 1]) * (points[d] - points[a]);
      sum += Math.sign(area);
    }
  }
  return sum < 0 ? -1 : 1;
}

const winding = (p0, p1, p2) => Math.sign((p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x));

/** Pushes triangle corners away from the centroid to hide hairline seams. */
function expand(p0, p1, p2, px) {
  const cx = (p0.x + p1.x + p2.x) / 3;
  const cy = (p0.y + p1.y + p2.y) / 3;
  return [p0, p1, p2].map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const l = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / l) * px, y: p.y + (dy / l) * px };
  });
}

function drawTriangle(ctx, image, s0, s1, s2, d0, d1, d2) {
  const m = affineFromTriangles(s0, s1, s2, d0, d1, d2);
  if (!m) return;
  const [e0, e1, e2] = expand(d0, d1, d2, 1.5);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(e0.x, e0.y);
  ctx.lineTo(e1.x, e1.y);
  ctx.lineTo(e2.x, e2.y);
  ctx.closePath();
  ctx.clip();
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.drawImage(image, 0, 0);
  ctx.restore();
}

/**
 * @param ctx    CanvasRenderingContext2D
 * @param image  CanvasImageSource (garment)
 * @param src    {x,y,w,h} region of the image covered by the grid
 * @param points Float32Array of (cols+1)*(rows+1) destination points
 */
export function drawImageMesh(ctx, image, src, points, cols, rows) {
  const P = (i, j) => {
    const k = (j * (cols + 1) + i) * 2;
    return { x: points[k], y: points[k + 1] };
  };
  const S = (i, j) => ({ x: src.x + (src.w * i) / cols, y: src.y + (src.h * j) / rows });
  const front = dominantWinding(points, cols, rows);
  // The back of any fold first, then the front over it.
  for (const pass of [-front, front]) {
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const s00 = S(i, j);
        const s10 = S(i + 1, j);
        const s01 = S(i, j + 1);
        const s11 = S(i + 1, j + 1);
        const d00 = P(i, j);
        const d10 = P(i + 1, j);
        const d01 = P(i, j + 1);
        const d11 = P(i + 1, j + 1);
        if (winding(d00, d10, d11) === pass) drawTriangle(ctx, image, s00, s10, s11, d00, d10, d11);
        if (winding(d00, d11, d01) === pass) drawTriangle(ctx, image, s00, s11, s01, d00, d11, d01);
      }
    }
  }
}
