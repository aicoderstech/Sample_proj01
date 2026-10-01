// One Euro filter (Casiez et al. 2012): low jitter when still, low lag when
// moving. Used to steady the pose landmarks between camera frames.
const smoothingFactor = (cutoff, dt) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

export class OneEuroFilter {
  constructor({ minCutoff = 1.2, beta = 0.01, dCutoff = 1 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset() {
    this.x = null;
    this.dx = 0;
    this.t = null;
  }

  /** @param {number} value @param {number} t time in seconds */
  filter(value, t) {
    if (this.x === null || this.t === null || t <= this.t) {
      if (this.x === null || this.t === null) {
        this.x = value;
        this.t = t;
      }
      return this.x;
    }
    const dt = t - this.t;
    this.t = t;
    const rawDx = (value - this.x) / dt;
    this.dx += smoothingFactor(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += smoothingFactor(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

/** Smooths an array of {x, y, v} points; keeps visibility as-is. */
export class PointSmoother {
  constructor(options) {
    this.options = options;
    this.filters = [];
  }

  reset() {
    this.filters = [];
  }

  smooth(points, t) {
    if (this.filters.length !== points.length) {
      this.filters = points.map(() => [new OneEuroFilter(this.options), new OneEuroFilter(this.options)]);
    }
    return points.map((p, i) => ({
      x: this.filters[i][0].filter(p.x, t),
      y: this.filters[i][1].filter(p.y, t),
      v: p.v,
    }));
  }
}
