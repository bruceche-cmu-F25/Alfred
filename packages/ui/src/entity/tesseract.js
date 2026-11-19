/* Alfred's figure: a wireframe tesseract (the body), and a 3D wireframe one step simpler for every other state.
 *
 *   rest    tesseract, almost still (the body)       hello   tesseract, slowly unfolding and back (the body)
 *   listen  a globe turning, swelling with your voice think    an octahedron spinning like a top
 *   speak   four stacked rings swelling with a voice  work     a hex nut turned a sixth at a time
 *   notice  a tetrahedron, amber, hopping             done     a cube, settled, green
 *   error   two crossed beams, red, shaking           sleep    a flat slab lying down, breathing
 *
 * A change between two figures is a redraw: the old one's wires shrink back to their middles and fade while the new
 * one draws itself wire by wire, like a pen, turning gently into place. Poses of the same figure glide. Lines further from the viewer are mixed toward the
 * background colour, so the wireframes read as solid space; the menu-bar (mono) version stays flat.
 *
 * Used by the Mac app's presence window and menu-bar icon, and by the prototypes (prototype/figure.js links here).
 * Design record: docs/research/alfred-entity.md §4.4. State sheet: prototype/tesseract.html.
 * Nothing here touches the DOM until createFigure() or drawMark() is called, so Node can import the geometry.
 */

export const STATES = ["rest", "hello", "listen", "think", "speak", "work", "notice", "done", "error", "sleep"];
export const PALETTES = {
  light: { ind: "#4967c5", light: "#a9b8f2", amber: "#e09a1f", ok: "#2f9a64", now: "#d9443f" },
  dark: { ind: "#86a0f2", light: "#56649c", amber: "#efaa3e", ok: "#4cc38a", now: "#f05a54" },
};
/* States that show colour even in the monochrome (menu-bar) version. */
export const LOUD = ["notice", "done", "error"];

const S = Math.sin, Cs = Math.cos, PI = Math.PI, abs = Math.abs, max = Math.max;
const NSEG = 96;
const voice = (t) => max(0, 0.5 + 0.3 * S(t * 7.3) + 0.25 * S(t * 12.1 + 1) + 0.2 * S(t * 2.3));
const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgbHex = (c) => "#" + c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("");
const mix = (a, b, u) => a.map((x, i) => x + (b[i] - x) * u);

/* ── Viewing: a fixed three-quarter view. view() returns [x, y, nearness]; bigger nearness is closer. ── */
const YAW = 0.62, PITCH = 0.5;
const view = ([X, Y, Z]) => { const x1 = X * Cs(YAW) + Z * S(YAW), z1 = -X * S(YAW) + Z * Cs(YAW); return [x1, Y * Cs(PITCH) - z1 * S(PITCH), -(Y * S(PITCH) + z1 * Cs(PITCH))]; };
const rotY = ([x, y, z], a) => [x * Cs(a) + z * S(a), y, -x * S(a) + z * Cs(a)];
const rotX = ([x, y, z], a) => [x, y * Cs(a) - z * S(a), y * S(a) + z * Cs(a)];
const rotZ = ([x, y, z], a) => [x * Cs(a) - y * S(a), x * S(a) + y * Cs(a), z];
/* 4D → 3D: rotate in the XW, YW, ZW planes, then perspective along W. Returns [x, y, z, w]. */
function proj4(v, { xw = 0, yw = 0, zw = 0, D = 2.7 } = {}) {
  return v.map(([x, y, z, w]) => {
    let X = x * Cs(xw) - w * S(xw), W = x * S(xw) + w * Cs(xw);
    let Y = y * Cs(yw) - W * S(yw); W = y * S(yw) + W * Cs(yw);
    let Z = z * Cs(zw) - W * S(zw); W = z * S(zw) + W * Cs(zw);
    const k = 1 / (D - W); return [X * k, Y * k, Z * k, W];
  });
}
const TV = Array.from({ length: 16 }, (_, i) => [i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1, i & 8 ? 1 : -1]);
/* Edges join vertices that differ in one coordinate; the third field marks the 8 edges along W (inner to outer cube). */
const TE = []; for (let i = 0; i < 16; i++) for (let j = i + 1; j < 16; j++) { const x = i ^ j; if ((x & (x - 1)) === 0) TE.push([i, j, x === 8]); }
const FIT = (() => { const p = proj4(TV).map(view), xs = p.map((q) => q[0]), ys = p.map((q) => q[1]); return { s: 92 / Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)), cx: (Math.max(...xs) + Math.min(...xs)) / 2, cy: (Math.max(...ys) + Math.min(...ys)) / 2 }; })();
/* Figures are drawn in a 120 × 120 box. */
const place = ([x, y], sc = 1) => [60 + (x - FIT.cx) * FIT.s * sc, 60 + (y - FIT.cy) * FIT.s * sc];
/* A segment is [endA, endB, isWEdge, nearnessA, nearnessB]. */
const segs = (pts3, edges, { sc = 1, cam = view } = {}) => { const v = pts3.map(cam), p = v.map((q) => place(q, sc)); return edges.map(([i, j, w]) => [p[i], p[j], !!w, v[i][2], v[j][2]]); };
const near = (s) => (s[3] + s[4]) / 2;

