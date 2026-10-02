import '../styles/base.css';
import '../styles/studio.css';
import { toPixels } from '../core/body.js';
import { PointSmoother } from '../core/filters.js';
import { DEFAULT_ADJUST } from '../core/fit.js';
import { GARMENT_TYPES } from '../core/garment.js';
import { fitReport } from '../core/fitReport.js';
import { bodyMeasurements, chartFor, fitVerdicts, measureScale, recommendSize, sizeFit } from '../core/sizing.js';
import { TryOnRenderer } from '../core/renderer.js';
import { startCamera, stopCamera } from '../lib/camera.js';
import { CATALOG, catalogUrl } from '../lib/catalog.js';
import { extractImageUrl } from '../lib/dropData.js';
import { loadImage, loadRemoteImage, prepareGarment } from '../lib/garmentLoader.js';
import { createHumanParser } from '../lib/humanParser.js';
import { createMockTracker, createPoseTracker } from '../lib/poseTracker.js';

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const els = {
  canvas: $('view'),
  heightCm: $('height-cm'),
  sizeAdvice: $('size-advice'),
  sizeChips: $('size-chips'),
  sizeMeasures: $('size-measures'),
  video: $('camera'),
  empty: $('empty-state'),
  status: $('status'),
  dropOverlay: $('drop-overlay'),
  toolbar: $('toolbar'),
  snapshot: $('snapshot'),
  mirror: $('toggle-mirror'),
  switchSource: $('switch-source'),
  snapshots: $('snapshots'),
  startCamera: $('start-camera'),
  photoInput: $('photo-input'),
  grid: $('garment-grid'),
  dropzone: $('dropzone'),
  garmentInput: $('garment-input'),
  urlForm: $('url-form'),
  url: $('garment-url'),
  info: $('garment-info'),
  type: $('garment-type'),
  size: $('fit-size'),
  length: $('fit-length'),
  offset: $('fit-offset'),
  physics: $('opt-physics'),
  arms: $('opt-arms'),
  bg: $('opt-bg'),
  tolerance: $('opt-tolerance'),
  skeleton: $('opt-skeleton'),
  accurate: $('opt-accurate'),
  resetFit: $('reset-fit'),
  addToCart: $('add-to-cart'),
};

const state = {
  source: null, // 'camera' | 'photo'
  trackers: {}, // 'live:lite' | 'live:full' | 'photo:full' -> { promise, tracker, error }
  tracker: null, // the tracker serving the current source
  trackerError: null,
  photo: null,
  points: null,
  mask: null,
  parsing: null, // per-pixel hair / skin / clothes labels (see lib/humanParser.js)
  parser: null, // Promise of the human parser, loaded on first use
  liveParser: null, // the parser, once ready for video
  lastEngine: null,
  garment: null,
  garmentImage: null,
  garmentMeta: null,
  garmentToken: 0,
  adjust: { ...DEFAULT_ADJUST },
  mirror: true,
  dirty: true,
  lastTime: 0,
  lastVideoTime: -1,
  framesRendered: 0,
  poseFrames: 0,
  fps: 0,
  fpsFrames: 0,
  fpsSince: 0,
  lastResult: null,
  heightCm: null, // the wearer's height, for measurements (remembered)
  sizeChoice: 'auto', // 'auto' = fitted to the body, or a size drawn true to its measurements
  sizing: null, // latest { kind, chart, scale, measures, rec }
  lastResultDrawn: false,
  statusKey: '',
};

const smoother = new PointSmoother({ minCutoff: 1.2, beta: 0.01 });
const renderer = new TryOnRenderer(els.canvas, { webgl: params.get('webgl') !== '0' });
const embed = params.get('embed') === '1';
if (embed) document.body.classList.add('embed');

// ---------------------------------------------------------------- status

function setStatus(text, tone = 'info', key = text) {
  if (state.statusKey === key) return;
  state.statusKey = key;
  els.status.hidden = !text;
  els.status.textContent = text;
  els.status.dataset.tone = tone;
}

