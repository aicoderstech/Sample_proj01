// WebGL textured-mesh renderer for garment layers: one draw call per garment
// part, no seams between triangles. TryOnRenderer falls back to the
// 2D-canvas mesh when WebGL is unavailable or the garment image is
// cross-origin (tainted).
import { dominantWinding } from './mesh.js';
import { NEUTRAL_LOOK } from './photoMatch.js';

const VERTEX = `
attribute vec2 aPos;
attribute vec2 aUv;
attribute vec4 aNrm;
attribute vec4 aFold;
attribute vec2 aTy;
uniform vec2 uRes;
varying vec2 vUv;
varying vec4 vNrm;
varying vec4 vFold;
varying vec2 vTy;
void main() {
  vec2 clip = (aPos / uRes) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vUv = aUv;
  vNrm = aNrm;
  vFold = aFold;
  vTy = aTy;
}`;

// Fabric shading. Each vertex carries the surface normal of the body under
// it (image-plane part; xy), the image directions of the garment's x axis
// (zw) and y axis (vTy), and a fold field: drape (x, spare fabric hanging
// in vertical folds), compression (y, folds across the compressed
// direction) and which garment axis is compressed (z).
//
// On top of that, folds that clothes make in a given pose (uKind says which
// apply, in garment pixel coordinates so they move with the fabric):
//  - drag folds fanning from the armpits of a top when the arms hang down;
//  - soft horizontal folds where a top's spare length gathers above the hem;
//  - folds across a bent elbow or knee (some even when straight);
//  - whiskers fanning out from the crotch of trousers;
//  - stacking: zigzag folds where a sleeve or trouser leg is longer than the
//    limb and bunches at the wrist or ankle.
// They form a height field whose slope tilts the normal; creases (low
// ground) also get less ambient light. The body's own roundness darkens the
// fabric where it turns away (ambient occlusion). The result is lit by the
// scene's light.
const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUv;
varying vec4 vNrm;
varying vec4 vFold;
varying vec2 vTy;
uniform sampler2D uTex;
uniform vec3 uLight;
uniform vec2 uTexSize;
uniform float uFoldWave;
uniform float uLit;
uniform float uKind;
uniform vec4 uAxis;
uniform vec4 uLimb;
uniform vec4 uPts;
uniform vec4 uAmt;
uniform vec2 uHem;

float hash1(float n) { return fract(sin(n) * 43758.5453); }
float noise1(float x) {
  float i = floor(x);
  float f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(hash1(i), hash1(i + 1.0), f) * 2.0 - 1.0;
}
// Fold profile: broad rounded ridges, narrower creases between them.
float fold(float p) { return cos(p) - 0.2 * cos(2.0 * p); }

