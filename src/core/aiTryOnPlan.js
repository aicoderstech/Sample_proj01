// Filling in a generative try-on model's inputs from its own API description.
//
// Free virtual try-on models (Leffa, CatVTON, IDM-VTON, Kolors and others)
// run as Gradio apps on Hugging Face Spaces. Each takes a photo of the
// person and a picture of the garment, plus model-specific settings, and
// their exact inputs change between versions. Rather than hard-coding them,
// the app reads the endpoint's description (Gradio's view_api: label,
// component and type of every parameter) and decides each value here:
//  - images: which is the person and which the garment, from their labels
//    (or their order: person first);
//  - a choice of garment kind (upper / lower / dresses, in each model's own
//    words), of model (VITON-HD for tops, DressCode otherwise) or of what to
//    show (the result alone);
//  - a description text box: the garment's name;
//  - seed fixed (repeatable), step counts capped (faster), automatic masking
//    and cropping on, randomising off; everything else at its default.

const PERSON = /person|human|model|people|src|source|user|body|subject|target|you\b|your/i;
const GARMENT = /garment|cloth|ref|reference|outfit|apparel|dress|top|shirt|item|product/i;

const KIND_WORDS = {
  top: ['upper_body', 'upper body', 'upper', 'tops', 'top', 'upper_cloth', 'shirt'],
  bottom: ['lower_body', 'lower body', 'lower', 'bottoms', 'bottom', 'pants', 'trousers', 'lower_cloth'],
  dress: ['dresses', 'dress', 'overall', 'full_body', 'full body', 'full', 'one-pieces', 'one-piece', 'whole'],
};

/** The component name, lower case ("image", "imageeditor", "dropdown"...). */
const componentOf = (p) => String(p.component || '').toLowerCase();
const textOf = (p) => `${p.label || ''} ${p.parameter_name || ''}`;

/** An input that takes a picture. */
export function isImageParam(p) {
  const c = componentOf(p);
  return c === 'image' || c === 'imageeditor' || c === 'sketchpad' || c === 'imageslider' || (c === 'file' && /image|photo|img/i.test(textOf(p)));
}

/**
 * The fixed choices a parameter allows, from its TypeScript type
 * ('"upper" | "lower"') or Python type ("Literal['upper', 'lower']").
 */
