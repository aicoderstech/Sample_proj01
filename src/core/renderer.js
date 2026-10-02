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
import { rasterizeMeshes } from './raster.js';
import { DEFAULT_LIGHT, estimateLight } from './lighting.js';
import { LABEL, undress } from './undress.js';
import { NEUTRAL_LOOK, applyLook, estimatePhotoLook } from './photoMatch.js';
import { hairMask, untuckedTopMask } from './layering.js';

// Pixels of other people in the picture (not one of the parser's labels).
const LABEL_OTHER_PERSON = 9;
import { GLMeshRenderer } from './glMesh.js';
import { drawImageMesh } from './mesh.js';
import { ClothSway } from './physics.js';

const SKELETON = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
];
const SLEEVES = new Set([PART.SLEEVE_LEFT, PART.SLEEVE_RIGHT]);

const offscreen = () => document.createElement('canvas');

/**
 * The head as an ellipse from the face landmarks: from above the eyes down
 * to the chin, as wide as the ears. Null when the face isn't visible.
 */
export function headOutline(points) {
  if (!points) return null;
  const seen = (i) => points[i] && points[i].v >= 0.5;
  if (![0, 2, 5, 9, 10].every(seen)) return null;
  const mid = (a, b) => ({ x: (points[a].x + points[b].x) / 2, y: (points[a].y + points[b].y) / 2 });
  const eyes = mid(2, 5);
  const mouth = mid(9, 10);
  const d = { x: mouth.x - eyes.x, y: mouth.y - eyes.y };
  const len = Math.hypot(d.x, d.y);
  if (len < 1) return null;
  const chin = { x: mouth.x + d.x * 0.95, y: mouth.y + d.y * 0.95 };
  const top = { x: eyes.x - d.x * 2.4, y: eyes.y - d.y * 2.4 };
  const ears = seen(7) && seen(8) ? Math.hypot(points[7].x - points[8].x, points[7].y - points[8].y) : 0;
  return {
    x: (chin.x + top.x) / 2,
    y: (chin.y + top.y) / 2,
    rx: Math.max(ears * 0.6, len * 1.7),
    ry: (len * 4.35) / 2,
    angle: Math.atan2(d.y, d.x) - Math.PI / 2,
  };
}

/**
 * Per-vertex surface data for lit fabric (see glMesh.js FRAGMENT):
 *  nrm  - body surface normal (image plane) and the image direction of the
 *         garment's x axis;
 *  fold - drape (how far the garment stands off the body at this height,
 *         hanging in vertical folds), compression (where the warp squeezes
 *         the fabric: inside a bent elbow, a waist when leaning) and the
 *         garment axis that is squeezed.
 */
export function fabricSurface(part, points, cols, rows, body, g) {
  const n = (cols + 1) * (rows + 1);
  const nrm = new Float32Array(n * 4);
  const fold = new Float32Array(n * 4);
  const ty = new Float32Array(n * 2);
  const { rect } = part;
  const gxOf = (i) => rect.x + (rect.w * i) / cols;
  const gyOf = (j) => rect.y + (rect.h * j) / rows;
  const P = (i, j) => {
    const k = (Math.min(rows, Math.max(0, j)) * (cols + 1) + Math.min(cols, Math.max(0, i))) * 2;
    return { x: points[k], y: points[k + 1] };
  };
  // Local scale of the warp along each garment axis, and its median per part.
  const sx = new Float32Array(n);
  const sy = new Float32Array(n);
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const k = j * (cols + 1) + i;
      const ax = P(i + 1, j);
      const bx = P(i - 1, j);
      const ay = P(i, j + 1);
      const by = P(i, j - 1);
      const di = Math.min(cols, i + 1) - Math.max(0, i - 1);
      const dj = Math.min(rows, j + 1) - Math.max(0, j - 1);
      sx[k] = Math.hypot(ax.x - bx.x, ax.y - bx.y) / ((rect.w / cols) * di || 1);
      sy[k] = Math.hypot(ay.x - by.x, ay.y - by.y) / ((rect.h / rows) * dj || 1);
      const nv = part.normal ? part.normal(gxOf(i), gyOf(j)) : { x: 0, y: 0 };
      const tl = Math.hypot(ax.x - bx.x, ax.y - bx.y) || 1;
      nrm.set([nv.x, nv.y, (ax.x - bx.x) / tl, (ax.y - bx.y) / tl], k * 4);
      const yl = Math.hypot(ay.x - by.x, ay.y - by.y) || 1;
      ty[k * 2] = (ay.x - by.x) / yl;
      ty[k * 2 + 1] = (ay.y - by.y) / yl;
    }
  }
  const median = (a) => Float32Array.from(a).sort()[a.length >> 1] || 1;
  const mx = median(sx);
  const my = median(sy);
  // Drape for the body part: per garment row, how far its edges stand off the body.
  const a = g.analysis;
  const drapeRow = new Float32Array(rows + 1);
  if (part.part === PART.BODY && a?.rows) {
    for (let j = 0; j <= rows; j++) {
      const y = Math.round(gyOf(j));
      const r = y - a.bbox.y;
      if (r < 0 || r >= a.bbox.h || !a.rows.width[r]) continue;
      let excess = 0;
      for (const [x, side] of [[a.rows.left[r], 'imageLeft'], [a.rows.right[r], 'imageRight']]) {
        const p = part.map(x, y);
        const l = body.toLocal(p.x, p.y);
        if (l.v < body.armpitV) continue;
        excess += Math.max(0, Math.abs(l.u) - body.halfAt(Math.min(l.v, 1.3 * body.T), side)) / 2;
      }
      drapeRow[j] = Math.min(1, excess / (0.12 * body.sw));
    }
  }
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const k = j * (cols + 1) + i;
      const cx = sx[k] / mx;
      const cy = sy[k] / my;
      const squeeze = 1 - Math.min(cx, cy);
      const comp = Math.min(1, Math.max(0, (squeeze - 0.15) / 0.3));
      fold.set([drapeRow[j], comp, cx < cy ? 0 : 1, 0], k * 4);
    }
  }
  // Folds about every eighth of the garment's width (in garment pixels).
  return { nrm, fold, ty, foldWave: Math.max(8, (a?.bbox.w ?? rect.w) / 9), folds: body && g.rig ? poseFolds(part, g.rig, body) : null };
}