/* Cut a figure's edges into exactly NSEG pieces. How many pieces each edge gets is fixed per figure (by length,
   the first time it is drawn), so pieces never jump between edges as the figure turns. */
const ALLOC = {};
function cut(list, key) {
  if (list.length === NSEG) return list;
  if (!ALLOC[key]) {
    const L = list.map(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]) + 1e-6), tot = L.reduce((x, y) => x + y, 0);
    const n = L.map((l) => Math.max(1, Math.floor((l / tot) * NSEG)));
    for (let left = NSEG - n.reduce((x, y) => x + y, 0); left > 0; left--) { let best = 0; for (let i = 1; i < n.length; i++) if (L[i] / n[i] > L[best] / n[best]) best = i; n[best]++; }
    ALLOC[key] = n;
  }
  const out = [], lerp = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  list.forEach(([a, b, w, na, nb], i) => { const n = ALLOC[key][i]; for (let k = 0; k < n; k++) out.push([lerp(a, b, k / n), lerp(a, b, (k + 1) / n), w, na + (nb - na) * (k / n), na + (nb - na) * ((k + 1) / n)]); });
  return out;
}
const ring = (n, f) => { const pts = Array.from({ length: n }, (_, i) => f((i / n) * PI * 2)); return { pts, edges: pts.map((_, i) => [i, (i + 1) % n]) }; };
const merge = (...parts) => { const pts = [], edges = []; for (const p of parts) { const o = pts.length; pts.push(...p.pts); edges.push(...p.edges.map(([i, j]) => [i + o, j + o])); } return { pts, edges }; };

/* ── The figures ── */
/* The tesseract's nearness adds its fourth dimension: the inner cube is further away along W, so it is a little lighter. */
const cam4 = (q) => { const v = view(q); return [v[0], v[1], v[2] + 0.25 * q[3]]; };
const tesseract = (o, sc) => segs(proj4(TV, o), TE, { sc, cam: cam4 });
const CUBEV = Array.from({ length: 8 }, (_, i) => [i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1]);
const CUBEE = []; for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) { const x = i ^ j; if ((x & (x - 1)) === 0) CUBEE.push([i, j]); }
const OCTV = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const OCTE = []; for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) if ((i >> 1) !== (j >> 1)) OCTE.push([i, j]);
const TETV = [[0, -1.15, 0], [0.94, 0.42, 0.54], [-0.94, 0.42, 0.54], [0, 0.42, -1.09]];
const TETE = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
const HEXV = [...Array.from({ length: 6 }, (_, i) => [0.8 * Cs((i * PI) / 3), -0.36, 0.8 * S((i * PI) / 3)]), ...Array.from({ length: 6 }, (_, i) => [0.8 * Cs((i * PI) / 3), 0.36, 0.8 * S((i * PI) / 3)])];
const HEXE = [...Array.from({ length: 6 }, (_, i) => [i, (i + 1) % 6]), ...Array.from({ length: 6 }, (_, i) => [6 + i, 6 + ((i + 1) % 6)]), ...Array.from({ length: 6 }, (_, i) => [i, 6 + i])];
const BEAMV = CUBEV.map(([x, y, z]) => [x * 0.82, y * 0.13, z * 0.13]);

/* The greeting's timing in s: still, unfold, held open, fold back (also `move`), then still again till the cycle ends. */
const HELLO = { rest: 3, move: 2.6, hold: 1.2, cycle: 11 };