function setInfo(text, tone = 'info') {
  els.info.textContent = text;
  els.info.dataset.tone = tone;
}

// ---------------------------------------------------------------- tracker

// Live video uses the fast "lite" pose model (or "full" with high-accuracy
// tracking on); photos always use the more accurate "full" model.
const liveModel = () => params.get('model') || (els.accurate.checked ? 'full' : 'lite');

function getTracker(kind = 'live') {
  const model = kind === 'photo' ? 'full' : liveModel();
  const slot = (state.trackers[`${kind}:${model}`] ||= {});
  if (!slot.promise) {
    const mock = params.get('pose') === 'mock';
    const delegate = params.get('delegate') || undefined;
    slot.promise = (mock ? Promise.resolve(createMockTracker({ back: params.get('view') === 'back' })) : createPoseTracker({ delegate, model, maxPeople: kind === 'photo' ? 4 : 1 }))
      .then((tracker) => {
        slot.tracker = tracker;
        return tracker;
      })
      .catch((err) => {
        slot.promise = null;
        throw err;
      });
  }
  return slot.promise;
}

/**
 * Forgets a tracker after it failed: a WebAssembly abort leaves it unusable,
 * so the next detection loads a fresh one.
 */
function discardTracker(tracker) {
  for (const [key, slot] of Object.entries(state.trackers)) {
    if (slot.tracker === tracker) delete state.trackers[key];
  }
  if (state.tracker === tracker) state.tracker = null;
  try {
    tracker?.close();
  } catch {
    // Already dead.
  }
}

/** The human parser (clothes / skin / hair labels), loaded on first use. */
function getParser() {
  if (!state.parser) {
    const delegate = params.get('delegate') || undefined;
    state.parser = createHumanParser({ delegate }).catch((err) => {
      state.parser = null;
      throw err;
    });
  }
  return state.parser;
}

/** Points the current source at its tracker, loading it if needed. */
async function attachTracker(kind) {
  state.tracker = null;
  state.trackerError = null;
  try {
    const tracker = await getTracker(kind);
    if (kind === 'live') await tracker.prepareVideo();
    if ((kind === 'live') === (state.source === 'camera')) state.tracker = tracker;
    return tracker;
  } catch (err) {
    state.trackerError = err;
    throw err;
  }
}

// ---------------------------------------------------------------- sources

function showStage() {
  els.empty.hidden = true;
  els.toolbar.hidden = false;
}

async function useCamera() {
  els.startCamera.disabled = true;
  setStatus('Starting camera…');
  try {
    await startCamera(els.video);
  } catch (err) {
    els.startCamera.disabled = false;
    setStatus(err.message, 'error');
    return;
  }
  els.startCamera.disabled = false;
  // The camera can disappear mid-session (unplugged, taken by another app).
  for (const track of els.video.srcObject.getVideoTracks()) track.addEventListener('ended', onCameraEnded, { once: true });
  state.source = 'camera';
  state.photo = null;
  state.points = null;
  state.mask = null;
  state.mirror = true;
  syncMirrorButton();
  smoother.reset();
  renderer.resetMotion();
  showStage();
  setStatus('Loading body tracking…');
  try {
    await attachTracker('live');
  } catch (err) {
    setStatus(`Body tracking failed to load: ${err.message}`, 'error');
    return;
  }
  // Clothes / skin parsing for live video, loaded in the background.
  if (params.get('parsing') !== '0' && params.get('pose') !== 'mock') {
    getParser()
      .then(async (parser) => {
        await parser.prepareVideo();
        if (state.source === 'camera') state.liveParser = parser;
      })
      .catch((err) => console.warn('[mirrorfit] human parsing unavailable', err));
  }
}

