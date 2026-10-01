// WebGL textured-mesh renderer for garment layers: one draw call per garment
// part, no seams between triangles. TryOnRenderer falls back to the
// 2D-canvas mesh when WebGL is unavailable or the garment image is
// cross-origin (tainted).
const VERTEX = `
attribute vec2 aPos;
attribute vec2 aUv;
uniform vec2 uRes;
varying vec2 vUv;
void main() {
  vec2 clip = (aPos / uRes) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vUv = aUv;
}`;

const FRAGMENT = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
void main() {
  gl_FragColor = texture2D(uTex, vUv);
}`;

// Post-process for a garment layer, run on its way to the screen:
//  - fill: where the person's outline is a few pixels wider than the garment
//    (the wearer's own clothes peeking out), extend the garment to the
//    outline with the colour of the nearest garment pixel; only inside the
//    person mask and the garment's zone (never past the hem or into the
//    neckline).
//  - shade: rounding. Fabric wrapping round the body and arms turns away
//    from the light towards its outline, so it darkens gently there. (The
//    photo's own shading isn't used: it can't be told apart from the
//    pattern of the clothes the person is wearing, which would show through.)
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
uniform float uShade;
uniform float uRound;
// Garment, or the wearer's outline it is extended to (fill), at uv.
float covered(vec2 uv) {
  if (texture2D(uGarment, uv).a > 0.5) return 1.0;
  if (uFill <= 0.0) return 0.0;
  vec2 img = vec2(uv.x, 1.0 - uv.y);
  return step(0.5, texture2D(uPerson, img).a) * step(0.5, texture2D(uZone, img).a);
}

void main() {
  // Image coordinates run top-down; the framebuffer texture bottom-up.
  vec2 img = vec2(vUv.x, 1.0 - vUv.y);
  vec4 g = texture2D(uGarment, vUv);
  float person = texture2D(uPerson, img).a;
  if (uFill > 0.0 && g.a < 0.98 && person > 0.5 && texture2D(uZone, img).a > 0.5) {
    vec4 near = vec4(0.0);
    for (int ring = 1; ring <= 4; ring++) {
      float r = uFill * float(ring) / 4.0;
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
  if (uShade > 0.0 && g.a > 0.0) {
    // Fabric wraps round the body and arms: it turns away from the light
    // towards its outline. How much of a disc around this pixel the garment
    // covers (about 1 inside, 0.5 at an edge, less at a corner) gives that
    // rounding at two scales.
    float near = 0.0;
    float far = 0.0;
    for (int k = 0; k < 16; k++) {
      float a = float(k) * 0.3926991 + 0.19635;
      vec2 dir = vec2(cos(a), sin(a)) * uTexel;
      near += covered(vUv + dir * uRound * 0.5);
      far += covered(vUv + dir * uRound);
    }
    near /= 16.0;
    far /= 16.0;
    float s = mix(0.74, 1.0, smoothstep(0.38, 0.9, near)) * mix(0.9, 1.0, smoothstep(0.45, 0.95, far));
    g.rgb *= mix(1.0, s, uShade);
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
    this.uRes = gl.getUniformLocation(program, 'uRes');
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
      ['uGarment', 'uPerson', 'uZone', 'uTexel', 'uFill', 'uInset', 'uShade', 'uRound'].map((n) => [n, gl.getUniformLocation(post, n)]),
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
  drawMeshes(width, height, meshes, post = null) {
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
    for (const m of meshes) {
      gl.bindTexture(gl.TEXTURE_2D, this.texture(m.image));
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
   * @param {{person: HTMLCanvasElement, zone: HTMLCanvasElement, fill: number, inset?: number, shade: number, round: number}} post
   *   fill / inset / round in pixels; shade 0..1
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
    gl.uniform1f(u.uShade, post.shade);
    gl.uniform1f(u.uRound, post.round);
    gl.disableVertexAttribArray(this.aUv);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(this.postPos);
    gl.vertexAttribPointer(this.postPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.activeTexture(gl.TEXTURE0);
  }
}
