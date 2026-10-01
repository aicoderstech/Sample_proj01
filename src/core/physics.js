// Spring-damper "sway" for the lower part of the garment: each mesh vertex
// is pulled towards where the rigid fit puts it, so the hem lags behind and
// swings when you move.
export class ClothSway {
  constructor({ stiffness = 90, damping = 9, maxOffset = 0.18 } = {}) {
    this.k = stiffness;
    this.c = damping;
    this.maxOffset = maxOffset; // fraction of the reference size (shoulder width)
    this.pos = null;
    this.vel = null;
    this.out = null;
  }

  reset() {
    this.pos = null;
    this.vel = null;
  }

  /**
   * @param {Float32Array} targets  rigid vertex positions [x0,y0,x1,y1,...]
   * @param {Float32Array} weights  0 = rigid, 1 = fully simulated, per vertex
   * @param {number} dt             seconds since the last step
   * @param {number} refSize        body scale in pixels (shoulder width)
   * @returns {Float32Array} positions to draw
   */
  step(targets, weights, dt, refSize) {
    const n = weights.length;
    if (!this.pos || this.pos.length !== targets.length) {
      this.pos = Float32Array.from(targets);
      this.vel = new Float32Array(targets.length);
      this.out = new Float32Array(targets.length);
    }
    const out = this.out;
    const maxOff = Math.max(1, refSize * this.maxOffset);
    const snapOff = maxOff * 4;
    const total = Math.min(Math.max(dt, 0), 0.05);
    const steps = Math.max(1, Math.ceil(total / (1 / 120)));
    const h = total / steps;

    for (let i = 0; i < n; i++) {
      const xi = i * 2;
      const yi = xi + 1;
      const w = weights[i];
      const tx = targets[xi];
      const ty = targets[yi];
      if (w <= 0) {
        this.pos[xi] = tx;
        this.pos[yi] = ty;
        this.vel[xi] = 0;
        this.vel[yi] = 0;
        out[xi] = tx;
        out[yi] = ty;
        continue;
      }
      let px = this.pos[xi];
      let py = this.pos[yi];
      let vx = this.vel[xi];
      let vy = this.vel[yi];
      if (Math.hypot(px - tx, py - ty) > snapOff || !Number.isFinite(px + py + vx + vy)) {
        // Tracking jumped (person re-entered the frame): don't fling the cloth.
        px = tx;
        py = ty;
        vx = 0;
        vy = 0;
      }
      for (let s = 0; s < steps; s++) {
        vx += (this.k * (tx - px) - this.c * vx) * h;
        vy += (this.k * (ty - py) - this.c * vy) * h;
        px += vx * h;
        py += vy * h;
      }
      let ox = px - tx;
      let oy = py - ty;
      const off = Math.hypot(ox, oy);
      if (off > maxOff) {
        const f = maxOff / off;
        ox *= f;
        oy *= f;
        px = tx + ox;
        py = ty + oy;
        vx *= 0.5;
        vy *= 0.5;
      }
      this.pos[xi] = px;
      this.pos[yi] = py;
      this.vel[xi] = vx;
      this.vel[yi] = vy;
      out[xi] = tx + ox * w;
      out[yi] = ty + oy * w;
    }
    return out;
  }
}