async function usePhoto(file) {
  if (!file || !file.type.startsWith('image/')) {
    setStatus('Please choose an image file.', 'error');
    return;
  }
  setStatus('Loading photo…');
  let img;
  const url = URL.createObjectURL(file);
  try {
    img = await loadImage(url);
  } catch {
    setStatus('That photo could not be opened.', 'error');
    return;
  } finally {
    URL.revokeObjectURL(url);
  }
  if (state.source === 'camera') stopCamera(els.video);
  const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  const photo = document.createElement('canvas');
  photo.width = Math.round(img.naturalWidth * k);
  photo.height = Math.round(img.naturalHeight * k);
  photo.getContext('2d').drawImage(img, 0, 0, photo.width, photo.height);

  state.source = 'photo';
  state.liveParser = null;
  state.photo = photo;
  state.points = null;
  state.mask = null;
  state.mirror = false;
  syncMirrorButton();
  renderer.resetMotion();
  showStage();
  state.dirty = true;
  setStatus('Finding you in the photo…');
  let tracker = null;
  try {
    tracker = await attachTracker('photo');
    state.tracker = tracker;
    const detection = await tracker.detectImage(photo);
    if (state.photo !== photo) return;
    state.points = detection ? toPixels(detection.landmarks, photo.width, photo.height) : null;
    state.mask = detection?.mask ?? null;
    state.parsing = null;
    state.poseFrames += detection ? 1 : 0;
    if (detection && params.get('parsing') !== '0') {
      state.dirty = true; // show the fit right away; parsing refines it
      try {
        const parsing = await (await getParser()).parse(photo);
        if (state.photo === photo) state.parsing = parsing;
      } catch (err) {
        console.warn('[mirrorfit] human parsing unavailable', err);
        state.parser = null;
      }
    }
  } catch (err) {
    if (tracker) discardTracker(tracker);
    console.warn('[mirrorfit] body tracking failed', err);
    if (state.photo === photo) setStatus('Body tracking failed on this photo. Try another photo, or try again.', 'error');
    return;
  }
  state.dirty = true;
}

function switchSource() {
  if (state.source === 'camera') stopCamera(els.video);
  state.liveParser = null;
  state.source = null;
  state.photo = null;
  state.points = null;
  state.mask = null;
  state.parsing = null;
  els.empty.hidden = false;
  els.toolbar.hidden = true;
  setStatus('');
  const ctx = els.canvas.getContext('2d');
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
}

function onCameraEnded() {
  if (state.source !== 'camera') return;
  switchSource();
  setStatus('The camera stopped (disconnected or in use by another app). Press "Start camera" to try again.', 'error');
}

function syncMirrorButton() {
  els.mirror.setAttribute('aria-pressed', String(state.mirror));
}

// ---------------------------------------------------------------- garments

function renderCatalog() {
  for (const item of CATALOG) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.garmentId = item.id;
    btn.title = item.name;
    btn.setAttribute('aria-pressed', 'false');
    btn.innerHTML = `<img alt="${item.name}" src="${item.file}" loading="lazy">`;
    btn.addEventListener('click', () => selectGarment({ url: catalogUrl(item), name: item.name, type: item.type, id: item.id }));
    els.grid.append(btn);
  }
}

function markActive(id) {
  for (const btn of els.grid.querySelectorAll('button')) btn.setAttribute('aria-pressed', String(btn.dataset.garmentId === id));
}

async function selectGarment({ url, file, name, type, id }) {
  const token = ++state.garmentToken;
  setInfo(`Loading ${name || 'garment'}…`);
  let image;
  let via = 'file';
  let objectUrl = null;
  try {
    if (file) {
      if (!file.type.startsWith('image/')) throw new Error('That file is not an image.');
      objectUrl = URL.createObjectURL(file);
      image = await loadImage(objectUrl);
    } else {
      ({ image, via } = await loadRemoteImage(url));
    }
  } catch (err) {
    if (token === state.garmentToken) setInfo(err.message.startsWith('Could not load') ? 'Could not load an image from that link.' : err.message, 'error');
    return;
  } finally {
    if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
  if (token !== state.garmentToken) return;
  state.garmentImage = image;
  state.garmentMeta = { url: url || null, name: name || (file ? file.name : hostLabel(url)), via, id: id || null };
  els.type.value = GARMENT_TYPES.includes(type) ? type : 'auto';
  markActive(id || null);
  processGarment();
}

function hostLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Garment';
  }
}

