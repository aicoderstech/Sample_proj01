// What of the wearer stays in front of the new garment, besides the arms:
//  - hair that falls over the shoulders and chest;
//  - their own top, worn untucked, over a new pair of trousers or skirt:
//    a shirt hanging over the waistband is what makes trousers look worn
//    rather than pasted over the shirt.
// Both work on the parsing labels at reduced resolution (see undress.js for
// the labels) and return a mask (1 = in front).
import { LABEL } from './undress.js';
import { segDist } from './vec.js';

/** Pixels passing `ok` connected (4-neighbour) to a seed pixel. */
function grow(labels, w, h, ok, seeds) {
  const out = new Uint8Array(w * h);
  const stack = [];
  for (const i of seeds) {
    if (ok(i) && !out[i]) {
      out[i] = 1;
      stack.push(i);
    }
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
      if (j < 0 || j >= w * h || out[j] || !ok(j)) continue;
      out[j] = 1;
      stack.push(j);
    }
  }
  return out;
}

/**
 * Hair attached to the head (other hair-coloured bits elsewhere are
 * ignored).
 * @param {{x:number,y:number,rx:number,ry:number,angle:number}} head ellipse in low-res pixels
 */
export function hairMask(labels, w, h, head) {
  if (!head) return null;
  const seeds = [];
  const c = Math.cos(head.angle);
  const s = Math.sin(head.angle);
  const x0 = Math.max(0, Math.floor(head.x - head.rx - head.ry));
  const x1 = Math.min(w - 1, Math.ceil(head.x + head.rx + head.ry));
  const y0 = Math.max(0, Math.floor(head.y - head.rx - head.ry));
  const y1 = Math.min(h - 1, Math.ceil(head.y + head.rx + head.ry));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - head.x;
      const dy = y - head.y;
      const u = (dx * c + dy * s) / head.rx;
      const v = (-dx * s + dy * c) / head.ry;
      if (u * u + v * v <= 1.2) seeds.push(y * w + x);
    }
  }
  const mask = grow(labels, w, h, (i) => labels[i] === LABEL.HAIR, seeds);
  return mask.some((v) => v) ? mask : null;
}

function colourStats(pix, idx) {
  if (idx.length < 8) return null;
  const m = [0, 0, 0];
  for (const i of idx) for (let c = 0; c < 3; c++) m[c] += pix[i * 4 + c];
  for (let c = 0; c < 3; c++) m[c] /= idx.length;
  let v = 0;
  for (const i of idx) for (let c = 0; c < 3; c++) v += (pix[i * 4 + c] - m[c]) ** 2;
  return { mean: m, sd: Math.sqrt(v / idx.length / 3) };
}
const dist = (pix, i, m) => Math.hypot(pix[i * 4] - m[0], pix[i * 4 + 1] - m[1], pix[i * 4 + 2] - m[2]);

/**
 * The wearer's own top where it hangs over the waist: clothes coloured like
 * the top (sampled on the chest and belly) and unlike their trousers
 * (sampled on the thighs), connected to the top, from the waist down to the
 * top of the thighs. Null when the two can't be told apart (same colour) or
 * aren't both in view; the new garment is then drawn over everything.
 * @param {object} o
 * @param {Uint8ClampedArray} o.pix  RGBA (w x h)
 * @param {Uint8Array} o.labels      parsing labels (w x h); other people relabelled
 * @param {number} o.k               low-res pixels per image pixel
 * @param {object} o.body            measureBody() result (image coordinates)
 */
