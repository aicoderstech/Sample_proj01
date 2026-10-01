// Same-origin image proxy so garments dragged in from other shops can be
// processed in a <canvas> (background removal, snapshots) even when the
// shop's CDN does not send CORS headers.
//
// It only fetches public http(s) images: every resolved IP address is checked
// at connect time (so DNS rebinding can't reach internal hosts), redirects are
// re-validated, and responses must be a raster image under a size limit.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const ALLOWED_TYPES = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0);
}

const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [ipv4ToInt(base), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

function isPublicIPv4(ip) {
  const value = ipv4ToInt(ip);
  return !BLOCKED_V4.some(([base, mask]) => ((value & mask) >>> 0) === base);
}

/** Expands an IPv6 address into 8 hextets. Handles :: and embedded IPv4. */
function expandIPv6(ip) {
  let addr = ip.toLowerCase().split('%')[0];
  const v4 = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    addr = addr.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = addr.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = addr.includes('::') ? 8 - headParts.length - tailParts.length : 0;
  return [...headParts, ...Array(fill).fill('0'), ...tailParts].map((h) => parseInt(h || '0', 16));
}

function isPublicIPv6(ip) {
  const h = expandIPv6(ip);
  if (h.length !== 8 || h.some((x) => Number.isNaN(x))) return false;
  const allZeroPrefix = (n) => h.slice(0, n).every((x) => x === 0);
  if (allZeroPrefix(8)) return false; // ::
  if (allZeroPrefix(7) && h[7] === 1) return false; // ::1
  const embeddedV4 = () => `${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`;
  if (allZeroPrefix(5) && h[5] === 0xffff) return isPublicIPv4(embeddedV4()); // ::ffff:a.b.c.d
  if (allZeroPrefix(6)) return isPublicIPv4(embeddedV4()); // deprecated ::a.b.c.d
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) {
    return isPublicIPv4(embeddedV4()); // NAT64
  }
  if ((h[0] & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((h[0] & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
  if ((h[0] & 0xff00) === 0xff00) return false; // multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return false; // documentation
  if (h[0] === 0x2002) return isPublicIPv4(`${h[1] >> 8}.${h[1] & 255}.${h[2] >> 8}.${h[2] & 255}`); // 6to4
  return true;
}

export function isPublicAddress(ip) {
  if (net.isIPv4(ip)) return isPublicIPv4(ip);
  if (net.isIPv6(ip)) return isPublicIPv6(ip);
  return false;
}

/**
 * Validates a user-supplied image URL. Returns a URL object or throws an
 * Error with a `status` property suitable for the HTTP response.
 */
export function validateTargetUrl(raw, { allowPrivate = false } = {}) {
  const fail = (message) => Object.assign(new Error(message), { status: 400 });
  if (typeof raw !== 'string' || raw.length === 0) throw fail('Missing "url" parameter');
  if (raw.length > 4096) throw fail('URL is too long');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw fail('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw fail('Only http(s) URLs are allowed');
  if (url.username || url.password) throw fail('URLs with credentials are not allowed');
  if (!allowPrivate) {
    if (url.port && url.port !== '80' && url.port !== '443') throw fail('Only ports 80 and 443 are allowed');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && !isPublicAddress(host)) {
      throw Object.assign(new Error('Private network addresses are not allowed'), { status: 403 });
    }
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
      throw Object.assign(new Error('Private network addresses are not allowed'), { status: 403 });
    }
  }
  return url;
}

function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options?.family || 4 }];
    if (list.length === 0 || list.some((a) => !isPublicAddress(a.address))) {
      const blocked = new Error('Private network addresses are not allowed');
      blocked.code = 'EBLOCKED';
      return callback(blocked);
    }
    if (options && options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

function fetchOnce(url, { allowPrivate, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(
      url,
      {
        headers: { 'User-Agent': 'MirrorfitImageProxy/1.0', Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8' },
        lookup: allowPrivate ? undefined : safeLookup,
        timeout: timeoutMs,
      },
      resolve,
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('Upstream timed out'), { status: 504 })));
    req.on('error', reject);
  });
}

/**
 * Fetches a remote image, following a limited number of redirects. Resolves
 * with { contentType, body: Buffer }.
 */
export async function fetchImage(rawUrl, opts = {}) {
  const { allowPrivate = false, maxBytes = 15 * 1024 * 1024, timeoutMs = 10_000, maxRedirects = 3 } = opts;
  let url = validateTargetUrl(rawUrl, { allowPrivate });
  for (let hop = 0; ; hop++) {
    let upstream;
    try {
      upstream = await fetchOnce(url, { allowPrivate, timeoutMs });
    } catch (err) {
      if (err.code === 'EBLOCKED') throw Object.assign(err, { status: 403 });
      throw Object.assign(new Error(err.status ? err.message : 'Could not reach the image host'), { status: err.status || 502 });
    }
    if (REDIRECT_CODES.has(upstream.statusCode) && upstream.headers.location) {
      upstream.resume();
      if (hop >= maxRedirects) throw Object.assign(new Error('Too many redirects'), { status: 502 });
      url = validateTargetUrl(new URL(upstream.headers.location, url).href, { allowPrivate });
      continue;
    }
    if (upstream.statusCode !== 200) {
      upstream.resume();
      throw Object.assign(new Error(`Image host responded with ${upstream.statusCode}`), { status: 502 });
    }
    const contentType = String(upstream.headers['content-type'] || '').split(';')[0].trim();
    if (!ALLOWED_TYPES.test(contentType)) {
      upstream.resume();
      throw Object.assign(new Error('The link does not point to a supported image'), { status: 415 });
    }
    const declared = Number(upstream.headers['content-length'] || 0);
    if (declared > maxBytes) {
      upstream.destroy();
      throw Object.assign(new Error('Image is too large'), { status: 413 });
    }
    const chunks = [];
    let size = 0;
    await new Promise((resolve, reject) => {
      upstream.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          upstream.destroy();
          reject(Object.assign(new Error('Image is too large'), { status: 413 }));
          return;
        }
        chunks.push(chunk);
      });
      upstream.on('end', resolve);
      upstream.on('error', (err) => reject(Object.assign(err, { status: 502 })));
    });
    return { contentType, body: Buffer.concat(chunks) };
  }
}

/** Connect/Node-style request handler: GET ?url=<image url>. */
export function createImageProxy(opts = {}) {
  return async function imageProxy(req, res) {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', ...headers });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(405, 'Method not allowed', { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    }
    const target = new URL(req.url, 'http://proxy.local').searchParams.get('url');
    try {
      const { contentType, body } = await fetchImage(target, opts);
      send(200, body, {
        'Content-Type': contentType,
        'Content-Length': body.length,
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      });
    } catch (err) {
      send(err.status || 500, err.status ? err.message : 'Proxy error', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
  };
}
