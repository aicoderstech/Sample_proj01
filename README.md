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
- **Measured fit (fit engine v2).**
  - The pose model also returns a person segmentation mask. The engine measures
    the wearer's real outline from it: shoulder edges, chest, waist and hips,
    neck, armpits, and the thickness of each arm and leg.
  - Each garment is "rigged" from its silhouette: collar, shoulder seams,
    armpits, side seams, hem, and separate sleeves and trouser legs.
  - A thin-plate-spline warp pins the garment's construction points onto the
    body. Sleeves and trouser legs follow the real arms and legs, bending at
    the elbows and knees. Forearms and hands are drawn in front of the garment.
  - Fabric hugs the body where it is wider than the garment and keeps its own
    shape where the garment is wider (a T-shirt hanging straight, a skirt
    flaring out). Shoulder seams sit on the top-outer corner of each shoulder,
    and the top edge follows the measured line of the shoulders.
  - A WebGL realism pass extends the garment's edges to the wearer's outline
    where the clothes underneath are a few pixels wider (so none peek out).
    The head, hair, forearms and hands stay in front of the garment.
- **Folds, wrinkles and lighting.** Every mesh vertex carries the surface
  normal of the body under it (the torso as a rounded cylinder, sleeves and
  legs as tubes) and a fold field from the fit itself: where the warp
  squeezes the fabric (inside a bent elbow, a waist when leaning) folds form
  across the squeeze; where the garment is wider than the body the spare
  fabric hangs in vertical drape folds. The scene's light direction is
  estimated from the shading across the wearer's face, and the fabric is lit
  with it.
