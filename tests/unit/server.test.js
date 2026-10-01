import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createImageProxy, fetchImage, isPublicAddress, validateTargetUrl } from '../../server/imageProxy.mjs';
import { createServer } from '../../server/index.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd00::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    '64:ff9b::a00:1', '2002:c0a8:101::1', '2001:db8::1', 'not-an-ip',
  ])('blocks %s', (ip) => expect(isPublicAddress(ip)).toBe(false));

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '142.250.72.14', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808'])(
    'allows %s',
    (ip) => expect(isPublicAddress(ip)).toBe(true),
  );
});

describe('validateTargetUrl', () => {
  it('accepts public http(s) URLs', () => {
    expect(validateTargetUrl('https://cdn.shop.example/a.jpg').hostname).toBe('cdn.shop.example');
  });

  it.each([
    ['', 400],
    ['not a url', 400],
    ['ftp://example.com/a.jpg', 400],
    ['file:///etc/passwd', 400],
    ['https://user:pw@example.com/a.jpg', 400],
    ['https://example.com:8080/a.jpg', 400],
    ['http://127.0.0.1/a.jpg', 403],
    ['http://2130706433/a.jpg', 403], // 127.0.0.1 in decimal
    ['http://0x7f.1/a.jpg', 403],
    ['http://[::1]/a.jpg', 403],
    ['http://localhost/a.jpg', 403],
    ['http://metadata.google.internal/a.jpg', 403],
  ])('rejects %s', (url, status) => {
    expect(() => validateTargetUrl(url)).toThrow();
    try {
      validateTargetUrl(url);
    } catch (err) {
      expect(err.status).toBe(status);
    }
  });
});

describe('fetchImage / image proxy', () => {
  let upstream;
  let base;
  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      const routes = {
        '/ok.png': () => res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG),
        '/page.html': () => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1>hi</h1>'),
        '/evil.svg': () => res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end('<svg/>'),
        '/big.png': () => res.writeHead(200, { 'Content-Type': 'image/png' }).end(Buffer.alloc(2048)),
        '/missing.png': () => res.writeHead(404).end(),
        '/redirect': () => res.writeHead(302, { Location: '/ok.png' }).end(),
        '/loop': () => res.writeHead(302, { Location: '/loop' }).end(),
      };
      (routes[req.url] || routes['/missing.png'])();
    });
    base = await listen(upstream);
  });
  afterAll(() => upstream.close());

  const opts = { allowPrivate: true };

  it('fetches an image', async () => {
    const { contentType, body } = await fetchImage(`${base}/ok.png`, opts);
    expect(contentType).toBe('image/png');
    expect(body.equals(PNG)).toBe(true);
  });

  it('follows redirects, up to a limit', async () => {
    expect((await fetchImage(`${base}/redirect`, opts)).contentType).toBe('image/png');
    await expect(fetchImage(`${base}/loop`, opts)).rejects.toMatchObject({ status: 502 });
  });

  it('rejects non-images, SVG, errors and oversized files', async () => {
    await expect(fetchImage(`${base}/page.html`, opts)).rejects.toMatchObject({ status: 415 });
    await expect(fetchImage(`${base}/evil.svg`, opts)).rejects.toMatchObject({ status: 415 });
    await expect(fetchImage(`${base}/missing.png`, opts)).rejects.toMatchObject({ status: 502 });
    await expect(fetchImage(`${base}/big.png`, { ...opts, maxBytes: 1000 })).rejects.toMatchObject({ status: 413 });
  });

  it('refuses private addresses by default', async () => {
    await expect(fetchImage(`${base}/ok.png`)).rejects.toMatchObject({ status: 400 }); // non-default port
    await expect(fetchImage('http://127.0.0.1/ok.png')).rejects.toMatchObject({ status: 403 });
  });

  it('serves proxied images with safe headers', async () => {
    const proxy = http.createServer(createImageProxy(opts));
    const proxyBase = await listen(proxy);
    try {
      const ok = await fetch(`${proxyBase}/api/image-proxy?url=${encodeURIComponent(`${base}/ok.png`)}`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toBe('image/png');
      expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
      expect(ok.headers.get('content-security-policy')).toContain('sandbox');
      expect(Buffer.from(await ok.arrayBuffer()).equals(PNG)).toBe(true);

      const bad = await fetch(`${proxyBase}/api/image-proxy?url=${encodeURIComponent(`${base}/page.html`)}`);
      expect(bad.status).toBe(415);
      const post = await fetch(`${proxyBase}/api/image-proxy`, { method: 'POST' });
      expect(post.status).toBe(405);
    } finally {
      proxy.close();
    }
  });
});

describe('static server', () => {
  let server;
  let base;
  beforeAll(async () => {
    const outer = mkdtempSync(join(tmpdir(), 'mirrorfit-'));
    const root = join(outer, 'dist');
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'index.html'), '<h1>home</h1>');
    writeFileSync(join(root, 'studio.html'), '<h1>studio</h1>');
    writeFileSync(join(root, '404.html'), '<h1>missing</h1>');
    writeFileSync(join(root, 'assets', 'app-123.js'), 'console.log(1)');
    writeFileSync(join(root, 'model.task'), 'bin');
    writeFileSync(join(outer, 'secret.txt'), 'top secret');
    server = createServer({ root });
    base = await listen(server);
  });
  afterAll(() => server.close());

  // Raw request so "../" segments reach the server unnormalized.
  const raw = (path, method = 'GET') =>
    new Promise((resolve, reject) => {
      const { hostname, port } = new URL(base);
      const req = http.request({ hostname, port, path, method }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });

  it('serves pages, clean URLs and assets with the right headers', async () => {
    expect((await raw('/')).body).toBe('<h1>home</h1>');
    expect((await raw('/studio')).body).toBe('<h1>studio</h1>');
    const asset = await raw('/assets/app-123.js');
    expect(asset.headers['content-type']).toContain('text/javascript');
    expect(asset.headers['cache-control']).toContain('immutable');
    expect((await raw('/model.task')).headers['content-type']).toBe('application/octet-stream');
    expect((await raw('/healthz')).body).toBe('ok');
  });

  it('returns the 404 page for unknown paths', async () => {
    const res = await raw('/nope');
    expect(res.status).toBe(404);
    expect(res.body).toBe('<h1>missing</h1>');
  });

  it('blocks path traversal', async () => {
    for (const path of ['/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/assets/%2e%2e/%2e%2e/secret.txt', '/%00']) {
      const res = await raw(path);
      expect(res.status, path).toBe(404);
      expect(res.body).not.toContain('top secret');
    }
  });

  it('supports HEAD and rejects other methods', async () => {
    const head = await raw('/', 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect((await raw('/', 'DELETE')).status).toBe(405);
  });
});
