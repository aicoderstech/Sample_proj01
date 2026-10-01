// Composites the background (camera frame / photo), the fitted garment and
// the wearer's arms, in this order:
//   1. background
//   2. garment body (torso, skirt, trouser seat and legs)
//   3. the wearer's forearms and hands, cut out of the background with the
//      segmentation mask, so arms crossed in front of the body stay in front
//   4. sleeves, which cover the arms
import { computeBodyFrame } from './body.js';
import { BodyFilter, measureBody } from './bodyModel.js';
import { buildGrid, createGarmentMapper } from './fit.js';
import { fitGarment } from './fit2.js';
import { PART } from './garmentRig.js';
import { GLMeshRenderer } from './glMesh.js';
import { drawImageMesh } from './mesh.js';
import { ClothSway } from './physics.js';

const SKELETON = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
];
const SLEEVES = new Set([PART.SLEEVE_LEFT, PART.SLEEVE_RIGHT]);

const offscreen = () => document.createElement('canvas');

export class TryOnRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{webgl?: boolean}} options  webgl=false forces the 2D-canvas mesh
   */
  constructor(canvas, { webgl = true } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bg = offscreen();
    this.bgCtx = this.bg.getContext('2d');
    this.layer = offscreen();
    this.layerCtx = this.layer.getContext('2d');
    this.arms = offscreen();
    this.armsCtx = this.arms.getContext('2d');
    this.armMask = offscreen();
    this.armMaskCtx = this.armMask.getContext('2d');
    this.person = offscreen();
    this.personCtx = this.person.getContext('2d');
    this.probe = offscreen();
    this.probe.width = 8;
    this.probe.height = 8;
    this.probeCtx = this.probe.getContext('2d', { willReadFrequently: true });
    this.sways = new Map();
    this.bodyFilter = new BodyFilter();
    this.gl = webgl ? GLMeshRenderer.create() : null;
    this.brightness = 1;
    this.frameCount = 0;
  }

  resize(width, height) {
    for (const c of [this.canvas, this.bg, this.layer, this.arms, this.armMask]) {
      if (c.width !== width || c.height !== height) {
        c.width = width;
        c.height = height;
      }
    }
  }

  resetMotion() {
    this.sways.clear();
    this.bodyFilter.reset();
  }

  sway(key) {
    let s = this.sways.get(key);
    if (!s) {
      s = new ClothSway();
      this.sways.set(key, s);
    }
    return s;
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
   * @param {CanvasImageSource|null} o.source      background (video / photo)
   * @param {(ctx:CanvasRenderingContext2D)=>void} [o.drawBackground] custom background painter
   * @param {boolean} o.mirror                      flip horizontally (selfie view)
   * @param {object[]|null} o.points                pixel landmarks
   * @param {{data:Float32Array,width:number,height:number,scale?:number}|null} [o.mask] person segmentation
   * @param {object|null} o.garment                 result of prepareGarment()
   * @param {{size:number,length:number,offset:number}} o.adjust
   * @param {number} o.dt                            seconds since last frame
   * @param {boolean} o.physics                      enable hem sway
   * @param {boolean} [o.temporal]                   smooth body measurements over frames (live video)
   * @param {boolean} [o.guides]                     draw the body tracking / fit guides
   * @param {'v1'|'v2'} [o.engine]                   fit engine (v2 unless forced or unavailable)
   */
  render(o) {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    this.resize(w, h); // keep the off-screen layers the canvas's size
    const bctx = this.bgCtx;
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, w, h);
    if (o.drawBackground) o.drawBackground(bctx);
    else if (o.source) bctx.drawImage(o.source, 0, 0, w, h);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (o.mirror) ctx.setTransform(-1, 0, 0, 1, w, 0);
    ctx.drawImage(this.bg, 0, 0);

    const g = o.garment;
    const useGl = !!(this.gl && !this.gl.lost && g && g.readable !== false);
    let result = { frame: null, drawn: false, webgl: useGl, engine: null };
    const useV2 = g && o.engine !== 'v1' && g.rig && g.readable !== false;

    if (o.points && g && useV2) {
      let body = measureBody(o.points, o.mask || null);
      if (o.temporal) body = this.bodyFilter.apply(body);
      if (body) {
        const fit = fitGarment(body, g.rig, o.adjust, { followArms: o.followArms !== false });
        const meshes = fit.parts.map((part) => {
          const cols = useGl ? part.cols : Math.min(part.cols, 12);
          const rows = useGl ? part.rows : Math.min(part.rows, 16);
          const grid = buildGrid({ map: part.map, physicsWeight: (gy) => part.sway(part.rect.x + part.rect.w / 2, gy) }, part.rect, cols, rows);
          const pts = o.physics ? this.sway(part.part).step(grid.points, grid.weights, o.dt, body.sw) : grid.points;
          return { part: part.part, image: g.partCanvases?.[part.part] ?? g.canvas, rect: part.rect, points: pts, cols, rows };
        });
        if (!o.physics) this.sways.clear();
        if (o.matchLighting && o.source && this.frameCount++ % 10 === 0) this.updateLighting(o.source, body.frame);
        this.drawGarment(meshes.filter((m) => !SLEEVES.has(m.part)), useGl, body.sw, o.matchLighting);
        this.drawArms(body, o.mask);
        this.drawGarment(meshes.filter((m) => SLEEVES.has(m.part)), useGl, body.sw, o.matchLighting);
        result = { frame: body.frame, body, fit, drawn: true, webgl: useGl, engine: 'v2' };
        if (o.guides) this.drawGuides(o.points, body, fit);
      } else {
        this.resetMotion();
      }
    } else if (o.points && g) {
      // Classic engine: used for cross-origin garments whose pixels can't be analysed.
      const frame = computeBodyFrame(o.points);
      if (frame) {
        const mapper = createGarmentMapper(frame, g.anchors, o.adjust, { followArms: o.followArms !== false });
        const cols = useGl ? 16 : 10;
        const rows = useGl ? 22 : 14;
        const grid = buildGrid(mapper, g.rect, cols, rows);
        const pts = o.physics ? this.sway('v1').step(grid.points, grid.weights, o.dt, frame.shoulderWidth) : grid.points;
        if (o.matchLighting && o.source && this.frameCount++ % 10 === 0) this.updateLighting(o.source, frame);
        this.drawGarment([{ image: g.canvas, rect: g.rect, points: pts, cols, rows }], useGl, frame.shoulderWidth, o.matchLighting);
        result = { frame, drawn: true, webgl: useGl, engine: 'v1' };
        if (o.guides) this.drawGuides(o.points, null, null);
      }
    } else if (o.guides && o.points) {
      this.drawGuides(o.points, null, null);
    }
    if (!result.drawn) this.resetMotion();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return result;
  }

  drawGarment(meshes, useGl, sw, matchLighting) {
    if (!meshes.length) return;
    const { ctx } = this;
    const w = this.canvas.width;
    const h = this.canvas.height;
    let layer = this.layer;
    if (useGl) {
      layer = this.gl.drawMeshes(w, h, meshes);
    } else {
      const lc = this.layerCtx;
      lc.setTransform(1, 0, 0, 1, 0, 0);
      lc.clearRect(0, 0, w, h);
      for (const m of meshes) drawImageMesh(lc, m.image, m.rect, m.points, m.cols, m.rows);
    }
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
    ctx.shadowBlur = Math.max(4, sw * 0.06);
    ctx.shadowOffsetY = sw * 0.015;
    if (matchLighting && Math.abs(this.brightness - 1) > 0.01) ctx.filter = `brightness(${this.brightness.toFixed(3)})`;
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
  }

  /** Redraws the wearer's forearms and hands (from the background) over the garment body. */
  drawArms(body, mask) {
    const arms = Object.values(body.arms);
    if (!mask || !arms.length) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    // Person mask as an alpha image.
    if (this.person.width !== mask.width || this.person.height !== mask.height) {
      this.person.width = mask.width;
      this.person.height = mask.height;
      this.personImage = null;
    }
    this.personImage ||= this.personCtx.createImageData(mask.width, mask.height);
    const px = this.personImage.data;
    for (let i = 0; i < mask.data.length; i++) {
      px[i * 4 + 3] = mask.data[i] >= 0.5 ? 255 : Math.max(0, mask.data[i] * 2 - 0.2) * 255;
    }
    this.personCtx.putImageData(this.personImage, 0, 0);

    const mc = this.armMaskCtx;
    mc.setTransform(1, 0, 0, 1, 0, 0);
    mc.globalCompositeOperation = 'source-over';
    mc.clearRect(0, 0, w, h);
    mc.strokeStyle = '#fff';
    mc.lineCap = 'round';
    mc.lineJoin = 'round';
    for (const a of arms) {
      const c = a.chain;
      if (c.length < 3) continue; // no forearm visible
      // From the lower half of the upper arm (the shoulder end stays under
      // the garment) to the fingertips.
      const start = { x: c[0].x + (c[1].x - c[0].x) * 0.55, y: c[0].y + (c[1].y - c[0].y) * 0.55 };
      mc.lineWidth = a.rU * 2.4;
      mc.beginPath();
      mc.moveTo(start.x, start.y);
      mc.lineTo(c[1].x, c[1].y);
      mc.stroke();
      mc.lineWidth = a.rF * 2.5;
      mc.beginPath();
      mc.moveTo(c[1].x, c[1].y);
      for (let i = 2; i < c.length; i++) mc.lineTo(c[i].x, c[i].y);
      mc.stroke();
    }
    mc.globalCompositeOperation = 'destination-in';
    mc.drawImage(this.person, 0, 0, w, h);
    mc.globalCompositeOperation = 'source-over';

    const ac = this.armsCtx;
    ac.setTransform(1, 0, 0, 1, 0, 0);
    ac.globalCompositeOperation = 'source-over';
    ac.clearRect(0, 0, w, h);
    ac.drawImage(this.bg, 0, 0);
    ac.globalCompositeOperation = 'destination-in';
    ac.drawImage(this.armMask, 0, 0);
    ac.globalCompositeOperation = 'source-over';
    this.ctx.drawImage(this.arms, 0, 0);
  }

  /** Body tracking and fit guides: skeleton, measured outline, pinned points. */
  drawGuides(points, body, fit) {
    const { ctx } = this;
    const lw = Math.max(2, this.canvas.width / 320);
    ctx.save();
    ctx.lineWidth = lw;
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
      ctx.arc(points[i].x, points[i].y, lw * 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    if (body) {
      ctx.strokeStyle = 'rgba(255, 210, 60, 0.95)';
      ctx.setLineDash([lw * 3, lw * 2]);
      for (const side of ['imageLeft', 'imageRight']) {
        ctx.beginPath();
        let first = true;
        for (let v = body.neckBaseV; v <= body.T * 1.3; v += body.T / 30) {
          const u = (side === 'imageLeft' ? -1 : 1) * body.halfAt(v, side);
          const p = body.toImage(u, v);
          if (first) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
          first = false;
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    if (fit) {
      ctx.fillStyle = 'rgba(255, 60, 120, 0.95)';
      for (const pin of fit.pins) {
        ctx.beginPath();
        ctx.arc(pin.image.x, pin.image.y, lw * 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }
}
