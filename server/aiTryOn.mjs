// Server relay for the AI try-on (src/lib/aiTryOn.js), for browsers that
// can't reach the Hugging Face Spaces themselves. POST /api/ai-tryon with a
// multipart form: person (image), garment (image), kind (top | bottom |
// dress), description and optionally only (a provider id). Answers with the
// generated image, or JSON {error}.
//
// HF_TOKEN (optional, a free Hugging Face token) gives the relay its own
// GPU quota on the shared Spaces. Requests are limited in size and in
// number per client, and only one runs per client at a time.
import { AiTryOnError, runAiTryOn } from '../src/lib/aiTryOn.js';

const MAX_BYTES = 15 * 1024 * 1024;
const IMAGE = /^image\/(png|jpe?g|webp)$/i;
const KINDS = new Set(['top', 'bottom', 'dress']);

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * @param {object} [o]
 * @param {Function} [o.run]       runAiTryOn (replaced in tests)
 * @param {Function} [o.fetchImage] fetches the generated image (replaced in tests)
 * @param {string|null} [o.token]  Hugging Face token
 * @param {number} [o.perHour]     requests allowed per client per hour
 */
export function createAiTryOnHandler({ run = runAiTryOn, fetchImage = (url) => fetch(url), token = process.env.HF_TOKEN || null, perHour = 30 } = {}) {
  const recent = new Map(); // client -> timestamps
  const busy = new Set();
  return async function aiTryOn(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      return res.end();
    }
    const client = req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const times = (recent.get(client) || []).filter((t) => now - t < 3600e3);
    if (times.length >= perHour) return sendJson(res, 429, { error: 'Too many AI try-ons from here this hour. Please try again later.' });
    if (busy.has(client)) return sendJson(res, 429, { error: 'An AI try-on is already running. Please wait for it to finish.' });
    const length = Number(req.headers['content-length'] || 0);
    if (!length || length > MAX_BYTES) return sendJson(res, 413, { error: 'Send a photo and a garment image under 15 MB together.' });
    if (!/^multipart\/form-data/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'Expected a multipart form.' });

    let form;
    try {
      const request = new Request('http://relay/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: req, duplex: 'half' });
      form = await request.formData();
    } catch {
      return sendJson(res, 400, { error: 'Could not read the upload.' });
    }
    const person = form.get('person');
    const garment = form.get('garment');
    const kind = String(form.get('kind') || '');
    const description = String(form.get('description') || '').slice(0, 120);
    const only = form.get('only') ? String(form.get('only')).slice(0, 40) : null;
    if (!(person instanceof Blob) || !(garment instanceof Blob) || !IMAGE.test(person.type) || !IMAGE.test(garment.type)) {
      return sendJson(res, 400, { error: 'Send a person photo and a garment image (PNG, JPEG or WebP).' });
    }
    if (!KINDS.has(kind)) return sendJson(res, 400, { error: 'Unknown garment kind.' });

    times.push(now);
    recent.set(client, times);
    busy.add(client);
    try {
      const result = await run({ person, garment, kind, description, only, token });
      const img = await fetchImage(result.url);
      if (!img.ok) throw new AiTryOnError('Could not download the generated picture.');
      const type = img.headers.get('content-type') || 'image/png';
      if (!/^image\//.test(type)) throw new AiTryOnError('The model returned something that is not a picture.');
      const body = Buffer.from(await img.arrayBuffer());
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-AI-Provider': result.provider.name, 'X-Content-Type-Options': 'nosniff' });
      return res.end(body);
    } catch (err) {
      const message = err instanceof AiTryOnError ? err.message : 'The AI try-on failed.';
      return sendJson(res, 502, { error: message, attempts: err?.attempts ?? [] });
    } finally {
      busy.delete(client);
    }
  };
}
