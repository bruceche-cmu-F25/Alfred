/** Voice in and out, for the prototype.
 *
 *  In:  the browser's SpeechRecognition (Chrome / Safari / Edge) with interim
 *       results, plus a mic analyser for the level and spectrum the entity
 *       draws. Where the browser has no recogniser, or the mic is refused, it
 *       falls back to a scripted "simulated" stream so every flow stays
 *       testable — and says so. In the real app this module is the seam where
 *       Higgs Realtime (talk) and a streaming STT like Deepgram (dictation) go.
 *  Out: speechSynthesis, with word-boundary events driving the entity.
 *
 *  It also times what matters for "快": first partial, and stop → final.
 */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition

export const canRecognise = !!SR

let audioCtx = null
let micStream = null
let analyser = null
let levelRaf = 0

async function openMic(onLevel) {
  try {
    if (!micStream) micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    audioCtx = audioCtx || new AudioContext()
    if (audioCtx.state === 'suspended') await audioCtx.resume()
    const src = audioCtx.createMediaStreamSource(micStream)
    analyser = audioCtx.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.6
    src.connect(analyser)
    const bins = new Uint8Array(analyser.frequencyBinCount)
    const tick = () => {
      analyser.getByteFrequencyData(bins)
      // 48 bands over the voice range, mirrored so the ring is symmetric
      const out = new Float32Array(48)
      let sum = 0
      for (let i = 0; i < 24; i++) {
        const v = bins[2 + Math.floor(i * 1.6)] / 255
        out[i] = out[47 - i] = Math.pow(v, 1.4)
        sum += v
      }
      onLevel(Math.min(1, sum / 24 * 1.6), out)
      levelRaf = requestAnimationFrame(tick)
    }
    tick()
    return true
  } catch (e) {
    return false
  }
}

function closeMic() {
  cancelAnimationFrame(levelRaf)
  levelRaf = 0
  analyser = null
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null }
}

const SIM_LINES = {
  talk: ['计划一下今天', '把站会改到四点', 'Stripe 那封邮件的事做完了', '自动任务怎么样了', '帮我调查一下本地语音转写方案', '明早早报加上英伟达前一天的表现'],
  dictate: ['帮我把 entity 外圈的转速调慢一点，idle 的时候粒子少一些，然后跑一下 npm test 看看有没有挂'],
}
let simIndex = 0

/**
 * listen({ mode: 'talk'|'dictate', lang, onInterim, onFinal, onLevel, onEnd })
 * returns { stop(), cancel(), simulated }
 *  talk:    ends on its own after a pause (one utterance)
 *  dictate: keeps going until stop()
 */
export function listen(opts) {
  const { mode = 'talk', lang = 'zh-CN', onInterim, onFinal, onLevel, onEnd, onError } = opts
  const t0 = performance.now()
  const metrics = { firstPartial: null, final: null, stopAt: null }
  let finalText = ''
  let ended = false
  let rec = null
  let simTimer = 0

  const finish = (text, cancelled) => {
    if (ended) return
    ended = true
    clearInterval(simTimer)
    closeMic()
    if (metrics.stopAt) metrics.final = performance.now() - metrics.stopAt
    onEnd?.(cancelled ? '' : text.trim(), metrics)
  }

  const level = (v, spec) => onLevel?.(v, spec)

  const simulate = (reason) => {
    metrics.simulated = true
    const line = SIM_LINES[mode][simIndex++ % SIM_LINES[mode].length]
    // stream it out in chunks the way a real recogniser does: words arrive,
    // the tail is revised, then it settles
    let i = 0
    const chunk = mode === 'dictate' ? 3 : 2
    const fakeLevel = () => {
      const spec = new Float32Array(48)
      for (let k = 0; k < 24; k++) spec[k] = spec[47 - k] = Math.random() * 0.6 * (1 - k / 30)
      level(0.4 + Math.random() * 0.4, spec)
    }
    simTimer = setInterval(() => {
      fakeLevel()
      i += chunk
      if (metrics.firstPartial == null) metrics.firstPartial = performance.now() - t0
      onInterim?.(line.slice(0, i), '')
      if (i >= line.length) {
        clearInterval(simTimer)
        if (mode === 'talk') setTimeout(() => { onFinal?.(line); finish(line) }, 280)
        else { finalText = line; onFinal?.(line) }
      }
    }, 90)
    return reason
  }

  const handle = {
    simulated: false,
    stop() {
      metrics.stopAt = performance.now()
      if (rec) { try { rec.stop() } catch (e) { finish(finalText) } }
      else finish(finalText)
    },
    cancel() {
      if (rec) { try { rec.abort() } catch (e) {} }
      finish('', true)
    },
  }

  if (!SR) {
    handle.simulated = 'no-recogniser'
    simulate()
    return handle
  }

  openMic(level).then(ok => { if (!ok && !ended) level(0.3, null) })

  rec = new SR()
  rec.lang = lang
  rec.interimResults = true
  rec.continuous = mode === 'dictate'
  rec.maxAlternatives = 1
  rec.onresult = e => {
    let interim = ''
    finalText = ''
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i]
      if (r.isFinal) finalText += r[0].transcript
      else interim += r[0].transcript
    }
    if (metrics.firstPartial == null) metrics.firstPartial = performance.now() - t0
    onInterim?.(finalText, interim)
  }
  rec.onerror = e => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'network') {
      // no mic or no service: keep the flow testable
      rec = null
      handle.simulated = e.error
      onError?.(e.error)
      simulate()
      return
    }
    if (e.error === 'no-speech' || e.error === 'aborted') return
    onError?.(e.error)
  }
  rec.onend = () => {
    if (!rec) return // switched to simulation
    if (mode === 'dictate' && !metrics.stopAt && !ended) {
      // Chrome ends continuous sessions on long silence; carry on
      try { rec.start(); return } catch (err) {}
    }
    onFinal?.(finalText)
    finish(finalText)
  }
  try { rec.start() } catch (e) { rec = null; handle.simulated = 'start-failed'; simulate() }
  return handle
}