const unit = (v) => {
  const l = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / l, y: v.y / l };
};
/** Angle (radians) between two directions. */
const turn = (a, b) => Math.acos(Math.max(-1, Math.min(1, unit(a).x * unit(b).x + unit(a).y * unit(b).y)));
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * Where along a garment limb (distance from its root, garment pixels) the
 * point nearest a body joint lands; Infinity when the garment ends before it.
 */
function jointAlong(part, joint) {
  const { root, dir, length } = part.limb;
  let best = { d: Infinity, s: 0 };
  for (let i = 0; i <= 48; i++) {
    const s = (length * i) / 48;
    const p = part.map(root.x + dir.x * s, root.y + dir.y * s);
    const d = Math.hypot(p.x - joint.x, p.y - joint.y);
    if (d < best.d) best = { d, s };
  }
  return best.s >= length * 0.98 ? Infinity : best.s;
}

/**
 * Parameters of the folds a garment part makes in this pose (see glMesh.js
 * FRAGMENT): which kind of part it is, where its armpits / crotch / elbow /
 * knee are on the garment, and how strongly each kind of fold shows.
 */
export function poseFolds(part, rig, body) {
  const kp = rig.kp;
  const down = body.frame.down;
  if (part.part === PART.BODY && rig.type !== 'bottom') {
    if (!kp.armpitL || !kp.armpitR) return null;
    const sleeved = Object.keys(rig.sleeves ?? {}).length > 0;
    // Arms hanging down pull the fabric under them into folds.
    const dragOf = (side) => {
      const c = body.arms[side]?.chain;
      if (!sleeved) return 0;
      if (!c || c.length < 2) return 0.25;
      const d = unit({ x: c[1].x - c[0].x, y: c[1].y - c[0].y });
      return 0.15 + 0.45 * clamp01((d.x * down.x + d.y * down.y - 0.2) / 0.7);
    };
    const hemY = (kp.hemC ?? kp.hemL).y;
    const topY = Math.min(kp.neckL?.y ?? kp.shoulderL?.y ?? 0, kp.neckR?.y ?? kp.shoulderR?.y ?? 0);
    return {
      kind: 1,
      axis: [0, 0, 1, 0],
      limb: [0, 1, 0, 0],
      pts: [kp.armpitL.x, kp.armpitL.y, kp.armpitR.x, kp.armpitR.y],
      amt: [dragOf('imageLeft'), dragOf('imageRight'), 0, rig.type === 'top' ? 0.4 : 0.2],
      hem: [hemY, Math.max(1, hemY - topY)],
    };
  }
  const trousers = rig.type === 'bottom' && kp.crotch;
  const waistW = Math.max(1, kp.waistR.x - kp.waistL.x);
  // Whiskers deepen as the hips bend (sitting, a lunge).
  let whiskers = 0;
  if (trousers) {
    let flex = 0;
    for (const leg of Object.values(body.legs)) {
      const c = leg.chain;
      if (c.length >= 2) flex = Math.max(flex, turn(down, { x: c[1].x - c[0].x, y: c[1].y - c[0].y }));
    }
    whiskers = 0.3 + 0.4 * clamp01(flex / (Math.PI / 3));
  }
  const pts = trousers ? [kp.crotch.x, kp.crotch.y, waistW, 0] : [0, 0, 1, 0];
  if (part.part === PART.BODY) {
    return trousers ? { kind: 3, axis: [0, 0, 1, 0], limb: [0, 1, 0, 0], pts, amt: [0, 0, whiskers, 0], hem: [0, 1] } : null;
  }
  if (!part.limb) return null;
  const leg = part.part === PART.LEG_LEFT || part.part === PART.LEG_RIGHT;
  const bodyLimb = (leg ? body.legs : body.arms)[part.limb.side];
  const c = bodyLimb?.chain;
  let jointS = Infinity;
  let bend = 0;
  if (part.limb.followed && c && c.length >= 3) {
    jointS = jointAlong(part, c[1]);
    bend = clamp01(turn({ x: c[1].x - c[0].x, y: c[1].y - c[0].y }, { x: c[2].x - c[1].x, y: c[2].y - c[1].y }) / (Math.PI * 0.4));
  }
  // Longer than the limb: the end bunches up.
  const bunch = clamp01((1 - part.limb.squash) / (leg ? 0.15 : 0.2));
  const { root, dir, length } = part.limb;
  return {
    kind: leg ? 4 : 2,
    axis: [root.x, root.y, dir.x, dir.y],
    limb: [Number.isFinite(jointS) ? jointS : length * 4, length, bend, bunch],
    pts,
    amt: [0, 0, leg ? whiskers : 0, 0],
    hem: [0, 1],
  };
}

