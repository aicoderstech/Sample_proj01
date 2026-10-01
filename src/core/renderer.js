// Composites a background (camera frame / photo) and the warped garment.
import { computeBodyFrame } from './body.js';
import { buildGrid, createGarmentMapper } from './fit.js';
import { GLMeshRenderer } from './glMesh.js';
import { drawImageMesh } from './mesh.js';
import { ClothSway } from './physics.js';

const SKELETON = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
];

export class TryOnRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{webgl?: boolean}} options  webgl=false forces the 2D-canvas mesh
   */
  constructor(canvas, { webgl = true } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.layer = document.createElement('canvas');
    this.layerCtx = this.layer.getContext('2d');
    this.probe = document.createElement('canvas');
    this.probe.width = 8;
    this.probe.height = 8;
    this.probeCtx = this.probe.getContext('2d', { willReadFrequently: true });
    this.sway = new ClothSway();
    this.gl = webgl ? GLMeshRenderer.create() : null;
    this.brightness = 1;
    this.frameCount = 0;
  }

  resize(width, height) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    if (this.layer.width !== width || this.layer.height !== height) {
      this.layer.width = width;
      this.layer.height = height;
    }
  }

  resetMotion() {
    this.sway.reset();
  }

  /** Estimates scene brightness around the torso so the garment matches the lighting. */
  updateLighting(source, frame) {
    try {
      const size = frame.shoulderWidth * 1.2;
      const cx = (frame.shoulderMid.x + frame.hipMid.x) / 2;
      const cy = (frame.shoulderMid.y + frame.hipMid.y) / 2;
      this.probeCtx.drawImage(source, cx - size / 2, cy - size / 2, size, size, 0, 0, 8, 8);
      const d = this.probeCtx.getImageData(0, 0, 8, 8).data;
      let lum = 0;
      for (let i = 0; i < d.length; i += 4) lum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      lum /= d.length / 4;
      const target = Math.min(1.08, Math.max(0.8, 0.78 + lum * 0.45));
      this.brightness += (target - this.brightness) * 0.25;
    } catch {
      this.brightness = 1;
    }
  }

  /**
   * @param {object} o
   * @param {CanvasImageSource|null} o.source      background (video / photo); null to skip
   * @param {(ctx:CanvasRenderingContext2D)=>void} [o.drawBackground] custom background painter
   * @param {boolean} o.mirror                      flip horizontally (selfie view)
   * @param {object[]|null} o.points                pixel landmarks
   * @param {{canvas:CanvasImageSource, anchors:object, rect:object}|null} o.garment
   * @param {{size:number,length:number,offset:number}} o.adjust
   * @param {number} o.dt                            seconds since last frame
   * @param {boolean} o.physics                      enable hem sway
   * @param {boolean} [o.skeleton]                   debug overlay
   * @param {boolean} [o.matchLighting]
   */
  render(o) {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (o.mirror) ctx.setTransform(-1, 0, 0, 1, w, 0);
    if (o.drawBackground) o.drawBackground(ctx);
    else if (o.source) ctx.drawImage(o.source, 0, 0, w, h);

    const frame = o.points ? computeBodyFrame(o.points) : null;
    let result = { frame, drawn: false };
    if (frame && o.garment) {
      const mapper = createGarmentMapper(frame, o.garment.anchors, o.adjust, { followArms: o.followArms !== false });
      // WebGL draws a fine mesh in one call; the 2D fallback uses a coarser
      // one (it can't upload cross-origin "tainted" images to WebGL either).
      const useGl = this.gl && !this.gl.lost && o.garment.readable !== false;
      const cols = useGl ? 16 : 10;
      const rows = useGl ? 22 : 14;
      const grid = buildGrid(mapper, o.garment.rect, cols, rows);
      const pts = o.physics ? this.sway.step(grid.points, grid.weights, o.dt, frame.shoulderWidth) : grid.points;
      if (!o.physics) this.sway.reset();

      if (o.matchLighting && o.source && this.frameCount++ % 10 === 0) this.updateLighting(o.source, frame);
      let layer = this.layer;
      if (useGl) {
        layer = this.gl.draw({ width: w, height: h, image: o.garment.canvas, rect: o.garment.rect, points: pts, cols, rows });
      } else {
        const lc = this.layerCtx;
        lc.setTransform(1, 0, 0, 1, 0, 0);
        lc.clearRect(0, 0, w, h);
        drawImageMesh(lc, o.garment.canvas, o.garment.rect, pts, cols, rows);
      }

      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
      ctx.shadowBlur = Math.max(4, frame.shoulderWidth * 0.06);
      ctx.shadowOffsetY = frame.shoulderWidth * 0.015;
      if (o.matchLighting && Math.abs(this.brightness - 1) > 0.01) ctx.filter = `brightness(${this.brightness.toFixed(3)})`;
      ctx.drawImage(layer, 0, 0);
      ctx.restore();
      result = { frame, drawn: true, mapper, points: pts, webgl: useGl };
    } else {
      this.sway.reset();
    }

    if (o.skeleton && o.points) this.drawSkeleton(o.points);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return result;
  }

  drawSkeleton(points) {
    const { ctx } = this;
    ctx.save();
    ctx.lineWidth = Math.max(2, this.canvas.width / 320);
    ctx.strokeStyle = 'rgba(80, 255, 200, 0.9)';
    ctx.fillStyle = '#ffffff';
    for (const [a, b] of SKELETON) {
      if (points[a].v < 0.5 || points[b].v < 0.5) continue;
      ctx.beginPath();
      ctx.moveTo(points[a].x, points[a].y);
      ctx.lineTo(points[b].x, points[b].y);
      ctx.stroke();
    }
    for (const i of [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
      if (points[i].v < 0.5) continue;
      ctx.beginPath();
      ctx.arc(points[i].x, points[i].y, ctx.lineWidth * 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
