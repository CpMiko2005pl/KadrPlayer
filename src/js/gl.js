// Kadr Player — WebGL2 video renderer
// Every new video frame is processed once (process):
//   prep   (source size): crop, rotate/flip, deband, colour controls, sRGB→linear
//   scale  (separable, 2 passes): Catmull-Rom / Mitchell / Lanczos-3 / Spline36, kernel widened when shrinking, anti-ringing
//   post   (output size): AMD FidelityFX RCAS sharpening, linear→sRGB  → stored in one of two output slots
// Every screen refresh only presents (present): mixes the two slots (smooth motion) + dithering → cheap even on weak GPUs.
window.K = window.K || {};
(() => {
  const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

  const COMMON = `#version 300 es
precision highp float;
precision highp int;
in vec2 uv; out vec4 o;
uniform float seed;
float rnd(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + seed) * 43758.5453); }
vec3 toLin(vec3 c){ c = clamp(c, 0.0, 1.0); return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c){ c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
`;

  const PREP = COMMON + `
uniform sampler2D T;
uniform vec4 crop; uniform int rot; uniform bvec2 flip;
uniform bool colorOn; uniform float bright, contr, sat, gam, hueRot;
uniform bool debandOn; uniform float debThr, debRange, debGrain;
uniform bool linearize;
vec2 mapUV(vec2 q){
  if (flip.x) q.x = 1.0 - q.x;
  if (flip.y) q.y = 1.0 - q.y;
  if (rot == 1) q = vec2(1.0 - q.y, q.x);
  else if (rot == 2) q = vec2(1.0 - q.x, 1.0 - q.y);
  else if (rot == 3) q = vec2(q.y, 1.0 - q.x);
  return crop.xy + q * crop.zw;
}
void main(){
  vec2 s = mapUV(uv);
  s.y = 1.0 - s.y;               // the video texture is uploaded top-down (no UNPACK_FLIP_Y copy)
  vec4 c = texture(T, s);
  if (debandOn) {
    vec2 px = 1.0 / vec2(textureSize(T, 0));
    for (int i = 1; i <= 3; i++) {
      float fi = float(i);
      float r = debRange * fi * (0.35 + 0.65 * rnd(uv * 1.31 + fi));
      float a = 6.2831853 * rnd(uv * 2.17 + fi * 3.7);
      vec2 d = vec2(cos(a), sin(a)) * r * px;
      vec4 avg = (texture(T, s + d) + texture(T, s - d) + texture(T, s + vec2(-d.y, d.x)) + texture(T, s + vec2(d.y, -d.x))) * 0.25;
      vec3 diff = abs(c.rgb - avg.rgb);
      if (max(max(diff.r, diff.g), diff.b) < debThr / fi) c = avg;
    }
    c.rgb += (rnd(uv * 3.31 + 0.7) - 0.5) * debGrain;
  }
  if (colorOn) {
    c.rgb = (c.rgb - 0.5) * contr + 0.5 + bright;
    float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
    c.rgb = mix(vec3(l), c.rgb, sat);
    if (abs(hueRot) > 0.0001) {
      float cs = cos(hueRot), sn = sin(hueRot); vec3 k = vec3(0.57735027);
      c.rgb = c.rgb * cs + cross(k, c.rgb) * sn + k * dot(k, c.rgb) * (1.0 - cs);
    }
    c.rgb = pow(max(c.rgb, 0.0), vec3(1.0 / gam));
  }
  c.rgb = clamp(c.rgb, 0.0, 1.0);
  if (linearize) c.rgb = toLin(c.rgb);
  o = vec4(c.rgb, 1.0);
}`;

  const LUT_N = 2048;
  const SEP = COMMON + `#define LUT_N ${LUT_N}

uniform sampler2D T; uniform bool horiz; uniform float scale; uniform float radius; uniform float antiring;
uniform highp sampler2D W;      // kernel weights K(x) for x in [0, radius], LUT_N samples — no sin() per tap
uniform bool flipSrc;           // T is the raw video texture (rows top-down) instead of the prep pass
uniform bool linIn;             // linearize each tap (raw sRGB video in, linear light out)
vec3 linFast(vec3 c){ return c * (c * (c * 0.305306011 + 0.682171111) + 0.012522878); }
float K(float x){
  float a = abs(x) / radius;
  return a < 1.0 ? texelFetch(W, ivec2(int(a * float(LUT_N - 1) + 0.5), 0), 0).r : 0.0;
}
void main(){
  ivec2 sz = textureSize(T, 0);
  int len = horiz ? sz.x : sz.y;
  float pos = (horiz ? uv.x : uv.y) * float(len) - 0.5;
  float base = floor(pos), f = pos - base;
  float ss = clamp(1.0 / scale, 1.0, 10.0);
  int taps = min(int(ceil(radius * ss)), 32);
  ivec2 fc = ivec2(gl_FragCoord.xy);
  if (flipSrc) fc.y = sz.y - 1 - fc.y;
  vec4 sum = vec4(0.0); float wsum = 0.0;
  vec4 lo = vec4(1e9), hi = vec4(-1e9);
  // dynamic bounds: only the taps the kernel needs (6 for Lanczos-3 when enlarging) instead of a fixed 64
  for (int i = 1 - taps; i <= taps; i++) {
    float w = K((float(i) - f) / ss);
    int k = clamp(int(base) + i, 0, len - 1);
    vec4 t = texelFetch(T, horiz ? ivec2(k, fc.y) : ivec2(fc.x, k), 0);
    if (linIn) t.rgb = linFast(t.rgb);
    sum += t * w; wsum += w;
    if (i == 0 || i == 1) { lo = min(lo, t); hi = max(hi, t); }
  }
  vec4 r = sum / max(wsum, 1e-6);
  if (antiring > 0.0 && ss <= 1.0) r = mix(r, clamp(r, lo, hi), antiring);
  o = vec4(r.rgb, 1.0);
}`;

  const POST = COMMON + `
uniform sampler2D T; uniform vec2 outSize; uniform float sharp; uniform bool delin; uniform bool flipSrc;
vec3 at(vec2 off){ vec2 q = uv + off / outSize; if (flipSrc) q.y = 1.0 - q.y; vec3 c = texture(T, q).rgb; return delin ? toSrgb(c) : c; }
void main(){
  vec3 e = at(vec2(0.0));
  if (sharp > 0.001) {
    vec3 b = at(vec2(0.0, 1.0)), d = at(vec2(-1.0, 0.0)), f = at(vec2(1.0, 0.0)), h = at(vec2(0.0, -1.0));
    vec3 mn4 = min(min(b, d), min(f, h)), mx4 = max(max(b, d), max(f, h));
    vec3 hitMin = mn4 / (4.0 * mx4 + 1e-5);
    vec3 hitMax = (1.0 - mx4) / (4.0 * mn4 - 4.0 - 1e-5);
    vec3 lobeRGB = max(-hitMin, hitMax);
    float lobe = max(-0.1875, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.0)) * sharp;
    e = (lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0);
  }
  o = vec4(clamp(e, 0.0, 1.0), 1.0);
}`;

  const PRESENT = COMMON + `
uniform sampler2D A; uniform sampler2D B; uniform float mixF; uniform bool dither;
void main(){
  vec3 c = texture(B, uv).rgb;
  if (mixF < 0.999) c = mix(texture(A, uv).rgb, c, mixF);
  if (dither) c += (rnd(gl_FragCoord.xy * 0.0173) + rnd(gl_FragCoord.yx * 0.0291 + 0.5) - 1.0) / 255.0;
  o = vec4(c, 1.0);
}`;

  const KERNELS = { catrom: [0, 2], mitchell: [1, 2], lanczos: [2, 3], spline36: [3, 3] };
  // the same kernel functions as before, evaluated once on the CPU into the weight table
  const cubic = (x, B, C) => {
    x = Math.abs(x);
    if (x < 1) return ((12 - 9 * B - 6 * C) * x ** 3 + (-18 + 12 * B + 6 * C) * x * x + (6 - 2 * B)) / 6;
    if (x < 2) return ((-B - 6 * C) * x ** 3 + (6 * B + 30 * C) * x * x + (-12 * B - 48 * C) * x + (8 * B + 24 * C)) / 6;
    return 0;
  };
  const sinc = x => (Math.abs(x) < 1e-7 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
  const spline36 = x => {
    x = Math.abs(x);
    if (x < 1) return ((13 / 11 * x - 453 / 209) * x - 3 / 209) * x + 1;
    if (x < 2) { x -= 1; return ((-6 / 11 * x + 270 / 209) * x - 156 / 209) * x; }
    if (x < 3) { x -= 2; return ((1 / 11 * x - 45 / 209) * x + 26 / 209) * x; }
    return 0;
  };
  const KFUNC = [x => cubic(x, 0, 0.5), x => cubic(x, 1 / 3, 1 / 3), x => (Math.abs(x) < 3 ? sinc(x) * sinc(x / 3) : 0), spline36];

  class GLRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ok = false;
      this.fbos = {};
      canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.ok = false; if (this.onLost) this.onLost(); });
      canvas.addEventListener('webglcontextrestored', () => { this.init(); if (this.onRestored) this.onRestored(); });
      this.init();
    }
    init() {
      const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
      this.gl = gl;
      if (!gl) return;
      try {
        this.float = !!gl.getExtension('EXT_color_buffer_float');
        this.progs = { prep: this.program(PREP), sep: this.program(SEP), post: this.program(POST), present: this.program(PRESENT) };
        this.vao = gl.createVertexArray();
        gl.bindVertexArray(this.vao);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        this.src = this.texture();
        this.luts = KFUNC.map((f, k) => {
          const data = new Float32Array(LUT_N), r = Object.values(KERNELS).find(v => v[0] === k)[1];
          for (let i = 0; i < LUT_N; i++) data[i] = f(i / (LUT_N - 1) * r);
          const t = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, t);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, LUT_N, 1, 0, gl.RED, gl.FLOAT, data);
          return t;
        });
        this.texW = 0; this.texH = 0;
        this.fbos = {};
        this.slot = 0;            // output slot holding the newest processed frame
        this.slotKey = ['', ''];  // size of what each slot holds (a blend needs both the same)
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        this.gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        this.ok = true;
      } catch (e) {
        console.error('WebGL init failed', e);
        this.ok = false;
      }
    }
    program(fs) {
      const gl = this.gl;
      const sh = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
      gl.bindAttribLocation(prog, 0, 'p');
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      const u = {};
      const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(prog, i); u[info.name] = gl.getUniformLocation(prog, info.name); }
      return { prog, u };
    }
    texture() {
      const gl = this.gl;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }
    fbo(name, w, h, float) {
      const gl = this.gl;
      let f = this.fbos[name];
      // linear light is kept in sRGB-encoded 8-bit textures: the GPU decodes/encodes for free on fetch/write,
      // half the memory traffic of RGBA16F (which cost ~20 ms per 1080p frame on an Intel HD 520)
      const fmt = float ? 's' : 'b';
      if (f && f.w === w && f.h === h && f.fmt === fmt) return f;
      if (f) { gl.deleteTexture(f.tex); gl.deleteFramebuffer(f.fb); }
      const tex = this.texture();
      if (fmt === 's') gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      f = { tex, fb, w, h, fmt };
      this.fbos[name] = f;
      return f;
    }
    // copy the video's current frame into the source texture
    upload(video) {
      if (!this.ok) return false;
      const gl = this.gl;
      const w = video.videoWidth, h = video.videoHeight;
      if (!w || !h) return false;
      gl.bindTexture(gl.TEXTURE_2D, this.src);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);    // flipped in the shaders instead: cheaper upload path
      // (an SRGB8_ALPHA8 upload would linearize for free on fetch, but Chromium copies video into it on a slow path: ~86 ms/frame)
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video); }
      catch (e) { this.uploadError = e.message; return false; }
      this.texW = w; this.texH = h;
      return true;
    }
    // p: { dst:{x,y,w,h} (canvas px, top-left origin), crop:{x,y,w,h} (0..1, top-left origin), rot, flipH, flipV,
    //      scaler, antiring, sharpen, deband, debandStrength, linear, color:{bright,contr,sat,gamma,hue} }
    // newFrame: the result goes to the other slot (the previous frame stays for blending); otherwise the newest slot is redone
    process(p, newFrame) {
      if (!this.ok || !this.texW) return false;
      const gl = this.gl;
      const dw = Math.max(1, Math.min(this.maxTex, Math.round(p.dst.w))), dh = Math.max(1, Math.min(this.maxTex, Math.round(p.dst.h)));
      const crop = p.crop || { x: 0, y: 0, w: 1, h: 1 };
      const rot = ((p.rot || 0) / 90 | 0) & 3;
      let sw = Math.max(1, Math.round(this.texW * crop.w)), sh = Math.max(1, Math.round(this.texH * crop.h));
      if (rot & 1) [sw, sh] = [sh, sw];
      const kernel = (dw !== sw || dh !== sh) && KERNELS[p.scaler];
      const down = dw < sw || dh < sh;
      const linear = !!(p.linear && down && kernel);
      const c = p.color || {};
      const colorOn = Math.abs(c.bright || 0) > 1e-3 || Math.abs((c.contr ?? 1) - 1) > 1e-3 || Math.abs((c.sat ?? 1) - 1) > 1e-3 || Math.abs((c.gamma ?? 1) - 1) > 1e-3 || Math.abs(c.hue || 0) > 1e-3;
      const seed = (performance.now() % 1000) / 1000;
      // high precision only where it buys something (linear light); 8-bit is half the memory traffic
      const hp = linear;
      gl.bindVertexArray(this.vao);
      gl.disable(gl.BLEND);

      // the prep pass (full source size) only when it does something; otherwise the next pass reads the video texture
      const plain = !rot && !p.flipH && !p.flipV && !colorOn && !p.deband && crop.x === 0 && crop.y === 0 && crop.w === 1 && crop.h === 1;
      const trivial = plain && (!linear || kernel);      // linear light: the first scaling pass linearizes each tap itself
      let src, P;
      if (trivial) src = { tex: this.src, raw: true };
      else {
      const prep = this.fbo('prep', sw, sh, hp);
      gl.bindFramebuffer(gl.FRAMEBUFFER, prep.fb);
      gl.viewport(0, 0, sw, sh);
      P = this.progs.prep; gl.useProgram(P.prog);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.src);
      gl.uniform1i(P.u.T, 0);
      gl.uniform4f(P.u.crop, crop.x, 1 - crop.y - crop.h, crop.w, crop.h);   // crop is top-left based, textures bottom-up
      gl.uniform1i(P.u.rot, rot);
      gl.uniform2i(P.u.flip, p.flipH ? 1 : 0, p.flipV ? 1 : 0);
      gl.uniform1i(P.u.colorOn, colorOn ? 1 : 0);
      gl.uniform1f(P.u.bright, c.bright || 0); gl.uniform1f(P.u.contr, c.contr ?? 1); gl.uniform1f(P.u.sat, c.sat ?? 1);
      gl.uniform1f(P.u.gam, c.gamma ?? 1); gl.uniform1f(P.u.hueRot, (c.hue || 0) * Math.PI / 180);
      const ds = p.debandStrength ?? 0.5;
      gl.uniform1i(P.u.debandOn, p.deband ? 1 : 0);
      gl.uniform1f(P.u.debThr, 0.006 + 0.02 * ds); gl.uniform1f(P.u.debRange, 8 + 16 * ds); gl.uniform1f(P.u.debGrain, 0.004 + 0.012 * ds);
      gl.uniform1i(P.u.linearize, linear ? 1 : 0);
      gl.uniform1f(P.u.seed, seed);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      src = prep;
      }

      if (kernel && (dw !== sw || dh !== sh)) {
        P = this.progs.sep; gl.useProgram(P.prog);
        gl.uniform1f(P.u.radius, kernel[1]);
        gl.uniform1f(P.u.antiring, p.antiring ?? 0.6);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.luts[kernel[0]]); gl.uniform1i(P.u.W, 1);
        gl.uniform1i(P.u.T, 0); gl.activeTexture(gl.TEXTURE0);
        const fx = this.fbo('sx', dw, sh, hp);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fx.fb); gl.viewport(0, 0, dw, sh);
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        gl.uniform1i(P.u.flipSrc, src.raw ? 1 : 0);
        gl.uniform1i(P.u.linIn, src.raw && linear ? 1 : 0);
        gl.uniform1i(P.u.horiz, 1); gl.uniform1f(P.u.scale, dw / sw);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        const fy = this.fbo('sy', dw, dh, hp);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fy.fb); gl.viewport(0, 0, dw, dh);
        gl.bindTexture(gl.TEXTURE_2D, fx.tex);
        gl.uniform1i(P.u.flipSrc, 0); gl.uniform1i(P.u.linIn, 0);
        gl.uniform1i(P.u.horiz, 0); gl.uniform1f(P.u.scale, dh / sh);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        src = fy;
      }

      if (newFrame) this.slot ^= 1;
      const out = this.fbo('out' + this.slot, dw, dh, false);
      gl.bindFramebuffer(gl.FRAMEBUFFER, out.fb);
      gl.viewport(0, 0, dw, dh);
      P = this.progs.post; gl.useProgram(P.prog);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex);
      const nearest = p.scaler === 'nearest';
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
      gl.uniform1i(P.u.T, 0);
      gl.uniform2f(P.u.outSize, dw, dh);
      gl.uniform1f(P.u.sharp, p.sharpen || 0);
      gl.uniform1i(P.u.delin, linear ? 1 : 0);
      gl.uniform1i(P.u.flipSrc, src.raw ? 1 : 0);
      gl.uniform1f(P.u.seed, seed);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      this.slotKey[this.slot] = dw + 'x' + dh;
      if (!newFrame) this.slotKey[this.slot ^ 1] = '';      // the older slot no longer matches what is shown
      return true;
    }
    // draw the newest processed frame (blended with the previous one by mixF) into dst on the canvas
    present(dst, mixF, dither) {
      if (!this.ok) return false;
      const gl = this.gl;
      const cur = this.fbos['out' + this.slot];
      if (!cur) return false;
      const prev = this.fbos['out' + (this.slot ^ 1)];
      const canBlend = prev && this.slotKey[this.slot ^ 1] === this.slotKey[this.slot];
      const cw = this.canvas.width, ch = this.canvas.height;
      gl.bindVertexArray(this.vao);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, cw, ch);
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.viewport(Math.round(dst.x), Math.round(ch - dst.y - dst.h), Math.round(dst.w), Math.round(dst.h));
      const P = this.progs.present; gl.useProgram(P.prog);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, cur.tex);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, canBlend ? prev.tex : cur.tex);
      gl.uniform1i(P.u.B, 0); gl.uniform1i(P.u.A, 1);
      gl.uniform1f(P.u.mixF, canBlend ? mixF : 1);
      gl.uniform1i(P.u.dither, dither ? 1 : 0);
      gl.uniform1f(P.u.seed, (performance.now() % 1000) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      return true;
    }
  }
  K.GLRenderer = GLRenderer;
})();
