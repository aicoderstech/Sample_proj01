// Writes a PNG visualising a benchmark case: the synthetic person (grey),
// the warped garment (coloured by part) and the true shoulder / arm points.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { rasterizeMeshes } from '../../src/core/raster.js';

function crc32(buf) {
  let c;
  const table = (crc32.t ||= Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function encodePng(width, height, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PART_COLORS = [null, [230, 90, 60], [60, 140, 230], [60, 190, 120], [200, 120, 230], [230, 180, 50]];

export function writeDebugPng(path, body, g, fit) {
  const { width, height, truth } = body;
  const img = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const v = body.mask && body.mask.data[i] > 0.5 ? 200 : 250;
    img.set([v, v, v, 255], i * 4);
  }
  for (const m of fit.meshes) {
    const cover = rasterizeMeshes(width, height, [
      {
        ...m,
        opaque: (gx, gy) => {
          const x = Math.round(gx);
          const y = Math.round(gy);
          if (x < 0 || y < 0 || x >= g.analysis.width || y >= g.analysis.height) return false;
          const i = y * g.analysis.width + x;
          return g.analysis.mask[i] === 1 && (m.part == null || g.rig.parts[i] === m.part);
        },
      },
    ]);
    const col = PART_COLORS[m.part ?? 1];
    for (let i = 0; i < cover.length; i++) {
      if (!cover[i]) continue;
      const o = i * 4;
      img[o] = (img[o] + col[0] * 2) / 3;
      img[o + 1] = (img[o + 1] + col[1] * 2) / 3;
      img[o + 2] = (img[o + 2] + col[2] * 2) / 3;
    }
  }
  const dot = (p, rgb, r = 3) => {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = Math.round(p.x + dx);
        const y = Math.round(p.y + dy);
        if (x >= 0 && y >= 0 && x < width && y < height && dx * dx + dy * dy <= r * r) img.set([...rgb, 255], (y * width + x) * 4);
      }
    }
  };
  for (const s of ['imageLeft', 'imageRight']) {
    dot(truth.shoulderOuter[s], [0, 0, 0]);
    for (const k of ['joint', 'elbow', 'wrist', 'hand']) dot(truth.arms[s][k], [20, 20, 160], 2);
  }
  writeFileSync(path, encodePng(width, height, img));
}
