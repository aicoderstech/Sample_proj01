# Mirrorfit: live virtual try-on in the browser

Drag a garment image from any online shop and see it on yourself, live in your
camera, with sleeves that follow your arms and a hem that sways as you move.
Store owners can add a **"Try it on"** button to their product pages with one
script tag.

Inspired by [Decart's Anywear](https://anywear.decart.ai/). This is an
independent, open implementation and is not affiliated with Decart.

| Page | What it is |
| --- | --- |
| `index.html` | Landing page with an animated demo, install snippet and FAQ |
| `studio.html` | The try-on studio: live camera or photo, garment picker, fit controls, snapshots |
| `demo-store.html` | A demo fashion shop using the embeddable widget |
| `widget.js` | The one-line store widget (adds buttons, opens the studio in an overlay) |

## Quick start

Requires Node.js 20 or newer.

```bash
npm install
npm run dev          # http://localhost:5173 (hot reload)
```

Production build and server:

```bash
npm run build
npm start            # http://127.0.0.1:4173  (PORT / HOST env vars to change)
```

The camera needs a secure context: `localhost` works, and anything else must be
served over **HTTPS**.

## Features

- **Live body tracking, on-device.** MediaPipe Pose Landmarker runs in
  WebAssembly. It is served by this app, with no third-party CDN, and the camera
  feed never leaves the browser. It uses the GPU when one is available and
  automatically picks the CPU path on machines with software-only WebGL.
- **Any garment image.** Pick a sample, drop a file, drag an image straight out
  of another shop's tab, paste one (Ctrl/⌘+V) or paste a URL.
  - Plain product-photo backgrounds are removed automatically, and the
    tolerance is adjustable.
  - The garment type (top / dress / skirt or trousers) is auto-detected.
  - Shops that block cross-origin image access go through a same-origin image
    proxy. If that isn't available, the garment is still shown, and the studio
    explains what's limited.
- **Realistic fit.**
  - The garment is warped onto shoulders, torso and hips with a textured
    triangle mesh (WebGL, with a 2D-canvas fallback).
  - Sleeves rotate to follow the upper arms, and the mesh is guaranteed never to
    fold.
  - Spring physics make the hem lag and sway when you move.
  - A One Euro filter steadies tracking jitter, and the garment brightness
    follows the scene's lighting.
- **Fit controls.** Size, length, position, garment type, sway and sleeve
  following, plus a body-tracking overlay for debugging.
- **Photo mode** for people without a camera, and **snapshots** you can
  download.
- Responsive layout with light and dark themes.

## Add it to a store

```html
<!-- 1. Load the widget once per page -->
<script async src="https://YOUR-HOST/widget.js"></script>

<!-- 2. Mark product images that can be tried on -->
<img src="/images/coral-tee.jpg" alt="Coral Crew Tee"
     data-tryon data-tryon-type="top" data-tryon-product="sku-1042">

<!-- 3. Optional: react when the shopper presses "Add to cart" in the try-on -->
<script>
  document.addEventListener('mirrorfit:add-to-cart', (e) => addToCart(e.detail.product));
</script>
```

| Script attribute | Default | Meaning |
| --- | --- | --- |
| `data-studio` | `studio.html` next to `widget.js` | URL of the studio page |
| `data-selector` | `[data-tryon]` | Which elements get a button |
| `data-label` | `Try it on` | Button text |

The marked element can also carry the following attributes:

- `data-tryon-image`: the garment URL, if it isn't the `<img>` itself.
- `data-tryon-type`: `top`, `dress` or `bottom`.
- `data-tryon-product`
- `data-tryon-name`
- `data-tryon-label`

The widget emits `mirrorfit:open`, `mirrorfit:close` and `mirrorfit:add-to-cart`
on `document`. It also exposes `window.Mirrorfit.open({ garment, type, product, name })`
and `window.Mirrorfit.close()`. Products added to the page later (SPA themes)
are picked up automatically.

**Shopify:** paste the script tag into `theme.liquid` before `</body>`, and add
`data-tryon` to the product image in your product template.

## How it works

```
camera / photo ──► MediaPipe Pose (33 landmarks) ──► One Euro smoothing
                                                     │
garment image ──► background removal ──► silhouette analysis
                  (border flood fill)    (torso width, shoulder line,
                                          sleeve pivots and angles, type)
                                                     │
                                                     ▼
                  body frame (shoulders, hips, torso axis, upper arms)
                                                     │
                                                     ▼
                  garment → body mapping (+ sleeve rotation, no folds)
                                                     │
                  16×22 mesh ──► spring "sway" ──► WebGL textured mesh ──► composite
```

| Directory | Contents |
| --- | --- |
| `src/core/` | Framework-free engine: garment analysis, fitting, physics, filters, mesh rendering |
| `src/lib/` | Browser glue: camera, pose tracker, garment loader, drag-and-drop parsing |
| `src/pages/` | Page scripts for the landing page, studio and demo store |
| `public/` | The store widget, sample garments and the pose model |
| `server/` | Production static server and the image proxy |

The image proxy (`/api/image-proxy?url=…`) only fetches public `http(s)`
images:

- **Network:** every resolved IP is checked at connect time, so DNS rebinding
  can't reach private or internal networks. Redirects are re-validated, and
  only ports 80 and 443 are allowed.
- **Content:** raster image types only (no SVG), with a size limit and a
  timeout.

## Tests

```bash
npm test             # unit + end-to-end
npm run test:unit    # Vitest
npm run test:e2e     # builds, then Playwright against the production server
```

- **Unit tests** cover:
  - garment analysis and type detection
  - the fitting math, including a property test that the mesh never folds
    across 300 body and arm poses
  - physics, filters and mesh affine maps
  - drag-and-drop parsing
  - the widget, in jsdom
  - the image proxy's SSRF protection, and the static server, including
    path-traversal attempts
- **End-to-end tests** run Chromium against the production build:
  - **Real body tracking.** Photo mode runs the real MediaPipe model on a real
    photo of a person. Live camera mode feeds Chromium's fake camera a video of
    that photo.
  - **Every garment input path.** Drag and drop, paste, URL, and cross-origin
    images.
  - **The store widget.** Its overlay, add-to-cart and keyboard handling.
  - **Phone layouts and error states.** Camera disconnects, busy garment
    backgrounds, non-web links and keyboard-only use.
  - **Accessibility.** An axe-core audit of every page in light and dark mode.

The test photo is downloaded on first run into `tests/.fixtures/`. If it can't
be downloaded, the tests that need it are skipped.

## Limitations

This is a 2D fit driven by body landmarks, not a generative model, so:

- arms crossing in front of the body are covered by the garment;
- trousers follow the hips but not each leg separately;
- very steeply raised arms are followed only partly;
- it gives a convincing sense of colour, length and proportion, not a size
  recommendation.

Product photos work best when they are front-facing, show a single garment and
have a plain background.

## Credits

- Body tracking: [MediaPipe Pose Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker)
  (`@mediapipe/tasks-vision`). `public/models/pose_landmarker_lite.task` is
  Google's model, distributed under the Apache License 2.0.
- The sample garments are original SVG illustrations made for this project.
