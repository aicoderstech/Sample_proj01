// Body tracking. The real tracker runs MediaPipe Pose Landmarker fully in the
// browser (WebAssembly + GPU/CPU); nothing leaves the device. The mock tracker
// is used by the landing page demo and by automated tests (`?pose=mock`).
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { mockPose } from '../core/mockPose.js';

const REMOTE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';

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

/**
 * @param {{delegate?: 'GPU'|'CPU'}} options  omit delegate to pick automatically
 * @returns {Promise<{backend:string, detectImage(src):Promise<object[]|null>, detectVideo(src, ts:number):object[]|null, close():void}>}
 */
export async function createPoseTracker({ delegate } = {}) {
  const fileset = {
    wasmLoaderPath: assetUrl('mediapipe/wasm/vision_wasm_internal.js'),
    wasmBinaryPath: assetUrl('mediapipe/wasm/vision_wasm_internal.wasm'),
  };
  // Sanity check that the SIMD build can run here; all current browsers support it.
  if (!(await FilesetResolver.isSimdSupported())) {
    throw new Error('This browser does not support WebAssembly SIMD, which body tracking needs.');
  }

  const delegates = delegate ? [delegate] : hasSoftwareWebGL() ? ['CPU', 'GPU'] : ['GPU', 'CPU'];
  const models = [assetUrl('models/pose_landmarker_lite.task'), REMOTE_MODEL];
  let landmarker = null;
  let backend = null;
  let lastError = null;
  outer: for (const modelAssetPath of models) {
    for (const d of delegates) {
      try {
        landmarker = await PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath, delegate: d },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
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
    async detectImage(source) {
      await setMode('IMAGE');
      return landmarker.detect(source).landmarks[0] || null;
    },
    async prepareVideo() {
      await setMode('VIDEO');
    },
    detectVideo(source, ts) {
      if (mode !== 'VIDEO') return null;
      const t = Math.max(Math.round(ts), lastTs + 1);
      lastTs = t;
      return landmarker.detectForVideo(source, t).landmarks[0] || null;
    },
    close() {
      landmarker.close();
    },
  };
}

export function createMockTracker() {
  const opts = (src) => {
    const w = src.videoWidth || src.naturalWidth || src.width || 4;
    const h = src.videoHeight || src.naturalHeight || src.height || 3;
    // Landscape camera frames show the upper body, like a laptop webcam.
    return w > h ? { aspect: w / h, zoom: 1.45, offsetY: 0.2 } : { aspect: w / h, zoom: 1, offsetY: 0.02 };
  };
  return {
    backend: 'mock',
    async detectImage(source) {
      return mockPose(0.6, { ...opts(source), motion: 0 });
    },
    async prepareVideo() {},
    detectVideo(source, ts) {
      return mockPose(ts / 1000, opts(source));
    },
    close() {},
  };
}
