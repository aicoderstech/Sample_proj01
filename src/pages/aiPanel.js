// Studio panel for the AI try-on (lib/aiTryOn.js): consent, model choice,
// progress, the result over the stage, and switching between the AI result
// and the instant 2D fit.
import { AI_PROVIDERS, providersFor, relayAiTryOn, runAiTryOn } from '../lib/aiTryOn.js';

const $ = (id) => document.getElementById(id);

/** A canvas as an image file (JPEG for photos, PNG for garments). */
const toBlob = (canvas, type, quality) =>
  new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read the picture.'))), type, quality));

/** A copy at most `max` pixels on its longer side, on white if asked. */
function scaled(source, max, white = false) {
  const w = source.naturalWidth || source.videoWidth || source.width;
  const h = source.naturalHeight || source.videoHeight || source.height;
  const k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext('2d');
  if (white) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
  }
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return c;
}

/**
 * @param {object} o
 * @param {() => {person: CanvasImageSource, garment: HTMLCanvasElement, kind: string, name: string}|null} o.inputs
 *   what to send, or null when there isn't a person and a readable garment yet
 * @param {Function} [o.connect] Gradio connect (a mock in tests)
 */
export function setupAiPanel({ inputs, connect }) {
  const els = {
    section: $('ai-section'),
    consent: $('ai-consent'),
    model: $('ai-model'),
    run: $('ai-run'),
    cancel: $('ai-cancel'),
    status: $('ai-status'),
    result: $('ai-result'),
    toggle: $('ai-toggle'),
  };
  const state = { running: null, url: null, showing: false, key: null, provider: null, guide: false };

  // guide: a hint about what to do next, replaced as soon as it no longer
  // applies (other messages stay until the next action).
  const setStatus = (text, tone = 'info', guide = false) => {
    els.status.textContent = text;
    els.status.dataset.tone = tone;
    els.status.title = '';
    state.guide = guide;
  };

  function show(on) {
    state.showing = on && !!state.url;
    els.result.hidden = !state.showing;
    els.toggle.hidden = !state.url;
    els.toggle.setAttribute('aria-pressed', String(state.showing));
    els.toggle.querySelector('span').textContent = state.showing ? 'Quick fit' : 'AI result';
  }

  function clearResult() {
    if (state.url?.startsWith('blob:')) URL.revokeObjectURL(state.url);
    state.url = null;
    state.key = null;
    els.result.removeAttribute('src');
    show(false);
  }

  /** The models offered for the current garment. */
  function syncModels(kind) {
    const keep = els.model.value;
    const list = providersFor(kind || 'top');
    els.model.replaceChildren(new Option('Best available', ''), ...list.map((p) => new Option(p.name, p.id)));
    if (list.some((p) => p.id === keep)) els.model.value = keep;
  }

  function sync() {
    const inp = inputs();
    syncModels(inp?.kind);
    els.run.disabled = !!state.running || !inp || !els.consent.checked;
    els.run.textContent = state.url ? 'Generate again' : 'Generate AI try-on';
    if (state.running) return;
    if (!inp) setStatus('Upload a photo (or start the camera) and pick a garment first.', 'info', true);
    else if (!els.consent.checked && !state.url) setStatus('Tick the box above to allow sending the photo.', 'info', true);
    else if (state.guide) setStatus('');
  }

  function describe(s) {
    if (s.stage === 'connecting') return `Connecting to ${s.provider}…`;
    if (s.stage === 'pending') {
      const pos = Number.isFinite(s.position) ? ` (place ${s.position + 1} in the queue${Number.isFinite(s.eta) && s.eta > 0 ? `, about ${Math.round(s.eta)} s` : ''})` : '';
      return `Waiting for ${s.provider}${pos}…`;
    }
    if (s.stage === 'generating' || s.stage === 'streaming') {
      const p = s.progress?.progress;
      return `${s.provider} is drawing you in it${Number.isFinite(p) ? `: ${Math.round(p * 100)}%` : '…'}`;
    }
    return `${s.provider}…`;
  }

  async function run() {
    const inp = inputs();
    if (!inp || state.running || !els.consent.checked) return;
    const controller = new AbortController();
    state.running = controller;
    els.cancel.hidden = false;
    sync();
    const started = performance.now();
    setStatus('Preparing the pictures…');
    try {
      const person = await toBlob(scaled(inp.person, 1024), 'image/jpeg', 0.92);
      const garment = await toBlob(scaled(inp.garment, 768, true), 'image/png');
      const job = { person, garment, kind: inp.kind, description: inp.name, only: els.model.value || null, signal: controller.signal };
      let res;
      try {
        res = await runAiTryOn({ ...job, connect, onStatus: (s) => !controller.signal.aborted && setStatus(describe(s)) });
      } catch (err) {
        // The browser couldn't reach the models: let the app's server try.
        if (!err.network || controller.signal.aborted || connect) throw err;
        setStatus('Trying through the Mirrorfit server…');
        res = await relayAiTryOn({ ...job });
      }
      if (controller.signal.aborted) return;
      clearResult();
      // A local copy, so snapshots of it work (a picture from another site
      // can be shown but not saved from a canvas).
      let url = res.url;
      if (/^https?:/.test(url)) {
        try {
          const r = await fetch(url, { signal: controller.signal });
          if (r.ok) url = URL.createObjectURL(await r.blob());
        } catch {
          // shown from the model's site instead
        }
      }
      state.url = url;
      state.provider = res.provider.name;
      await new Promise((resolve, reject) => {
        els.result.onload = resolve;
        els.result.onerror = () => reject(new Error('The generated picture could not be shown.'));
        els.result.src = url;
      });
      show(true);
      setStatus(`Made by ${res.provider.name} in ${Math.round((performance.now() - started) / 1000)} s. Use the toolbar to switch to the quick fit.`, 'ok');
    } catch (err) {
      if (controller.signal.aborted) {
        setStatus('Cancelled.');
      } else {
        const tried = err.attempts?.length ? ` (tried ${err.attempts.map((a) => a.provider).join(', ')})` : '';
        setStatus(`${err.message}${tried} Free models share GPUs and queue up; try again in a minute, or pick another model.`, 'error');
        if (err.attempts?.length) els.status.title = err.attempts.map((a) => `${a.provider}: ${a.error}`).join('\n');
      }
    } finally {
      state.running = null;
      els.cancel.hidden = true;
      sync();
    }
  }

  els.consent.addEventListener('change', sync);
  els.run.addEventListener('click', run);
  els.cancel.addEventListener('click', () => state.running?.abort());
  els.toggle.addEventListener('click', () => show(!state.showing));
  sync();

  return {
    /** Call when the photo or garment changes: the old result no longer applies. */
    invalidate() {
      state.running?.abort();
      const had = !!state.url;
      clearResult();
      if (had) setStatus('');
      sync();
    },
    sync,
    /** The AI picture when it is on show (for snapshots), else null. */
    shownImage: () => (state.showing ? els.result : null),
    providers: AI_PROVIDERS,
  };
}
