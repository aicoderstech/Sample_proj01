// WebGL textured-mesh renderer for garment layers: one draw call per garment
// part, no seams between triangles. TryOnRenderer falls back to the
// 2D-canvas mesh when WebGL is unavailable or the garment image is
// cross-origin (tainted).
const VERTEX = `
attribute vec2 aPos;
attribute vec2 aUv;
attribute vec4 aNrm;
attribute vec4 aFold;
uniform vec2 uRes;
varying vec2 vUv;
varying vec4 vNrm;
varying vec4 vFold;
void main() {
  vec2 clip = (aPos / uRes) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vUv = aUv;
  vNrm = aNrm;
  vFold = aFold;
}`;

// Fabric shading. Each vertex carries the surface normal of the body under
// it (image-plane part; xy) and the image direction of the garment's x axis
// (zw), and a fold field: drape (x, spare fabric hanging in vertical
// folds), compression (y, folds across the compressed direction) and which
// garment axis is compressed (z). Folds are a height field tied to the
// fabric (garment pixel coordinates), so they move with it; they tilt the
// normal, and the result is lit by the scene's light.
const FRAGMENT = `
precision mediump float;
varying vec2 vUv;
varying vec4 vNrm;
varying vec4 vFold;
uniform sampler2D uTex;
uniform vec3 uLight;
uniform vec2 uTexSize;
uniform float uFoldWave;
uniform float uLit;
void main() {
  vec4 c = texture2D(uTex, vUv);
  if (uLit > 0.0 && c.a > 0.0) {
    vec2 g = vUv * uTexSize;
    vec2 tx = vNrm.zw;
    float tl = length(tx);
    tx = tl > 1e-4 ? tx / tl : vec2(1.0, 0.0);
    vec2 ty = vec2(-tx.y, tx.x);
    vec2 n2 = vNrm.xy;
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
    float l2 = dot(n2, n2);
    if (l2 > 0.94) n2 *= sqrt(0.94 / l2);
    vec3 n = vec3(n2, sqrt(1.0 - dot(n2, n2)));
    float amb = 0.5;
    float s = (amb + (1.0 - amb) * max(dot(n, uLight), 0.0)) / (amb + (1.0 - amb) * uLight.z);
    c.rgb *= clamp(s, 0.55, 1.15);
  }
  gl_FragColor = c;
}`;

// Post-process for a garment layer, run on its way to the screen:
//  - fill: where the person's outline is a few pixels wider than the garment
//    (the wearer's own clothes peeking out), extend the garment to the
//    outline with the colour of the nearest garment pixel; only inside the
//    person mask and the garment's zone (never past the hem or into the
//    neckline).
// (Shading is done when the meshes are drawn: see FRAGMENT.)
const QUAD_VERTEX = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const POST_FRAGMENT = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uGarment;
uniform sampler2D uPerson;
uniform sampler2D uZone;
uniform vec2 uTexel;
uniform float uFill;
uniform float uInset;
void main() {
  // Image coordinates run top-down; the framebuffer texture bottom-up.
  vec2 img = vec2(vUv.x, 1.0 - vUv.y);
  vec4 g = texture2D(uGarment, vUv);
  float person = texture2D(uPerson, img).a;
  if (uFill > 0.0 && g.a < 0.98 && person > 0.5 && texture2D(uZone, img).a > 0.5) {
    vec4 near = vec4(0.0);
    for (int ring = 1; ring <= 7; ring++) {
      float r = uFill * float(ring) / 7.0;
      vec4 acc = vec4(0.0);
      for (int k = 0; k < 16; k++) {
        float a = float(k) * 0.3926991;
        vec2 dir = vec2(cos(a), sin(a));
        vec4 t = texture2D(uGarment, vUv + dir * r * uTexel);
        if (t.a > 0.9) {
          // The fabric a little further in: edges often carry a seam line or
          // outline, which shouldn't be smeared outwards.
          vec4 inner = texture2D(uGarment, vUv + dir * (r + uInset) * uTexel);
          acc += inner.a > 0.9 ? vec4(inner.rgb / inner.a, 1.0) : vec4(t.rgb / t.a, 1.0);
        }
      }
      if (acc.a > 0.0) {
        near = vec4(acc.rgb / acc.a, 1.0);
        break;
      }
    }
    g = g + (1.0 - g.a) * near;
  }
  gl_FragColor = g;
}`;

const MAX_TEXTURES = 16;

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
    this.uRes = gl.getUniformLocation(program, 'uRes');
    this.uLight = gl.getUniformLocation(program, 'uLight');
    this.uTexSize = gl.getUniformLocation(program, 'uTexSize');
    this.uFoldWave = gl.getUniformLocation(program, 'uFoldWave');
    this.uLit = gl.getUniformLocation(program, 'uLit');
    this.nrmBuffer = gl.createBuffer();
    this.foldBuffer = gl.createBuffer();
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
      ['uGarment', 'uPerson', 'uZone', 'uTexel', 'uFill', 'uInset'].map((n) => [n, gl.getUniformLocation(post, n)]),
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
    for (const m of meshes) {
      gl.bindTexture(gl.TEXTURE_2D, this.texture(m.image));
      const lit = !!(light && m.nrm && m.fold);
      gl.uniform1f(this.uLit, lit ? 1 : 0);
      gl.uniform2f(this.uTexSize, m.image.width, m.image.height);
      gl.uniform1f(this.uFoldWave, m.foldWave || 40);
      for (const [loc, buf, data] of [[this.aNrm, this.nrmBuffer, m.nrm], [this.aFold, this.foldBuffer, m.fold]]) {
        if (loc < 0) continue;
        if (lit) {
          gl.bindBuffer(gl.ARRAY_BUFFER, buf);
          gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
          gl.enableVertexAttribArray(loc);
          gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 0, 0);
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
      gl.drawElements(gl.TRIANGLES, g.idx.length, gl.UNSIGNED_SHORT, 0);
    }
    if (post) this.postProcess(width, height, post);
    return canvas;
  }

  /**
   * Draws the off-screen garment to the canvas through the post-process.
   * @param {{person: HTMLCanvasElement, zone: HTMLCanvasElement, fill: number, inset?: number}} post
   *   fill / inset in pixels
   */
  postProcess(width, height, post) {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);
    gl.useProgram(this.post);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    this.frameTexture('person', post.person, 1);
    this.frameTexture('zone', post.zone, 2);
    const u = this.postLoc;
    gl.uniform1i(u.uGarment, 0);
    gl.uniform1i(u.uPerson, 1);
    gl.uniform1i(u.uZone, 2);
    gl.uniform2f(u.uTexel, 1 / width, 1 / height);
    gl.uniform1f(u.uFill, post.fill);
    gl.uniform1f(u.uInset, post.inset ?? post.fill * 0.5);
    for (const loc of [this.aUv, this.aNrm, this.aFold]) if (loc >= 0) gl.disableVertexAttribArray(loc);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(this.postPos);
    gl.vertexAttribPointer(this.postPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.activeTexture(gl.TEXTURE0);
  }
}
