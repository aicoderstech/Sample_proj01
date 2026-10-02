// AI try-on: filling in each model's inputs from its API description, trying
// models in turn, and the server relay.
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { choicesOf, findImageUrl, kindChoice, pickEndpoint, planInputs } from '../../src/core/aiTryOnPlan.js';
import { AiTryOnError, providersFor, runAiTryOn } from '../../src/lib/aiTryOn.js';
import { MOCK_API } from '../../src/lib/aiTryOnMock.js';
import { createAiTryOnHandler } from '../../server/aiTryOn.mjs';

// API descriptions shaped like the real Spaces' (Gradio view_api output).
const CATVTON = {
  named_endpoints: {
    '/submit_function': {
      parameters: [
        { label: 'Person Image', parameter_name: 'person_image', component: 'Imageeditor', type: 'Record<string, any>' },
        { label: 'Condition Image', parameter_name: 'cloth_image', component: 'Image', type: 'Blob | File | Buffer' },
        { label: 'Try-On Cloth Type', parameter_name: 'cloth_type', component: 'Radio', type: '"upper" | "lower" | "overall"', parameter_has_default: true, parameter_default: 'upper' },
        { label: 'Steps', parameter_name: 'num_inference_steps', component: 'Slider', type: 'number', parameter_has_default: true, parameter_default: 50 },
        { label: 'CFG Strenth', parameter_name: 'guidance_scale', component: 'Slider', type: 'number', parameter_has_default: true, parameter_default: 2.5 },
        { label: 'Seed', parameter_name: 'seed', component: 'Slider', type: 'number', parameter_has_default: true, parameter_default: 42 },
        { label: 'Show Type', parameter_name: 'show_type', component: 'Radio', type: '"result only" | "input & result" | "input & mask & result"', parameter_has_default: true, parameter_default: 'input & mask & result' },
      ],
      returns: [{ label: 'Result', component: 'Image' }],
    },
    '/person_example_fn': { parameters: [{ label: 'image_path', component: 'Textbox', type: 'string' }], returns: [] },
  },
  unnamed_endpoints: {},
};
const IDM = {
  named_endpoints: {
    '/tryon': {
      parameters: [
        { label: 'Human. Mask with pen or use auto-masking', parameter_name: 'dict', component: 'Imageeditor', type: 'Record<string, any>' },
        { label: 'Garment', parameter_name: 'garm_img', component: 'Image', type: 'Blob | File | Buffer' },
        { label: 'Description of garment ex) Short Sleeve Round Neck T-shirts', parameter_name: 'garment_des', component: 'Textbox', type: 'string' },
        { label: 'Yes', parameter_name: 'is_checked', component: 'Checkbox', type: 'boolean', parameter_has_default: true, parameter_default: true },
        { label: 'Yes', parameter_name: 'is_checked_crop', component: 'Checkbox', type: 'boolean', parameter_has_default: true, parameter_default: false },
        { label: 'Denoising Steps', parameter_name: 'denoise_steps', component: 'Number', type: 'number', parameter_has_default: true, parameter_default: 30 },
        { label: 'Seed', parameter_name: 'seed', component: 'Number', type: 'number', parameter_has_default: true, parameter_default: 42 },
      ],
      returns: [{ label: 'Output', component: 'Image' }, { label: 'Masked image output', component: 'Image' }],
    },
  },
  unnamed_endpoints: {},
};
const KOLORS = {
  named_endpoints: {
    '/tryon': {
      parameters: [
        { label: 'Person image', parameter_name: 'person_img', component: 'Image', type: 'Blob | File | Buffer' },
        { label: 'Garment image', parameter_name: 'garment_img', component: 'Image', type: 'Blob | File | Buffer' },
        { label: 'Seed', parameter_name: 'seed', component: 'Slider', type: 'number', parameter_has_default: true, parameter_default: 0 },
        { label: 'Random seed', parameter_name: 'randomize_seed', component: 'Checkbox', type: 'boolean', parameter_has_default: true, parameter_default: true },
      ],
      returns: [{ label: 'Result', component: 'Image' }, { label: 'Seed', component: 'Number' }, { label: 'Response', component: 'Textbox' }],
    },
  },
  unnamed_endpoints: {},
};

