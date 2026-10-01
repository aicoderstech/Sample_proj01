// Extracts an image URL from drag-and-drop / clipboard data. Dragging a
// product image out of another browser tab provides text/html (<img>) and/or
// text/uri-list; the <img> is preferred because the uri-list is often the
// product page link rather than the image.

const isHttpUrl = (s) => {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

/** Picks the largest candidate from a srcset string. */
export function largestFromSrcset(srcset) {
  if (!srcset) return null;
  let best = null;
  let bestScore = -1;
  for (const part of srcset.split(/,\s+(?=\S)/)) {
    const [url, descriptor = '1x'] = part.trim().split(/\s+/);
    const n = parseFloat(descriptor);
    const score = Number.isFinite(n) ? (descriptor.endsWith('w') ? n : n * 1000) : 0;
    if (url && score > bestScore) {
      best = url;
      bestScore = score;
    }
  }
  return best;
}

/** @param {{getData(type:string):string}} dt  DataTransfer-like */
export function extractImageUrl(dt) {
  const html = dt.getData('text/html');
  if (html && typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const img = doc.querySelector('img');
    if (img) {
      const candidates = [largestFromSrcset(img.getAttribute('srcset')), img.getAttribute('src')];
      for (const c of candidates) if (c && isHttpUrl(c)) return c;
    }
  }
  const uriList = dt.getData('text/uri-list');
  if (uriList) {
    const first = uriList.split(/\r?\n/).find((l) => l && !l.startsWith('#'));
    if (first && isHttpUrl(first.trim())) return first.trim();
  }
  const text = (dt.getData('text/plain') || '').trim();
  if (isHttpUrl(text)) return text;
  return null;
}
