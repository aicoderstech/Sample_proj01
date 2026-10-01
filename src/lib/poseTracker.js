// Body tracking. The real tracker runs MediaPipe Pose Landmarker fully in the
// browser (WebAssembly + GPU/CPU); nothing leaves the device. Each detection
// returns the 33 pose landmarks and a person segmentation mask (the body's
// outline), which the fit engine measures. The mock tracker (landing demo,
// `?pose=mock` in tests) returns a synthetic person with a known outline.
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { mockBodyFrame, normalizedLandmarks } from '../core/mockBody.js';

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

/** Copies the first pose and its mask out of a MediaPipe result, then frees it. */
function readResult(result) {
  try {
    const landmarks = result.landmarks[0] || null;
    let mask = null;
    const m = result.segmentationMasks?.[0];
    if (landmarks && m) mask = { data: Float32Array.from(m.getAsFloat32Array()), width: m.width, height: m.height };
    return landmarks ? { landmarks, mask } : null;
  } finally {
    result.close?.();
  }
}

/**
 * @param {{delegate?: 'GPU'|'CPU', model?: 'lite'|'full'}} options  omit delegate to pick automatically
 * @returns {Promise<{backend:string, model:string, detectImage(src):Promise<object|null>, prepareVideo():Promise<void>, detectVideo(src, ts:number):object|null, close():void}>}
 *   detections are { landmarks, mask } (mask: { data, width, height }) or null
 */
export async function createPoseTracker({ delegate, model = 'lite' } = {}) {
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
          numPoses: 1,
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

  return {
    backend,
    model,
    async detectImage(source) {
      await setMode('IMAGE');
      return readResult(landmarker.detect(source));
    },
    async prepareVideo() {
      await setMode('VIDEO');
    },
    detectVideo(source, ts) {
      if (mode !== 'VIDEO') return null;
      const t = Math.max(Math.round(ts), lastTs + 1);
      lastTs = t;
      return readResult(landmarker.detectForVideo(source, t));
    },
    close() {
      landmarker.close();
    },
  };
}

export function createMockTracker() {
  const size = (src) => ({
    width: src.videoWidth || src.naturalWidth || src.width || 640,
    height: src.videoHeight || src.naturalHeight || src.height || 480,
  });
  const detect = (src, t, motion) => {
    const body = mockBodyFrame(t, { ...size(src), motion });
    return { landmarks: normalizedLandmarks(body), mask: body.mask };
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
