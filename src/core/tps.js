// Thin-plate spline (TPS) warp: the smoothest 2D deformation that moves a
// set of source points exactly (or, with regularization, nearly) onto
// target points. The standard warp used by virtual try-on systems to fit a
// garment's construction points onto a body.

const U = (r2) => (r2 > 1e-12 ? r2 * Math.log(r2) : 0);

/** Solves A x = b (in place) by Gaussian elimination with partial pivoting. */
function solve(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) throw new Error('TPS system is singular');
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      if (!f) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

/**
 * @param {{x:number,y:number}[]} src control points (garment)
 * @param {{x:number,y:number}[]} dst matching targets (body / image)
 * @param {number} [lambda] smoothing; 0 = exact interpolation
 * @returns {(x:number, y:number) => {x:number, y:number}}
 */
export function fitTps(src, dst, lambda = 0) {
  const n = src.length;
  if (n < 3) throw new Error('TPS needs at least 3 points');
  // Normalize source coordinates for numerical conditioning.
  let mx = 0;
  let my = 0;
  for (const p of src) {
    mx += p.x;
    my += p.y;
  }
  mx /= n;
  my /= n;
  let sc = 0;
  for (const p of src) sc = Math.max(sc, Math.hypot(p.x - mx, p.y - my));
  sc = sc || 1;
  const P = src.map((p) => ({ x: (p.x - mx) / sc, y: (p.y - my) / sc }));

  const build = () => {
    const A = [];
    for (let i = 0; i < n; i++) {
      const row = new Array(n + 3).fill(0);
      for (let j = 0; j < n; j++) {
        const dx = P[i].x - P[j].x;
        const dy = P[i].y - P[j].y;
        row[j] = U(dx * dx + dy * dy) + (i === j ? lambda : 0);
      }
      row[n] = 1;
      row[n + 1] = P[i].x;
      row[n + 2] = P[i].y;
      A.push(row);
    }
    for (let k = 0; k < 3; k++) {
      const row = new Array(n + 3).fill(0);
      for (let j = 0; j < n; j++) row[j] = k === 0 ? 1 : k === 1 ? P[j].x : P[j].y;
      A.push(row);
    }
    return A;
  };
  const wx = solve(build(), [...dst.map((p) => p.x), 0, 0, 0]);
  const wy = solve(build(), [...dst.map((p) => p.y), 0, 0, 0]);

  return (x, y) => {
    const qx = (x - mx) / sc;
    const qy = (y - my) / sc;
    let ox = wx[n] + wx[n + 1] * qx + wx[n + 2] * qy;
    let oy = wy[n] + wy[n + 1] * qx + wy[n + 2] * qy;
    for (let j = 0; j < n; j++) {
      const dx = qx - P[j].x;
      const dy = qy - P[j].y;
      const u = U(dx * dx + dy * dy);
      ox += wx[j] * u;
      oy += wy[j] * u;
    }
    return { x: ox, y: oy };
  };
}