- **Bulky clothes and what you are wearing.** A second on-device model
  (MediaPipe's multi-class selfie segmenter) labels hair, skin, face and
  clothes. The shoulder joints fix the body's frame whatever is worn, and
  the visible neck tells its build, so a coat or a loose top is no longer
  mistaken for a bigger body: the garment fits the body inside. The old
  clothes the new garment leaves visible are taken off: bulk outside the
  body becomes background (push-pull inpainting, or a clean plate of the
  background learnt over time in live video), and old long sleeves under a
  new T-shirt become bare arms in the wearer's own skin tone.
- **Turned bodies and back views.** The pose model's landmark depths give
  the body's turn. A 3/4 view wraps the garment round a turned elliptical
  torso (its centre and print move towards the side turning away, the far
  half is foreshortened). Seen from behind, the garment's back is drawn:
  generated from the front photo by mirroring it, removing front-only
  details (prints, pockets, buttons, hood strings) while keeping repeating
  patterns such as stripes, and raising the neckline.
- **Size recommendation.** Enter your height: the scale comes from your
  head-to-heel height in the picture (or your head height when your feet
  are out of view). Chest, waist and hip circumferences come from the
  measured widths and an ellipse model of the body's cross-section; the
  garment's size chart then gives the recommended size and how it fits
  (snug, regular, relaxed) at chest, waist and hips. Pick any size to see it
  drawn true to its measurements: shorter and tighter, or longer and
  looser.
  - Accuracy is measured: see [Fit accuracy](#fit-accuracy).
  - Rendered as textured triangle meshes (WebGL, with a 2D-canvas fallback).
    Spring physics make the hem lag and sway when you move.
  - A One Euro filter steadies tracking jitter, and the garment brightness
    follows the scene's lighting.
- **Fit controls.** Size, length, position, garment type, sway and sleeve
  following, an optional high-accuracy tracking model for live video, and a
  fit-guides overlay that shows the measured body and the pinned points.
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
camera / photo ──► MediaPipe Pose ──► 33 landmarks + person mask
                                                     │
                                                     ▼
                  body model (bodyModel.js): outline profile, shoulder edges,
                  neck, armpits, waist, hips, arm and leg chains + radii,
                  smoothed over frames
                                                     │
garment image ──► background removal ──► garment rig (garmentRig.js):
                  (border flood fill)    collar, shoulders, armpits, side
                                         seams, hem, sleeve and leg parts
                                                     │
                                                     ▼
                  fit (fit2.js): thin-plate spline for the torso,
                  spine warps for sleeves / trouser legs
                                                     │
                  per-part meshes ──► spring "sway" ──► WebGL ──► forearms and
                                                               hands composited
                                                               back on top
```

| Directory | Contents |
| --- | --- |
| `src/core/` | Framework-free engine: body model, garment rig, fitting (TPS / spine warps), fit metrics, physics, filters, mesh rendering |
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

## Fit accuracy

`npm run bench` fits every catalog garment to synthetic people whose exact
shape is known. That is 3 builds × 13 poses (arms down, A-pose, T-pose, raised,
crossed, hands on hips, leaning, wide stance, lunge, webcam framing). It then
scores each fit with geometric checks, measured in shoulder widths (sw):

| Check | Passes when |
| --- | --- |
| Shoulder seam | the seam is within 4% sw of the top-outer corner of the shoulder |
| Shoulder top | the top of the shoulders, collar to seam, is covered (within 2.5% sw) |
| Neck centring | the neckline is within 2.5% sw of the body's midline |
| Chest / waistband contact | the fabric touches the body, with at most 10% sw ease |
| Waist / hip cover | the fabric covers the body, with at most 20–25% sw drape |
| Sleeve on arm / leg on leg | the sleeve or trouser-leg centre line is within 4–5% sw of the limb |
| Torso coverage | at least 99% of the torso the garment should cover is covered |
| Spill | at most 2% of the garment hangs in the air (a collar or hood may stand up round the neck) |

| Tracking | Original engine | Fit engine v2 |
| --- | --- | --- |
| Exact landmarks and mask | 51.6% of checks | **100%** (5,494 / 5,494) |
| Webcam-level noise (±2% landmarks, ragged mask edge) | 53.1% | **99.1%** |
| Heavy noise (±4% landmarks) | 51.3% | 91.5% |

The unit tests require at least 99.9% with exact tracking and 98% with
webcam-level noise. How well a real try-on fits depends on the pose model's
accuracy on that image. Good light, the whole body in frame and fitted clothes
underneath all help.

## Tests

```bash
npm test             # unit + end-to-end
npm run test:unit    # Vitest
npm run test:e2e     # builds, then Playwright against the production server
```

- **Unit tests** cover:
  - garment analysis and type detection
  - the fit engine: thin-plate spline, spine warp, garment rig, body model
    and the fit benchmark (see above)
  - clothing bulk, old-clothes removal, folds and lighting, turned bodies,
    the generated garment backs and size measurement (scale within 2% and
    widths within 2 cm on bodies of known size)
  - the original fitting math, including a property test that the mesh never
    folds across 300 body and arm poses
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
  - **Advanced fitting.** Clothes / skin parsing and the size recommendation
    on a real photo, sizes drawn true to size, and the back view.

The test photo is downloaded on first run into `tests/.fixtures/`. If it can't
be downloaded, the tests that need it are skipped.

## Limitations

The fit is measured and rendered in 2D (with a 2.5D body model), not
generated by a diffusion model, so:

- folds are synthesised from the fit (compression and drape) and the scene's
  light, not simulated cloth; very loose garments don't billow;
- the back of a garment is generated from its front photo: back-only
  details (a back print, a yoke) can't be known, and a shirt's placket can
  survive;
- the body's turn comes from the pose model's depth estimates, which are
  noisy: turns under about 20 degrees are treated as facing the camera, and
  clothing-bulk removal only runs when the person faces the camera;
- under bulky clothes the body's width is estimated from the skeleton and
  the visible neck, with a generous margin so a real body is never cut away;
  legs under a skirt or dress keep the wearer's own trousers;
- sizes are measured from one front view: circumferences assume an average
  body depth (about ±5 cm), and without your height the scale is rough;
- other people in the picture are left untouched, and very small or
  far-away people aren't found.

Product photos work best when they are front-facing, show a single garment and
have a plain background.

## Credits

- Body tracking: [MediaPipe Pose Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker)
  (`@mediapipe/tasks-vision`). `public/models/pose_landmarker_lite.task` and
  `pose_landmarker_full.task` and `selfie_multiclass_256x256.tflite` are
  Google's models, distributed under the
  Apache License 2.0.
- The sample garments are original SVG illustrations made for this project.