function processGarment() {
  if (!state.garmentImage) return;
  try {
    state.garment = prepareGarment(state.garmentImage, {
      removeBg: els.bg.checked,
      tolerance: Number(els.tolerance.value),
      type: els.type.value,
    });
  } catch (err) {
    state.garment = null;
    setInfo(err.message, 'error');
    state.dirty = true;
    return;
  }
  renderer.resetMotion();
  state.dirty = true;
  const g = state.garment;
  const typeLabel = { top: 'top', dress: 'dress', bottom: 'skirt / trousers' }[g.type];
  if (!g.readable) {
    setInfo(`${state.garmentMeta.name}: this shop blocks image access, so the background can't be removed and snapshots are disabled. Save the image and drop the file here instead.`, 'warn');
    return;
  }
  if (g.backgroundNote === 'busy-background') {
    setInfo(`${state.garmentMeta.name}: the background is too busy to remove, so the whole picture is shown. Use a product photo on a plain background, or a transparent PNG.`, 'warn');
    return;
  }
  const auto = els.type.value === 'auto' ? ' (auto)' : '';
  const bg = g.backgroundRemoved ? ' · background removed' : '';
  setInfo(`${state.garmentMeta.name} · ${typeLabel}${auto}${bg}`);
}

// ---------------------------------------------------------------- render loop

function updateFps(now) {
  state.fpsFrames++;
  if (!state.fpsSince) state.fpsSince = now;
  if (now - state.fpsSince >= 1000) {
    state.fps = Math.round((state.fpsFrames * 1000) / (now - state.fpsSince));
    state.fpsFrames = 0;
    state.fpsSince = now;
  }
}

function updateStatus(result) {
  if (state.trackerError) return setStatus(`Body tracking failed to load: ${state.trackerError.message}`, 'error', 'tracker-error');
  if (!state.tracker) return setStatus('Loading body tracking…', 'info', 'loading');
  if (!result.frame) {
    return state.source === 'photo'
      ? setStatus('No person found. Use a photo where your shoulders are clearly visible.', 'error', 'no-person-photo')
      : setStatus('Step into view so your shoulders are visible', 'info', 'no-person');
  }
  if (!state.garment) return setStatus('Pick a garment to try on', 'info', 'no-garment');
  if (result.reason === 'side-on') {
    return state.source === 'photo'
      ? setStatus('This photo is side-on. Use a photo where you face the camera (turned a little is fine).', 'error', 'side-on-photo')
      : setStatus('Turn to face the camera', 'info', 'side-on');
  }
  if (result.reason === 'lower-body-out-of-view') {
    return state.source === 'photo'
      ? setStatus('Skirts and trousers need your hips and legs in the photo. Try a photo that shows them, or pick a top.', 'error', 'need-legs-photo')
      : setStatus('Step back so your hips and legs are in view', 'info', 'need-legs');
  }
  if (state.source === 'photo') return setStatus('Done! Tweak the fit or take a snapshot', 'ok', 'photo-ok');
  return setStatus(`Live · ${state.fps || '–'} fps`, 'ok', `live-${state.fps}`);
}

/** ?realism=0 turns the edge fill off; ?fill=… tunes it (debugging). */
function realismOption() {
  if (params.get('realism') === '0') return false;
  const tune = {};
  if (params.has('fill')) tune.fill = Number(params.get('fill'));
  return Object.keys(tune).length ? tune : true;
}

function renderOptions(source, dt) {
  return {
    source,
    mirror: state.mirror,
    points: state.points,
    garment: state.garment,
    adjust: sizedAdjust(),
    dt,
    physics: els.physics.checked && state.source === 'camera',
    followArms: els.arms.checked,
    mask: state.mask,
    temporal: state.source === 'camera',
    guides: els.skeleton.checked,
    engine: params.get('engine') || undefined,
    realism: realismOption(),
    shading: params.get('shading') !== '0',
    photoMatch: params.get('match') !== '0',
    undress: params.get('undress') !== '0',
    turn: params.get('turn') !== '0',
    parsing: state.parsing,
    matchLighting: true,
  };
}

