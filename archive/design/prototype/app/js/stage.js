/** The stage: one canvas over the whole viewport, on the page's 9px grid.
 *
 *  Same method as bruce-portfolio's BlackHole.tsx: every frame each cell gets a
 *  brightness from a small model, and that brightness is quantised into the
 *  hour's four-colour heat ramp (plus a white-hot fifth) through a 4×4 ordered
 *  dither. Here the model is 3D — a lit sphere, gyroscope rings turning in
 *  their own planes, motes on orbits — projected onto the grid, so the entity
 *  reads as "3渲2": real depth, drawn as pixel art.
 *
 *  Everything that lives on the grid writes into one field (max-blend):
 *    entity     the hero: lit core, gyroscope rings, and an outer ring that turns in 3D
 *    links      dotted connectors from the entity to open panels
 *    sweeps     a panel being built in / taken down, row by row
 *    trail      the pointer's heat, as on the portfolio
 *  The docked entity (workspace view) is drawn at a 3px cell in its own box.
 *
 *  Cost control: the loop only runs while something moves; a calm idle entity
 *  is drawn at ~20fps; a hidden tab stops; reduced motion draws still frames.
 */

export const CELL = 9
/** The entity is drawn on a half-cell sub-grid: every second line meets the
 *  page's 9px grid, and on a 2× screen each cell is exactly 9 device pixels. */
const HERO_CELL = CELL / 2
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16 - 0.5)

const clamp01 = v => Math.max(0, Math.min(1, v))
const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t) }
const lerp = (a, b, t) => a + (b - a) * t
const hash = (a, b) => {
  let n = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0
  n = Math.imul(n ^ (n >>> 13), 1274126177)
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}

/* ── the entity's moods ─────────────────────────────────────────
   Each state is a set of targets; the live values ease toward them, so any
   change of state is a smooth re-tuning of one object, never a swap. */
const MOODS = {
  sleep:     { energy: 0.38, spin: 0.25, spread: 0.92, scan: 0, wave: 0,   rings: 0.35, motes: 0.2, hud: 0.15, wedge: 0,   core: 0.55, voice: 0, rest: 1 },
  idle:      { energy: 0.85, spin: 1,    spread: 1,    scan: 0, wave: 0,   rings: 1,    motes: 0.8, hud: 0.8,  wedge: 0.7, core: 1,    voice: 0, rest: 0 },
  listening: { energy: 1,    spin: 0.55, spread: 1.04, scan: 0, wave: 1,   rings: 0.75, motes: 0.6, hud: 1,    wedge: 0.3, core: 1.05, voice: 0, rest: 0 },
  thinking:  { energy: 1,    spin: 3.2,  spread: 0.9,  scan: 1, wave: 0,   rings: 1,    motes: 1,   hud: 1,    wedge: 1,   core: 0.95, voice: 0, rest: 0 },
  speaking:  { energy: 1,    spin: 0.9,  spread: 1,    scan: 0, wave: 0.8, rings: 0.9,  motes: 0.8, hud: 0.9,  wedge: 0.5, core: 1.1,  voice: 1, rest: 0 },
}

/* gyroscope rings, in units of the entity's radius. tilt/roll set the plane,
   the ring turns in that plane; style draws it */
const RINGS = [
  { r: 0.52, tilt: 1.22, roll: 0.15, speed: 0.55, style: 'solid', bright: 0.5, width: 1 },
  { r: 0.68, tilt: 1.05, roll: -0.55, speed: -0.38, style: 'dash', bright: 0.46, width: 1 },
  { r: 0.82, tilt: -0.95, roll: 0.75, speed: 0.24, style: 'arcs', bright: 0.44, width: 2 },
]

/** points on a sphere, evenly spread (Fibonacci lattice), ordered by height
 *  so taking every k-th keeps them even: [x, y, z, phase, grain] */
const FIB = (() => {
  const n = 380, out = [], ga = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 2, r = Math.sqrt(1 - y * y), th = ga * i
    out.push([Math.cos(th) * r, y, Math.sin(th) * r, hash(i, 41) * Math.PI * 2, hash(i, 43)])
  }
  return out
})()
/** which entity: the rings (default) or the point sphere (?entity=swarm) */
export const ENTITY = new URLSearchParams(location.search).get('entity') === 'swarm' ? 'swarm' : 'rings'

const MOTES = Array.from({ length: 22 }, (_, i) => ({
  r: 0.5 + hash(i, 3) * 0.62,
  tilt: (hash(i, 5) - 0.5) * 2.6,
  roll: hash(i, 7) * Math.PI,
  speed: (0.25 + hash(i, 11) * 0.6) * (hash(i, 13) > 0.5 ? 1 : -1),
  phase: hash(i, 17) * Math.PI * 2,
  hot: hash(i, 19) > 0.8,
}))

function rotate(x, y, z, tilt, roll, turn) {
  // turn in the ring's own plane (around z), tilt around x, roll around z
  let c = Math.cos(turn), s = Math.sin(turn)
  let x1 = x * c - y * s, y1 = x * s + y * c, z1 = z
  c = Math.cos(tilt); s = Math.sin(tilt)
  let y2 = y1 * c - z1 * s, z2 = y1 * s + z1 * c
  c = Math.cos(roll); s = Math.sin(roll)
  return [x1 * c - y2 * s, x1 * s + y2 * c, z2]
}
/** turn a point with the entity's gaze: yaw about the screen's y, then pitch
 *  about its x (positive pitch looks up) */
function aim(x, y, z, yaw, pitch) {
  let c = Math.cos(yaw), s = Math.sin(yaw)
  const x1 = x * c + z * s, z1 = -x * s + z * c
  c = Math.cos(pitch); s = Math.sin(pitch)
  return [x1, y * c - z1 * s, y * s + z1 * c]
}
/** critically-ish damped spring, so moves and turns settle with a little life */
function spring(o, key, target, dt, k, zeta) {
  const v = 'v_' + key
  const a = k * (target - o[key]) - 2 * zeta * Math.sqrt(k) * (o[v] || 0)
  o[v] = (o[v] || 0) + a * dt
  o[key] += o[v] * dt
}

