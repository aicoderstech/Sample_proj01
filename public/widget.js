/*!
 * Mirrorfit try-on widget — adds a "Try it on" button to product images.
 *
 *   <script async src="https://YOUR-HOST/widget.js"></script>
 *   <img src="tee.jpg" data-tryon data-tryon-type="top" data-tryon-product="sku-123">
 *
 * Script attributes (all optional):
 *   data-studio    URL of studio.html (default: next to widget.js)
 *   data-selector  CSS selector of product images/containers (default: [data-tryon])
 *   data-label     Button text (default: "Try it on")
 *
 * Element attributes: data-tryon-image (garment URL if not the <img> itself),
 * data-tryon-type (top | dress | bottom), data-tryon-product, data-tryon-name,
 * data-tryon-label.
 *
 * Events on document: mirrorfit:open, mirrorfit:close,
 * mirrorfit:add-to-cart (detail: { product, garment }).
 */
(function () {
  'use strict';
  if (window.Mirrorfit && window.Mirrorfit.version) return;

  var script =
    document.currentScript ||
    document.querySelector('script[data-mirrorfit]') ||
    document.querySelector('script[src*="widget.js"]');
  var scriptSrc = script && script.src ? script.src : location.href;
  function cfg(name, fallback) {
    var v = script && script.getAttribute('data-' + name);
    return v === null || v === undefined || v === '' ? fallback : v;
  }
  var studioUrl = new URL(cfg('studio', 'studio.html'), scriptSrc).href;
  var studioOrigin = new URL(studioUrl).origin;
  var selector = cfg('selector', '[data-tryon]');
  var label = cfg('label', 'Try it on');
  var TYPES = { top: 1, dress: 1, bottom: 1 };

  var CSS =
    '.mf-tryon-btn{display:inline-flex;align-items:center;gap:6px;margin:8px 0 0;padding:8px 14px;min-height:38px;' +
    'border:0;border-radius:999px;background:#f0482a;color:#fff;font:600 14px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;' +
    'cursor:pointer;box-shadow:0 4px 14px rgba(240,72,42,.35)}' +
    '.mf-tryon-btn:hover{background:#d93a1e}.mf-tryon-btn:focus-visible{outline:3px solid #f0482a;outline-offset:2px}' +
    '.mf-tryon-btn svg{width:16px;height:16px;flex:none}' +
    '.mf-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(12,10,8,.62);backdrop-filter:blur(4px);animation:mf-in .18s ease-out}' +
    '.mf-frame{position:relative;width:min(1200px,96vw);height:min(840px,92vh);border-radius:16px;overflow:hidden;' +
    'background:#121110;box-shadow:0 30px 80px rgba(0,0,0,.45)}' +
    '.mf-frame iframe{width:100%;height:100%;border:0;display:block;background:#121110}' +
    '.mf-close{position:absolute;top:8px;right:8px;width:40px;height:40px;border:0;border-radius:50%;' +
    'background:rgba(20,18,16,.75);color:#fff;font:400 26px/40px system-ui,sans-serif;cursor:pointer}' +
    '.mf-close:focus-visible{outline:3px solid #f0482a;outline-offset:2px}' +
    'html.mf-lock,html.mf-lock body{overflow:hidden}' +
    '@media (max-width:640px){.mf-frame{width:100vw;height:100%;border-radius:0}}' +
    '@keyframes mf-in{from{opacity:0}}';
  var ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M12 6a2 2 0 1 1 2 2c-1 0-2 .7-2 1.6V11l9 6.2c.8.6.4 1.8-.6 1.8H3.6c-1 0-1.4-1.2-.6-1.8L12 11"/></svg>';

  function injectStyle() {
    if (document.getElementById('mirrorfit-widget-style')) return;
    var style = document.createElement('style');
    style.id = 'mirrorfit-widget-style';
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function absolute(url) {
    try {
      return new URL(url, document.baseURI).href;
    } catch (e) {
      return null;
    }
  }

  function imageOf(el) {
    return el.tagName === 'IMG' ? el : el.querySelector('img');
  }

  function garmentFor(el) {
    var explicit = el.getAttribute('data-tryon-image');
    if (explicit) return absolute(explicit);
    var img = imageOf(el);
    return img ? absolute(img.currentSrc || img.getAttribute('src') || '') : null;
  }

  function emit(name, detail) {
    var event;
    try {
      event = new CustomEvent(name, { detail: detail });
    } catch (e) {
      event = document.createEvent('CustomEvent');
      event.initCustomEvent(name, false, false, detail);
    }
    document.dispatchEvent(event);
  }

  function enhance(el) {
    if (el.__mirrorfit) return;
    el.__mirrorfit = true;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mf-tryon-btn';
    btn.innerHTML = ICON + '<span></span>';
    btn.lastChild.textContent = el.getAttribute('data-tryon-label') || label;
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var img = imageOf(el);
      open({
        garment: garmentFor(el),
        type: el.getAttribute('data-tryon-type'),
        product: el.getAttribute('data-tryon-product'),
        name: el.getAttribute('data-tryon-name') || (img && img.getAttribute('alt')) || '',
      });
    });
    if (el.tagName === 'IMG') el.insertAdjacentElement('afterend', btn);
    else el.appendChild(btn);
  }

  var overlay = null;
  var iframe = null;
  var lastFocus = null;

  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  function open(opts) {
    if (!opts || !opts.garment) return false;
    if (overlay) close();
    injectStyle();
    lastFocus = document.activeElement;
    var url = new URL(studioUrl);
    url.searchParams.set('embed', '1');
    url.searchParams.set('garment', opts.garment);
    if (opts.type && TYPES[opts.type]) url.searchParams.set('type', opts.type);
    if (opts.product) url.searchParams.set('product', opts.product);
    if (opts.name) url.searchParams.set('name', opts.name);

    overlay = document.createElement('div');
    overlay.className = 'mf-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Virtual try-on');
    var frame = document.createElement('div');
    frame.className = 'mf-frame';
    iframe = document.createElement('iframe');
    iframe.src = url.href;
    iframe.title = 'Virtual try-on';
    iframe.setAttribute('allow', 'camera; clipboard-read; clipboard-write; fullscreen');
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'mf-close';
    closeBtn.setAttribute('aria-label', 'Close try-on');
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });
    frame.appendChild(iframe);
    frame.appendChild(closeBtn);
    overlay.appendChild(frame);
    document.body.appendChild(overlay);
    document.documentElement.classList.add('mf-lock');
    document.addEventListener('keydown', onKey);
    closeBtn.focus();
    emit('mirrorfit:open', { garment: opts.garment, product: opts.product || null });
    return true;
  }

  function close() {
    if (!overlay) return;
    overlay.parentNode && overlay.parentNode.removeChild(overlay);
    overlay = null;
    iframe = null;
    document.documentElement.classList.remove('mf-lock');
    document.removeEventListener('keydown', onKey);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    emit('mirrorfit:close', {});
  }

  window.addEventListener('message', function (e) {
    if (!iframe || e.source !== iframe.contentWindow || e.origin !== studioOrigin) return;
    var d = e.data;
    if (!d || d.source !== 'mirrorfit') return;
    if (d.type === 'close') close();
    else if (d.type === 'add-to-cart') emit('mirrorfit:add-to-cart', { product: d.product || null, garment: d.garment || null });
  });

  function scan(root) {
    var scope = root || document;
    if (scope.nodeType === 1 && scope.matches && scope.matches(selector)) enhance(scope);
    var nodes = scope.querySelectorAll ? scope.querySelectorAll(selector) : [];
    for (var i = 0; i < nodes.length; i++) enhance(nodes[i]);
  }

  function start() {
    injectStyle();
    scan(document);
    if (window.MutationObserver) {
      new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var added = mutations[i].addedNodes;
          for (var j = 0; j < added.length; j++) if (added[j].nodeType === 1) scan(added[j]);
        }
      }).observe(document.body, { childList: true, subtree: true });
    }
  }

  window.Mirrorfit = { version: '1.0.0', open: open, close: close, scan: scan, studioUrl: studioUrl };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