function tick(now) {
  requestAnimationFrame(tick);
  const dt = state.lastTime ? (now - state.lastTime) / 1000 : 1 / 60;
  state.lastTime = now;

  if (state.source === 'camera') {
    const v = els.video;
    if (v.readyState < 2 || !v.videoWidth) return;
    renderer.resize(v.videoWidth, v.videoHeight);
    if (state.tracker && v.currentTime !== state.lastVideoTime) {
      state.lastVideoTime = v.currentTime;
      try {
        const detection = state.tracker.detectVideo(v, now);
        if (detection) {
          state.points = smoother.smooth(toPixels(detection.landmarks, v.videoWidth, v.videoHeight), now / 1000);
          state.mask = detection.mask;
          state.poseFrames++;
          // Clothes / skin labels every few frames (they change slowly).
          if (state.liveParser && state.poseFrames % 6 === 0) {
            try {
              state.parsing = state.liveParser.parseVideo(v, now);
            } catch {
              state.liveParser = null;
            }
          }
        } else {
          state.points = null;
          state.mask = null;
          state.parsing = null;
          smoother.reset();
        }
      } catch (err) {
        console.warn('[mirrorfit] pose detection failed', err);
        // Reload body tracking rather than failing on every frame.
        discardTracker(state.tracker);
        state.trackerFailures = (state.trackerFailures || 0) + 1;
        if (state.trackerFailures <= 3) attachTracker('live').catch(() => {});
        else setStatus('Body tracking stopped working. Reload the page to try again.', 'error');
      }
    }
    const result = renderer.render(renderOptions(v, dt));
    state.lastResult = result;
    if (state.framesRendered % 15 === 0) updateSizing(result);
    state.lastResultDrawn = result.drawn;
    state.lastWebgl = !!result.webgl;
    state.lastEngine = result.engine;
    state.framesRendered++;
    updateFps(now);
    updateStatus(result);
  } else if (state.source === 'photo' && state.dirty) {
    state.dirty = false;
    renderer.resize(state.photo.width, state.photo.height);
    const result = renderer.render(renderOptions(state.photo, 0));
    state.lastResult = result;
    updateSizing(result);
    state.lastResultDrawn = result.drawn;
    state.lastWebgl = !!result.webgl;
    state.lastEngine = result.engine;
    state.framesRendered++;
    if (state.tracker || state.trackerError) updateStatus(result);
  }
}

// ---------------------------------------------------------------- size

/** The garment kind for size charts. */
function garmentKind(g) {
  if (!g?.rig) return null;
  if (g.rig.type === 'bottom') return g.rig.kind === 'trousers' ? 'trousers' : 'skirt';
  return g.rig.type === 'dress' ? 'dress' : 'top';
}

/** Measurements and the recommended size from the last fitted body. */
function updateSizing(result) {
  const kind = garmentKind(state.garment);
  if (!result?.body || !kind || !state.points) return;
  const chart = chartFor(kind);
  const scale = measureScale(result.body, state.points, state.mask, state.heightCm);
  const measures = bodyMeasurements(result.body, scale.pxPerCm, null, { statureCm: state.heightCm });
  const rec = recommendSize(measures, chart);
  const prev = state.sizing;
  state.sizing = { kind, chart, scale, measures, rec };
  if (prev?.chart !== chart || prev?.rec.size !== rec.size) renderSizeChips();
  renderSizeAdvice();
}

