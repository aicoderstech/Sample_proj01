// Body tracking. The real tracker runs MediaPipe Pose Landmarker fully in the
// browser (WebAssembly + GPU/CPU); nothing leaves the device. Each detection
// returns the 33 pose landmarks and a person segmentation mask (the body's
// outline), which the fit engine measures. The mock tracker (landing demo,
// `?pose=mock` in tests) returns a synthetic person with a known outline.
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { mockBodyFrame, normalizedLandmarks } from '../core/mockBody.js';
import { asIfFromFront } from '../core/orientation.js';

const MODELS = {
  lite: {
    local: 'models/pose_landmarker_lite.task',
    remote: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
  },
  full: {
    local: 'models/pose_landmarker_full.task',
    remote: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
  },
};

const assetUrl = (path) => new URL(path, document.baseURI).href;

/** True when WebGL is software-emulated (no real GPU): MediaPipe's CPU path is faster there. */
export function hasSoftwareWebGL() {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
  } catch {
    return true;
  }
}

export const sourceSize = (src) => ({
  width: src.videoWidth || src.naturalWidth || src.width,
  height: src.videoHeight || src.naturalHeight || src.height,
});

/**
 * MediaPipe's segmentation mask aborts the whole WebAssembly module
 * ("Check failed: 1 == ChannelSize()") when the image width isn't a multiple
 * of 4. Such images are copied, stretched by at most 3 pixels, onto a canvas
 * that is; landmarks are normalized, so they are unaffected.
 */
export function alignedInput(source, canvas) {
  const { width, height } = sourceSize(source);
  const w = Math.ceil(width / 4) * 4;
  const h = Math.ceil(height / 4) * 4;
  if (w === width && h === height) return { input: source, width, height };
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  canvas.getContext('2d').drawImage(source, 0, 0, w, h);
  return { input: canvas, width, height };
}

/** Nearest-neighbour resample of a mask to the original image size. */
function resampleMask(data, mw, mh, width, height) {
  if (mw === width && mh === height) return data;
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = Math.min(mh - 1, Math.floor(((y + 0.5) * mh) / height)) * mw;
    for (let x = 0; x < width; x++) out[y * width + x] = data[row + Math.min(mw - 1, Math.floor(((x + 0.5) * mw) / width))];
  }
  return out;
}

/** Torso size in pixels (shoulder width + shoulder-to-hip length): how prominent a person is. */
function torsoSize(lm, width, height) {
  const d = (a, b) => Math.hypot((lm[a].x - lm[b].x) * width, (lm[a].y - lm[b].y) * height);
  const mid = (a, b) => ({ x: (lm[a].x + lm[b].x) / 2, y: (lm[a].y + lm[b].y) / 2 });
  const s = mid(11, 12);
  const h = mid(23, 24);
  return d(11, 12) + Math.hypot((s.x - h.x) * width, (s.y - h.y) * height);
}

/**
 * Copies the most prominent pose (the largest torso; in a group photo, the
 * person in front) and its mask out of a MediaPipe result, then frees it.
 */
function readResult(result, width, height) {
  try {
    let best = 0;
    for (let i = 1; i < result.landmarks.length; i++) {
      if (torsoSize(result.landmarks[i], width, height) > torsoSize(result.landmarks[best], width, height)) best = i;
    }
    const landmarks = result.landmarks[best] || null;
    let mask = null;
    const m = result.segmentationMasks?.[best];
    if (landmarks && m) {
      const data = resampleMask(m.getAsFloat32Array(), m.width, m.height, width, height);
      mask = { data: Float32Array.from(data), width, height };
    }
    return landmarks ? { landmarks, mask } : null;
  } finally {
    result.close?.();
  }
}

/**
 * @param {{delegate?: 'GPU'|'CPU', model?: 'lite'|'full', maxPeople?: number}} options
 *   omit delegate to pick automatically; with maxPeople > 1 the most prominent person is returned
 * @returns {Promise<{backend:string, model:string, detectImage(src):Promise<object|null>, prepareVideo():Promise<void>, detectVideo(src, ts:number):object|null, close():void}>}
 *   detections are { landmarks, mask } (mask: { data, width, height }) or null
 */
