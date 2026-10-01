// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { extractImageUrl, largestFromSrcset } from '../../src/lib/dropData.js';

const dt = (data) => ({ getData: (type) => data[type] || '' });

describe('extractImageUrl', () => {
  it('prefers the dragged <img> over the product link', () => {
    const url = extractImageUrl(
      dt({
        'text/html': '<a href="https://shop.example/p/1"><img src="https://cdn.example/tee.jpg"></a>',
        'text/uri-list': 'https://shop.example/p/1',
      }),
    );
    expect(url).toBe('https://cdn.example/tee.jpg');
  });

  it('picks the largest srcset candidate', () => {
    const url = extractImageUrl(
      dt({ 'text/html': '<img src="https://cdn.example/s.jpg" srcset="https://cdn.example/m.jpg 600w, https://cdn.example/l.jpg 1200w">' }),
    );
    expect(url).toBe('https://cdn.example/l.jpg');
  });

  it('falls back to text/uri-list, skipping comments', () => {
    expect(extractImageUrl(dt({ 'text/uri-list': '# comment\r\nhttps://cdn.example/a.png' }))).toBe('https://cdn.example/a.png');
  });

  it('accepts a plain-text URL', () => {
    expect(extractImageUrl(dt({ 'text/plain': '  https://cdn.example/b.webp ' }))).toBe('https://cdn.example/b.webp');
  });

  it('rejects non-http URLs and plain text', () => {
    expect(extractImageUrl(dt({ 'text/html': '<img src="javascript:alert(1)">' }))).toBeNull();
    expect(extractImageUrl(dt({ 'text/plain': 'hello' }))).toBeNull();
    expect(extractImageUrl(dt({ 'text/uri-list': 'file:///etc/passwd' }))).toBeNull();
  });
});

describe('largestFromSrcset', () => {
  it('handles density descriptors', () => {
    expect(largestFromSrcset('a.jpg 1x, b.jpg 2x')).toBe('b.jpg');
    expect(largestFromSrcset('')).toBeNull();
  });
});
