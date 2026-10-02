// A stand-in for a Hugging Face try-on Space, for tests and offline demos
// (studio.html?ai=mock). It describes its API the way Gradio does (a
// Leffa-like endpoint), queues briefly, reports progress and answers with
// the person photo with the garment pasted on and a "MOCK" label: it
// exercises everything around the model, not the model.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const MOCK_API = Object.freeze({
  named_endpoints: {
    '/leffa_predict_vt': {
      parameters: [
        { label: 'Person Image', parameter_name: 'src_image_path', component: 'Image', type: 'Blob | File | Buffer' },
        { label: 'Garment Image', parameter_name: 'ref_image_path', component: 'Image', type: 'Blob | File | Buffer' },
        { label: 'Accelerate Reference UNet', parameter_name: 'ref_acceleration', component: 'Checkbox', type: 'boolean', parameter_has_default: true, parameter_default: false },
        { label: 'Inference Steps', parameter_name: 'step', component: 'Slider', type: 'number', parameter_has_default: true, parameter_default: 50 },
        { label: 'Guidance Scale', parameter_name: 'scale', component: 'Slider', type: 'number', parameter_has_default: true, parameter_default: 2.5 },
        { label: 'Random Seed', parameter_name: 'seed', component: 'Number', type: 'number', parameter_has_default: true, parameter_default: 42 },
        { label: 'Model Type', parameter_name: 'vt_model_type', component: 'Radio', type: '"viton_hd" | "dress_code"', parameter_has_default: true, parameter_default: 'viton_hd' },
        { label: 'Garment Type', parameter_name: 'vt_garment_type', component: 'Radio', type: '"upper_body" | "lower_body" | "dresses"', parameter_has_default: true, parameter_default: 'upper_body' },
        { label: 'Repaint Mode', parameter_name: 'vt_repaint', component: 'Checkbox', type: 'boolean', parameter_has_default: true, parameter_default: false },
      ],
      returns: [
        { label: 'Generated Image', component: 'Image' },
        { label: 'Generated Mask', component: 'Image' },
      ],
    },
  },
  unnamed_endpoints: {},
});

async function composite(person, garment, kind) {
  const [p, g] = await Promise.all([createImageBitmap(person), createImageBitmap(garment)]);
  const c = document.createElement('canvas');
  c.width = p.width;
  c.height = p.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(p, 0, 0);
  const w = c.width * 0.42;
  const h = (g.height / g.width) * w;
  const y = kind === 'bottom' ? c.height * 0.5 : c.height * 0.22;
  ctx.globalAlpha = 0.85;
  ctx.drawImage(g, (c.width - w) / 2, y, w, h);
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(8, 8, 96, 30);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 18px sans-serif';
  ctx.fillText('MOCK', 18, 30);
  return c.toDataURL('image/png');
}

/**
 * Client.connect stand-in.
 * @param {{delayMs?: number, fail?: string[]}} [o] fail: spaces that error
 */
export function mockConnect({ delayMs = 250, fail = [] } = {}) {
  return async (space) => {
    if (fail.includes(space)) throw new Error(`Could not connect to ${space}`);
    return {
      view_api: async () => MOCK_API,
      submit(endpoint, data) {
        return (async function* events() {
          yield { type: 'status', stage: 'pending', position: 1, eta: 3, endpoint };
          await sleep(delayMs);
          yield { type: 'status', stage: 'pending', position: 0, eta: 2, endpoint };
          await sleep(delayMs);
          for (const progress of [0.3, 0.7]) {
            yield { type: 'status', stage: 'generating', progress_data: [{ progress, index: null, length: null, unit: null, desc: null }], endpoint };
            await sleep(delayMs);
          }
          const kind = data[7] === 'lower_body' ? 'bottom' : 'top';
          yield { type: 'data', data: [{ url: await composite(data[0], data[1], kind) }, null], endpoint };
        })();
      },
      close() {},
    };
  };
}
