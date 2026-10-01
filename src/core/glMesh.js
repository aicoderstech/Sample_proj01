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
  drawMeshes(width, height, meshes) {
    const { gl, canvas } = this;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
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
    return canvas;
  }
}