export function choicesOf(p) {
  const out = [];
  const add = (s) => {
    for (const m of String(s || '').matchAll(/["']([^"']+)["']/g)) if (!out.includes(m[1])) out.push(m[1]);
  };
  if (Array.isArray(p.choices)) for (const c of p.choices) out.push(Array.isArray(c) ? String(c[1] ?? c[0]) : String(c));
  if (!out.length) add(typeof p.type === 'string' ? p.type : p.type?.type);
  if (!out.length && /Literal\[/.test(p.python_type?.type || '')) add(p.python_type.type);
  return out;
}

/** The choice that names this kind of garment, or null. */
export function kindChoice(choices, kind) {
  const words = KIND_WORDS[kind] ?? KIND_WORDS.top;
  for (const w of words) {
    const hit = choices.find((c) => c.toLowerCase() === w);
    if (hit) return hit;
  }
  for (const w of words) {
    const hit = choices.find((c) => c.toLowerCase().replace(/[_-]/g, ' ').includes(w.replace(/_/g, ' ')));
    if (hit) return hit;
  }
  return null;
}

/**
 * The endpoint to call: the preferred one when the app has it, else the
 * first that takes at least two pictures (person and garment).
 */
export function pickEndpoint(apiInfo, preferred = []) {
  const named = apiInfo?.named_endpoints ?? {};
  for (const name of preferred) if (named[name]) return name;
  const usable = Object.entries(named).filter(([, info]) => (info.parameters ?? []).filter(isImageParam).length >= 2);
  // Prefer names that sound like try-on.
  usable.sort(([a], [b]) => Number(/try|vt|submit|predict|run|generate/i.test(b)) - Number(/try|vt|submit|predict|run|generate/i.test(a)));
  return usable[0]?.[0] ?? null;
}

/**
 * How to fill each parameter.
 * @param {{parameters: object[]}} endpoint  view_api() endpoint description
 * @param {{kind: 'top'|'bottom'|'dress', description?: string, seed?: number, maxSteps?: number}} o
 * @returns {Array<{role: 'person'|'garment', editor?: boolean} | {role: 'value', value: any}>}
 *   one entry per parameter, in order; 'person' / 'garment' are pictures
 *   (editor: the app takes an image editor's {background, layers} value)
 */
export function planInputs(endpoint, { kind = 'top', description = '', seed = 42, maxSteps = 30 } = {}) {
  const params = endpoint?.parameters ?? [];
  const images = params.filter(isImageParam);
  if (images.length < 2) throw new Error('This model does not take a person photo and a garment picture.');
  // Which picture is which: by label, else the first is the person.
  let personParam = images.find((p) => PERSON.test(textOf(p)) && !GARMENT.test(textOf(p)));
  let garmentParam = images.find((p) => p !== personParam && GARMENT.test(textOf(p)));
  if (!personParam) personParam = images.find((p) => p !== garmentParam);
  if (!garmentParam) garmentParam = images.find((p) => p !== personParam);
  return params.map((p) => {
    const c = componentOf(p);
    const t = textOf(p);
    const fallback = { role: 'value', value: p.parameter_has_default ? p.parameter_default : null };
    if (p === personParam) return { role: 'person', editor: c === 'imageeditor' || c === 'sketchpad' };
    if (p === garmentParam) return { role: 'garment', editor: c === 'imageeditor' || c === 'sketchpad' };
    if (isImageParam(p)) return { role: 'value', value: null }; // an optional extra picture (a mask)
    const choices = choicesOf(p);
    if (choices.length) {
      const k = kindChoice(choices, kind);
      if (k) return { role: 'value', value: k };
      // Model variants: VITON-HD is trained on tops, DressCode on all three.
      const viton = choices.find((x) => /viton/i.test(x));
      const dressCode = choices.find((x) => /dress.?code/i.test(x));
      if (viton || dressCode) return { role: 'value', value: (kind === 'top' ? viton : dressCode) ?? viton ?? dressCode };
      // What to show: the result alone.
      const only = choices.find((x) => /result/i.test(x) && !/input|mask|&|\+/i.test(x));
      if (only) return { role: 'value', value: only };
      return p.parameter_has_default ? fallback : { role: 'value', value: choices[0] };
    }
    if (c === 'checkbox') {
      if (/random/i.test(t)) return { role: 'value', value: false };
      if (/auto|mask|crop|resiz/i.test(t)) return { role: 'value', value: true };
      if (/repaint|accelerat|ref.?accel/i.test(t)) return { role: 'value', value: false };
      return p.parameter_has_default ? fallback : { role: 'value', value: false };
    }
    if (c === 'number' || c === 'slider') {
      if (/seed/i.test(t)) return { role: 'value', value: seed };
      if (/step/i.test(t)) {
        const d = Number(p.parameter_default);
        return { role: 'value', value: Number.isFinite(d) && d > 0 ? Math.min(d, maxSteps) : maxSteps };
      }
      return p.parameter_has_default ? fallback : { role: 'value', value: 0 };
    }
    if (c === 'textbox' || c === 'text') {
      if (/desc|prompt|caption|text|garment/i.test(t)) return { role: 'value', value: description || (p.parameter_has_default ? p.parameter_default : '') };
      return fallback;
    }
    return fallback;
  });
}

/**
 * The generated picture in a result: the first image-like value (a file
 * reference with a URL, a URL string, or an {image} wrapper).
 * @returns {string|null} its URL
 */
export function findImageUrl(data) {
  const seen = new Set();
  const visit = (v) => {
    if (v == null || seen.has(v)) return null;
    if (typeof v === 'string') return /^(https?:|data:image|blob:)/.test(v) ? v : null;
    if (typeof v !== 'object') return null;
    seen.add(v);
    if (typeof v.url === 'string' && v.url) return v.url;
    if (Array.isArray(v)) {
      for (const x of v) {
        const u = visit(x);
        if (u) return u;
      }
      return null;
    }
    for (const k of ['image', 'value', 'composite', 'background', 'path']) {
      const u = visit(v[k]);
      if (u) return u;
    }
    return null;
  };
  return visit(data);
}