/* ── States: (time in s, entry spin in rad) → { s: segments, col: palette key, dx, dy, depth }. ── */
const STATE = {
  rest: (t) => ({ s: cut(tesseract({ xw: 0.12 * S(t * 0.55) }), "body"), col: "ind", depth: true }),
  // a slow, full turn through the fourth dimension: the inner cube swells out until it is the outer one, a pause,
  // then it folds back the same way; long rests between
  hello: (t) => {
    const ph = t % HELLO.cycle, { rest, move, hold } = HELLO, glide = (x) => (1 - Cs(PI * Math.min(1, Math.max(0, x)))) / 2;
    const u = ph < rest ? 0 : ph < rest + move ? glide((ph - rest) / move) : ph < rest + move + hold ? 1 : 1 - glide((ph - rest - move - hold) / move);
    return { s: cut(tesseract({ xw: u * PI + 0.12 * S(t * 0.55) }), "body"), col: "ind", dy: -3 * S(u * PI), depth: true };
  },
  // a globe: equator and three meridians, turning; it swells a little with your voice
  listen: (t, e) => {
    const R = 0.72 * (1 + 0.07 * voice(t * 0.7 + 3)), spin = t * 0.35 + e;
    const meridian = (phi) => ring(24, (a) => [R * Cs(a) * Cs(phi), R * S(a), R * Cs(a) * S(phi)]);
    const g = merge(ring(24, (a) => [R * Cs(a), 0, R * S(a)]), meridian(spin), meridian(spin + PI / 3), meridian(spin + (2 * PI) / 3));
    return { s: segs(g.pts.map((p) => rotX(p, 0.2)), g.edges), col: "ind", depth: true };
  },
  // a spinning top: speeds up and slows as it turns the idea over, and wobbles
  think: (t, e) => { const ry = t * 0.7 + 0.55 * S(t * 0.9) + e, rx = 0.2 * S(t * 0.6); return { s: cut(segs(OCTV.map((v) => rotX(rotY(v.map((c) => c * 0.88), ry), rx)), OCTE), "oct"), col: "ind", depth: true }; },
  // four rings stacked like a sphere's latitudes; each swells with the voice, one after another, bottom to top
  speak: (t, e) => {
    const R = 0.62, lat = [0.72, 0.25, -0.25, -0.72];
    const g = merge(...lat.map((u, i) => { const r = R * Math.sqrt(1 - u * u) * (1 + 0.32 * voice(t - i * 0.09)); return ring(24, (a) => [r * Cs(a + e), R * u * 1.2, r * S(a + e)]); }));
    return { s: segs(g.pts.map((p) => rotZ(p, 0.08 * S(t * 0.9))), g.edges), col: "ind", depth: true };
  },
  // a nut being turned: a sixth of a turn at a time
  work: (t, e) => { const ph = (t * 0.8) % 1, step = Math.floor(t * 0.8), ry = ((step + ease(ph / 0.35)) * PI) / 3 + e; return { s: cut(segs(HEXV.map((v) => rotX(rotY(v, ry), 0.12)), HEXE), "hex"), col: "ind", depth: true }; },
  notice: (t, e) => ({ s: cut(segs(TETV.map((v) => rotX(rotY(v.map((c) => c * 0.8), 0.5 + 0.25 * S(t * 1.5) + e), 0.05)), TETE), "tet"), col: "amber", dy: -5 * abs(S(t * 4.2)), depth: true }),
  done: (t, e) => ({ s: cut(segs(CUBEV.map((v) => rotY(v.map((c) => c * 0.55), 0.08 * S(t * 0.8) + e)), CUBEE), "cube"), col: "ok", depth: true }),
  // two crossed beams, seen a little from the side, shaking
  error: (t, e) => {
    const ph = (t * 0.9) % 1, sway = 0.42 + 0.12 * S(t * 0.7) + e;
    const cam = (p) => { const q = rotX(rotY(p, sway), -0.32); return [q[0], q[1], -q[2]]; };
    const pts = [...BEAMV.map((v) => rotZ(v, PI / 4)), ...BEAMV.map((v) => rotZ(v, -PI / 4))];
    return { s: cut(segs(pts, [...CUBEE, ...CUBEE.map(([i, j]) => [i + 8, j + 8])], { cam }), "x"), col: "now", dx: ph < 0.3 ? 4 * S(ph * 80) * (1 - ph / 0.3) : 0, depth: true };
  },
  // lying down: a flat slab that breathes
  sleep: (t, e) => { const h = 0.07 + 0.03 * S(t * 1.1); return { s: cut(segs(CUBEV.map(([x, y, z]) => rotY([x * 0.6, y * h, z * 0.6], 0.2 + e)), CUBEE), "slab"), col: "light", dy: 8, depth: true }; },
};
const BODY = ["rest", "hello"]; // in mono and small sizes the body drops the 8 W edges, leaving a cube in a cube