export function untuckedTopMask({ pix, labels, w, h, k, body }) {
  const { T, sw } = body;
  const legs = Object.values(body.legs ?? {}).filter((l) => l.chain.length >= 2);
  if (!legs.length) return null;
  const local = (i) => body.toLocal(((i % w) + 0.5) / k, (Math.floor(i / w) + 0.5) / k);
  const top = [];
  const below = [];
  for (let i = 0; i < w * h; i++) {
    if (labels[i] !== LABEL.CLOTHES) continue;
    const l = local(i);
    if (l.v > 0.35 * T && l.v < 0.75 * T && Math.abs(l.u) < 0.6 * body.halfAt(l.v, l.u < 0 ? 'imageLeft' : 'imageRight')) top.push(i);
  }
  // Thighs: the lower half, above the knee (a long top can cover the
  // upper thigh), near the bone.
  for (const leg of legs) {
    const [a, b] = leg.chain;
    for (let t = 0.5; t <= 0.85; t += 0.05) {
      const px = (a.x + (b.x - a.x) * t) * k;
      const py = (a.y + (b.y - a.y) * t) * k;
      const r = Math.max(1, leg.r * 0.5 * k);
      for (let y = Math.floor(py - r); y <= py + r; y++) {
        for (let x = Math.floor(px - r); x <= px + r; x++) {
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const i = y * w + x;
          if (labels[i] === LABEL.CLOTHES) below.push(i);
        }
      }
    }
  }
  const ts = colourStats(pix, top);
  const bs = colourStats(pix, below);
  if (!ts || !bs) return null;
  // Can the two be told apart? Most samples of each must be nearer their
  // own mean colour than the other's (a patterned shirt varies a lot, but
  // still differs from denim).
  const gap = Math.hypot(ts.mean[0] - bs.mean[0], ts.mean[1] - bs.mean[1], ts.mean[2] - bs.mean[2]);
  const own = (idx, mine, other) => idx.filter((i) => dist(pix, i, mine.mean) < dist(pix, i, other.mean)).length / idx.length;
  if (gap < 24 || own(top, ts, bs) < 0.75 || own(below, bs, ts) < 0.75) return null;
  // Arms hanging beside the hips wear the top's colour too (sleeves): not the top.
  const armSegs = [];
  for (const a of Object.values(body.arms ?? {})) {
    for (let j = 1; j < a.chain.length; j++) armSegs.push({ a: a.chain[j - 1], b: a.chain[j], r: (j === 1 ? a.rU : a.rF) * 1.3 });
  }
  const onArm = (x, y) => armSegs.some((s) => segDist({ x, y }, s.a, s.b) < s.r);
  const topLike = (i) => {
    if (labels[i] !== LABEL.CLOTHES || dist(pix, i, ts.mean) >= Math.min(0.7 * dist(pix, i, bs.mean), 2.5 * ts.sd + 24)) return false;
    return !onArm(((i % w) + 0.5) / k, (Math.floor(i / w) + 0.5) / k);
  };
  // The hem: down each column (across the body) from the belly, the top
  // goes on while its colour does (short gaps allowed: creases, a belt
  // loop) and ends where the trousers begin. The hem line is then smoothed:
  // a real hem doesn't jump from column to column.
  const step = 1 / k;
  const v0 = 0.55 * T;
  const vMax = T + 0.35 * sw;
  const uMax = Math.max(body.halfAt(T, 'imageLeft'), body.halfAt(T, 'imageRight')) + 0.06 * sw;
  const cols = [];
  for (let u = -uMax; u <= uMax; u += step) {
    let hem = null;
    let gap = 0;
    for (let v = v0; v <= vMax; v += step) {
      const p = body.toImage(u, v);
      const x = Math.floor(p.x * k);
      const y = Math.floor(p.y * k);
      if (x < 0 || y < 0 || x >= w || y >= h) break;
      if (topLike(y * w + x)) {
        hem = v;
        gap = 0;
      } else if (hem == null || ++gap > 3) {
        break;
      }
    }
    cols.push(hem);
  }
  const smooth = cols.map((_, i) => {
    const near = cols.slice(Math.max(0, i - 3), i + 4).filter((v) => v != null);
    if (cols[i] == null || near.length < 4) return null;
    near.sort((a, b) => a - b);
    return near[near.length >> 1];
  });
  // A hem runs across the whole body as one line: most columns over the
  // torso must find it, and no column may hang far below the rest (a
  // sleeve or shadow that slipped through).
  const central = [];
  const halfT = Math.min(body.halfAt(T, 'imageLeft'), body.halfAt(T, 'imageRight'));
  smooth.forEach((v, c) => {
    if (Math.abs(-uMax + c * step) < halfT * 0.85) central.push(v);
  });
  const found = central.filter((v) => v != null).sort((a, b) => a - b);
  if (found.length < 0.4 * central.length) return null;
  const line = found[found.length >> 1];
  // Close to that line everywhere; across the middle of the body the hem is
  // continuous even where a pattern's light stripe stopped the scan early.
  for (let c = 0; c < smooth.length; c++) {
    const centre = Math.abs(-uMax + c * step) < halfT * 0.85;
    if (smooth[c] == null && !centre) continue;
    smooth[c] = Math.min(line + 0.06 * T, Math.max(line - 0.05 * T, smooth[c] ?? line));
  }
  // Then eased along the body (a hem is a smooth curve).
  const eased = smooth.map((v, c) => {
    if (v == null) return null;
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, c - 4); j <= Math.min(smooth.length - 1, c + 4); j++) {
      if (smooth[j] == null) continue;
      sum += smooth[j];
      n++;
    }
    return sum / n;
  });
  smooth.splice(0, smooth.length, ...eased);
  const mask = new Uint8Array(w * h);
  let any = false;
  for (let i = 0; i < w * h; i++) {
    if (labels[i] !== LABEL.CLOTHES) continue;
    const l = local(i);
    if (l.v < v0 || l.v > vMax) continue;
    const c = Math.round((l.u + uMax) / step);
    const hem = smooth[c];
    if (hem == null || l.v > hem + step || onArm(((i % w) + 0.5) / k, (Math.floor(i / w) + 0.5) / k)) continue;
    mask[i] = 1;
    any = true;
  }
  return any ? mask : null;
}
