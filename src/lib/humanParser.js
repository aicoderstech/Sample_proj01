// Human parsing: labels every pixel of a photo or video frame as hair, body
// skin, face skin, clothes, accessories or background (MediaPipe's
// selfie_multiclass_256x256 model, on-device). The fit engine uses it to tell
// the wearer's clothes from their body (bulky clothes, bare arms) and to
// find the skin tone.
import { ImageSegmenter } from '@mediapipe/tasks-vision';
import { alignedInput, hasSoftwareWebGL } from './poseTracker.js';

export const LABEL = { BACKGROUND: 0, HAIR: 1, BODY_SKIN: 2, FACE_SKIN: 3, CLOTHES: 4, OTHER: 5 };

const MODEL = {
  local: 'models/selfie_multiclass_256x256.tflite',
  remote: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
};

const assetUrl = (path) => new URL(path, document.baseURI).href;

/**
 * @returns {Promise<{parse(source): {labels: Uint8Array, width: number, height: number}|null, parseVideo(source, ts:number): object|null, close(): void}>}
 *   labels are LABEL values, one per image pixel (width x height of the source)
 */
export async function createHumanParser({ delegate } = {}) {
  const fileset = {
    wasmLoaderPath: assetUrl('mediapipe/wasm/vision_wasm_internal.js'),
    wasmBinaryPath: assetUrl('mediapipe/wasm/vision_wasm_internal.wasm'),
  };
  const delegates = delegate ? [delegate] : hasSoftwareWebGL() ? ['CPU', 'GPU'] : ['GPU', 'CPU'];
  let segmenter = null;
  let lastError = null;
  outer: for (const modelAssetPath of [assetUrl(MODEL.local), MODEL.remote]) {
    for (const d of delegates) {
      try {
        segmenter = await ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetPath, delegate: d },
          runningMode: 'IMAGE',
          outputCategoryMask: true,
          outputConfidenceMasks: false,
        });
        break outer;
      } catch (err) {
        lastError = err;
      }
    }
  }
  if (!segmenter) throw lastError || new Error('Human parsing failed to load');

  const scratch = document.createElement('canvas');
  let mode = 'IMAGE';
  let lastTs = 0;
  const read = (result, width, height) => {
    try {
      const m = result.categoryMask;
      if (!m) return null;
      const src = m.getAsUint8Array();
      const labels = new Uint8Array(width * height);
      // Nearest-neighbour back to the source size (the input may have been padded).
      for (let y = 0; y < height; y++) {
        const row = Math.min(m.height - 1, Math.floor(((y + 0.5) * m.height) / height)) * m.width;
        for (let x = 0; x < width; x++) labels[y * width + x] = src[row + Math.min(m.width - 1, Math.floor(((x + 0.5) * m.width) / width))];
      }
      return { labels, width, height };
    } finally {
      result.close?.();
    }
  };
  return {
    async parse(source) {
      if (mode !== 'IMAGE') {
        await segmenter.setOptions({ runningMode: 'IMAGE' });
        mode = 'IMAGE';
      }
      const { input, width, height } = alignedInput(source, scratch);
      return read(segmenter.segment(input), width, height);
    },
    async prepareVideo() {
      if (mode !== 'VIDEO') {
        await segmenter.setOptions({ runningMode: 'VIDEO' });
        mode = 'VIDEO';
      }
    },
    parseVideo(source, ts) {
      if (mode !== 'VIDEO') return null;
      const t = Math.max(Math.round(ts), lastTs + 1);
      lastTs = t;
      const { input, width, height } = alignedInput(source, scratch);
      return read(segmenter.segmentForVideo(input, t), width, height);
    },
    close() {
      segmenter.close();
    },
  };
}