// Drag folds from an armpit at A; sg = 1 when the body's centre is at +x.
float drag(vec2 g, vec2 A, float sg, float W) {
  vec2 d = g - A;
  d.x *= sg;
  float r = length(d);
  float th = atan(d.y, d.x);
  float sector = smoothstep(0.05, 0.4, th) * (1.0 - smoothstep(0.95, 1.3, th));
  float env = smoothstep(0.02 * W, 0.07 * W, r) * (1.0 - smoothstep(0.12 * W, 0.3 * W, r));
  float n = 6.2832 * 0.16 * W / uFoldWave;
  return fold(th * n + 0.9 * noise1(th * 3.0 + sg * 5.0)) * sector * env;
}
// Whiskers: fanning upwards and outwards from the crotch C.
float whiskers(vec2 g, vec2 C, float W) {
  vec2 d = g - C;
  float sg = d.x < 0.0 ? -1.0 : 1.0;
  d.x *= sg;
  float r = length(d);
  float th = atan(-d.y, d.x);
  float sector = smoothstep(-0.3, -0.05, th) * (1.0 - smoothstep(0.4, 0.75, th));
  float env = smoothstep(0.02 * W, 0.07 * W, r) * (1.0 - smoothstep(0.18 * W, 0.36 * W, r));
  float n = 6.2832 * 0.2 * W / (uFoldWave * 0.9);
  return fold(th * n + 1.1 * noise1(th * 4.0 + sg * 3.0)) * sector * env;
}
// Position along (x) and across (y) a limb.
vec2 limbCoords(vec2 g) {
  vec2 d = g - uAxis.xy;
  return vec2(dot(d, uAxis.zw), dot(d, vec2(-uAxis.w, uAxis.z)));
}
// Folds across the limb around its joint (elbow / knee).
float joint(vec2 q) {
  float env = exp(-pow((q.x - uLimb.x) / (0.08 * uLimb.y), 2.0)) * (0.6 + 0.4 * noise1(q.y / uFoldWave * 0.8 + 7.0));
  float p = q.x / (uFoldWave * 0.9) * 6.2832 + 1.4 * noise1(q.y / uFoldWave * 1.1) + 0.5 * q.y / uFoldWave;
  return fold(p) * env;
}
// Zigzag folds where the limb's end bunches up.
float stack(vec2 q) {
  float env = smoothstep(uLimb.y * 0.8, uLimb.y * 0.96, q.x) * (0.65 + 0.35 * noise1(q.y / uFoldWave + 2.0));
  float p = q.x / (uFoldWave * 0.75) * 6.2832 + 2.4 * noise1(q.y / uFoldWave * 1.2 + 3.0);
  return fold(p) * env;
}
// Spare length gathering above a top's hem.
float blouse(vec2 g) {
  float env = smoothstep(uHem.x - 0.3 * uHem.y, uHem.x - 0.14 * uHem.y, g.y) * (1.0 - smoothstep(uHem.x - 0.08 * uHem.y, uHem.x, g.y));
  // Few, long and uneven: they come and go across the body.
  env *= max(0.0, noise1(g.x / (uFoldWave * 2.2) + 11.0)) * 1.4;
  float p = g.y / (uFoldWave * 1.5) * 6.2832 + 2.2 * noise1(g.x / (uFoldWave * 2.4));
  return fold(p) * env;
}
float height(vec2 g) {
  float h = 0.0;
  if (uKind > 0.5 && uKind < 1.5) {
    float W = max(1.0, uPts.z - uPts.x);
    h += uAmt.x * drag(g, uPts.xy, 1.0, W) + uAmt.y * drag(g, uPts.zw, -1.0, W) + uAmt.w * blouse(g);
  } else if (uKind < 2.5) {
    vec2 q = limbCoords(g);
    h += (0.12 + 0.8 * uLimb.z) * joint(q) + uLimb.w * stack(q);
  } else if (uKind < 3.5) {
    h += uAmt.z * whiskers(g, uPts.xy, uPts.z);
  } else if (uKind < 4.5) {
    vec2 q = limbCoords(g);
    h += uAmt.z * whiskers(g, uPts.xy, uPts.z) + (0.2 + 0.9 * uLimb.z) * joint(q) + min(1.2, 0.15 + 1.2 * uLimb.w) * stack(q);
  }
  return h;
}
void main() {
  vec4 c = texture2D(uTex, vUv);
  if (uLit > 0.0 && c.a > 0.0) {
    vec2 g = vUv * uTexSize;
    vec2 tx = vNrm.zw;
    float tl = length(tx);
    tx = tl > 1e-4 ? tx / tl : vec2(1.0, 0.0);
    vec2 ty = vTy;
    float yl = length(ty);
    ty = yl > 1e-4 ? ty / yl : vec2(-tx.y, tx.x);
    vec2 n2 = vNrm.xy;
    float bodyZ = sqrt(max(0.0, 1.0 - dot(n2, n2)));
    // Drape: soft, irregular vertical folds; their depth varies along the
    // fabric, so folds come and go instead of repeating evenly.
    float ph = g.x / uFoldWave * 6.2832 + 1.3 * sin(g.y / (uFoldWave * 2.7)) + 0.9 * sin(g.x / (uFoldWave * 0.61) + 0.4);
    float depth = 0.55 + 0.45 * sin(g.x / (uFoldWave * 2.3) + 1.7) * sin(g.x / (uFoldWave * 3.9) + g.y / (uFoldWave * 6.0));
    n2 += tx * cos(ph) * 0.4 * vFold.x * depth;
    // Compression: tighter folds across the compressed axis.
    float axis = step(0.5, vFold.z);
    float along = mix(g.x, g.y, axis);
    float ph2 = along / (uFoldWave * 0.55) * 6.2832 + 0.9 * sin(mix(g.y, g.x, axis) / (uFoldWave * 1.6));
    float cdepth = 0.6 + 0.4 * sin(mix(g.y, g.x, axis) / (uFoldWave * 0.9) + 0.8);
    n2 += mix(tx, ty, axis) * cos(ph2) * 0.4 * vFold.y * cdepth;
    // Pose folds: slope of the height field (finite differences).
    float e = max(1.0, uFoldWave * 0.08);
    float h0 = height(g);
    vec2 slope = vec2(height(g + vec2(e, 0.0)) - h0, height(g + vec2(0.0, e)) - h0) * (uFoldWave * 0.16 / e);
    n2 -= tx * slope.x + ty * slope.y;
    float l2 = dot(n2, n2);
    if (l2 > 0.94) n2 *= sqrt(0.94 / l2);
    vec3 n = vec3(n2, sqrt(1.0 - dot(n2, n2)));
    float amb = 0.5 * (0.72 + 0.28 * bodyZ) * (1.0 - 0.15 * clamp(-h0, 0.0, 1.5));
    float s = (amb + 0.5 * max(dot(n, uLight), 0.0)) / (0.5 + 0.5 * uLight.z);
    c.rgb *= clamp(s, 0.45, 1.15);
  }
  gl_FragColor = c;
}`;

// Post-process for a garment layer, run on its way to the screen:
//  - fill: where the person's outline is a few pixels wider than the garment
//    (the wearer's own clothes peeking out), extend the garment to the
//    outline with the colour of the nearest garment pixel; only inside the
//    person mask and the garment's zone (never past the hem or into the
//    neckline).
//  - photo matching (core/photoMatch.js): the garment is softened a little
//    (a camera never renders an edge as crisply as a vector drawing) and
//    takes on the photo's black level, tint, exposure and saturation, and
//    its grain (noise), so it looks shot with the same camera.
// (Shading is done when the meshes are drawn: see FRAGMENT.)
const QUAD_VERTEX = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const POST_FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUv;
uniform sampler2D uGarment;
uniform sampler2D uPerson;
uniform sampler2D uZone;
uniform vec2 uTexel;
uniform float uFill;
uniform float uInset;
uniform float uSoft;
uniform float uLift;
uniform vec3 uGain;
uniform float uSat;
uniform float uGrain;
uniform float uSeed;
float hash2(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + uSeed) * 43758.5453); }
void main() {
  // Image coordinates run top-down; the framebuffer texture bottom-up.
  vec2 img = vec2(vUv.x, 1.0 - vUv.y);
  vec4 g = texture2D(uGarment, vUv);
  if (uSoft > 0.0) {
    vec2 o = uTexel * uSoft;
    g = g * 0.4 + 0.15 * (texture2D(uGarment, vUv + vec2(o.x, o.y)) + texture2D(uGarment, vUv + vec2(-o.x, o.y)) +
      texture2D(uGarment, vUv + vec2(o.x, -o.y)) + texture2D(uGarment, vUv + vec2(-o.x, -o.y)));
  }
  float person = texture2D(uPerson, img).a;
  if (uFill > 0.0 && g.a < 0.98 && person > 0.02 && texture2D(uZone, img).a > 0.5) {
    // Average colour of the nearest ring of fabric around this pixel (a
    // stripe continues, not a blur of the pattern), smooth rather than
    // streaked: each ring is turned a little so no rays line up.
    vec4 acc = vec4(0.0);
    float nearest = 7.0;
    for (int ring = 1; ring <= 6; ring++) {
      float r = uFill * float(ring) / 6.0;
      float w = 1.0;
      for (int k = 0; k < 40; k++) {
        float a = (float(k) + 0.37 * float(ring)) * 0.1570796;
        vec2 dir = vec2(cos(a), sin(a));
        vec4 t = texture2D(uGarment, vUv + dir * r * uTexel);
        if (t.a > 0.9) {
          // The fabric a little further in: edges often carry a seam line or
          // outline, which shouldn't be smeared outwards.
          vec4 inner = texture2D(uGarment, vUv + dir * (r + uInset) * uTexel);
          acc += inner.a > 0.9 ? vec4(inner.rgb / inner.a * w, w) : vec4(t.rgb / t.a * w, w);
          nearest = min(nearest, float(ring));
        }
      }
      // The nearest ring with fabric decides: no need to look further out.
      if (acc.a > 0.0) break;
    }
    if (acc.a > 0.0) {
      // Soft at the wearer's outline, like the photo's own edges, and fading
      // out towards the fill's reach (so its limit draws no hard line).
      float cover = smoothstep(0.02, 0.6, person) * (1.0 - smoothstep(3.5, 6.5, nearest));
      g = g + (1.0 - g.a) * vec4(acc.rgb / acc.a, 1.0) * cover;
    }
  }
  if (g.a > 0.0) {
    vec3 c = g.rgb / g.a * uGain;
    c = uLift + c * (1.0 - uLift);
    c = mix(vec3(dot(c, vec3(0.299, 0.587, 0.114))), c, uSat);
    // Uniform noise of the same deviation: half-width sqrt(3) * sigma.
    c += (hash2(gl_FragCoord.xy) - 0.5) * 3.464 * uGrain;
    g.rgb = clamp(c, 0.0, 1.0) * g.a;
  }
  gl_FragColor = g;
}`;

