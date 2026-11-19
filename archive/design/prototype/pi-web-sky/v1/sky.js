/* Sky/Clouds shader adapted from ../forms.html (Alfred, MIT).
 * Only the visual renderer is reused. No prototype mic, fake tasks or global controls.
 * One bounded WebGL surface is copied into visible 2D slots, including the native dialog.
 */
const COMMON = `#version 300 es
precision highp float;
uniform vec2 u_c;
uniform float u_r, u_rcss, u_t;
uniform float u_listen, u_think, u_speak, u_work, u_notice, u_sleep;
uniform float u_voice, u_phase, u_spin, u_near;
uniform vec2 u_gaze, u_ptr;
uniform vec3 u_h1, u_h2, u_h3, u_h4, u_amber, u_ink, u_you;
mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
vec3 ramp(float x){
  x = clamp(x, 0., 1.) * 3.;
  vec3 c = mix(u_h1, u_h2, smoothstep(0., 1., x));
  c = mix(c, u_h3, smoothstep(1., 2., x));
  return mix(c, u_h4, smoothstep(2., 3., x));
}
float grain(){ return fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - .5; }
`;
// Simplex noise: Copyright (C) 2011 Ashima Arts; Stefan Gustavson. MIT.
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
const NOISE = `
vec3 mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
float fbm(vec3 p, int oct){
  float a = .5, s = 0.;
  for (int i = 0; i < 4; i++) { if (i >= oct) break; s += a * snoise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= .5; }
  return s;
}
`;
const VERTEX = `#version 300 es
void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2. - 1., 0., 1.); }`;
const FRAGMENT = COMMON + NOISE + `
out vec4 o;
void main(){
  vec2 p = (gl_FragCoord.xy - u_c) / u_r;
  float L = length(p);
  if (L > 2.7) { o = vec4(0.); return; }
  float lod = smoothstep(9., 60., u_rcss);
  int oct = u_rcss > 24. ? 3 : 2;
  vec2 ca = L > 1e-4 ? p / L : vec2(0., 1.);
  float sl = u_sleep;
  float wob = snoise(vec3(ca * 1.1, u_t * .3)) * .010
            + snoise(vec3(ca * 2.3 + 4.1, u_t * 1.7)) * .075 * u_voice * (u_speak * .85 + u_listen);
  vec2 pd = length(u_ptr) > 1e-3 ? normalize(u_ptr) : vec2(0.);
  wob += .04 * u_near * pow(max(dot(ca, pd), 0.), 4.);
  float R = 1. + wob * lod;
  float d = L / R;
  float aa = 1.4 / u_r;
  float inside = smoothstep(1. + aa * .5, 1. - aa, d);
  float hd = max(d - 1., 0.);
  float gw = (.55 + .5 * u_voice * u_speak + .15 * u_listen) * (1. - .8 * sl);
  float low = clamp(-ca.y * .5 + .5, 0., 1.);
  vec3 hc = mix(u_h2, u_h3, .3 + .5 * low);
  hc = mix(hc, u_amber, u_notice * .75 * low);
  float halo = (exp(-hd * 4.) * .24 + exp(-hd * 16.) * .20) * gw;
  vec3 col = vec3(0.);
  if (d < 1. + aa * 2.) {
    float dd = min(d, .9999);
    float z = sqrt(1. - dd * dd);
    vec3 n = vec3(p / R, z);
    vec3 q = n;
    q.xz = rot(u_phase) * q.xz;
    q.yz = rot(.35) * q.yz;
    vec3 w = q * .8;
    w.y *= 1. + 1.7 * u_think;
    float f1 = fbm(w + vec3(0., 0., u_spin), 2);
    float f2 = fbm(w * 1.25 + vec3(f1 * .9, f1 * .7, -u_spin * 1.1), oct);
    vec3 Ld = normalize(vec3(u_gaze * 1.2, 1.));
    float lam = dot(n, Ld) * .5 + .5;
    float h = n.y * .5 + .5;
    float x = mix(.68, .14, h) + f2 * .30 + (lam - .5) * .24;
    x += u_voice * u_speak * .20 + u_listen * .03 - sl * .42;
    col = mix(ramp(x), u_ink, .07);
    float cl = smoothstep(.05, .7, f2 + .3 * f1);
    col = mix(col, mix(col, u_ink, .62), cl * .42 * (1. - .6 * sl));
    float facing = pow(clamp(dot(n, normalize(vec3(u_gaze, .55))), 0., 1.), 3.);
    col = mix(col, u_you, u_listen * (.10 + .40 * u_voice) * facing);
    col *= (.78 + .38 * lam) * mix(1., .30, sl);
    float fr = pow(1. - z, 2.6);
    float a2 = atan(p.y, p.x) - u_t * 1.7;
    float run = pow(.5 + .5 * cos(a2), 5.) + .6 * pow(.5 + .5 * cos(a2 * 2. + 2.), 9.);
    col += mix(u_h3, u_h4, .45) * fr * (.38 + 1.8 * run * u_work) * (1. - .55 * sl);
    col *= 1. - .30 * (1. - fr) * pow(1. - z, 2.);
    float nb = smoothstep(.15, -1., n.y);
    col += u_amber * u_notice * nb * (.55 + .2 * sin(u_t * 2.1));
    float sv = max(dot(n, normalize(vec3(-.38, .5, .78))), 0.);
    col += (pow(sv, 30.) * .14 + pow(sv, 5.) * .07) * (1. - sl) * lod;
  }
  vec3 outc = col * inside + hc * halo * (1. - inside);
  float a = inside + halo * (1. - inside);
  outc += grain() / 255. * a;
  o = vec4(outc, clamp(a, 0., 1.));
}`;

