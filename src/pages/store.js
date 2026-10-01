import '../styles/base.css';
import '../styles/store.css';
import { CATALOG } from '../lib/catalog.js';

const grid = document.getElementById('products');
const cartCount = document.getElementById('cart-count');
const toast = document.getElementById('toast');
let count = 0;
let toastTimer = 0;

function addToCart(productId) {
  const item = CATALOG.find((c) => c.id === productId);
  if (!item) return;
  count++;
  cartCount.textContent = String(count);
  toast.textContent = `Added ${item.name} to your cart`;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 2400);
}

for (const item of CATALOG) {
  const card = document.createElement('article');
  card.className = 'product';
  card.innerHTML = `
    <div class="product-media">
      <img src="${item.file}" alt="${item.name}" loading="lazy"
           data-tryon data-tryon-type="${item.type}" data-tryon-product="${item.id}">
    </div>
    <div class="product-body">
      <h2>${item.name}</h2>
      <p class="price">$${item.price}</p>
      <button class="btn small" type="button" data-add="${item.id}">Add to cart</button>
    </div>`;
  card.querySelector('[data-add]').addEventListener('click', () => addToCart(item.id));
  grid.append(card);
}

// Fired by widget.js when the shopper presses "Add to cart" inside the try-on.
document.addEventListener('mirrorfit:add-to-cart', (e) => addToCart(e.detail.product));
