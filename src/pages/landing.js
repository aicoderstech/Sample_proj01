import '../styles/base.css';
import '../styles/landing.css';
import { toPixels } from '../core/body.js';
import { DEFAULT_ADJUST } from '../core/fit.js';
import { drawMannequin } from '../core/mannequin.js';
import { mockPose } from '../core/mockPose.js';
import { TryOnRenderer } from '../core/renderer.js';
import { CATALOG, catalogUrl } from '../lib/catalog.js';
import { loadImage, prepareGarment } from '../lib/garmentLoader.js';

// ------------------------------------------------------------ install snippet

const widgetUrl = new URL('widget.js', document.baseURI).href;
const snippet = `<!-- 1. Load the widget once per page -->
<script async src="${widgetUrl}"></script>

<!-- 2. Mark product images that can be tried on -->
<img src="/images/coral-tee.jpg" alt="Coral Crew Tee"
     data-tryon data-tryon-type="top" data-tryon-product="sku-1042">

<!-- 3. Optional: react when shoppers add to cart from the try-on -->
<script>
  document.addEventListener('mirrorfit:add-to-cart', (e) => {
    addToCart(e.detail.product);
  });
</script>`;
document.getElementById('snippet').textContent = snippet;

const copyBtn = document.getElementById('copy-snippet');
copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(snippet);
    copyBtn.textContent = 'Copied!';
  } catch {
    copyBtn.textContent = 'Select & copy';
  }
  setTimeout(() => (copyBtn.textContent = 'Copy'), 1800);
});

// ------------------------------------------------------------ hero demo

const canvas = document.getElementById('hero-canvas');
const caption = document.getElementById('hero-caption');
const W = canvas.width;
const H = canvas.height;
const renderer = new TryOnRenderer(canvas);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const showcase = ['tee-coral', 'sundress-sage', 'tee-graphic', 'breton-longsleeve', 'hoodie-grey'].map((id) => CATALOG.find((c) => c.id === id));

const garments = [];
let current = 0;
let switchedAt = 0;
let visible = true;
let last = 0;

function background(ctx, pts) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#f6e3d6');
  g.addColorStop(1, '#e9cdbb');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
  ctx.beginPath();
  ctx.ellipse(W / 2, H * 0.965, W * 0.22, H * 0.018, 0, 0, Math.PI * 2);
  ctx.fill();
  drawMannequin(ctx, pts);
}

function frame(now) {
  requestAnimationFrame(frame);
  if (!visible || garments.length === 0) return;
  const t = now / 1000;
  const dt = last ? (now - last) / 1000 : 1 / 60;
  last = now;
  if (now - switchedAt > 3200 && garments.length > 1) {
    current = (current + 1) % garments.length;
    switchedAt = now;
    renderer.resetMotion();
    caption.innerHTML = `Now wearing: <strong>${garments[current].name}</strong>`;
  }
  const pts = toPixels(mockPose(reducedMotion ? 0.6 : t, { aspect: W / H, motion: reducedMotion ? 0 : 1 }), W, H);
  renderer.render({
    drawBackground: (ctx) => background(ctx, pts),
    mirror: false,
    points: pts,
    garment: garments[current],
    adjust: DEFAULT_ADJUST,
    dt,
    physics: !reducedMotion,
  });
}

new IntersectionObserver((entries) => {
  visible = entries[0].isIntersecting;
}).observe(canvas);

(async () => {
  for (const item of showcase) {
    try {
      const img = await loadImage(catalogUrl(item));
      garments.push({ ...prepareGarment(img, { type: item.type }), name: item.name });
      if (garments.length === 1) switchedAt = performance.now();
    } catch (err) {
      console.warn('[mirrorfit] could not prepare', item.id, err);
    }
  }
})();
requestAnimationFrame(frame);
