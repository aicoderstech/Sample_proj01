// Loads a garment image (URL, File, sample) and prepares it for fitting:
// background removal, cropping and anchor analysis.
import { analyzeGarment, defaultAnchors, deriveAnchors, guessGarmentType, removeBackground } from '../core/garment.js';

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

  const analysis = analyzeGarment(octx.getImageData(0, 0, out.width, out.height));
  if (!analysis) throw new Error('No garment found in that image.');
  const guessedType = guessGarmentType(analysis);
  const finalType = type === 'auto' ? guessedType : type;
  return {
    canvas: out,
    rect: analysis.bbox,
    anchors: deriveAnchors(analysis, finalType),
    analysis,
    type: finalType,
    guessedType,
    backgroundRemoved: processed.removed,
    backgroundNote: removeBg ? processed.reason || null : null,
    readable: true,
  };
}