/**
 * The resting mark as plain segments in a 120 × 120 box: [[x1, y1], [x2, y2], nearness 0..1].
 * mono drops the 8 W edges (for 16 px and template images). Pure; safe to call from Node.
 */
export function markSegments({ mono = false } = {}) {
  const e = tesseract({}).filter((s) => !(mono && s[2])), ns = e.map(near), lo = Math.min(...ns), hi = Math.max(...ns);
  return e.map((s, i) => [s[0], s[1], (ns[i] - lo) / (hi - lo)]);
}

/* ── Colours from CSS: any syntax (oklch, color-mix…) resolved through a 1 px canvas. ── */
let probe = null;
function toRgba(css) {
  if (!probe) { const c = document.createElement("canvas"); c.width = c.height = 1; probe = c.getContext("2d", { willReadFrequently: true }); }
  probe.clearRect(0, 0, 1, 1); probe.fillStyle = "#0000"; probe.fillStyle = css; probe.fillRect(0, 0, 1, 1);
  return [...probe.getImageData(0, 0, 1, 1).data];
}
/* The colour the figure sits on: the first ancestor with a visible background. */
function findBackground(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const c = toRgba(getComputedStyle(n).backgroundColor); if (c[3] > 8) return c.slice(0, 3); }
  return null;
}
const resolveBg = (svg, background) => (background === "auto" ? findBackground(svg.parentElement) : background ? toRgba(background).slice(0, 3) : null);

/**
 * Draws the static mark into an <svg viewBox="0 0 120 120">. Far edges are mixed toward the background.
 * mono: no depth, W edges dropped, drawn in currentColor.
 */
export function drawMark(svg, { width = 5, dark = false, background = "auto", mono = false } = {}) {
  const bg = mono ? null : resolveBg(svg, background), ink = hexRgb(PALETTES[dark ? "dark" : "light"].ind);
  const lines = markSegments({ mono }).sort((a, b) => a[2] - b[2]).map(([a, b, f]) => {
    const stroke = mono ? "currentColor" : rgbHex(bg ? mix(ink, bg, (1 - f) * 0.62) : ink);
    return `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" stroke="${stroke}"/>`;
  });
  svg.innerHTML = `<g stroke-width="${width}" stroke-linecap="round">${lines.join("")}</g>`;
}

/* ── Live figures: one animation loop for all of them. ──
 * A change between two different figures is a redraw, not a reshuffle: the old figure's wires shrink back toward
 * their own middles and fade (in its own colour), while the new figure draws itself wire by wire, like a pen, turning
 * gently into place (already in its colour). The two overlap a little, so it reads as one motion, and the lines are
 * always whole. Between poses of the same figure (the body resting and greeting) it simply glides. */
const figures = new Set();
const SVGNS = "http://www.w3.org/2000/svg";
const GLIDE_S = 0.5, OUT_S = 0.42, IN_AT = 0.16, SWEEP_S = 0.22, IN_S = 0.5, ENTRY_SPIN = 0.55;
const REDRAW_S = IN_AT + SWEEP_S + IN_S;
const easeInOut = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOut = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 - Math.pow(1 - x, 3));
const easeIn = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x);
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const family = (state) => (BODY.includes(state) ? "body" : state);
let running = false;

/* A figure's wires: runs of pieces that join end to start (an edge cut into pieces, a ring), ordered around the
   figure so a redraw sweeps round it. Fixed per state, so worked out once. */