const values = (plan) => plan.map((p) => (p.role === 'value' ? p.value : `<${p.role}${p.editor ? ':editor' : ''}>`));

describe('filling in a try-on model’s inputs', () => {
  it('reads choices from TypeScript and Python types', () => {
    expect(choicesOf({ type: '"upper" | "lower" | "overall"' })).toEqual(['upper', 'lower', 'overall']);
    expect(choicesOf({ type: 'string', python_type: { type: "Literal['upper_body', 'lower_body', 'dresses']" } })).toEqual(['upper_body', 'lower_body', 'dresses']);
    expect(kindChoice(['upper_body', 'lower_body', 'dresses'], 'bottom')).toBe('lower_body');
    expect(kindChoice(['upper', 'lower', 'overall'], 'dress')).toBe('overall');
  });

  it('Leffa: person and garment pictures, garment type and the matching model variant', () => {
    const ep = MOCK_API.named_endpoints['/leffa_predict_vt'];
    expect(values(planInputs(ep, { kind: 'top' }))).toEqual(['<person>', '<garment>', false, 30, 2.5, 42, 'viton_hd', 'upper_body', false]);
    const bottom = values(planInputs(ep, { kind: 'bottom' }));
    expect(bottom[6]).toBe('dress_code');
    expect(bottom[7]).toBe('lower_body');
    expect(values(planInputs(ep, { kind: 'dress' }))[7]).toBe('dresses');
  });

  it('CatVTON: the person is an image editor, the garment unlabelled; only the result is shown', () => {
    expect(pickEndpoint(CATVTON, ['/submit_function'])).toBe('/submit_function');
    expect(pickEndpoint(CATVTON, ['/renamed'])).toBe('/submit_function'); // found by its two pictures
    const v = values(planInputs(CATVTON.named_endpoints['/submit_function'], { kind: 'bottom' }));
    expect(v).toEqual(['<person:editor>', '<garment>', 'lower', 30, 2.5, 42, 'result only']);
  });

  it('IDM-VTON: description, automatic mask and crop on', () => {
    const v = values(planInputs(IDM.named_endpoints['/tryon'], { kind: 'top', description: 'Coral Crew Tee' }));
    expect(v).toEqual(['<person:editor>', '<garment>', 'Coral Crew Tee', true, true, 30, 42]);
  });

  it('Kolors: a fixed seed, not a random one', () => {
    expect(values(planInputs(KOLORS.named_endpoints['/tryon'], { kind: 'top' }))).toEqual(['<person>', '<garment>', 42, false]);
  });

  it('refuses an endpoint without two pictures', () => {
    expect(() => planInputs({ parameters: [{ label: 'x', component: 'Image' }] }, {})).toThrow(/person photo/);
    expect(pickEndpoint({ named_endpoints: { '/a': { parameters: [] } } })).toBeNull();
  });

  it('finds the generated picture in a result', () => {
    expect(findImageUrl([{ url: 'https://x.hf.space/file=a.png', path: 'a.png' }, null])).toBe('https://x.hf.space/file=a.png');
    expect(findImageUrl([[{ image: { url: 'https://g/1.webp' } }]])).toBe('https://g/1.webp');
    expect(findImageUrl(['data:image/png;base64,AAA'])).toBe('data:image/png;base64,AAA');
    expect(findImageUrl([42, 'hello'])).toBeNull();
  });
});

