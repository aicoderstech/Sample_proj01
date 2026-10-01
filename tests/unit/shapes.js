// Test fixtures: garment silhouettes (matching public/garments/*.svg) and a
// synthetic body, rasterized into plain RGBA buffers.

export const TEE = {
  width: 600,
  height: 500,
  polygons: [
    [[250, 30], [270, 58], [300, 66], [330, 58], [350, 30], [440, 62], [542, 133], [485, 215], [456, 200], [452, 462],
      [300, 470], [148, 462], [144, 200], [114, 215], [57, 133], [160, 62]],
  ],
};

export const DRESS = {
  width: 600,
  height: 680,
  polygons: [
    [[228, 20], [246, 20], [250, 112], [232, 114]],
    [[354, 20], [372, 20], [368, 114], [350, 112]],
    [[162, 118], [231, 104], [300, 128], [369, 104], [438, 118], [438, 165], [414, 250], [560, 640], [300, 660], [40, 640],
      [186, 250], [162, 165]],
  ],
};

export const SKIRT = {
  width: 600,
  height: 560,
  polygons: [[[175, 20], [425, 20], [425, 64], [530, 520], [300, 534], [70, 520], [175, 64]]],
};

export const TROUSERS = {
  width: 600,
  height: 540,
  polygons: [[[180, 20], [420, 20], [440, 510], [330, 510], [300, 170], [270, 510], [160, 510]]],
};

function inside(poly, x, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** @returns {{data: Uint8ClampedArray, width: number, height: number}} */
export function rasterize(shape, { background = [255, 255, 255, 255], color = [210, 80, 60, 255], extra } = {}) {
  const { width, height, polygons } = shape;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const on = polygons.some((p) => inside(p, x + 0.5, y + 0.5));
      data.set(on ? color : background, i);
      if (on && extra) extra(data, i, x, y);
    }
  }
  return { data, width, height };
}

/**
 * 33 pixel landmarks for a person facing the camera. Their left side
 * (odd landmark indices) is on the image right.
 */
export function makePose({ armAngleLeftImage = 1.2, armAngleRightImage = 1.2, hips = true, shoulderVis = 1, rotate = 0 } = {}) {
  const pts = Array.from({ length: 33 }, () => ({ x: 300, y: 200, v: 0.01 }));
  const set = (i, x, y, v = 0.99) => (pts[i] = { x, y, v });
  set(0, 300, 200);
  set(11, 400, 300, shoulderVis); // left shoulder (image right)
  set(12, 200, 300, shoulderVis); // right shoulder (image left)
  const upper = 130;
  // Arm angles are measured below the outward horizontal.
  set(14, 200 - upper * Math.cos(armAngleLeftImage), 300 + upper * Math.sin(armAngleLeftImage)); // right elbow
  set(13, 400 + upper * Math.cos(armAngleRightImage), 300 + upper * Math.sin(armAngleRightImage)); // left elbow
  if (hips) {
    set(23, 360, 560);
    set(24, 240, 560);
    set(25, 362, 740);
    set(26, 238, 740);
    set(27, 364, 920);
    set(28, 236, 920);
  }
  if (rotate) {
    const c = Math.cos(rotate);
    const s = Math.sin(rotate);
    for (const p of pts) {
      const dx = p.x - 300;
      const dy = p.y - 430;
      p.x = 300 + dx * c - dy * s;
      p.y = 430 + dx * s + dy * c;
    }
  }
  return pts;
}
