// Loads a garment image (URL, File, sample) and prepares it for fitting:
// background removal, cropping and anchor analysis.
import { analyzeGarment, defaultAnchors, deriveAnchors, guessGarmentType, removeBackground } from '../core/garment.js';
import { buildGarmentRig } from '../core/garmentRig.js';

const MAX_PROCESS_SIZE = 1024;
const MAX_TEXTURE_SIZE = 768;

export function loadImage(src, { crossOrigin } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = crossOrigin;
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load image: ${String(src).slice(0, 120)}`));
    img.src = src;
  });
}

function isSameOrigin(url) {
  try {
    const u = new URL(url, document.baseURI);
    return u.protocol === 'data:' || u.protocol === 'blob:' || u.origin === location.origin;
  } catch {
    return false;
  }
}

export function proxyUrlFor(url) {
  return new URL(`api/image-proxy?url=${encodeURIComponent(url)}`, document.baseURI).href;
}

/**
 * Loads an image from any URL, preferring a pixel-readable (CORS-clean)
 * copy: direct CORS -> same-origin proxy -> plain (display-only) load.
 * @returns {Promise<{image: HTMLImageElement, via: 'direct'|'cors'|'proxy'|'tainted'}>}
 */
export async function loadRemoteImage(url) {
  let protocol;
  try {
    protocol = new URL(url, document.baseURI).protocol;
  } catch {
    throw new Error('That is not a valid link.');
  }
  if (!['http:', 'https:', 'data:', 'blob:'].includes(protocol)) {
    throw new Error('Only web (http/https) image links are supported.');
  }
  if (isSameOrigin(url)) return { image: await loadImage(url), via: 'direct' };
  try {
    return { image: await loadImage(url, { crossOrigin: 'anonymous' }), via: 'cors' };
  } catch {
    // Shop CDN without CORS headers: try our proxy.
  }
  try {
    return { image: await loadImage(proxyUrlFor(url), { crossOrigin: 'anonymous' }), via: 'proxy' };
  } catch {
    // No proxy (static hosting) or the proxy refused the URL.
  }
  return { image: await loadImage(url), via: 'tainted' };
}

function drawScaled(source, maxSize) {
  const sw = source.naturalWidth || source.videoWidth || source.width;
  const sh = source.naturalHeight || source.videoHeight || source.height;
  if (!sw || !sh) throw new Error('Image has no size');
  const k = Math.min(1, maxSize / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * k));
  canvas.height = Math.max(1, Math.round(sh * k));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * One texture per garment part (torso, each sleeve / leg), so each part can
 * be warped and layered on its own. Each part keeps a 2px skirt of its
 * neighbours' pixels to hide hairline seams where parts meet.
 */
function splitParts(texture, parts) {
  const { width, height, data } = texture;
  const ids = [...new Set(parts)].filter(Boolean);
  const out = {};
  for (const id of ids) {
    const own = new Uint8Array(width * height);
    for (let i = 0; i < own.length; i++) if (parts[i] === id) own[i] = 1;
    // Dilate by 2px into other parts.
    const grown = Uint8Array.from(own);
    for (let pass = 0; pass < 2; pass++) {
      const prev = Uint8Array.from(grown);
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const i = y * width + x;
          if (!prev[i] && parts[i] && (prev[i - 1] || prev[i + 1] || prev[i - width] || prev[i + width])) grown[i] = 1;
        }
      }
    }
    const img = new ImageData(width, height);
    for (let i = 0; i < grown.length; i++) {
      if (!grown[i]) continue;
      img.data[i * 4] = data[i * 4];
      img.data[i * 4 + 1] = data[i * 4 + 1];
      img.data[i * 4 + 2] = data[i * 4 + 2];
      img.data[i * 4 + 3] = data[i * 4 + 3];
    }
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    c.getContext('2d').putImageData(img, 0, 0);
    out[id] = c;
  }
  return out;
}

/**
 * @param {CanvasImageSource} source
 * @param {{removeBg?: boolean, tolerance?: number, type?: 'auto'|'top'|'dress'|'bottom'}} options
 * @returns {{canvas, rect, anchors, type, guessedType, backgroundRemoved, readable}}
 */
export function prepareGarment(source, { removeBg = true, tolerance = 42, type = 'auto' } = {}) {
  const canvas = drawScaled(source, MAX_PROCESS_SIZE);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let pixels;
  try {
    pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    // Cross-origin image without CORS: we can draw it but not read it.
    const finalType = type === 'auto' ? 'top' : type;
    return {
      canvas,
      rect: { x: 0, y: 0, w: canvas.width, h: canvas.height },
      anchors: defaultAnchors(canvas.width, canvas.height, finalType),
      type: finalType,
      guessedType: 'top',
      backgroundRemoved: false,
      readable: false,
    };
  }

  const processed = removeBg ? removeBackground(pixels, { tolerance }) : { data: pixels.data, width: pixels.width, height: pixels.height, removed: false };
  const first = analyzeGarment(processed);
  if (!first) throw new Error('No garment found in that image. Try a product photo on a plain background.');

  // Crop to the garment (plus a little padding) and cap the texture size.
  const pad = 4;
  const bx = Math.max(0, first.bbox.x - pad);
  const by = Math.max(0, first.bbox.y - pad);
  const bw = Math.min(processed.width - bx, first.bbox.w + pad * 2);
  const bh = Math.min(processed.height - by, first.bbox.h + pad * 2);
  const full = document.createElement('canvas');
  full.width = processed.width;
  full.height = processed.height;
  full.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(processed.data), processed.width, processed.height), 0, 0);
  const k = Math.min(1, MAX_TEXTURE_SIZE / Math.max(bw, bh));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(bw * k));
  out.height = Math.max(1, Math.round(bh * k));
  const octx = out.getContext('2d', { willReadFrequently: true });
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(full, bx, by, bw, bh, 0, 0, out.width, out.height);

  const texture = octx.getImageData(0, 0, out.width, out.height);
  const analysis = analyzeGarment(texture);
  if (!analysis) throw new Error('No garment found in that image.');
  const guessedType = guessGarmentType(analysis);
  const finalType = type === 'auto' ? guessedType : type;
  const rig = buildGarmentRig(analysis, finalType);
  return {
    canvas: out,
    rect: analysis.bbox,
    anchors: deriveAnchors(analysis, finalType),
    analysis,
    rig,
    partCanvases: rig ? splitParts(texture, rig.parts) : null,
    type: finalType,
    guessedType,
    backgroundRemoved: processed.removed,
    backgroundNote: removeBg ? processed.reason || null : null,
    readable: true,
  };
}