/** A connect() stand-in: each space answers (url), errors, or never connects. */
function fakeConnect(behaviour) {
  const calls = [];
  const connect = async (space) => {
    calls.push(space);
    const b = behaviour[space] ?? 'down';
    if (b === 'down') throw new TypeError('Failed to fetch');
    return {
      view_api: async () => MOCK_API,
      submit: () =>
        (async function* events() {
          yield { type: 'status', stage: 'pending', position: 0 };
          if (b === 'error') yield { type: 'status', stage: 'error', message: 'GPU quota exceeded' };
          yield { type: 'data', data: [{ url: b }] };
        })(),
      close() {},
    };
  };
  return { connect, calls };
}

describe('trying the models in turn', () => {
  it('uses the first model that answers', async () => {
    const { connect, calls } = fakeConnect({ 'franciszzj/Leffa': 'error', 'zhengchong/CatVTON': 'https://x/result.png' });
    const statuses = [];
    const res = await runAiTryOn({ person: new Blob(['p']), garment: new Blob(['g']), kind: 'top', connect, onStatus: (s) => statuses.push(s.stage) });
    expect(res.url).toBe('https://x/result.png');
    expect(res.provider.id).toBe('catvton');
    expect(res.attempts).toEqual([{ provider: 'Leffa', error: 'GPU quota exceeded' }]);
    expect(calls).toEqual(['franciszzj/Leffa', 'zhengchong/CatVTON']);
    expect(statuses).toContain('pending');
  });

  it('only offers models that handle the garment', () => {
    expect(providersFor('bottom').map((p) => p.id)).toEqual(['leffa', 'catvton']);
    expect(providersFor('top', 'idm-vton').map((p) => p.id)).toEqual(['idm-vton']);
  });

  it('says when none can be reached (so the server relay can try)', async () => {
    const { connect } = fakeConnect({});
    const err = await runAiTryOn({ person: new Blob(['p']), garment: new Blob(['g']), kind: 'dress', connect }).catch((e) => e);
    expect(err).toBeInstanceOf(AiTryOnError);
    expect(err.network).toBe(true);
    expect(err.attempts).toHaveLength(3); // Leffa, CatVTON and Kolors handle dresses
  });
});

describe('server relay', () => {
  let server;
  let base;
  const runs = [];
  beforeAll(async () => {
    const handler = createAiTryOnHandler({
      perHour: 2,
      run: async (job) => {
        runs.push(job);
        if (job.description === 'fail') throw new AiTryOnError('The free AI try-on models are busy or unavailable right now.', { attempts: [{ provider: 'Leffa', error: 'busy' }] });
        return { url: 'https://example/result.png', provider: { name: 'Leffa' } };
      },
      fetchImage: async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }),
    });
    server = http.createServer((req, res) => handler(req, res));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/api/ai-tryon`;
  });
  afterAll(() => server.close());

  const form = (description = 'Coral Crew Tee', type = 'image/jpeg') => {
    const f = new FormData();
    f.append('person', new Blob(['person'], { type }), 'person.jpg');
    f.append('garment', new Blob(['garment'], { type: 'image/png' }), 'garment.png');
    f.append('kind', 'top');
    f.append('description', description);
    return f;
  };

  it('relays a try-on and returns the picture', async () => {
    const res = await fetch(base, { method: 'POST', body: form() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-ai-provider')).toBe('Leffa');
    expect(runs[0]).toMatchObject({ kind: 'top', description: 'Coral Crew Tee' });
    expect(runs[0].person.type).toBe('image/jpeg');
  });

  it('rejects wrong methods and uploads, explains failures, and limits each client', async () => {
    expect((await fetch(base)).status).toBe(405);
    const bad = await fetch(base, { method: 'POST', body: form('x', 'text/plain') });
    expect(bad.status).toBe(400);
    const failed = await fetch(base, { method: 'POST', body: form('fail') });
    expect(failed.status).toBe(502);
    expect((await failed.json()).error).toMatch(/busy or unavailable/);
    // Two allowed per hour in this test (one success, one failure so far).
    expect((await fetch(base, { method: 'POST', body: form() })).status).toBe(429);
  });
});