export function createStage(canvas) {
  const ctx = canvas.getContext('2d', { alpha: true })
  const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  const rgb = value => {
    probe.fillStyle = '#000'; probe.fillStyle = value.trim() || '#fff'
    probe.fillRect(0, 0, 1, 1)
    const d = probe.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2]]
  }
  let ramp = [], amber = '#dcb181'
  const sats = [], flyers = []
  const readRamp = () => {
    const st = getComputedStyle(document.documentElement)
    const heat = [1, 2, 3, 4].map(i => rgb(st.getPropertyValue(`--heat-${i}`)))
    const hot = heat[3].map(c => Math.round(c + (255 - c) * 0.6))
    ramp = [...heat, hot].map(c => `rgb(${c[0]} ${c[1]} ${c[2]})`)
    amber = st.getPropertyValue('--amber').trim() || '#dcb181'
  }
  readRamp()
  new MutationObserver(readRamp).observe(document.documentElement, { attributes: true, attributeFilter: ['data-hour'] })

  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches
  const finePointer = matchMedia('(pointer: fine)').matches

  let width = 0, height = 0, cols = 0, rows = 0
  let field = new Float32Array(0)
  let trail = new Float32Array(0)
  const resize = () => {
    width = innerWidth; height = innerHeight
    const dpr = Math.min(devicePixelRatio || 1, 2)
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr)
    canvas.style.width = width + 'px'; canvas.style.height = height + 'px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    cols = Math.ceil(width / CELL); rows = Math.ceil(height / CELL)
    field = new Float32Array(cols * rows)
    trail = new Float32Array(cols * rows)
    kick()
  }

  /* ── public state ── */
  const hero = {
    mood: 'sleep', live: { ...MOODS.sleep },
    x: 0, y: 0, R: 120,             // current (eased)
    tx: 0, ty: 0, tR: 120,          // target
    vis: 1, tvis: 1,                // dissolve
    wedgeAngle: -0.6, tWedge: -0.6,
    yaw: 0, pitch: 0,               // gaze (springs)
    look: null,                     // { x, y, until } — what it's looking at
    env: 0, envNow: 0,              // the speaking envelope: swell with each word
    level: 0,                       // mic / voice level 0..1
    spectrum: new Float32Array(48), // circular waveform
    notice: 0, tNotice: 0,          // a quiet amber mote when something waits
    sats: 0,                        // point sphere: one satellite per waiting result
    bootAt: -1,
  }
  const dock = { el: null, vis: 0, tvis: 0 }
  const links = []           // {el}
  const sweeps = []          // {el, start, dur, dir, done}
  const embers = []

  let raf = 0, lastFrame = 0, lastDraw = 0, time = 0
  let pointer = { x: -1, y: -1, px: -1, py: -1, on: false }

  const kick = () => { if (!raf && !document.hidden) raf = requestAnimationFrame(frame) }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { lastFrame = 0; kick() } })
  addEventListener('resize', resize)

  if (finePointer && !calm) {
    addEventListener('pointermove', e => {
      if (!pointer.on) { pointer.px = e.clientX; pointer.py = e.clientY }
      pointer.x = e.clientX; pointer.y = e.clientY; pointer.on = true; kick()
    }, { passive: true })
    document.addEventListener('pointerleave', () => { pointer.on = false })
    addEventListener('pointerdown', e => {
      for (let i = 0; i < 14; i++) {
        const a = Math.random() * Math.PI * 2, v = 0.08 + Math.random() * 0.22
        embers.push({ x: e.clientX, y: e.clientY, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.05, born: time, life: 380 + Math.random() * 380 })
      }
      kick()
    })
  }

  /** a screen point → yaw/pitch for the gaze */
  const aimAt = (x, y) => {
    const D = Math.max(hero.R * 2.6, 240)
    const yaw = Math.max(-1.05, Math.min(1.05, Math.atan2(x - hero.x, D) * 1.05))
    const pitch = Math.max(-0.8, Math.min(0.8, -Math.atan2(y - hero.y, D) * 0.95))
    return [yaw, pitch]
  }

  /* ── field writers ── */
  const put = (c, r, v) => {
    if (c < 0 || r < 0 || c >= cols || r >= rows) return
    const i = r * cols + c
    if (v > field[i]) field[i] = v
  }

  /** The entity: a lit sphere with gyroscope rings and motes inside, and an
   *  outer ring that is the equator of one big sphere around all of it. At
   *  rest that ring faces you, flat; when Alfred attends to something the ring
   *  tilts toward it like a dish turning, while the dotted limb stays round —
   *  so the whole thing reads as one ball turning, not a face. */
  function paintEntity(buf, bc, br, cell, ox, oy, cx, cy, R0, L, t, vis, putFn) {
    const env = hero.envNow
    const R = R0 * (1 + 0.06 * env + 0.03 * hero.level * L.wave)
    const ext = R * 1.32
    const c0 = Math.max(0, Math.floor((cx - ext) / cell)), c1 = Math.min(bc - 1, Math.ceil((cx + ext) / cell))
    const r0 = Math.max(0, Math.floor((cy - ext) / cell)), r1 = Math.min(br - 1, Math.ceil((cy + ext) / cell))
    const boot = hero.bootAt < 0 ? 1 : clamp01((t - hero.bootAt) / 1.6)
    const bootCore = smooth(0, 0.35, boot), bootRings = smooth(0.2, 0.8, boot), bootHud = smooth(0.45, 1, boot)
    const breathe = 1 + Math.sin(t * 1.1) * 0.025 * L.energy + hero.level * 0.06 * L.wave + 0.1 * env
    const rc = 0.21 * L.core * breathe * (0.4 + 0.6 * bootCore)
    const lightA = t * 0.35
    const lx = Math.cos(lightA) * 0.55, ly = -0.55, lz = 0.62
    const spinT = hero.spinPhase
    const yaw = hero.yaw, pitch = hero.pitch
    // the inside turns with the gaze too, a little less than the outer ring,
    // so the layers read as depth
    const iy = yaw * 0.6, ip = pitch * 0.6
    const fx = Math.sin(iy) * Math.cos(ip), fy = -Math.sin(ip), fz = Math.cos(iy) * Math.cos(ip)
    const depth = new Float32Array((c1 - c0 + 1) * (r1 - r0 + 1)).fill(-9)
    const W = c1 - c0 + 1
    const dissolveGate = (c, r) => vis >= 1 || hash(c + 911, r + 377) < vis

    // per-cell: sphere, halo, waveform, wedge, limb
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (!dissolveGate(c, r)) continue
        const u = ((c + 0.5) * cell - cx) / R, v = ((r + 0.5) * cell - cy) / R
        const d = Math.hypot(u, v)
        let val = 0
        if (d < rc) {
          const z = Math.sqrt(rc * rc - d * d)
          const nx = u / rc, ny = v / rc, nz = z / rc
          depth[(r - r0) * W + (c - c0)] = z
          const lam = Math.max(0, nx * lx + ny * ly + nz * lz)
          const rim = Math.pow(1 - nz, 2.2)
          // surface coords on a sphere turning about a tilted axis
          // undo the gaze turn (pitch, then yaw) so the grid is fixed to the turning body
          let bx = nx, by = ny * Math.cos(-ip) - nz * Math.sin(-ip), bz = ny * Math.sin(-ip) + nz * Math.cos(-ip)
          const cy0 = Math.cos(-iy), sy0 = Math.sin(-iy)
          ;[bx, bz] = [bx * cy0 + bz * sy0, -bx * sy0 + bz * cy0]
          const [sx, sy, sz] = rotate(bx, by, bz, 0.35, 0, 0)
          const lon = Math.atan2(sx, sz) + spinT * 0.6, lat = Math.asin(Math.max(-1, Math.min(1, sy)))
          const gl = Math.abs(((lon * 6 / Math.PI) % 1 + 1) % 1 - 0.5) > 0.42 || Math.abs(((lat * 6 / Math.PI) % 1 + 1) % 1 - 0.5) > 0.44
          val = 0.16 + 0.48 * lam + rim * 0.32 + (gl ? 0.16 : 0)
          if (L.scan > 0.01) {
            const band = ((t * 0.9) % 1.6) - 0.3
            val += L.scan * 0.5 * Math.exp(-(((v / rc + 1) / 2 - band) ** 2) / 0.006)
          }
          val *= (0.55 + 0.45 * L.energy) * bootCore
          // the hot spot sits on the side it faces
          if (nx * fx + ny * fy + nz * fz > 0.9) val = Math.max(val, (0.92 + 0.1 * env) * bootCore * L.energy)
        } else {
          const hd = d - rc
          val = Math.exp(-(hd * hd) / 0.0006) * (0.5 + 0.2 * env) * bootCore * L.energy
          val = Math.max(val, (hash(c, r) < 0.28 ? 1 : 0) * smooth(0.17, 0, hd) * (0.3 + 0.15 * env) * L.energy * bootCore)
          const ang = Math.atan2(v, u)
          const a01 = (ang / (Math.PI * 2) + 1) % 1
          if (L.wave > 0.02) {
            const bins = hero.spectrum.length
            const fi = a01 * bins, i0 = Math.floor(fi) % bins, i1 = (i0 + 1) % bins
            const amp = lerp(hero.spectrum[i0], hero.spectrum[i1], fi - Math.floor(fi))
            const rw = rc + 0.1 + amp * 0.2 * L.wave
            if (Math.abs(d - rw) < 0.011 + amp * 0.01) val = Math.max(val, (0.45 + amp * 0.55) * L.wave)
            if (d > rc + 0.1 && d < rw && hash(c, r * 3) < 0.12) val = Math.max(val, 0.28 * L.wave)
          }
          const hud = L.hud * bootHud
          if (hud > 0.01) {
            // the wedge: a checkered sector that points where attention is
            if (L.wedge > 0.01 && d > 0.36 && d < 0.88) {
              const da = Math.atan2(Math.sin(ang - hero.wedgeAngle), Math.cos(ang - hero.wedgeAngle))
              if (Math.abs(da) < 0.36 && (c + r) % 2 === 0) val = Math.max(val, (0.26 + 0.14 * (1 - Math.abs(da) / 0.36)) * L.wedge * hud)
              if (Math.abs(Math.abs(da) - 0.36) < 0.02) val = Math.max(val, 0.42 * L.wedge * hud)
            }
            // the limb: the big sphere's outline, always round
            if (Math.abs(d - 1.22) < 0.009 && ((a01 * 220) % 1) < 0.3) val = Math.max(val, 0.26 * hud)
          }
        }
        if (val > 0) putFn(c, r, val * vis)
      }
    }

    // 3D: gyroscope rings and motes, projected and depth-tested against the core
    const proj = (x, y, z) => {
      const s = 1 / (1 - z * 0.14)
      return [cx + x * R * s, cy + y * R * s, s]
    }
    const plot = (px, py, z, val) => {
      const c = Math.floor(px / cell), r = Math.floor(py / cell)
      if (c < c0 || c > c1 || r < r0 || r > r1) return
      const dz = depth[(r - r0) * W + (c - c0)]
      if (dz > -9 && z < dz) val *= 0.18 // behind the core
      if (!dissolveGate(c, r)) return
      putFn(c, r, val * vis)
    }
    const ringVis = L.rings * bootRings
    if (ringVis > 0.01) RINGS.forEach((ring, k) => {
      const rr = ring.r * L.spread * (1 + 0.04 * Math.sin(t * 0.7 + k) + 0.04 * env)
      const n = Math.ceil((Math.PI * 2 * rr * R) / (cell * 0.45))
      const turn = hero.spinPhase * ring.speed
      const tilt = ring.tilt * (1 - 0.35 * L.wave) + Math.sin(t * 0.2 + k) * 0.05
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2
        if (ring.style === 'dash' && ((a / (Math.PI * 2)) * 36) % 1 > 0.55) continue
        if (ring.style === 'arcs' && ((a / (Math.PI * 2)) * 3) % 1 > 0.62) continue
        for (let w = 0; w < ring.width; w += 0.8) {
          const rad = rr + (w - (ring.width - 1) / 2) * (cell / R) * 0.9
          const [x, y, z] = aim(...rotate(Math.cos(a) * rad, Math.sin(a) * rad, 0, tilt, ring.roll, turn), iy, ip)
          const [px, py] = proj(x, y, z)
          plot(px, py, z, ring.bright * (0.62 + 0.38 * (z / rr + 1) / 2 * 1.2) * ringVis * L.energy)
        }
      }
      const [bx, by, bz] = aim(...rotate(rr, 0, 0, tilt, ring.roll, turn * 2.2 + k * 2), iy, ip)
      const [px, py] = proj(bx, by, bz)
      plot(px, py, bz, 1.0 * ringVis)
    })
    const moteVis = L.motes * bootRings
    if (moteVis > 0.01) MOTES.forEach((m, i) => {
      const a = m.phase + hero.spinPhase * m.speed * 0.8
      const rr = m.r * L.spread * (L.scan > 0.5 ? 0.82 : 1)
      const [x, y, z] = aim(...rotate(Math.cos(a) * rr, Math.sin(a) * rr, 0, m.tilt, m.roll, 0), iy * 0.8, ip * 0.8)
      const [px, py] = proj(x, y, z)
      plot(px, py, z, (m.hot ? 0.98 : 0.62) * moteVis * (0.7 + 0.3 * Math.sin(t * 3 + i)))
    })

    // ── the outer ring, in 3D: the equator of the big sphere, facing the gaze.
    // Flat to you at rest (the first version's ring); tilts toward what Alfred
    // attends to. Front half bright, back half dim and behind the core.
    const hud = L.hud * bootHud
    if (hud > 0.01) {
      const ay = yaw * 0.75, ap = pitch * 0.75
      const rot = t * 0.05 * L.spin
      const onRing = (rad, a) => aim(Math.cos(a) * rad, Math.sin(a) * rad, 0, ay, ap)
      const shade = z => 0.45 + 0.55 * clamp01((z + 0.3) / 0.6)
      const ringPts = (rad, fn) => {
        const n = Math.ceil((Math.PI * 2 * rad * R) / (cell * 0.45))
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2
          const a01 = i / n
          const v = fn(a01)
          if (!v) continue
          const [x, y, z] = onRing(rad, a)
          const [px, py] = proj(x, y, z * 0.4) // flatter perspective out here
          plot(px, py, 1, v * shade(z) * hud)
        }
      }
      // heavy bracket arcs (two cells thick)
      for (const rad of [0.94, 0.955]) ringPts(rad, a01 => {
        const seg = ((a01 + rot * 0.3) * 4) % 1
        return seg > 0.08 && seg < 0.86 ? 0.56 + 0.12 * env : 0
      })
      // fine ticks
      ringPts(1.06, a01 => (((a01 - rot) * 90) % 1 + 1) % 1 < 0.4 ? 0.34 : 0)
      // long ticks every 45°
      for (let k = 0; k < 8; k++) {
        const a = (k / 8 + rot) * Math.PI * 2
        for (let rad = 1.07; rad < 1.15; rad += (cell * 0.45) / R) {
          const [x, y, z] = onRing(rad, a)
          const [px, py] = proj(x, y, z * 0.4)
          plot(px, py, 1, 0.6 * shade(z) * hud)
        }
      }
      // the quiet notice rides the ring at one o'clock
      if (hero.notice > 0.01) {
        const [x, y, z] = onRing(1.06, -1.05)
        const [px, py] = proj(x, y, z * 0.4)
        const s = Math.max(1, Math.round(0.035 * R / cell))
        for (let dy = -s; dy <= s; dy++) for (let dx = -s; dx <= s; dx++) {
          plot(px + dx * cell, py + dy * cell, 1, (0.9 + 0.12 * Math.sin(t * 2.2)) * hero.notice)
        }
      }
    }
  }

  /** The point sphere (?entity=swarm): one material, a few hundred points on
   *  a sphere, one pixel each. Depth comes from motion parallax as it turns
   *  (front and back move opposite ways), so it reads as 3D with no shading
   *  and no face. Every state is the same points moving differently:
   *    sleep      they settle low and dim, like embers
   *    boot       they gather from across the grid into a ball
   *    idle       slow turn, breathing, a little drift
   *    listening  your voice ripples the surface, pitch by latitude
   *    thinking   latitude bands flow at different speeds, like weather
   *    speaking   each word puffs the ball; waves run from the side facing you
   *    attending  points gather and brighten on the side it faces; it leans in
   *  Waiting results orbit outside as amber satellites (drawn after quantise). */
  function paintSwarm(buf, bc, br, cell, ox, oy, cx0, cy0, R0, L, t, vis, putFn, isHero) {
    const env = hero.envNow
    const R = R0 * (1 + 0.04 * env)
    const Rs = 0.74 * L.spread
    const rest = L.rest || 0, attn = 1 - rest
    const boot = hero.bootAt < 0 ? 1 : clamp01((t - hero.bootAt) / 1.8)
    const yaw = hero.yaw, pitch = hero.pitch
    const gx = Math.sin(yaw) * Math.cos(pitch), gy = -Math.sin(pitch), gz = Math.cos(yaw) * Math.cos(pitch)
    // lean in: the whole ball shifts a little toward what it attends to
    const cx = cx0 + gx * R * 0.07 * attn, cy = cy0 + gy * R * 0.07 * attn
    const spin = hero.spinPhase * 0.5
    const cs = Math.cos(spin), ss = Math.sin(spin), ct = Math.cos(0.32), st = Math.sin(0.32)
    // fewer points when it's small, so the dock isn't a solid blob
    const want = clamp01(((Rs * R / cell) ** 2 * 1.25) / FIB.length) * FIB.length
    const stride = Math.max(1, Math.round(FIB.length / Math.max(70, want)))
    const bins = hero.spectrum.length
    const plot = (px, py, v) => {
      const c = Math.floor(px / cell), r = Math.floor(py / cell)
      if (c < 0 || r < 0 || c >= bc || r >= br) return
      if (vis < 1 && hash(c + 911, r + 377) >= vis) return
      putFn(c, r, v * vis)
    }

    for (let i = 0; i < FIB.length; i += stride) {
      let [x, y, z, ph, h] = FIB[i]
      // thinking: latitude bands flow at different speeds
      if (L.scan > 0.01) {
        const a = L.scan * t * (0.5 + 1.2 * Math.sin(y * 4 + 1))
        const c = Math.cos(a), s = Math.sin(a)
        ;[x, z] = [x * c + z * s, -x * s + z * c]
      }
      // turn about the pole, top tipped toward you, then partly with the gaze
      ;[x, z] = [x * cs + z * ss, -x * ss + z * cs]
      ;[y, z] = [y * ct - z * st, y * st + z * ct]
      ;[x, y, z] = aim(x, y, z, yaw * 0.5, pitch * 0.5)
      // gather toward the side it attends to
      if (attn > 0.01) {
        x += gx * 0.3 * attn; y += gy * 0.3 * attn; z += gz * 0.3 * attn
        const n = Math.hypot(x, y, z); x /= n; y /= n; z /= n
      }
      let r = 1 + 0.025 * Math.sin(t * 0.9 + ph * 3) * L.energy
      if (L.wave > 0.01) {
        const bi = Math.min(bins - 1, Math.floor(((y + 1) / 2) * (bins / 2)))
        r += L.wave * hero.spectrum[bi] * 0.22
      }
      r += env * (0.07 + 0.05 * Math.sin(t * 11 - (1 - z) * 4))
      // asleep: settle low and flatter
      if (rest > 0.01) { y = lerp(y, 0.45 + 0.55 * y, rest); x *= 1 - 0.15 * rest; z *= 1 - 0.15 * rest }
      let X = x * r * Rs, Y = y * r * Rs, Z = z * r * Rs
      // waking: gather in from across the grid
      if (boot < 1) {
        const bt = smooth(h * 0.45, h * 0.45 + 0.55, boot)
        X = lerp((hash(i, 7) - 0.5) * 5, X, bt); Y = lerp((hash(i, 9) - 0.5) * 3.2, Y, bt); Z *= bt
      }
      const s = 1 / (1 - Z * 0.18)
      const face = Math.max(0, x * gx + y * gy + z * gz)
      let v = (0.22 + 0.55 * (z + 1) / 2 + 0.34 * face ** 3 * attn + 0.15 * env) * (0.6 + 0.4 * L.energy)
      if (h > 0.93) v += 0.2 // a few brighter grains
      // one point is one pixel: pin it to the middle of its colour band so the
      // dither can't scatter neighbours across colours (depth reads as colour)
      v = (Math.min(4, Math.max(0, Math.floor(v * 5))) + 0.5) / 5
      plot(cx + X * R * s, cy + Y * R * s, v)
    }

    // one decoration: a thin dotted horizon orbiting the ball
    // (the ball's equator, tipped like the ball, so it reads as a thin ellipse)
    const ring = 1.06
    const n = Math.ceil((Math.PI * 2 * ring * R) / (cell * 1.8))
    const orbit = a => {
      const x = Math.cos(a) * ring, z0 = Math.sin(a) * ring
      return aim(x, -z0 * st, z0 * ct, yaw * 0.5, pitch * 0.5)
    }
    const hb = smooth(0.5, 1, boot) * (0.35 + 0.65 * attn)
    for (let k = 0; k < n; k++) {
      const [x, y, z] = orbit((k / n) * Math.PI * 2)
      if (z < 0 && k % 2) continue
      const s = 1 / (1 - z * 0.12)
      plot(cx + x * R * s, cy + y * R * s, (z < 0 ? 0.14 : 0.28) * hb)
    }
    // satellites: one per waiting result, riding the horizon
    if (isHero) {
      sats.length = 0
      const m = hero.sats
      for (let k = 0; k < m; k++) {
        const [x, y, z] = orbit(t * 0.32 + (k / Math.max(1, m)) * Math.PI * 2 - 0.9)
        const s = 1 / (1 - z * 0.12)
        sats.push({ x: ox + cx + x * R * s, y: oy + cy + y * R * s, front: z >= 0 })
      }
    }
  }

  /** amber satellites and the ones flying in, painted over the quantised ball */
  function paintSats(now) {
    const size = HERO_CELL * 2
    for (const s of sats) {
      ctx.globalAlpha = s.front ? 1 : 0.45
      ctx.fillStyle = amber
      ctx.fillRect(Math.round(s.x / HERO_CELL) * HERO_CELL - size / 2, Math.round(s.y / HERO_CELL) * HERO_CELL - size / 2, size, size)
    }
    ctx.globalAlpha = 1
    for (let i = flyers.length - 1; i >= 0; i--) {
      const f = flyers[i]
      const p = clamp01((now - f.start) / 480)
      const e = p * p * p
      for (let k = 0; k < 4; k++) {
        const q = Math.max(0, e - k * 0.06)
        const x = lerp(f.x, hero.x, q), y = lerp(f.y, hero.y, q)
        ctx.globalAlpha = 1 - k * 0.24
        ctx.fillStyle = amber
        const sz = k ? HERO_CELL : size
        ctx.fillRect(Math.round(x / HERO_CELL) * HERO_CELL - sz / 2, Math.round(y / HERO_CELL) * HERO_CELL - sz / 2, sz, sz)
      }
      ctx.globalAlpha = 1
      if (p >= 1) { flyers.splice(i, 1); hero.env = Math.max(hero.env, 1) }
    }
    return flyers.length > 0
  }

  function paintLinks(t) {
    if (!links.length) return
    const ex = hero.x, ey = hero.y
    links.forEach((l, k) => {
      const rect = l.el.getBoundingClientRect()
      if (!rect.width || l.el.dataset.state === 'out') return
      const shown = parseFloat(l.el.dataset.shown || '1')
      if (shown < 0.98) return
      // anchor on the panel edge facing the entity
      const tx = rect.left > ex ? rect.left - 4 : rect.right + 4
      const ty = Math.max(rect.top + 18, Math.min(rect.bottom - 18, ey))
      const ang = Math.atan2(ty - ey, tx - ex)
      const sx = ex + Math.cos(ang) * hero.R * 1.18, sy = ey + Math.sin(ang) * hero.R * 1.18
      // an elbow: out horizontally, then across
      const midX = (sx + tx) / 2
      const pts = [[sx, sy], [midX, sy], [midX, ty], [tx, ty]]
      let along = 0
      for (let i = 0; i < 3; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[i + 1]
        const len = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.round(len / CELL))
        for (let j = 0; j <= n; j++) {
          const px = ax + (bx - ax) * j / n, py = ay + (by - ay) * j / n
          const step = along + j
          const pulse = ((t * 14 + k * 9) % 70)
          const hot = Math.abs(step - pulse) < 1.5 ? 0.95 : 0
          if (step % 2 === 0 || hot) put(Math.floor(px / CELL), Math.floor(py / CELL), Math.max(0.22, hot))
        }
        along += n
      }
      put(Math.floor(tx / CELL), Math.floor(ty / CELL), 0.8)
    })
  }

  /** A panel being built in (dir 1) or taken down (dir -1): a hot row sweeps
   *  through it and the DOM is clipped to whole cells behind the sweep. */
  function paintSweeps(now) {
    for (let i = sweeps.length - 1; i >= 0; i--) {
      const s = sweeps[i]
      const p = clamp01((now - s.start) / s.dur)
      const rect = s.el.getBoundingClientRect()
      const h = rect.height
      const front = p * (h + CELL * 6)
      const shown = s.dir > 0 ? Math.min(h, front) : Math.max(0, h - front)
      const snapped = Math.round(shown / CELL) * CELL
      s.el.style.clipPath = `inset(0 0 ${Math.max(0, h - snapped)}px 0)`
      s.el.dataset.shown = (snapped / Math.max(1, h)).toFixed(2)
      const edgeY = rect.top + (s.dir > 0 ? Math.min(h, front) : h - front + CELL * 6)
      const c0 = Math.floor(rect.left / CELL), c1 = Math.floor(rect.right / CELL)
      for (let k = 0; k < 6; k++) {
        const y = edgeY - k * CELL * s.dir
        if (y < rect.top - CELL || y > rect.bottom + CELL) continue
        const r = Math.floor(y / CELL)
        for (let c = c0; c <= c1; c++) {
          const v = (1 - k / 6) * (0.4 + 0.6 * hash(c, r + i))
          if (hash(c * 7, r) < 0.85 - k * 0.1) put(c, r, v)
        }
      }
      // the frame's corners light as it completes
      if (s.dir > 0 && p > 0.6) {
        const g = 1 - smooth(0.6, 1, p) * 0.7
        const L = Math.floor(rect.left / CELL), Rr = Math.floor((rect.right - 1) / CELL), T = Math.floor(rect.top / CELL), B = Math.floor((rect.bottom - 1) / CELL)
        for (let k = 0; k < 3; k++) { put(L + k, T, g); put(L, T + k, g); put(Rr - k, B, g); put(Rr, B - k, g) }
      }
      if (p >= 1) {
        if (s.dir > 0) { s.el.style.clipPath = ''; s.el.dataset.shown = '1' }
        sweeps.splice(i, 1)
        s.done?.()
      }
    }
  }

  function paintTrail(dt) {
    if (!(finePointer && !calm)) return false
    let active = false
    const decay = Math.exp(-dt / 150)
    for (let i = 0; i < trail.length; i++) if (trail[i] > 0.01) { trail[i] *= decay; active = true } else trail[i] = 0
    if (pointer.on && (pointer.x !== pointer.px || pointer.y !== pointer.py)) {
      const dist = Math.hypot(pointer.x - pointer.px, pointer.y - pointer.py)
      const steps = Math.max(1, Math.ceil(dist / (CELL * 0.6)))
      for (let s = 0; s <= steps; s++) {
        const x = pointer.px + (pointer.x - pointer.px) * s / steps, y = pointer.py + (pointer.y - pointer.py) * s / steps
        const c = Math.floor(x / CELL), r = Math.floor(y / CELL)
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc, rr = r + dr
          if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue
          const g = Math.exp(-(dc * dc + dr * dr) / 1.1) * Math.min(1, dist / 80) * 0.3 / Math.sqrt(steps)
          const i = rr * cols + cc
          trail[i] = Math.min(1, trail[i] + g)
        }
      }
      pointer.px = pointer.x; pointer.py = pointer.y
      active = true
    }
    for (let i = 0; i < trail.length; i++) if (trail[i] > 0.04 && trail[i] > field[i]) field[i] = trail[i]
    return active
  }

  function paintEmbers(now, dt) {
    for (let i = embers.length - 1; i >= 0; i--) {
      const e = embers[i]
      const age = (now - e.born) / e.life
      if (age >= 1) { embers.splice(i, 1); continue }
      e.vy += 0.0004 * dt; e.x += e.vx * dt; e.y += e.vy * dt
      put(Math.floor(e.x / CELL), Math.floor(e.y / CELL), 1.05 - age)
    }
    return embers.length > 0
  }

  function quantise(target, w, h, buf, cell, ox, oy, gap) {
    const bands = [[], [], [], [], []]
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const v = buf[r * w + c]
      if (v <= 0) continue
      const level = v * 5 + BAYER[(r % 4) * 4 + (c % 4)] * 0.9
      if (level < 0.55) continue
      bands[Math.min(4, Math.floor(level))].push(r * w + c)
    }
    bands.forEach((cells, b) => {
      target.fillStyle = ramp[b]
      for (const i of cells) target.fillRect(ox + (i % w) * cell + gap, oy + Math.floor(i / w) * cell + gap, cell - gap * 2, cell - gap * 2)
    })
  }

  /* the docked entity: its own small grid inside the dock button */
  let dockBuf = new Float32Array(0)
  let heroBuf = new Float32Array(0)
  function paintDock(t) {
    if (!dock.el || dock.vis < 0.01) return
    const rect = dock.el.getBoundingClientRect()
    if (!rect.width) return
    const cell = 3
    const w = Math.floor(rect.width / cell), h = Math.floor(rect.height / cell)
    if (dockBuf.length !== w * h) dockBuf = new Float32Array(w * h)
    dockBuf.fill(0)
    const R = Math.min(rect.width, rect.height) * 0.4
    ;(ENTITY === 'swarm' ? paintSwarm : paintEntity)(dockBuf, w, h, cell, rect.left, rect.top, rect.width / 2, rect.height / 2, R, hero.live, t, dock.vis,
      (c, r, v) => { const i = r * w + c; if (v > dockBuf[i]) dockBuf[i] = v })
    quantise(ctx, w, h, dockBuf, cell, rect.left, rect.top, 0.5)
  }

  function frame(now) {
    raf = 0
    if (document.hidden) return
    const dt = lastFrame ? Math.min(64, now - lastFrame) : 16
    lastFrame = now
    time = now
    const t = now / 1000
    const k = 1 - Math.exp(-dt / 220)
    const ds = dt / 1000

    // ease the entity toward its mood; glide to its place on a spring
    const target = MOODS[hero.mood]
    for (const key in target) hero.live[key] = lerp(hero.live[key], target[key], k)
    const px0 = hero.x
    spring(hero, 'x', hero.tx, ds, 34, 0.86); spring(hero, 'y', hero.ty, ds, 34, 0.86); spring(hero, 'R', hero.tR, ds, 30, 0.9)
    const vx = (hero.x - px0) / Math.max(ds, 0.001)

    // where it looks: what it was asked to look at, else what its mood implies,
    // else it follows your pointer a little, else it drifts
    let gyT, gpT
    if (hero.glance && now < hero.glance.until) [gyT, gpT] = aimAt(hero.glance.x, hero.glance.y)
    else if (hero.look) [gyT, gpT] = aimAt(hero.look.x, hero.look.y)
    else if (hero.mood === 'sleep') { gyT = Math.sin(t * 0.2) * 0.12; gpT = -0.42 }
    else if (hero.mood === 'thinking') { gyT = -0.42 + Math.sin(t * 1.1) * 0.14; gpT = 0.34 + Math.sin(t * 0.7) * 0.06 }
    else if (hero.mood === 'listening') { gyT = Math.sin(t * 0.6) * 0.04; gpT = -0.1 }
    else if (pointer.on && !calm) { [gyT, gpT] = aimAt(pointer.x, pointer.y); gyT *= 0.5; gpT *= 0.5 }
    else { gyT = Math.sin(t * 0.23) * 0.22; gpT = Math.sin(t * 0.17) * 0.1 }
    // lean into a glide
    gyT += Math.max(-0.45, Math.min(0.45, vx * 0.0011))
    if (calm) { hero.yaw = gyT; hero.pitch = gpT }
    else { spring(hero, 'yaw', gyT, ds, 46, 0.6); spring(hero, 'pitch', gpT, ds, 46, 0.6) }

    // the voice: words kick the envelope; between kicks it falls. While
    // speaking there's always a little syllable motion underneath.
    hero.env *= Math.exp(-dt / 170)
    const syll = hero.live.voice * (0.22 + 0.38 * Math.abs(Math.sin(t * 8.3) * Math.sin(t * 2.9 + 1)))
    hero.envNow = calm ? 0 : Math.max(hero.env, syll)
    hero.vis = lerp(hero.vis, hero.tvis, 1 - Math.exp(-dt / 180))
    dock.vis = lerp(dock.vis, dock.tvis, 1 - Math.exp(-dt / 180))
    hero.notice = lerp(hero.notice, hero.tNotice, k)
    const da = Math.atan2(Math.sin(hero.tWedge - hero.wedgeAngle), Math.cos(hero.tWedge - hero.wedgeAngle))
    hero.wedgeAngle += da * (1 - Math.exp(-dt / 260))
    hero.spinPhase = (hero.spinPhase || 0) + dt / 1000 * hero.live.spin * (calm ? 0 : 1)
    if (hero.mood === 'thinking' || hero.mood === 'idle' || hero.mood === 'sleep') {
      // no live audio: let the spectrum fall back to rest
      for (let i = 0; i < hero.spectrum.length; i++) hero.spectrum[i] *= 0.9
    }
    // speaking: a soft synthetic envelope when the browser gives us no audio
    if (hero.mood === 'speaking' && !hero.externalLevel) {
      for (let i = 0; i < hero.spectrum.length; i++) {
        const target = (0.25 + 0.75 * Math.abs(Math.sin(t * 7 + i * 0.8) * Math.sin(t * 3.1 + i * 0.33))) * hero.level
        hero.spectrum[i] = lerp(hero.spectrum[i], target, 0.3)
      }
    }

    field.fill(0)
    ctx.clearRect(0, 0, width, height)

    const moving = Math.abs(hero.x - hero.tx) + Math.abs(hero.y - hero.ty) + Math.abs(hero.R - hero.tR) > 0.5 ||
      Math.abs(hero.v_yaw || 0) + Math.abs(hero.v_pitch || 0) > 0.02 || hero.env > 0.02 ||
      Math.abs(hero.vis - hero.tvis) > 0.01 || Math.abs(dock.vis - dock.tvis) > 0.01
    let heroBox = null
    if (hero.vis > 0.01) {
      const hc = HERO_CELL
      const ox = Math.floor((hero.x - hero.R * 1.4) / CELL) * CELL, oy = Math.floor((hero.y - hero.R * 1.4) / CELL) * CELL
      const w = Math.ceil((hero.R * 2.8 + CELL) / hc), h = Math.ceil((hero.R * 2.8 + CELL) / hc)
      if (heroBuf.length !== w * h) heroBuf = new Float32Array(w * h)
      heroBuf.fill(0)
      const hput = (c, r, v) => { if (c < 0 || r < 0 || c >= w || r >= h) return; const i = r * w + c; if (v > heroBuf[i]) heroBuf[i] = v }
      if (ENTITY === 'swarm') paintSwarm(heroBuf, w, h, hc, ox, oy, hero.x - ox, hero.y - oy, hero.R, hero.live, t, hero.vis, hput, true)
      else paintEntity(heroBuf, w, h, hc, ox, oy, hero.x - ox, hero.y - oy, hero.R, hero.live, t, hero.vis, hput)
      paintLinks(t)
      heroBox = { w, h, ox, oy, hc }
    }
    paintSweeps(now)
    const trailOn = paintTrail(dt)
    const embersOn = paintEmbers(now, dt)
    quantise(ctx, cols, rows, field, CELL, 0, 0, 1)
    if (heroBox) quantise(ctx, heroBox.w, heroBox.h, heroBuf, heroBox.hc, heroBox.ox, heroBox.oy, 0.6)
    if (!heroBox) sats.length = 0
    const flying = paintSats(now)
    paintDock(t)
    lastDraw = now

    // keep going while anything is alive; a calm idle entity runs at ~20fps
    const busy = moving || sweeps.length || trailOn || embersOn || flying || hero.mood !== 'idle' && hero.mood !== 'sleep' || hero.bootAt > 0 && t - hero.bootAt < 2
    if (calm && !busy) return
    if (busy) raf = requestAnimationFrame(frame)
    else setTimeout(() => { if (!raf) raf = requestAnimationFrame(frame) }, 48)
  }

  resize()

  return {
    hero, dock,
    setMood(m) { if (MOODS[m]) { hero.mood = m; kick() } },
    place(x, y, R) { hero.tx = x; hero.ty = y; hero.tR = R; if (!hero.x) { hero.x = x; hero.y = y; hero.R = R } kick() },
    snap() { hero.x = hero.tx; hero.y = hero.ty; hero.R = hero.tR; hero.v_x = hero.v_y = hero.v_R = 0 },
    boot() { hero.bootAt = performance.now() / 1000; kick() },
    pointWedge(angle) { hero.tWedge = angle; kick() },
    pointAt(x, y) { hero.tWedge = Math.atan2(y - hero.ty, x - hero.tx); kick() },
    /** turn to face a screen point (and point the wedge at it). ms: glance, then let go */
    lookAt(x, y, ms) {
      if (x == null) { hero.look = null; kick(); return }
      if (ms) { hero.glance = { x, y, until: performance.now() + ms }; kick(); return }
      hero.look = { x, y }
      hero.tWedge = Math.atan2(y - hero.ty, x - hero.tx)
      kick()
    },
    lookAtEl(el, ms) { const r = el?.getBoundingClientRect(); if (r?.width) this.lookAt(r.left + r.width / 2, r.top + Math.min(r.height / 2, 120), ms) },
    /** a word was spoken: swell */
    pulse(v = 1) { hero.env = Math.max(hero.env, v); kick() },
    setLevel(v) { hero.level = v },
    setSpectrum(arr) { hero.externalLevel = true; for (let i = 0; i < hero.spectrum.length; i++) hero.spectrum[i] = lerp(hero.spectrum[i], arr[i] || 0, 0.5); kick() },
    releaseSpectrum() { hero.externalLevel = false },
    /** n waiting results: an amber block on the rings, or n satellites */
    setNotice(n) { n = +n || 0; hero.tNotice = n ? 1 : 0; hero.sats = n; kick() },
    /** a result is being opened: its satellite flies into the ball */
    absorb() {
      const s = sats[0]
      if (s) flyers.push({ x: s.x, y: s.y, start: performance.now() })
      else hero.env = Math.max(hero.env, 1)
      hero.sats = Math.max(0, hero.sats - 1)
      kick()
    },
    showHero(on) { hero.tvis = on ? 1 : 0; kick() },
    setDock(el, on) { dock.el = el; dock.tvis = on ? 1 : 0; kick() },
    link(el) { if (!links.some(l => l.el === el)) links.push({ el }); kick() },
    unlink(el) { const i = links.findIndex(l => l.el === el); if (i >= 0) links.splice(i, 1) },
    clearLinks() { links.length = 0 },
    /** build an element in on the grid; resolves when it's whole */
    buildIn(el, dur = 520) {
      return new Promise(done => {
        for (let i = sweeps.length - 1; i >= 0; i--) if (sweeps[i].el === el) sweeps.splice(i, 1)
        el.dataset.shown = '0'
        el.style.clipPath = 'inset(0 0 100% 0)'
        if (calm) { el.style.clipPath = ''; el.dataset.shown = '1'; return done() }
        const sw = { el, start: performance.now(), dur, dir: 1, done }
        sweeps.push(sw); kick()
        // if frames are paused (background tab), never leave the panel clipped
        setTimeout(() => { const i = sweeps.indexOf(sw); if (i >= 0) { sweeps.splice(i, 1); el.style.clipPath = ''; el.dataset.shown = '1'; done() } }, dur + 400)
      })
    },
    takeDown(el, dur = 360) {
      return new Promise(done => {
        for (let i = sweeps.length - 1; i >= 0; i--) if (sweeps[i].el === el) sweeps.splice(i, 1)
        if (calm) return done()
        const sw = { el, start: performance.now(), dur, dir: -1, done }
        sweeps.push(sw); kick()
        setTimeout(() => { const i = sweeps.indexOf(sw); if (i >= 0) { sweeps.splice(i, 1); done() } }, dur + 400)
      })
    },
    kick,
  }
}