export async function createPoseTracker({ delegate, model = 'lite', maxPeople = 1 } = {}) {
  const fileset = {
    wasmLoaderPath: assetUrl('mediapipe/wasm/vision_wasm_internal.js'),
    wasmBinaryPath: assetUrl('mediapipe/wasm/vision_wasm_internal.wasm'),
  };
  // Sanity check that the SIMD build can run here; all current browsers support it.
  if (!(await FilesetResolver.isSimdSupported())) {
    throw new Error('This browser does not support WebAssembly SIMD, which body tracking needs.');
  }

  const delegates = delegate ? [delegate] : hasSoftwareWebGL() ? ['CPU', 'GPU'] : ['GPU', 'CPU'];
  const paths = [assetUrl(MODELS[model].local), MODELS[model].remote];
  let landmarker = null;
  let backend = null;
  let lastError = null;
  outer: for (const modelAssetPath of paths) {
    for (const d of delegates) {
      try {
        landmarker = await PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath, delegate: d },
          runningMode: 'VIDEO',
          numPoses: maxPeople,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
          outputSegmentationMasks: true,
        });
        backend = d;
        break outer;
      } catch (err) {
        lastError = err;
      }
    }
  }
  if (!landmarker) throw lastError || new Error('Body tracking failed to load');

  let mode = 'VIDEO';
  let lastTs = 0;
  const setMode = async (m) => {
    if (mode !== m) {
      await landmarker.setOptions({ runningMode: m });
      mode = m;
    }
  };

  const scratch = document.createElement('canvas');
  const padded = document.createElement('canvas');
  const detectStill = (source) => {
    const { input, width, height } = alignedInput(source, scratch);
    return readResult(landmarker.detect(input), width, height);
  };
  return {
    backend,
    model,
    async detectImage(source) {
      await setMode('IMAGE');
      const found = detectStill(source);
      if (found) return found;
      // A head-and-shoulders photo that fills the frame is often missed by
      // the person detector: retry with a plain border round it, then map
      // the result back onto the original photo.
      const { width, height } = sourceSize(source);
      const ox = Math.round(width / 2);
      const oy = Math.round(height / 2);
      padded.width = width + 2 * ox;
      padded.height = height + 2 * oy;
      const ctx = padded.getContext('2d');
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, padded.width, padded.height);
      ctx.drawImage(source, ox, oy, width, height);
      const r = detectStill(padded);
      if (!r) return null;
      const landmarks = r.landmarks.map((p) => ({
        ...p,
        x: (p.x * padded.width - ox) / width,
        y: (p.y * padded.height - oy) / height,
      }));
      let mask = null;
      if (r.mask) {
        const data = new Float32Array(width * height);
        for (let y = 0; y < height; y++) data.set(r.mask.data.subarray((y + oy) * padded.width + ox, (y + oy) * padded.width + ox + width), y * width);
        mask = { data, width, height };
      }
      return { landmarks, mask };
    },
    async prepareVideo() {
      await setMode('VIDEO');
    },
    detectVideo(source, ts) {
      if (mode !== 'VIDEO') return null;
      const t = Math.max(Math.round(ts), lastTs + 1);
      lastTs = t;
      const { input, width, height } = alignedInput(source, scratch);
      return readResult(landmarker.detectForVideo(input, t), width, height);
    },
    close() {
      landmarker.close();
    },
  };
}

/**
 * @param {{back?: boolean}} options back: the synthetic person seen from
 *   behind (landmarks relabelled, face hidden)
 */
export function createMockTracker({ back = false } = {}) {
  const size = (src) => {
    const { width, height } = sourceSize(src);
    return { width: width || 640, height: height || 480 };
  };
  const detect = (src, t, motion) => {
    const body = mockBodyFrame(t, { ...size(src), motion });
    let landmarks = normalizedLandmarks(body);
    if (back) {
      // From behind the person's left is on the image's left, and the face is hidden.
      landmarks = asIfFromFront(landmarks).map((p, i) => (i <= 10 ? { ...p, visibility: 0.1 } : p));
    }
    return { landmarks, mask: body.mask };
  };
  return {
    backend: 'mock',
    model: 'mock',
    async detectImage(source) {
      return detect(source, 0.6, 0);
    },
    async prepareVideo() {},
    detectVideo(source, ts) {
      return detect(source, ts / 1000, 1);
    },
    close() {},
  };
}