export function createSky() {
  const source = document.createElement('canvas');
  source.width = source.height = 512;
  const gl = source.getContext('webgl2', { alpha: true, antialias: false, premultipliedAlpha: true, powerPreference: 'low-power' });
  if (!gl) return { setState() {}, setPaused() {}, refresh() {} };
  const shaders = [];
  function compile(type, text) {
    const shader = gl.createShader(type);
    shaders.push(shader); gl.shaderSource(shader, text); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }
  const program = gl.createProgram();
  try {
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  } catch (error) {
    console.warn('Sky uses its static fallback:', error.message);
    shaders.forEach(shader => gl.deleteShader(shader)); gl.deleteProgram(program);
    return { setState() {}, setPaused() {}, refresh() {} };
  }
  shaders.forEach(shader => gl.deleteShader(shader));
  gl.useProgram(program); gl.bindVertexArray(gl.createVertexArray());
  const loc = name => gl.getUniformLocation(program, name);
  const uniforms = Object.fromEntries(['u_t', 'u_phase', 'u_spin', 'u_voice', 'u_listen', 'u_think', 'u_speak', 'u_work', 'u_notice'].map(key => [key, loc(key)]));
  gl.uniform2f(loc('u_c'), 256, 256); gl.uniform1f(loc('u_r'), 156); gl.uniform1f(loc('u_rcss'), 100);
  gl.uniform2f(loc('u_gaze'), -.12, .2);
  for (const [name, hex] of Object.entries({ u_h1: '#4c25a6', u_h2: '#9c48ff', u_h3: '#ff4f93', u_h4: '#ffd56e', u_amber: '#e8b877', u_ink: '#f3ecf8', u_you: '#b5dce8' })) {
    const value = parseInt(hex.slice(1), 16);
    gl.uniform3f(loc(name), (value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255);
  }
  const slots = [...document.querySelectorAll('[data-sky]')].map(canvas => ({ canvas, ctx: canvas.getContext('2d'), visible: false }));
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let state = 'idle', paused = false, frame = 0, last = 0, time = 18, gone = false, lost = false;
  function draw() {
    if (lost) return;
    gl.uniform1f(uniforms.u_t, time);
    gl.uniform1f(uniforms.u_phase, time * .09);
    gl.uniform1f(uniforms.u_spin, time * (state === 'thinking' ? .13 : .035));
    // Simulated envelope only; this page never captures or plays audio.
    gl.uniform1f(uniforms.u_voice, state === 'listening' || state === 'speaking' ? (paused || reduce.matches ? .3 : Math.max(0, Math.sin(time * 8)) * .65) : 0);
    for (const [name, when] of Object.entries({ u_listen: 'listening', u_think: 'thinking', u_speak: 'speaking', u_work: 'working', u_notice: 'notice' })) gl.uniform1f(uniforms[name], +(state === when));
    gl.viewport(0, 0, 512, 512); gl.drawArrays(gl.TRIANGLES, 0, 3);
    for (const slot of slots) {
      if (!slot.visible || !slot.ctx) continue;
      slot.ctx.clearRect(0, 0, slot.canvas.width, slot.canvas.height);
      slot.ctx.drawImage(source, 0, 0, slot.canvas.width, slot.canvas.height);
      slot.canvas.parentElement.classList.add('sky-ready');
    }
  }
  function tick(now) {
    frame = 0;
    if (document.hidden || gone || lost || !slots.some(slot => slot.visible)) return;
    const delta = now - last;
    if (delta >= (state === 'idle' ? 50 : 33)) {
      if (!paused && !reduce.matches) time += Math.min(delta / 1000, .08);
      last = now; draw();
    }
    if (!paused && !reduce.matches) frame = requestAnimationFrame(tick);
  }
  function refresh() {
    if (frame) cancelAnimationFrame(frame); frame = 0;
    if (!document.hidden && !gone && !lost) { draw(); last = performance.now(); if (!paused && !reduce.matches) frame = requestAnimationFrame(tick); }
  }
  const size = new ResizeObserver(entries => {
    for (const entry of entries) {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      entry.target.width = Math.max(1, Math.round(entry.contentRect.width * dpr));
      entry.target.height = Math.max(1, Math.round(entry.contentRect.height * dpr));
    }
    refresh();
  });
  const visibility = new IntersectionObserver(entries => {
    for (const entry of entries) slots.find(slot => slot.canvas === entry.target).visible = entry.isIntersecting;
    refresh();
  });
  slots.forEach(slot => { size.observe(slot.canvas); visibility.observe(slot.canvas); });
  document.addEventListener('visibilitychange', refresh); reduce.addEventListener('change', refresh);
  addEventListener('pagehide', () => { gone = true; if (frame) cancelAnimationFrame(frame); frame = 0; });
  addEventListener('pageshow', () => { gone = false; refresh(); });
  source.addEventListener('webglcontextlost', () => { lost = true; if (frame) cancelAnimationFrame(frame); slots.forEach(slot => { slot.canvas.parentElement.classList.remove('sky-ready'); slot.ctx?.clearRect(0, 0, slot.canvas.width, slot.canvas.height); }); });
  return { setState(value) { state = value; refresh(); }, setPaused(value) { paused = value; refresh(); }, refresh };
}