/* ── speaking ───────────────────────────────────────────── */

let voices = []
const loadVoices = () => { voices = speechSynthesis?.getVoices?.() || [] }
if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices }

const pick = lang => {
  const want = lang.startsWith('zh') ? /zh[-_]CN|cmn/i : /en[-_](US|GB)/i
  const pool = voices.filter(v => want.test(v.lang))
  // prefer the nicer system voices where they exist
  return pool.find(v => /Tingting|Yu-shu|Xiaoxiao|Samantha|Daniel|Google/i.test(v.name)) || pool[0] || null
}

/** speak(text, { onWord, sound }) → Promise; resolves when done or cancelled */
export function speak(text, { onWord, sound = true } = {}) {
  return new Promise(resolve => {
    const cjk = /[一-鿿]/.test(text)
    // no audio: still pace the caption as if spoken, ~5.5 cjk chars / 15 latin chars per second
    const est = Math.max(900, cjk ? text.length * 190 : text.length * 62)
    if (!sound || !('speechSynthesis' in window)) {
      let i = 0
      const t = setInterval(() => { i = Math.min(text.length, i + 2); onWord?.(i); if (i >= text.length) clearInterval(t) }, est / (text.length / 2))
      setTimeout(() => { clearInterval(t); onWord?.(text.length); resolve() }, est)
      speakCancel = () => { clearInterval(t); resolve() }
      return
    }
    speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = cjk ? 'zh-CN' : 'en-US'
    const v = pick(u.lang); if (v) u.voice = v
    u.rate = cjk ? 1.08 : 1.02
    u.pitch = 1
    let done = false
    const end = () => { if (!done) { done = true; clearTimeout(guard); onWord?.(text.length); resolve() } }
    u.onboundary = e => onWord?.(e.charIndex + (e.charLength || 1))
    u.onend = end
    u.onerror = end
    // some engines never fire onend; never hang the UI on it
    const guard = setTimeout(end, est * 2.2 + 1500)
    speakCancel = () => { speechSynthesis.cancel(); end() }
    speechSynthesis.speak(u)
  })
}

let speakCancel = null
export function hush() { speakCancel?.(); speakCancel = null }

/* tiny chip sounds, like the portfolio's — square-wave blips, off with sound */
let sfx = null
export function blip(kind = 'tick', on = true) {
  if (!on) return
  try {
    sfx = sfx || new AudioContext()
    if (sfx.state === 'suspended') sfx.resume()
    const o = sfx.createOscillator(), g = sfx.createGain()
    o.type = 'square'
    const t = sfx.currentTime
    const f = { tick: 880, up: 660, done: 990, down: 440 }[kind] || 880
    o.frequency.setValueAtTime(f, t)
    if (kind === 'up') o.frequency.exponentialRampToValueAtTime(f * 1.5, t + 0.08)
    if (kind === 'down') o.frequency.exponentialRampToValueAtTime(f * 0.6, t + 0.1)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.035, t + 0.005)
    g.gain.exponentialRampToValueAtTime(0.0001, t + (kind === 'tick' ? 0.04 : 0.12))
    o.connect(g).connect(sfx.destination)
    o.start(t); o.stop(t + 0.15)
  } catch (e) {}
}