function renderSizeAdvice() {
  const z = state.sizing;
  if (!z) return;
  const shown = state.sizeChoice !== 'auto' && z.chart.sizes[state.sizeChoice] ? state.sizeChoice : z.rec.size;
  const fits = shown === z.rec.size ? z.rec.fits : fitVerdicts(z.measures, z.chart, shown);
  const parts = Object.entries(fits).map(([m, v]) => `${m} ${v}`);
  const how = {
    stature: 'Measured from your height.',
    head: 'From your height and head size: step back so your feet are in view for a better reading.',
    shoulders: 'Rough: add your height for an accurate size.',
  }[z.scale.method];
  const strong = document.createElement('strong');
  strong.textContent = shown;
  els.sizeAdvice.replaceChildren(
    document.createTextNode(state.sizeChoice === 'auto' ? 'Recommended size: ' : 'Showing size '),
    strong,
    document.createTextNode(` — ${parts.join(', ')}. ${how}`),
  );
  const m = z.measures;
  els.sizeMeasures.textContent = ['chest', 'waist', 'hips']
    .filter((k) => m[k])
    .map((k) => `${k[0].toUpperCase()}${k.slice(1)} ≈ ${m[k]} cm`)
    .join(' · ');
}

function renderSizeChips() {
  const z = state.sizing;
  els.sizeChips.replaceChildren();
  if (!z) return;
  if (state.sizeChoice !== 'auto' && !z.chart.sizes[state.sizeChoice]) state.sizeChoice = 'auto';
  const chip = (value, label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(state.sizeChoice === value));
    b.dataset.size = value;
    b.textContent = label;
    if (value === z.rec.size) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '★';
      b.append(badge);
      b.setAttribute('aria-label', `${label} (recommended)`);
    }
    b.addEventListener('click', () => {
      state.sizeChoice = value;
      for (const other of els.sizeChips.querySelectorAll('button')) other.setAttribute('aria-checked', String(other === b));
      renderSizeAdvice();
      state.dirty = true;
    });
    els.sizeChips.append(b);
  };
  chip('auto', 'Fit to me');
  for (const name of Object.keys(z.chart.sizes)) chip(name, name);
}

/** Fit adjustments, with a chosen size drawn true to its measurements. */
function sizedAdjust() {
  const z = state.sizing;
  if (state.sizeChoice === 'auto' || !z || !z.chart.sizes[state.sizeChoice]) return state.adjust;
  const f = sizeFit(z.chart, state.sizeChoice, z.measures, z.scale.pxPerCm, z.kind);
  return { ...state.adjust, easePx: f.easePx, lengthPx: f.lengthPx };
}

function loadHeight() {
  try {
    const v = Number(localStorage.getItem('mirrorfit.heightCm'));
    if (v >= 120 && v <= 220) {
      state.heightCm = v;
      els.heightCm.value = String(v);
    }
  } catch {
    // Storage unavailable: start empty.
  }
}

els.heightCm.addEventListener('change', () => {
  const v = Number(els.heightCm.value);
  state.heightCm = v >= 120 && v <= 220 ? v : null;
  try {
    if (state.heightCm) localStorage.setItem('mirrorfit.heightCm', String(state.heightCm));
    else localStorage.removeItem('mirrorfit.heightCm');
  } catch {
    // Not remembered; still used for now.
  }
  updateSizing(state.lastResult);
  state.dirty = true;
});
loadHeight();
// ---------------------------------------------------------------- snapshots

const MAX_SNAPSHOTS = 12;

function takeSnapshot() {
  if (!state.source) return;
  const fail = (msg) => setInfo(msg, 'error');
  try {
    els.canvas.toBlob((blob) => {
      if (!blob) return fail('Could not create the snapshot.');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mirrorfit-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      a.title = 'Download snapshot';
      a.innerHTML = `<img alt="Snapshot" src="${url}">`;
      els.snapshots.prepend(a);
      // Keep memory bounded: drop (and free) the oldest snapshots.
      while (els.snapshots.children.length > MAX_SNAPSHOTS) {
        const old = els.snapshots.lastElementChild;
        URL.revokeObjectURL(old.href);
        old.remove();
      }
      els.canvas.classList.remove('flash');
      void els.canvas.offsetWidth;
      els.canvas.classList.add('flash');
    }, 'image/png');
  } catch {
    fail('Snapshots are unavailable for this garment because its shop blocks image access.');
  }
}

// ---------------------------------------------------------------- input wiring

function bindRange(input, key, format) {
  const out = input.parentElement.querySelector('output');
  const update = () => {
    state.adjust[key] = Number(input.value);
    out.textContent = format(Number(input.value));
    state.dirty = true;
  };
  input.addEventListener('input', update);
  update();
}

