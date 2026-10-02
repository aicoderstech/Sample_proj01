// AI try-on: a photorealistic result from a free generative virtual try-on
// model, for a photo. The 2D fit (core/fit2.js) is instant and runs live;
// a diffusion model redraws the person wearing the garment (real drape,
// folds, occlusion and fit), which takes a GPU and 20-90 seconds.
//
// The models run as Gradio apps on Hugging Face Spaces (free, shared GPUs,
// queued). The browser calls them directly with the Gradio client; when it
// can't (a network or browser restriction) the app's own server relays the
// call (server/aiTryOn.mjs). Each model's inputs are read from its API
// description and filled in by core/aiTryOnPlan.js; models are tried in
// turn until one answers.
import { Client, handle_file } from '@gradio/client';
import { findImageUrl, pickEndpoint, planInputs } from '../core/aiTryOnPlan.js';

/**
 * Free try-on models, best first. kinds: the garments each handles well.
 * endpoints: the API names to use when present (else one is picked).
 */
export const AI_PROVIDERS = [
  { id: 'leffa', name: 'Leffa', space: 'franciszzj/Leffa', endpoints: ['/leffa_predict_vt'], kinds: ['top', 'bottom', 'dress'] },
  { id: 'catvton', name: 'CatVTON', space: 'zhengchong/CatVTON', endpoints: ['/submit_function'], kinds: ['top', 'bottom', 'dress'] },
  { id: 'idm-vton', name: 'IDM-VTON', space: 'yisol/IDM-VTON', endpoints: ['/tryon'], kinds: ['top'] },
  { id: 'kolors', name: 'Kolors Virtual Try-On', space: 'Kwai-Kolors/Kolors-Virtual-Try-On', endpoints: ['/tryon'], kinds: ['top', 'dress'] },
];

/** The providers to try for a garment kind, optionally only one of them. */
export function providersFor(kind, only = null) {
  const list = AI_PROVIDERS.filter((p) => p.kinds.includes(kind));
  return only ? list.filter((p) => p.id === only) : list;
}

/** An error worth telling the user about, with what to try. */
export class AiTryOnError extends Error {
  constructor(message, { attempts = [], network = false } = {}) {
    super(message);
    this.attempts = attempts;
    this.network = network;
  }
}

const withTimeout = (promise, ms, what) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} took too long`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });

/**
 * Runs one provider.
 * @returns {Promise<{url: string, provider: object}>}
 */
async function runProvider(provider, { person, garment, kind, description, token, onStatus, connect, timeoutMs, signal }) {
  const client = await withTimeout(connect(provider.space, token ? { token } : {}), 45000, `Connecting to ${provider.name}`);
  try {
    const api = await withTimeout(client.view_api(), 30000, `Reading ${provider.name}'s inputs`);
    const endpoint = pickEndpoint(api, provider.endpoints);
    if (!endpoint) throw new Error(`${provider.name} has no try-on endpoint`);
    const plan = planInputs(api.named_endpoints[endpoint], { kind, description });
    const file = (blob, editor) => (editor ? { background: handle_file(blob), layers: [], composite: null, id: null } : handle_file(blob));
    const data = plan.map((p) => (p.role === 'person' ? file(person, p.editor) : p.role === 'garment' ? file(garment, p.editor) : p.value));
    const job = client.submit(endpoint, data);
    const run = (async () => {
      for await (const msg of job) {
        if (signal?.aborted) throw new Error('Cancelled');
        if (msg.type === 'status') {
          if (msg.stage === 'error') throw new Error(typeof msg.message === 'string' && msg.message ? msg.message : `${provider.name} failed`);
          onStatus?.({ provider: provider.name, stage: msg.stage, position: msg.position, eta: msg.eta, progress: msg.progress_data?.[0] ?? null });
        } else if (msg.type === 'data') {
          const url = findImageUrl(msg.data);
          if (url) return url;
        }
      }
      throw new Error(`${provider.name} returned no picture`);
    })();
    const url = await withTimeout(run, timeoutMs, provider.name);
    return { url, provider };
  } finally {
    try {
      client.close?.();
    } catch {
      // already closed
    }
  }
}

/**
 * @param {object} o
 * @param {Blob} o.person          the photo
 * @param {Blob} o.garment         the garment on a white background
 * @param {'top'|'bottom'|'dress'} o.kind
 * @param {string} [o.description] the garment's name
 * @param {string} [o.only]        a provider id to use alone
 * @param {string} [o.token]       a Hugging Face token (more free GPU time)
 * @param {(s: object) => void} [o.onStatus]  queue / progress updates
 * @param {Function} [o.connect]   Client.connect (replaced in tests)
 * @param {number} [o.timeoutMs]   per provider
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{url: string, provider: object, attempts: object[]}>}
 */
export async function runAiTryOn({ person, garment, kind, description = '', only = null, token = null, onStatus, connect = (s, opt) => Client.connect(s, opt), timeoutMs = 240000, signal }) {
  const providers = providersFor(kind, only);
  if (!providers.length) throw new AiTryOnError('No AI try-on model handles this kind of garment.');
  const attempts = [];
  for (const provider of providers) {
    if (signal?.aborted) break;
    onStatus?.({ provider: provider.name, stage: 'connecting' });
    try {
      const res = await runProvider(provider, { person, garment, kind, description, token, onStatus, connect, timeoutMs, signal });
      return { ...res, attempts };
    } catch (err) {
      attempts.push({ provider: provider.name, error: String(err?.message || err) });
    }
  }
  // A browser that can't reach the models at all (blocked network, a
  // browser privacy setting) fails the same way for each: worth relaying.
  const network = attempts.length > 0 && attempts.every((a) => /fetch|network|cors|load failed|connect/i.test(a.error));
  throw new AiTryOnError(signal?.aborted ? 'Cancelled.' : 'The free AI try-on models are busy or unavailable right now.', { attempts, network });
}

/**
 * The same through the app's own server (server/aiTryOn.mjs), for when the
 * browser can't reach the models.
 * @returns {Promise<{url: string, provider: {name: string}}>}
 */
export async function relayAiTryOn({ person, garment, kind, description = '', only = null, endpoint = 'api/ai-tryon', signal }) {
  const form = new FormData();
  form.append('person', person, 'person.jpg');
  form.append('garment', garment, 'garment.png');
  form.append('kind', kind);
  form.append('description', description);
  if (only) form.append('only', only);
  const res = await fetch(new URL(endpoint, document.baseURI), { method: 'POST', body: form, signal });
  if (!res.ok) {
    let msg = `The server could not run the AI try-on (${res.status}).`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      // not JSON
    }
    throw new AiTryOnError(msg);
  }
  const blob = await res.blob();
  return { url: URL.createObjectURL(blob), provider: { name: res.headers.get('x-ai-provider') || 'AI model' } };
}
