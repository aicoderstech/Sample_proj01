// Production server: serves the built site from dist/, the image proxy and
// the AI try-on relay.
//   npm run build && npm start        (PORT=4173, HOST=127.0.0.1 by default)
import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAiTryOnHandler } from './aiTryOn.mjs';
import { createImageProxy } from './imageProxy.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};

export function createServer({ root, proxyOptions, aiOptions } = {}) {
  const distRoot = resolve(root);
  const imageProxy = createImageProxy(proxyOptions);
  const aiTryOn = createAiTryOnHandler(aiOptions);

  function resolveFile(pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (decoded.includes('\0')) return null;
    const candidate = normalize(join(distRoot, decoded));
    if (candidate !== distRoot && !candidate.startsWith(distRoot + sep)) return null;
    const tries = [candidate, join(candidate, 'index.html'), `${candidate}.html`];
    return tries.find((p) => existsSync(p) && statSync(p).isFile()) || null;
  }

  return http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/api/image-proxy') return imageProxy(req, res);
    if (pathname === '/api/ai-tryon') return aiTryOn(req, res);
    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }
    const file = resolveFile(pathname);
    if (!file) {
      const notFound = resolveFile('/404.html');
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      if (notFound && req.method === 'GET') return createReadStream(notFound).pipe(res);
      return res.end(req.method === 'GET' ? '<h1>404 Not Found</h1>' : undefined);
    }
    const hashedAsset = pathname.startsWith('/assets/');
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': statSync(file).size,
      'Cache-Control': hashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  if (!existsSync(join(root, 'index.html'))) {
    console.error('[mirrorfit] dist/ not found. Run `npm run build` first.');
    process.exit(1);
  }
  const port = Number(process.env.PORT || 4173);
  const host = process.env.HOST || '127.0.0.1';
  createServer({ root }).listen(port, host, () => {
    console.log(`[mirrorfit] serving http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  });
}