bindRange(els.size, 'size', (v) => `${Math.round(v * 100)}%`);
bindRange(els.length, 'length', (v) => `${Math.round(v * 100)}%`);
bindRange(els.offset, 'offset', (v) => (v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2)));
els.tolerance.addEventListener('input', () => {
  els.tolerance.parentElement.querySelector('output').textContent = els.tolerance.value;
});
els.tolerance.addEventListener('change', processGarment);
els.bg.addEventListener('change', processGarment);
els.type.addEventListener('change', processGarment);
for (const el of [els.physics, els.arms, els.skeleton]) el.addEventListener('change', () => (state.dirty = true));
els.accurate.addEventListener('change', () => {
  if (state.source === 'camera') attachTracker('live').catch((err) => setStatus(`Body tracking failed to load: ${err.message}`, 'error'));
});

els.resetFit.addEventListener('click', () => {
  for (const [input, value] of [[els.size, 1], [els.length, 1], [els.offset, 0]]) {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }
});

els.startCamera.addEventListener('click', useCamera);
// Real buttons (keyboard-focusable) that open the hidden file inputs.
for (const btn of document.querySelectorAll('[data-file-input]')) {
  btn.addEventListener('click', () => $(btn.dataset.fileInput).click());
}
els.photoInput.addEventListener('change', () => {
  const file = els.photoInput.files[0];
  els.photoInput.value = '';
  if (file) usePhoto(file);
});
els.snapshot.addEventListener('click', takeSnapshot);
els.mirror.addEventListener('click', () => {
  state.mirror = !state.mirror;
  syncMirrorButton();
  state.dirty = true;
});
els.switchSource.addEventListener('click', switchSource);

els.garmentInput.addEventListener('change', () => {
  const file = els.garmentInput.files[0];
  els.garmentInput.value = '';
  if (file) selectGarment({ file });
});
els.urlForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const url = els.url.value.trim();
  if (url) selectGarment({ url });
});

// Drag & drop anywhere on the page.
let dragDepth = 0;
const isDragWithData = (e) => [...(e.dataTransfer?.types || [])].some((t) => t === 'Files' || t === 'text/uri-list' || t === 'text/html');
document.addEventListener('dragenter', (e) => {
  if (!isDragWithData(e)) return;
  dragDepth++;
  els.dropOverlay.hidden = false;
  els.dropzone.classList.add('over');
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    els.dropOverlay.hidden = true;
    els.dropzone.classList.remove('over');
  }
});
document.addEventListener('dragover', (e) => {
  if (isDragWithData(e)) e.preventDefault();
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.dropOverlay.hidden = true;
  els.dropzone.classList.remove('over');
  const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('image/'));
  if (file) return selectGarment({ file });
  const url = e.dataTransfer && extractImageUrl(e.dataTransfer);
  if (url) return selectGarment({ url });
  setInfo("That didn't contain an image. Drag the product photo itself.", 'error');
});

document.addEventListener('paste', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
  if (file) return selectGarment({ file });
  const url = e.clipboardData && extractImageUrl(e.clipboardData);
  if (url) selectGarment({ url });
});

// Embedded in a store via widget.js.
function postToParent(message) {
  if (window.parent === window) return;
  let target = '*';
  try {
    if (document.referrer) target = new URL(document.referrer).origin;
  } catch {
    // keep '*': the message contains no private data
  }
  window.parent.postMessage({ source: 'mirrorfit', ...message }, target);
}
els.addToCart.addEventListener('click', () => {
  postToParent({ type: 'add-to-cart', product: params.get('product'), garment: state.garmentMeta?.url || null });
  els.addToCart.textContent = 'Added ✓';
  setTimeout(() => (els.addToCart.textContent = 'Add to cart'), 1600);
});
if (embed && !params.get('product')) els.addToCart.closest('section').hidden = true;
// Keyboard focus is inside this iframe once the shopper interacts with it, so
// forward Escape to the widget on the store page.
if (embed) {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') postToParent({ type: 'close' });
  });
}

