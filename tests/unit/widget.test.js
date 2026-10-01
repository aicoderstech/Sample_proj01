import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const WIDGET = readFileSync(join(import.meta.dirname, '../../public/widget.js'), 'utf8');

// Each test gets a fresh store page, like a real page load.
let window;
let document;
let KeyboardEvent;
let MouseEvent;
let MessageEvent;

function loadWidget(attrs = {}) {
  const script = document.createElement('script');
  script.setAttribute('data-mirrorfit', '');
  script.src = 'https://tryon.example/widget.js';
  for (const [k, v] of Object.entries(attrs)) script.setAttribute(k, v);
  document.head.append(script);
  window.eval(WIDGET);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('widget.js', () => {
  beforeEach(() => {
    const dom = new JSDOM(
      `<!doctype html><body>
        <img id="tee" src="/img/tee.jpg" alt="Coral Tee" data-tryon data-tryon-type="top" data-tryon-product="sku-1">
        <div id="card" data-tryon data-tryon-image="https://cdn.shop.example/dress.png" data-tryon-type="dress"></div>
        <img id="plain" src="/img/other.jpg">
      </body>`,
      { url: 'https://shop.example/products/tee', runScripts: 'outside-only' },
    );
    window = dom.window;
    document = window.document;
    ({ KeyboardEvent, MouseEvent, MessageEvent } = window);
  });

  it('adds a "Try it on" button to every marked product', () => {
    loadWidget();
    const buttons = document.querySelectorAll('.mf-tryon-btn');
    expect(buttons).toHaveLength(2);
    expect(document.getElementById('tee').nextElementSibling.classList.contains('mf-tryon-btn')).toBe(true);
    expect(document.querySelector('#card .mf-tryon-btn')).not.toBeNull();
    expect(buttons[0].textContent).toBe('Try it on');
    expect(document.getElementById('mirrorfit-widget-style')).not.toBeNull();
  });

  it('respects custom label, selector and studio URL', () => {
    loadWidget({ 'data-label': 'See it on me', 'data-selector': '#plain', 'data-studio': 'https://other.example/try/studio.html' });
    const buttons = document.querySelectorAll('.mf-tryon-btn');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe('See it on me');
    expect(window.Mirrorfit.studioUrl).toBe('https://other.example/try/studio.html');
  });

  it('opens the studio in an accessible overlay with the garment details', () => {
    loadWidget();
    const events = [];
    document.addEventListener('mirrorfit:open', (e) => events.push(e.detail));
    document.querySelector('.mf-tryon-btn').click();

    const overlay = document.querySelector('.mf-overlay');
    expect(overlay.getAttribute('role')).toBe('dialog');
    expect(overlay.getAttribute('aria-modal')).toBe('true');
    const iframe = overlay.querySelector('iframe');
    const url = new URL(iframe.src);
    expect(url.origin + url.pathname).toBe('https://tryon.example/studio.html');
    expect(url.searchParams.get('embed')).toBe('1');
    expect(url.searchParams.get('garment')).toBe(new URL('/img/tee.jpg', document.baseURI).href);
    expect(url.searchParams.get('type')).toBe('top');
    expect(url.searchParams.get('product')).toBe('sku-1');
    expect(url.searchParams.get('name')).toBe('Coral Tee');
    expect(iframe.getAttribute('allow')).toContain('camera');
    expect(document.activeElement.classList.contains('mf-close')).toBe(true);
    expect(document.documentElement.classList.contains('mf-lock')).toBe(true);
    expect(events).toHaveLength(1);
  });

  it('uses data-tryon-image and ignores unknown garment types', () => {
    loadWidget();
    document.getElementById('card').setAttribute('data-tryon-type', 'hat');
    document.querySelector('#card .mf-tryon-btn').click();
    const url = new URL(document.querySelector('.mf-overlay iframe').src);
    expect(url.searchParams.get('garment')).toBe('https://cdn.shop.example/dress.png');
    expect(url.searchParams.has('type')).toBe(false);
  });

  it('closes on Escape, the close button and a backdrop click, restoring focus', () => {
    loadWidget();
    const btn = document.querySelector('.mf-tryon-btn');
    const closes = [];
    document.addEventListener('mirrorfit:close', () => closes.push(1));

    btn.focus();
    btn.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.mf-overlay')).toBeNull();
    expect(document.activeElement).toBe(btn);
    expect(document.documentElement.classList.contains('mf-lock')).toBe(false);

    btn.click();
    document.querySelector('.mf-close').click();
    expect(document.querySelector('.mf-overlay')).toBeNull();

    btn.click();
    document.querySelector('.mf-overlay').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.mf-overlay')).toBeNull();
    expect(closes).toHaveLength(3);
  });

  it('relays add-to-cart only from the studio iframe and origin', () => {
    loadWidget();
    const added = [];
    document.addEventListener('mirrorfit:add-to-cart', (e) => added.push(e.detail));
    document.querySelector('.mf-tryon-btn').click();
    const frameWindow = document.querySelector('.mf-overlay iframe').contentWindow;
    const data = { source: 'mirrorfit', type: 'add-to-cart', product: 'sku-1', garment: 'g.png' };

    window.dispatchEvent(new MessageEvent('message', { data, origin: 'https://evil.example', source: frameWindow }));
    window.dispatchEvent(new MessageEvent('message', { data, origin: 'https://tryon.example', source: window }));
    window.dispatchEvent(new MessageEvent('message', { data: { ...data, source: 'other' }, origin: 'https://tryon.example', source: frameWindow }));
    expect(added).toHaveLength(0);

    window.dispatchEvent(new MessageEvent('message', { data, origin: 'https://tryon.example', source: frameWindow }));
    expect(added).toEqual([{ product: 'sku-1', garment: 'g.png' }]);

    window.dispatchEvent(new MessageEvent('message', { data: { source: 'mirrorfit', type: 'close' }, origin: 'https://tryon.example', source: frameWindow }));
    expect(document.querySelector('.mf-overlay')).toBeNull();
  });

  it('enhances products added to the page later', async () => {
    loadWidget();
    const img = document.createElement('img');
    img.src = '/img/late.jpg';
    img.setAttribute('data-tryon', '');
    const wrapper = document.createElement('section');
    wrapper.append(img);
    document.body.append(wrapper);
    await tick();
    expect(img.nextElementSibling?.classList.contains('mf-tryon-btn')).toBe(true);
    expect(document.querySelectorAll('.mf-tryon-btn')).toHaveLength(3);
  });

  it('does not open without a garment and loads only once', () => {
    loadWidget();
    expect(window.Mirrorfit.open({})).toBe(false);
    loadWidget();
    expect(document.querySelectorAll('.mf-tryon-btn')).toHaveLength(2);
  });
});
