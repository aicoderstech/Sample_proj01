// "Spine" warp for sleeves and trouser legs: a point described by its
// distance s along a straight garment axis and its offset t across it is
// placed at distance s along a body polyline (shoulder -> elbow -> wrist, or
// hip -> knee -> ankle), offset t along the polyline's local normal. The
// normal is averaged over a window around s, so the limb bends smoothly at
// the elbow or knee instead of creasing.

export function makeSpine(points) {
  const segs = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) continue;
    segs.push({ a, b, len, start: total, dir: { x: (b.x - a.x) / len, y: (b.y - a.y) / len } });
    total += len;
  }
  if (!segs.length) {
    const p = points[0] || { x: 0, y: 0 };
    segs.push({ a: p, b: { x: p.x, y: p.y + 1 }, len: 1, start: 0, dir: { x: 0, y: 1 } });
    total = 1;
  }
  const last = segs[segs.length - 1];
  const first = segs[0];

  const pointAt = (s) => {
    if (s <= 0) return { x: first.a.x + first.dir.x * s, y: first.a.y + first.dir.y * s };
    for (const g of segs) {
      if (s <= g.start + g.len) {
        const k = s - g.start;
        return { x: g.a.x + g.dir.x * k, y: g.a.y + g.dir.y * k };
      }
    }
    const k = s - last.start;
    return { x: last.a.x + last.dir.x * k, y: last.a.y + last.dir.y * k };
  };

  /** Direction averaged over [s - w, s + w] (weighted by overlap). */
  const tangentAt = (s, w) => {
    let tx = 0;
    let ty = 0;
    const lo = s - w;
    const hi = s + w;
    for (let i = 0; i < segs.length; i++) {
      const g = segs[i];
      const a = i === 0 ? -Infinity : g.start;
      const b = i === segs.length - 1 ? Infinity : g.start + g.len;
      const overlap = Math.min(hi, b) - Math.max(lo, a);
      if (overlap > 0) {
        tx += g.dir.x * overlap;
        ty += g.dir.y * overlap;
      }
    }
    const l = Math.hypot(tx, ty);
    return l > 1e-9 ? { x: tx / l, y: ty / l } : first.dir;
  };

  /**
   * @param {number} s distance along the spine
   * @param {number} t signed offset across (positive = to the right of travel, y down)
   * @param {number} smooth averaging half-window for the bend (pixels)
   */
  const place = (s, t, smooth) => {
    const p = pointAt(s);
    const d = tangentAt(s, Math.max(1, smooth));
    // Right-hand normal on screen (y down): rotate the direction by +90 deg.
    return { x: p.x - d.y * t, y: p.y + d.x * t };
  };

  /** Arc length of the point on the spine closest to p. */
  const project = (p) => {
    let best = Infinity;
    let at = 0;
    for (const g of segs) {
      const k = Math.min(g.len, Math.max(0, (p.x - g.a.x) * g.dir.x + (p.y - g.a.y) * g.dir.y));
      const d = Math.hypot(p.x - g.a.x - g.dir.x * k, p.y - g.a.y - g.dir.y * k);
      if (d < best) {
        best = d;
        at = g.start + k;
      }
    }
    return at;
  };

  return { length: total, pointAt, tangentAt, place, project };
}