window.addEventListener('pagehide', () => stopCamera(els.video));

// Read-only hook for automated tests and debugging.
window.__mirrorfit = {
  state: () => ({
    source: state.source,
    backend: state.tracker?.backend || null,
    model: state.tracker?.model || null,
    engine: state.lastEngine,
    hasMask: !!state.mask,
    hasParsing: !!state.parsing,
    sizing: state.sizing && { kind: state.sizing.kind, size: state.sizing.rec.size, fits: state.sizing.rec.fits, measures: state.sizing.measures, scale: state.sizing.scale, choice: state.sizeChoice },
    light: renderer.light ? { x: +renderer.light.x.toFixed(2), y: +renderer.light.y.toFixed(2), z: +renderer.light.z.toFixed(2), confidence: +renderer.light.confidence.toFixed(2) } : null,
    facing: state.lastResult?.body?.facing ?? null,
    yaw: state.lastResult?.body ? Math.round((state.lastResult.body.yaw * 180) / Math.PI) : null,
    look: renderer.look ? { lift: +renderer.look.lift.toFixed(3), gain: renderer.look.gain.map((v) => +v.toFixed(3)), sat: +renderer.look.sat.toFixed(2), grain: +renderer.look.grain.toFixed(4) } : null,
    layers: renderer.lastLayers ?? null,
    parsingCounts: state.parsing && Array.from(state.parsing.labels.reduce((c, l) => (c[l]++, c), new Uint32Array(6))),
    trackerError: state.trackerError?.message || null,
    poseFrames: state.poseFrames,
    framesRendered: state.framesRendered,
    garmentDrawn: state.lastResultDrawn,
    webgl: !!state.lastWebgl,
    fps: state.fps,
    mirror: state.mirror,
    canvas: { width: els.canvas.width, height: els.canvas.height },
    points: state.points && state.points.map((p) => ({ x: p.x, y: p.y, z: p.z, v: p.v })),
    garment: state.garment && {
      name: state.garmentMeta?.name,
      type: state.garment.type,
      guessedType: state.garment.guessedType,
      backgroundRemoved: state.garment.backgroundRemoved,
      readable: state.garment.readable,
      via: state.garmentMeta?.via,
    },
  }),
  /** The parsing labels as a colour image (debugging): a data URL, or null. */
  parsingImage: () => {
    const p = state.parsing;
    if (!p) return null;
    const colors = [[0, 0, 0], [140, 70, 20], [240, 180, 140], [255, 220, 0], [40, 120, 255], [200, 0, 200]];
    const c = document.createElement('canvas');
    c.width = p.width;
    c.height = p.height;
    const img = c.getContext('2d').createImageData(p.width, p.height);
    for (let i = 0; i < p.labels.length; i++) img.data.set([...colors[p.labels[i]] ?? [255, 0, 0], 255], i * 4);
    c.getContext('2d').putImageData(img, 0, 0);
    return c.toDataURL();
  },
  /** How well the last drawn garment sits on the person's mask (see core/fitReport.js). */
  fitReport: () => {
    const r = state.lastResult;
    if (!r?.fit || !state.mask || !state.garment?.rig) return null;
    return fitReport({ body: r.body, fit: r.fit, garment: state.garment, mask: state.mask, width: els.canvas.width, height: els.canvas.height });
  },
};

// ---------------------------------------------------------------- start

renderCatalog();
requestAnimationFrame(tick);
const initial = params.get('garment');
if (initial) {
  selectGarment({ url: initial, name: params.get('name') || undefined, type: params.get('type') || undefined });
} else {
  const first = CATALOG[0];
  selectGarment({ url: catalogUrl(first), name: first.name, type: first.type, id: first.id });
}
// Warm up body tracking in the background so it's ready when the camera starts.
const warmUp = () => getTracker('live').catch(() => {});
if ('requestIdleCallback' in window) requestIdleCallback(warmUp, { timeout: 2000 });
else setTimeout(warmUp, 500);
if (params.get('autostart') === 'camera') useCamera();