const WIRES = {};
function wiresOf(state) {
  if (WIRES[state]) return WIRES[state];
  const pieces = STATE[state](0, 0).s, wires = [];
  let wire = [0];
  for (let k = 1; k < pieces.length; k++) {
    const [x0, y0] = pieces[k - 1][1], [x1, y1] = pieces[k][0];
    if ((x0 - x1) ** 2 + (y0 - y1) ** 2 < 1e-6) wire.push(k); else { wires.push(wire); wire = [k]; }
  }
  wires.push(wire);
  const middle = (w) => { const p = pieces[w[Math.floor(w.length / 2)]]; return Math.atan2((p[0][1] + p[1][1]) / 2 - 60, (p[0][0] + p[1][0]) / 2 - 60); };
  return (WIRES[state] = wires.map((w) => ({ w, key: middle(w) })).sort((a, b) => a.key - b.key).map(({ w }) => w));
}

function makeLayer() {
  const g = document.createElementNS(SVGNS, "g");
  const lines = Array.from({ length: NSEG }, () => {
    const line = g.appendChild(document.createElementNS(SVGNS, "line"));
    line.style.display = "none"; // until the first frame places it
    return line;
  });
  return { g, lines, order: [] };
}

/* Paints one figure into a layer. `span(wire, wires, length)` gives the visible part of each wire as
   [from, to] along it; pieces outside are hidden, pieces across an end are trimmed. */
function paint(I, layer, state, frame, span, fade) {
  const s = frame.s, pal = PALETTES[I.dark ? "dark" : "light"];
  const loud = I.mono && LOUD.includes(state);
  const base = I.mono && !loud ? null : hexRgb(pal[frame.col]), bg = I.bg || [255, 255, 255];
  const shade = frame.depth && !I.mono && I.bg ? 0.62 : 0;
  let lo = Infinity, hi = -Infinity;
  for (const piece of s) { const d = near(piece); if (d < lo) lo = d; if (d > hi) hi = d; }
  const depth = (i) => (hi > lo ? (near(s[i]) - lo) / (hi - lo) : 1);
  const shown = new Array(NSEG).fill(null);
  const wires = wiresOf(state);
  wires.forEach((wire, n) => {
    const lengths = wire.map((i) => Math.hypot(s[i][1][0] - s[i][0][0], s[i][1][1] - s[i][0][1]));
    const total = lengths.reduce((a, b) => a + b, 0);
    const [from, to] = span ? span(n, wires.length, total) : [0, total];
    let at = 0;
    wire.forEach((i, k) => {
      const a0 = at, a1 = at + lengths[k];
      at = a1;
      const u0 = Math.max(a0, from), u1 = Math.min(a1, to);
      if (u1 - u0 < 1e-3) return;
      const [p, q] = s[i], len = lengths[k] || 1, t0 = (u0 - a0) / len, t1 = (u1 - a0) / len;
      shown[i] = [p[0] + (q[0] - p[0]) * t0, p[1] + (q[1] - p[1]) * t0, p[0] + (q[0] - p[0]) * t1, p[1] + (q[1] - p[1]) * t1];
    });
  });
  // Far lines first, so near lines cross over them; reorder the DOM only when the order changes.
  const order = Array.from({ length: NSEG }, (_, i) => i).sort((a, b) => depth(a) - depth(b));
  if (order.some((n, k) => n !== layer.order[k])) { for (const n of order) layer.g.appendChild(layer.lines[n]); layer.order = order; }
  const hideW = (I.mono || I.small) && BODY.includes(state);
  for (let i = 0; i < NSEG; i++) {
    const line = layer.lines[i], v = shown[i];
    if (!v || (hideW && s[i][2])) { line.style.display = "none"; continue; }
    line.style.display = "";
    line.setAttribute("x1", v[0].toFixed(2)); line.setAttribute("y1", v[1].toFixed(2));
    line.setAttribute("x2", v[2].toFixed(2)); line.setAttribute("y2", v[3].toFixed(2));
    line.setAttribute("stroke", base ? rgbHex(mix(base, bg, (1 - depth(i)) * shade)) : "currentColor");
    line.setAttribute("opacity", fade < 0.98 ? fade.toFixed(2) : "1");
  }
  layer.g.setAttribute("transform", `translate(${(frame.dx || 0).toFixed(2)} ${(frame.dy || 0).toFixed(2)})`);
  layer.g.style.display = "";
}