/**
 * Seen from the side (or nearly): the shoulder joints are much closer
 * together than the torso is long. A front-view garment can't be fitted to
 * that pose.
 */
export function isSideOn(body) {
  // Torso length / shoulder width: about 1.5 facing the camera, 2 turned
  // 3/4, near 3 side-on.
  return body.T > 2.4 * body.sw;
}

/**
 * Whether enough of the hips and legs is in the picture to draw a skirt or
 * trousers: a hip is seen, and there is room below the hip line (a third
 * of a shoulder width) inside the frame.
 */
export function lowerBodyInView(points, body, height) {
  const hips = [points?.[23], points?.[24]].filter((p) => p && p.v >= 0.3);
  if (!hips.length) return false;
  const y = hips.reduce((s, p) => s + p.y, 0) / hips.length;
  return y + 0.33 * body.sw < height;
}

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
    this.zone = offscreen();
    this.zoneCtx = this.zone.getContext('2d');
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
   * @param {boolean|{fill?:number}} [o.realism]   edge fill (default on with WebGL and a mask)
   * @param {boolean} [o.shading]                    lit fabric with folds (default on with WebGL)
   * @param {object|null} [o.parsing]                clothes / skin labels (lib/humanParser.js)
   * @param {boolean} [o.undress]                    take off old clothes the garment won't cover (default on with parsing)
   * @param {boolean} [o.turn]                       wrap the garment round a turned body (default on)
   *                                                (default on with WebGL and a mask)
   */
  render(o) {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    this.renderId = (this.renderId ?? 0) + 1;
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
      let body = measureBody(o.points, o.mask || null, o.parsing || null);
      if (o.temporal) body = this.bodyFilter.apply(body);
      if (body && o.turn === false) body.yaw = 0;
      if (body) {
        // Seen from behind: the garment's back.
        const g = (body.facing === 'back' && o.garment.back?.()) || o.garment;
        if (isSideOn(body)) {
          // Seen from the side the shoulders overlap: the garment, scaled by
          // them, would be a patch on one shoulder. Draw nothing; say why.
          this.resetMotion();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          return { frame: body.frame, body, drawn: false, reason: 'side-on', webgl: useGl, engine: 'v2' };
        }
        if (g.rig.type === 'bottom' && !lowerBodyInView(o.points, body, h)) {
          // A skirt or trousers on a photo cut off at the waist would be a
          // sliver along the bottom edge: draw nothing and say why.
          this.resetMotion();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          return { frame: body.frame, body, drawn: false, reason: 'lower-body-out-of-view', webgl: useGl, engine: 'v2' };
        }
        const fit = fitGarment(body, g.rig, o.adjust, { followArms: o.followArms !== false });
        const meshes = fit.parts.map((part) => {
          const cols = useGl ? part.cols : Math.min(part.cols, 12);
          const rows = useGl ? part.rows : Math.min(part.rows, 16);
          const grid = buildGrid({ map: part.map, physicsWeight: (gy) => part.sway(part.rect.x + part.rect.w / 2, gy) }, part.rect, cols, rows);
          const pts = o.physics ? this.sway(part.part).step(grid.points, grid.weights, o.dt, body.sw) : grid.points;
          const surf = useGl && o.shading !== false ? fabricSurface(part, grid.points, cols, rows, body, g) : null;
          return { part: part.part, image: g.partCanvases?.[part.part] ?? g.canvas, rect: part.rect, points: pts, cols, rows, ...surf };
        });
        if (!o.physics) this.sways.clear();
        if (o.mask) this.updatePerson(o.mask);
        this.light = o.shading === false ? null : this.sceneLight(o);
        // Take off what the wearer has on where the new garment won't cover it.
        const matching = useGl && o.realism !== false && o.photoMatch !== false;
        const look = matching ? this.photoLook(o, body) : null;
        if (o.parsing && o.undress !== false) this.undressPass(body, meshes, g, o, fit, look);
        // Post pass (WebGL): edges extended to the wearer's outline, and the
        // garment matched to the photo (tone, tint, softness, grain).
        let post = null;
        if (useGl) {
          const realism = o.realism !== false;
          post = { person: o.mask && realism ? this.person : null, fill: 0, soft: 0, look: null, seed: this.frameCount % 997 };
          if (o.mask && realism) post.fill = this.realismInputs(body.sw).fill;
          if (o.mask && realism && typeof o.realism === 'object' && o.realism.fill != null) post.fill = o.realism.fill * body.sw;
          if (realism && o.photoMatch !== false) {
            post.look = look;
            post.soft = 0.6;
          }
        }
        this.frameCount++;
        const bodyMeshes = meshes.filter((m) => !SLEEVES.has(m.part));
        const sleeveMeshes = meshes.filter((m) => SLEEVES.has(m.part));
        const shadows = o.shading !== false && !!o.mask;
        this.drawGarment(bodyMeshes, useGl, body.sw, false, post && { ...post, zone: post.person && this.drawZone(body, fit, g.rig, 'body') }, shadows);
        const front = this.frontLayer(body, o.mask, o.points, o.parsing, g.rig);
        if (front) {
          // What is in front (arms, hair, an untucked top) shades the garment under it.
          if (shadows) this.castShadow(front, body.sw, 0.3);
          this.ctx.drawImage(front, 0, 0);
        }
        this.drawGarment(sleeveMeshes, useGl, body.sw, false, post && { ...post, zone: post.person && this.drawZone(body, fit, g.rig, 'sleeves') }, shadows);
        result = { frame: body.frame, body, fit, garment: g, drawn: true, webgl: useGl, engine: 'v2' };
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

  drawGarment(meshes, useGl, sw, matchLighting, post = null, shadows = false) {
    if (!meshes.length) return;
    const { ctx } = this;
    const w = this.canvas.width;
    const h = this.canvas.height;
    let layer = this.layer;
    if (useGl) {
      layer = this.gl.drawMeshes(w, h, meshes, post, this.light);
    } else {
      const lc = this.layerCtx;
      lc.setTransform(1, 0, 0, 1, 0, 0);
      lc.clearRect(0, 0, w, h);
      for (const m of meshes) drawImageMesh(lc, m.image, m.rect, m.points, m.cols, m.rows);
    }
    if (shadows && this.person.width) {
      // Contact shadow: soft, a little away from the light, and only on the
      // wearer (neck, arms, legs, their own clothes), never on the scenery.
      this.castShadow(layer, sw, 0.36);
      ctx.drawImage(layer, 0, 0);
      return;
    }
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
    ctx.shadowBlur = Math.max(4, sw * 0.06);
    ctx.shadowOffsetY = sw * 0.015;
    if (matchLighting && Math.abs(this.brightness - 1) > 0.01) ctx.filter = `brightness(${this.brightness.toFixed(3)})`;
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
  }

  /**
   * Darkens the wearer under and around a layer (garment, arms) as the soft
   * shadow it casts: blurred, offset away from the light, cut to the person.
   */
  castShadow(caster, sw, strength) {
    const w = this.canvas.width;
    const h = this.canvas.height;
    // The shadow is soft: work at reduced size (a canvas blur costs in
    // proportion to its radius times the area) and scale it back up.
    const k = Math.min(1, 320 / Math.max(w, h));
    const sw2 = Math.max(1, Math.round(w * k));
    const sh2 = Math.max(1, Math.round(h * k));
    this.shade ||= offscreen();
    const s = this.shade;
    if (s.width !== sw2 || s.height !== sh2) {
      s.width = sw2;
      s.height = sh2;
    }
    const sc = (this.shadeCtx ||= s.getContext('2d'));
    sc.setTransform(1, 0, 0, 1, 0, 0);
    sc.globalCompositeOperation = 'source-over';
    sc.clearRect(0, 0, sw2, sh2);
    const L = this.light ?? DEFAULT_LIGHT;
    // The caster at the reduced size first (a shadow drawn straight from a
    // large source is slow).
    this.shadeSrc ||= offscreen();
    const src = this.shadeSrc;
    if (src.width !== sw2 || src.height !== sh2) {
      src.width = sw2;
      src.height = sh2;
    }
    const srcCtx = (this.shadeSrcCtx ||= src.getContext('2d'));
    srcCtx.clearRect(0, 0, sw2, sh2);
    srcCtx.drawImage(caster, 0, 0, sw2, sh2);
    // Draw only the shadow: the caster itself is placed off the canvas.
    const away = sw2 + 16;
    sc.shadowColor = '#000';
    sc.shadowBlur = Math.max(1, sw * 0.045 * k);
    sc.shadowOffsetX = away - L.x * sw * 0.05 * k;
    sc.shadowOffsetY = -L.y * sw * 0.05 * k;
    sc.drawImage(src, -away, 0);
    sc.shadowColor = 'transparent';
    sc.globalCompositeOperation = 'destination-in';
    sc.drawImage(this.person, 0, 0, sw2, sh2);
    sc.globalCompositeOperation = 'source-over';
    this.ctx.save();
    this.ctx.globalAlpha = strength;
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.drawImage(s, 0, 0, w, h);
    this.ctx.restore();
  }

  /**
   * How the photo looks (core/photoMatch.js): for a still photo once, for
   * video every half second or so, eased.
   */
  photoLook(o, body) {
    if (this.lookFrom === o.source && this.look && (!o.temporal || this.frameCount % 15 !== 0)) return this.look;
    this.lookFrom = o.source;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const k = Math.min(1, 200 / Math.max(w, h));
    const lw = Math.max(1, Math.round(w * k));
    const lh = Math.max(1, Math.round(h * k));
    this.lookCanvas ||= offscreen();
    const lc = (this.lookCtx ||= this.lookCanvas.getContext('2d', { willReadFrequently: true }));
    this.lookCanvas.width = lw;
    this.lookCanvas.height = lh;
    lc.drawImage(this.bg, 0, 0, lw, lh);
    let est;
    try {
      const pix = lc.getImageData(0, 0, lw, lh).data;
      // Noise at full resolution, on the torso and around it.
      const size = Math.max(16, Math.min(192, Math.round(body.sw * 1.2)));
      const c = body.frame.shoulderMid;
      const x0 = Math.max(0, Math.min(w - size, Math.round(c.x - size / 2)));
      const y0 = Math.max(0, Math.min(h - size, Math.round(c.y)));
      const crop = this.bgCtx.getImageData(x0, y0, Math.min(size, w), Math.min(size, h));
      est = estimatePhotoLook(pix, lw, lh, crop);
    } catch {
      return (this.look = NEUTRAL_LOOK);
    }
    const prev = this.look;
    if (!prev || !o.temporal) return (this.look = est);
    const mixv = (a, b) => a + (b - a) * 0.3;
    return (this.look = {
      lift: mixv(prev.lift, est.lift),
      gain: prev.gain.map((v, i) => mixv(v, est.gain[i])),
      sat: mixv(prev.sat, est.sat),
      grain: mixv(prev.grain, est.grain),
    });
  }

  /**
   * Light direction for the fabric, from the shading of the wearer's face
   * (core/lighting.js); recomputed when the parsing changes, eased for video.
   */
  sceneLight(o) {
    if (!o.parsing) return this.light ?? DEFAULT_LIGHT;
    if (o.parsing === this.lightFrom) return this.light;
    this.lightFrom = o.parsing;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const k = Math.min(1, 240 / Math.max(w, h));
    const lw = Math.max(1, Math.round(w * k));
    const lh = Math.max(1, Math.round(h * k));
    this.small ||= offscreen();
    this.smallCtx ||= this.small.getContext('2d', { willReadFrequently: true });
    this.small.width = lw;
    this.small.height = lh;
    this.smallCtx.drawImage(this.bg, 0, 0, lw, lh);
    const pix = this.smallCtx.getImageData(0, 0, lw, lh).data;
    const p = o.parsing;
    const m = o.mask;
    const labels = new Uint8Array(lw * lh);
    const mine = new Uint8Array(lw * lh);
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        labels[y * lw + x] = p.labels[Math.min(p.height - 1, Math.floor(((y + 0.5) / lh) * p.height)) * p.width + Math.min(p.width - 1, Math.floor(((x + 0.5) / lw) * p.width))];
        mine[y * lw + x] = !m || m.data[Math.min(m.height - 1, Math.floor(((y + 0.5) / lh) * m.height)) * m.width + Math.min(m.width - 1, Math.floor(((x + 0.5) / lw) * m.width))] >= 0.5 ? 1 : 0;
      }
    }
    const est = estimateLight(pix, labels, lw, lh, mine);
    const prev = this.light;
    if (!prev || !o.temporal) return est;
    const mixv = (a, b) => a + (b - a) * 0.3;
    const x = mixv(prev.x, est.x);
    const y = mixv(prev.y, est.y);
    const z = mixv(prev.z, est.z);
    const len = Math.hypot(x, y, z) || 1;
    return { x: x / len, y: y / len, z: z / len, confidence: est.confidence };
  }

  /**
   * Replaces the wearer's own clothes that the new garment leaves visible
   * (see core/undress.js), on a reduced-resolution copy, and lays the patch
   * over the background. Removed bulk is also taken out of the person mask,
   * so the garment's edges stop at the body.
   */
  undressPass(body, meshes, g, o, fit = null, look = null) {
    const w = this.canvas.width;
    const h = this.canvas.height;
    // The frame and its labels at reduced size, shared with the front layer.
    // (Parsing labels everyone in the picture; only the person being dressed,
    // the pose model's mask, is changed: other people count as scenery.)
    const { pix, labels, w: lw, h: lh, k } = this.sampleFrame(o);
    this.small ||= offscreen();
    this.smallCtx ||= this.small.getContext('2d', { willReadFrequently: true });
    if (this.small.width !== lw || this.small.height !== lh) {
      this.small.width = lw;
      this.small.height = lh;
      this.plate = null;
    }
    const sc = this.smallCtx;
    sc.globalCompositeOperation = 'source-over';
    // Where the new garment will be.
    const cover = rasterizeMeshes(
      lw,
      lh,
      meshes.map((m) => ({
        points: m.points.map((v) => v * k),
        cols: m.cols,
        rows: m.rows,
        rect: m.rect,
        opaque: (gx, gy) => {
          const x = Math.round(gx);
          const y = Math.round(gy);
          const a = g.analysis;
          if (!a || x < 0 || y < 0 || x >= a.width || y >= a.height) return false;
          const i = y * a.width + x;
          return a.mask[i] === 1 && (!g.rig || g.rig.parts[i] === m.part);
        },
      })),
    );
    // Live video: learn the background behind the person over time.
    if (o.temporal) {
      if (!this.plate) {
        this.plate = new Float32Array(lw * lh * 3);
        this.plateKnown = new Uint8Array(lw * lh);
      }
      for (let i = 0; i < lw * lh; i++) {
        if (labels[i] !== 0) continue;
        const a = this.plateKnown[i] ? 0.15 : 1;
        for (let c = 0; c < 3; c++) this.plate[i * 3 + c] += (pix[i * 4 + c] - this.plate[i * 3 + c]) * a;
        this.plateKnown[i] = 1;
      }
    }
    const neck = fit ? this.necklineOpening(body, fit, g) : null;
    const res = undress({
      pix,
      labels,
      cover,
      w: lw,
      h: lh,
      k,
      body,
      type: g.rig?.type ?? g.type,
      plate: o.temporal ? this.plate : null,
      plateKnown: o.temporal ? this.plateKnown : null,
      neckline: neck?.polygon ?? null,
      // The inside of the collar is garment, so it is matched to the photo
      // like the rest of it (in a black-and-white photo it is grey too).
      inner: neck?.inner ? applyLook(neck.inner, look) : null,
    });
    this.lastUndress = res ? { skin: res.skinCount, background: res.background } : null;
    // In front of a new top, only skin (the wearer's own, or made from their
    // old sleeves) is drawn: old clothes left round a forearm go behind it.
    if ((g.rig?.type ?? g.type) !== 'bottom') {
      const hide = new Uint8Array(lw * lh);
      for (let i = 0; i < lw * lh; i++) hide[i] = labels[i] === LABEL.CLOTHES && !res?.skin[i] ? 1 : 0;
      this.frontHide = { id: this.renderId, w: lw, h: lh, mask: hide };
    }
    if (!res) return;
    sc.putImageData(new ImageData(res.pix, lw, lh), 0, 0);
    this.bgCtx.imageSmoothingQuality = 'high';
    this.bgCtx.drawImage(this.small, 0, 0, w, h);
    this.ctx.drawImage(this.small, 0, 0, w, h);
    // Removed bulk is no longer part of the person.
    if (res.background && this.person.width) {
      const er = new Uint8ClampedArray(lw * lh * 4);
      for (let i = 0; i < lw * lh; i++) if (res.removed[i]) er[i * 4 + 3] = 255;
      sc.putImageData(new ImageData(er, lw, lh), 0, 0);
      this.personCtx.globalCompositeOperation = 'destination-out';
      this.personCtx.drawImage(this.small, 0, 0, this.person.width, this.person.height);
      this.personCtx.globalCompositeOperation = 'source-over';
    }
  }

  /**
   * The new top's neckline opening on the wearer (image coordinates): from
   * the neckline's curve up to well above the chin, and the colour of the
   * inside of the back collar seen through it (a sleeved top; a dress with
   * straps shows the shoulders instead).
   */
  necklineOpening(body, fit, g) {
    const kp = g.rig?.kp;
    if (!kp || g.rig.type === 'bottom' || !kp.neckL || !kp.neckR || !kp.neckC) return null;
    const ctrl = { x: 2 * kp.neckC.x - (kp.neckL.x + kp.neckR.x) / 2, y: 2 * kp.neckC.y - (kp.neckL.y + kp.neckR.y) / 2 };
    const curve = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const a = (1 - t) * (1 - t);
      const b = 2 * t * (1 - t);
      const c = t * t;
      curve.push(fit.mapPoint(a * kp.neckL.x + b * ctrl.x + c * kp.neckR.x, a * kp.neckL.y + b * ctrl.y + c * kp.neckR.y, PART.BODY));
    }
    const sleeved = Object.keys(g.rig.sleeves ?? {}).length > 0;
    const a = g.analysis;
    if (!sleeved && a?.mask) {
      // Sleeveless (straps, strapless): the opening is everything above the
      // garment's whole top edge, out past its sides over the shoulders.
      curve.length = 0;
      const { x: bx, y: by, w: bw, h: bh } = a.bbox;
      for (let i = 0; i <= 24; i++) {
        const x = Math.round(bx + 1 + ((bw - 3) * i) / 24);
        let y = by;
        while (y < by + bh && !a.mask[y * a.width + x]) y++;
        if (y < by + bh) curve.push(fit.mapPoint(x, y, PART.BODY));
      }
      if (curve.length < 3) return null;
      const out = (p, dir) => {
        const l = body.toLocal(p.x, p.y);
        return body.toImage(l.u + dir * 0.45 * body.sw, l.v);
      };
      curve.unshift(out(curve[0], -1));
      curve.push(out(curve[curve.length - 1], 1));
    }
    const last = curve[curve.length - 1];
    const top = Math.min(...curve.map((p) => body.toLocal(p.x, p.y).v)) - 0.5 * body.T;
    const up = (p) => body.toImage(body.toLocal(p.x, p.y).u, top);
    const polygon = [up(last), up(curve[0]), ...curve];
    let inner = null;
    if (sleeved) {
      this.innerColours ||= new WeakMap();
      inner = this.innerColours.get(g);
      if (!inner) {
        try {
          const x = Math.round(kp.neckC.x) - 3;
          const y = Math.round(kp.neckC.y) + 5;
          const d = g.canvas.getContext('2d').getImageData(x, y, 7, 7).data;
          const m = [0, 0, 0];
          let n = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] < 200) continue;
            m[0] += d[i];
            m[1] += d[i + 1];
            m[2] += d[i + 2];
            n++;
          }
          // The inside of the collar is in the garment's own shadow.
          inner = n ? m.map((v) => (v / n) * 0.55) : null;
        } catch {
          inner = null;
        }
        if (inner) this.innerColours.set(g, inner);
      }
    }
    return { polygon, inner };
  }

  /** The person mask as an alpha image (mask resolution). */
  updatePerson(mask) {
    if (this.person.width !== mask.width || this.person.height !== mask.height) {
      this.person.width = mask.width;
      this.person.height = mask.height;
      this.personImage = null;
    }
    this.personImage ||= this.personCtx.createImageData(mask.width, mask.height);
    const px = this.personImage.data;
    for (let i = 0; i < mask.data.length; i++) {
      px[i * 4] = 255;
      px[i * 4 + 1] = 255;
      px[i * 4 + 2] = 255;
      px[i * 4 + 3] = mask.data[i] >= 0.5 ? 255 : Math.max(0, mask.data[i] * 2 - 0.2) * 255;
    }
    this.personCtx.putImageData(this.personImage, 0, 0);
  }

  /** Inputs for the realism pass (sizes scale with the body). */
  realismInputs(sw) {
    return { person: this.person, fill: sw * 0.07 };
  }

  /**
   * Where the garment may be extended to the wearer's outline: the band it
   * covers on the body (shoulders to hem, not inside the neckline, not onto
   * the arms) for the body pass; along each arm as far as the sleeve reaches
   * for the sleeve pass.
   */
  drawZone(body, fit, rig, pass) {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const z = this.zone;
    if (z.width !== w || z.height !== h) {
      z.width = w;
      z.height = h;
    }
    const zc = this.zoneCtx;
    zc.globalCompositeOperation = 'source-over';
    zc.clearRect(0, 0, w, h);
    zc.fillStyle = '#fff';
    zc.strokeStyle = '#fff';
    zc.lineCap = 'round';
    zc.lineJoin = 'round';
    const { sw, T } = body;
    const local = (p) => body.toLocal(p.x, p.y);
    const kp = rig.kp;
    const limbStroke = (chain, end, width) => {
      // The limb's polyline up to the point nearest the garment's end.
      let best = { d: Infinity, i: 1, p: chain[0] };
      for (let i = 1; i < chain.length; i++) {
        const a = chain[i - 1];
        const b = chain[i];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((end.x - a.x) * dx + (end.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        const p = { x: a.x + dx * t, y: a.y + dy * t };
        const d = Math.hypot(end.x - p.x, end.y - p.y);
        if (d < best.d) best = { d, i, p };
      }
      // Square end at the cuff / hem: the zone stops where the garment does.
      zc.lineWidth = width;
      zc.lineCap = 'butt';
      zc.beginPath();
      zc.moveTo(chain[0].x, chain[0].y);
      for (let i = 1; i < best.i; i++) zc.lineTo(chain[i].x, chain[i].y);
      zc.lineTo(best.p.x, best.p.y);
      zc.stroke();
      zc.lineCap = 'round';
      zc.beginPath();
      zc.arc(chain[0].x, chain[0].y, width / 2, 0, Math.PI * 2);
      zc.fill();
    };

    // Hands (wrist to fingertips) are never painted over.
    const clearHands = () => {
      zc.globalCompositeOperation = 'destination-out';
      for (const arm of Object.values(body.arms)) {
        const c = arm.chain;
        if (c.length < 3) continue;
        const wr = c[2];
        const tip = c[3] ?? wr;
        zc.lineWidth = arm.rF * 3;
        zc.beginPath();
        zc.moveTo(wr.x, wr.y);
        zc.lineTo(tip.x, tip.y);
        zc.stroke();
        zc.beginPath();
        zc.arc(wr.x, wr.y, arm.rF * 1.6, 0, Math.PI * 2);
        zc.fill();
      }
      zc.globalCompositeOperation = 'source-over';
    };

    if (pass === 'sleeves') {
      for (const [side, sleeve] of Object.entries(rig.sleeves)) {
        const arm = body.arms[side];
        if (!arm) continue;
        const part = side === 'imageLeft' ? PART.SLEEVE_LEFT : PART.SLEEVE_RIGHT;
        // Up to the cuff, and no further than the wrist.
        const end = fit.mapPoint(sleeve.end.x, sleeve.end.y, part);
        const chain = arm.chain.slice(0, 3);
        limbStroke(chain, end, Math.max(arm.rU, arm.rF) * 3.2);
      }
      clearHands();
      return z;
    }

    // Body band: from above the shoulders (or the armpits, for straps) to
    // just above the hem.
    const hasSleeves = Object.keys(rig.sleeves).length > 0;
    const bottom = rig.type === 'bottom';
    const hem = kp.hemC ?? kp.crotch ?? kp.hemL;
    let vTop;
    if (bottom) vTop = local(fit.mapPoint(kp.waistL.x, kp.waistL.y, PART.BODY)).v + 0.02 * T;
    else if (!hasSleeves && kp.neckL && rig.type === 'dress') vTop = body.armpitV;
    else vTop = Math.min(local(body.shoulderCorner.imageLeft).v, local(body.shoulderCorner.imageRight).v) - 0.15 * sw;
    const vBottom = local(fit.mapPoint(hem.x, hem.y, PART.BODY)).v - 0.01 * T;
    if (vBottom > vTop) {
      zc.beginPath();
      const step = (vBottom - vTop) / 24;
      for (let i = 0; i <= 24; i++) {
        const v = vTop + step * i;
        const p = body.toImage(-(body.halfAt(Math.max(v, body.neckBaseV), 'imageLeft') + 0.25 * sw), v);
        if (i === 0) zc.moveTo(p.x, p.y);
        else zc.lineTo(p.x, p.y);
      }
      for (let i = 24; i >= 0; i--) {
        const v = vTop + step * i;
        const p = body.toImage(body.halfAt(Math.max(v, body.neckBaseV), 'imageRight') + 0.25 * sw, v);
        zc.lineTo(p.x, p.y);
      }
      zc.closePath();
      zc.fill();
    }
    // Trouser legs, down to the hem.
    for (const [side, leg] of Object.entries(rig.legs)) {
      const bl = body.legs[side];
      if (!bl) continue;
      const part = side === 'imageLeft' ? PART.LEG_LEFT : PART.LEG_RIGHT;
      limbStroke(bl.chain, fit.mapPoint(leg.end.x, leg.end.y, part), bl.r * 3.4);
    }
    zc.globalCompositeOperation = 'destination-out';
    // Not inside the neckline.
    if (!bottom && kp.neckL && kp.neckR && kp.neckC) {
      const nl = fit.mapPoint(kp.neckL.x, kp.neckL.y, PART.BODY);
      const nr = fit.mapPoint(kp.neckR.x, kp.neckR.y, PART.BODY);
      const nc = fit.mapPoint(kp.neckC.x, kp.neckC.y, PART.BODY);
      const up = (p) => body.toImage(local(p).u, -0.8 * T);
      zc.beginPath();
      for (const p of [up(nl), up(nr), nr, nc, nl]) zc.lineTo(p.x, p.y);
      zc.closePath();
      zc.fill();
    }
    // Not onto the arms (sleeves are a separate pass; bare arms stay bare).
    for (const arm of Object.values(body.arms)) {
      const c = arm.chain;
      zc.lineWidth = arm.rU * 2.1;
      zc.beginPath();
      zc.moveTo(c[0].x, c[0].y);
      for (let i = 1; i < c.length; i++) zc.lineTo(c[i].x, c[i].y);
      zc.stroke();
    }
    zc.globalCompositeOperation = 'source-over';
    clearHands();
    return z;
  }

  /**
   * The frame and its parsing labels at reduced size (other people's pixels
   * relabelled as scenery), once per render.
   */
  sampleFrame(o, maxSide = 360) {
    if (this.sample?.id === this.renderId) return this.sample;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const k = Math.min(1, maxSide / Math.max(w, h));
    const lw = Math.max(1, Math.round(w * k));
    const lh = Math.max(1, Math.round(h * k));
    this.sampleCanvas ||= offscreen();
    const sc = (this.sampleCtx ||= this.sampleCanvas.getContext('2d', { willReadFrequently: true }));
    this.sampleCanvas.width = lw;
    this.sampleCanvas.height = lh;
    sc.drawImage(this.bg, 0, 0, lw, lh);
    const pix = sc.getImageData(0, 0, lw, lh).data;
    const p = o.parsing;
    const m = o.mask;
    const labels = new Uint8Array(lw * lh);
    for (let y = 0; y < lh; y++) {
      const py = Math.min(p.height - 1, Math.floor(((y + 0.5) / lh) * p.height));
      const my = Math.min(m.height - 1, Math.floor(((y + 0.5) / lh) * m.height));
      for (let x = 0; x < lw; x++) {
        const label = p.labels[py * p.width + Math.min(p.width - 1, Math.floor(((x + 0.5) / lw) * p.width))];
        const mine = m.data[my * m.width + Math.min(m.width - 1, Math.floor(((x + 0.5) / lw) * m.width))] >= 0.5;
        labels[y * lw + x] = mine || label === 0 ? label : LABEL_OTHER_PERSON;
      }
    }
    this.sample = { id: this.renderId, pix, labels, w: lw, h: lh, k };
    return this.sample;
  }

  /**
   * What is in front of the garment body, cut from the background with the
   * person mask: the head (a hood or collar sits behind it), the forearms
   * and hands, hair falling over the shoulders, and (under new trousers or
   * a skirt) the wearer's own top where it hangs over the waist.
   * @returns {HTMLCanvasElement|null}
   */
  frontLayer(body, mask, points, parsing, rig) {
    if (!mask) return null;
    const arms = Object.values(body.arms);
    const head = headOutline(points);
    const w = this.canvas.width;
    const h = this.canvas.height;
    let any = false;

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
      any = true;
    }
    if (head) {
      mc.fillStyle = '#fff';
      mc.beginPath();
      mc.ellipse(head.x, head.y, head.rx, head.ry, head.angle, 0, Math.PI * 2);
      mc.fill();
      any = true;
    }
    if (this.frontHide?.id === this.renderId) {
      const f = this.frontHide;
      const img = new ImageData(f.w, f.h);
      for (let i = 0; i < f.w * f.h; i++) if (f.mask[i]) img.data[i * 4 + 3] = 255;
      this.layerMask ||= offscreen();
      this.layerMask.width = f.w;
      this.layerMask.height = f.h;
      this.layerMask.getContext('2d').putImageData(img, 0, 0);
      mc.globalCompositeOperation = 'destination-out';
      mc.imageSmoothingEnabled = true;
      mc.drawImage(this.layerMask, 0, 0, w, h);
      mc.globalCompositeOperation = 'source-over';
    }
    if (parsing) {
      const f = this.sampleFrame({ parsing, mask });
      const k = f.k;
      const hair = hairMask(f.labels, f.w, f.h, head && { x: head.x * k, y: head.y * k, rx: head.rx * k, ry: head.ry * k, angle: head.angle });
      const top = rig?.type === 'bottom' ? untuckedTopMask({ ...f, body }) : null;
      this.lastLayers = { hair: !!hair, untucked: !!top };
      if (hair || top) {
        const img = new ImageData(f.w, f.h);
        for (let i = 0; i < f.w * f.h; i++) {
          if (hair?.[i] || top?.[i]) img.data.set([255, 255, 255, 255], i * 4);
        }
        this.layerMask ||= offscreen();
        this.layerMask.width = f.w;
        this.layerMask.height = f.h;
        this.layerMask.getContext('2d').putImageData(img, 0, 0);
        mc.imageSmoothingEnabled = true;
        mc.imageSmoothingQuality = 'high';
        mc.drawImage(this.layerMask, 0, 0, w, h);
        any = true;
      }
    }
    if (!any) return null;
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
    return this.arms;
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