const MAX_TEXTURES = 16;
// Pose folds off (see FRAGMENT: uKind and its parameters).
const NO_FOLDS = Object.freeze({ kind: 0, axis: [0, 0, 1, 0], limb: [0, 1, 0, 0], pts: [0, 0, 1, 0], amt: [0, 0, 0, 0], hem: [0, 1] });

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return shader;
}

export class GLMeshRenderer {
  /** @returns {GLMeshRenderer|null} */
  static create() {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: true });
      return gl ? new GLMeshRenderer(canvas, gl) : null;
    } catch {
      return null;
    }
  }

  constructor(canvas, gl) {
    this.canvas = canvas;
    this.gl = gl;
    this.lost = false;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });

    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Shader link failed');
    gl.useProgram(program);
    this.aPos = gl.getAttribLocation(program, 'aPos');
    this.aUv = gl.getAttribLocation(program, 'aUv');
    this.aNrm = gl.getAttribLocation(program, 'aNrm');
    this.aFold = gl.getAttribLocation(program, 'aFold');
    this.aTy = gl.getAttribLocation(program, 'aTy');
    this.uRes = gl.getUniformLocation(program, 'uRes');
    this.uLight = gl.getUniformLocation(program, 'uLight');
    this.uTexSize = gl.getUniformLocation(program, 'uTexSize');
    this.uFoldWave = gl.getUniformLocation(program, 'uFoldWave');
    this.uLit = gl.getUniformLocation(program, 'uLit');
    this.uFolds = Object.fromEntries(['uKind', 'uAxis', 'uLimb', 'uPts', 'uAmt', 'uHem'].map((n) => [n, gl.getUniformLocation(program, n)]));
    this.nrmBuffer = gl.createBuffer();
    this.foldBuffer = gl.createBuffer();
    this.tyBuffer = gl.createBuffer();
    this.posBuffer = gl.createBuffer();
    this.uvBuffer = gl.createBuffer();
    this.indexBuffer = gl.createBuffer();
    this.textures = new Map(); // image -> WebGLTexture (insertion order = age)
    this.grids = new Map(); // key -> { uv, idx }
    this.program = program;

    const post = gl.createProgram();
    gl.attachShader(post, compile(gl, gl.VERTEX_SHADER, QUAD_VERTEX));
    gl.attachShader(post, compile(gl, gl.FRAGMENT_SHADER, POST_FRAGMENT));
    gl.linkProgram(post);
    if (!gl.getProgramParameter(post, gl.LINK_STATUS)) throw new Error('Shader link failed');
    this.post = post;
    this.postLoc = Object.fromEntries(
      ['uGarment', 'uPerson', 'uZone', 'uTexel', 'uFill', 'uInset', 'uSoft', 'uLift', 'uGain', 'uSat', 'uGrain', 'uSeed'].map((n) => [n, gl.getUniformLocation(post, n)]),
    );
    this.postPos = gl.getAttribLocation(post, 'aPos');
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.inputs = {}; // name -> texture re-uploaded each frame
    this.fbo = null;
    this.fboTex = null;
    this.fboSize = '';
  }

  /** A texture re-uploaded from a canvas every frame (person mask, fill zone). */
  frameTexture(name, source, unit) {
    const { gl } = this;
    // Select the unit first: creating the texture binds it to the active
    // unit, which must not be the garment's.
    gl.activeTexture(gl.TEXTURE0 + unit);
    let tex = this.inputs[name];
    if (!tex) {
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.inputs[name] = tex;
    }
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    return tex;
  }

  /** Off-screen render target the size of the canvas. */
  target(width, height) {
    const { gl } = this;
    const key = `${width}x${height}`;
    if (this.fboSize !== key) {
      if (this.fbo) {
        gl.deleteFramebuffer(this.fbo);
        gl.deleteTexture(this.fboTex);
      }
      this.fboTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.fboSize = key;
    }
    return this.fbo;
  }

  texture(image) {
    const { gl } = this;
    let tex = this.textures.get(image);
    if (tex) return tex;
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures.set(image, tex);
    if (this.textures.size > MAX_TEXTURES) {
      const [oldest, oldTex] = this.textures.entries().next().value;
      gl.deleteTexture(oldTex);
      this.textures.delete(oldest);
    }
    return tex;
  }

  grid(cols, rows, rect, texWidth, texHeight) {
    const key = `${cols}x${rows}:${rect.x},${rect.y},${rect.w},${rect.h}:${texWidth}x${texHeight}`;
    let g = this.grids.get(key);
    if (g) return g;
    const uv = new Float32Array((cols + 1) * (rows + 1) * 2);
    let k = 0;
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) {
        uv[k++] = (rect.x + (rect.w * i) / cols) / texWidth;
        uv[k++] = (rect.y + (rect.h * j) / rows) / texHeight;
      }
    }
    const idx = new Uint16Array(cols * rows * 6);
    k = 0;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const a = j * (cols + 1) + i;
        const b = a + 1;
        const c = a + cols + 1;
        const d = c + 1;
        idx.set([a, b, d, a, d, c], k);
        k += 6;
      }
    }
    g = { uv, idx };
    this.grids.set(key, g);
    if (this.grids.size > 64) this.grids.delete(this.grids.keys().next().value);
    return g;
  }

  /**
   * Renders meshes into this.canvas (cleared first) and returns the canvas.
   * @param {number} width
   * @param {number} height
   * @param {{image: CanvasImageSource, rect: object, points: Float32Array, cols: number, rows: number}[]} meshes
   */
  /**
   * @param {object[]} meshes  {image, rect, points, cols, rows, nrm?, fold?, foldWave?}
   * @param {object|null} post see postProcess
   * @param {{x:number,y:number,z:number}|null} light scene light (null: no shading)
   */
  drawMeshes(width, height, meshes, post = null, light = null) {
    const { gl, canvas } = this;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, post ? this.target(width, height) : null);
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(this.uRes, width, height);
    if (light) gl.uniform3f(this.uLight, light.x, light.y, light.z);
    // Fabric folded over by a bend shows its back: those triangles wind the
    // other way (see dominantWinding; clip space flips y). They are drawn
    // first and the front over them, so the front always wins and a fold
    // never leaves a hole (culling them left sawtooth gaps).
    gl.enable(gl.CULL_FACE);
    for (const m of meshes) {
      gl.frontFace(dominantWinding(m.points, m.cols, m.rows) > 0 ? gl.CW : gl.CCW);
      gl.bindTexture(gl.TEXTURE_2D, this.texture(m.image));
      const lit = !!(light && m.nrm && m.fold);
      gl.uniform1f(this.uLit, lit ? 1 : 0);
      gl.uniform2f(this.uTexSize, m.image.width, m.image.height);
      gl.uniform1f(this.uFoldWave, m.foldWave || 40);
      const f = m.folds ?? NO_FOLDS;
      const u = this.uFolds;
      gl.uniform1f(u.uKind, lit ? f.kind : 0);
      gl.uniform4fv(u.uAxis, f.axis);
      gl.uniform4fv(u.uLimb, f.limb);
      gl.uniform4fv(u.uPts, f.pts);
      gl.uniform4fv(u.uAmt, f.amt);
      gl.uniform2fv(u.uHem, f.hem);
      for (const [loc, buf, data, size] of [[this.aNrm, this.nrmBuffer, m.nrm, 4], [this.aFold, this.foldBuffer, m.fold, 4], [this.aTy, this.tyBuffer, m.ty, 2]]) {
        if (loc < 0) continue;
        if (lit && data) {
          gl.bindBuffer(gl.ARRAY_BUFFER, buf);
          gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
          gl.enableVertexAttribArray(loc);
          gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
        } else {
          gl.disableVertexAttribArray(loc);
          gl.vertexAttrib4f(loc, 0, 0, 1, 0);
        }
      }
      const g = this.grid(m.cols, m.rows, m.rect, m.image.width, m.image.height);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, m.points, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(this.aPos);
      gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, g.uv, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(this.aUv);
      gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.idx, gl.DYNAMIC_DRAW);
      gl.cullFace(gl.FRONT);
      gl.drawElements(gl.TRIANGLES, g.idx.length, gl.UNSIGNED_SHORT, 0);
      gl.cullFace(gl.BACK);
      gl.drawElements(gl.TRIANGLES, g.idx.length, gl.UNSIGNED_SHORT, 0);
    }
    gl.disable(gl.CULL_FACE);
    if (post) {
      // The post pass only needs the garment's surroundings (its bounding
      // box, grown by the fill's reach): no need to shade the whole canvas.
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const m of meshes) {
        for (let i = 0; i < m.points.length; i += 2) {
          x0 = Math.min(x0, m.points[i]);
          x1 = Math.max(x1, m.points[i]);
          y0 = Math.min(y0, m.points[i + 1]);
          y1 = Math.max(y1, m.points[i + 1]);
        }
      }
      const pad = (post.fill || 0) + (post.soft || 0) + 4;
      this.postProcess(width, height, post, { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad });
    }
    return canvas;
  }

  /**
   * Draws the off-screen garment to the canvas through the post-process.
   * @param {{person: HTMLCanvasElement|null, zone: HTMLCanvasElement|null, fill: number, inset?: number,
   *   soft?: number, look?: object, seed?: number}} post
   *   fill / inset / soft in pixels; look: see core/photoMatch.js
   */
  postProcess(width, height, post, box = null) {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (box && Number.isFinite(box.x0)) {
      // Scissor coordinates run bottom-up.
      const x = Math.max(0, Math.floor(box.x0));
      const y = Math.max(0, Math.floor(height - box.y1));
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(x, y, Math.max(0, Math.min(width, Math.ceil(box.x1)) - x), Math.max(0, Math.min(height, Math.ceil(height - box.y0)) - y));
    }
    gl.disable(gl.BLEND);
    gl.useProgram(this.post);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    this.blank ||= Object.assign(document.createElement('canvas'), { width: 1, height: 1 });
    this.frameTexture('person', post.person || this.blank, 1);
    this.frameTexture('zone', post.zone || this.blank, 2);
    const u = this.postLoc;
    gl.uniform1i(u.uGarment, 0);
    gl.uniform1i(u.uPerson, 1);
    gl.uniform1i(u.uZone, 2);
    gl.uniform2f(u.uTexel, 1 / width, 1 / height);
    const fill = post.person && post.zone ? post.fill : 0;
    gl.uniform1f(u.uFill, fill);
    gl.uniform1f(u.uInset, post.inset ?? fill * 0.5);
    const look = post.look ?? NEUTRAL_LOOK;
    gl.uniform1f(u.uSoft, post.soft ?? 0);
    gl.uniform1f(u.uLift, look.lift);
    gl.uniform3f(u.uGain, look.gain[0], look.gain[1], look.gain[2]);
    gl.uniform1f(u.uSat, look.sat);
    gl.uniform1f(u.uGrain, look.grain);
    gl.uniform1f(u.uSeed, post.seed ?? 0);
    for (const loc of [this.aUv, this.aNrm, this.aFold, this.aTy]) if (loc >= 0) gl.disableVertexAttribArray(loc);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(this.postPos);
    gl.vertexAttribPointer(this.postPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.SCISSOR_TEST);
    gl.activeTexture(gl.TEXTURE0);
  }
}