function step(I, t, still) {
  if (I.state !== I.now) {
    const from = I.now;
    I.now = I.state;
    if (still) I.mode = null;
    else if (I.mode === "redraw" && t - I.changed < REDRAW_S && family(I.state) === family(from)) {
      // Mid-redraw to another pose of the same figure: keep drawing, with the new pose.
    } else if (family(I.state) === family(from) && I.mode !== "redraw") {
      I.mode = "glide"; I.changed = t; I.glideFrom = I.pose.map((piece) => [[...piece[0]], [...piece[1]]]);
    } else {
      // What was being drawn (perhaps half drawn) leaves from where it had got to.
      const drawn = I.mode === "redraw" ? Math.min(1, Math.max(0, (t - I.changed - IN_AT) / (SWEEP_S + IN_S))) : 1;
      I.out = { state: from, drawn }; I.mode = "redraw"; I.changed = t;
    }
  }
  const since = t - I.changed;
  if (I.mode && since >= (I.mode === "glide" ? GLIDE_S : REDRAW_S)) { I.mode = null; I.out = null; }

  // The leaving figure: its wires shrink toward their middles and fade, still moving as it did.
  if (I.mode === "redraw" && I.out && since < OUT_S) {
    const left = I.out.drawn * (1 - easeIn(since / OUT_S));
    paint(I, I.layers.out, I.out.state, STATE[I.out.state](t, 0), (_, __, total) => [total * (1 - left) / 2, total * (1 + left) / 2], 0.35 + 0.65 * left);
  } else I.layers.out.g.style.display = "none";

  // The arriving figure: drawn wire by wire, sweeping round, turning into place as it forms.
  const spin = I.mode === "redraw" ? (1 - easeOut(since / REDRAW_S)) * ENTRY_SPIN : 0;
  let frame = STATE[I.now](t, spin);
  if (I.mode === "glide") {
    const w = easeInOut(since / GLIDE_S);
    frame = { ...frame, s: frame.s.map((piece, i) => {
      const [a0, b0] = I.glideFrom[i];
      return [[a0[0] + (piece[0][0] - a0[0]) * w, a0[1] + (piece[0][1] - a0[1]) * w], [b0[0] + (piece[1][0] - b0[0]) * w, b0[1] + (piece[1][1] - b0[1]) * w], piece[2], piece[3], piece[4]];
    }) };
  }
  I.pose = frame.s;
  const span = I.mode === "redraw"
    ? (n, count, total) => [0, total * easeOut((since - IN_AT - (n / count) * SWEEP_S) / IN_S)]
    : null;
  paint(I, I.layers.in, I.now, frame, span, 1);
  I.svg.dataset.state = I.now;
  I.svg.classList.toggle("loud", I.mono && LOUD.includes(I.now));
}

function frame(now) {
  if (!figures.size) { running = false; return; }
  const still = reduced(), t = still ? 0.6 : now / 1000;
  for (const I of figures) if (I.svg.isConnected) step(I, t, still);
  requestAnimationFrame(frame);
}

/**
 * Animates the figure in an <svg viewBox="0 0 120 120">.
 * width: stroke width in the 120 box (≈ 4 at 100 px+, 5.5 at 36 px, 7 at 18 px).
 * mono: menu-bar style, currentColor except notice/done/error, no depth; small: drop the W edges at small sizes.
 * background: "auto" (nearest ancestor's background), a CSS colour, or null (no depth shading).
 */
export function createFigure(svg, { state = "rest", width = 4, mono = false, small = false, dark = false, background = "auto" } = {}) {
  const first = STATES.includes(state) ? state : "rest";
  const root = document.createElementNS(SVGNS, "g");
  root.setAttribute("stroke-width", String(width));
  root.setAttribute("stroke-linecap", "round");
  const layers = { out: makeLayer(), in: makeLayer() };
  root.append(layers.out.g, layers.in.g);
  svg.replaceChildren(root);
  const I = {
    svg, layers, mono, small, dark, state: first, now: first, mode: null, changed: -Infinity, out: null,
    pose: STATE[first](0, 0).s, glideFrom: null, bg: resolveBg(svg, background),
  };
  figures.add(I);
  if (!running) { running = true; requestAnimationFrame(frame); }
  return {
    get state() { return I.state; },
    setState(next) { if (STATES.includes(next)) I.state = next; },
    setDark(next) { I.dark = !!next; I.bg = resolveBg(svg, background); },
    /** Re-reads the background colour, e.g. after a theme change. */
    refresh() { I.bg = resolveBg(svg, background); },
    destroy() { figures.delete(I); svg.replaceChildren(); },
  };
}
