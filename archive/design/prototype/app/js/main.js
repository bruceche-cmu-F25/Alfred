import { createStage, CELL, ENTITY } from './stage.js'
import { listen, speak, hush, blip, canRecognise } from './voice.js'
import { makeData, hm, freeSlots, glyphSVG } from './data.js'

const $ = s => document.querySelector(s)
const $$ = s => [...document.querySelectorAll(s)]
const wait = ms => new Promise(r => setTimeout(r, ms))
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const store = {
  get(k, d) { try { const v = localStorage.getItem('alfred-proto:' + k); return v == null ? d : JSON.parse(v) } catch (e) { return d } },
  set(k, v) { try { localStorage.setItem('alfred-proto:' + k, JSON.stringify(v)) } catch (e) {} },
}

const stage = createStage($('#stage'))
const params = new URLSearchParams(location.search)
const clockScenario = () => { const h = new Date().getHours(); return h < 12 ? 'morning' : h < 19 ? 'afternoon' : 'evening' }
const SCN_NOW = { morning: 8 * 60 + 12, afternoon: 14 * 60 + 40, evening: 21 * 60 + 5 }
const SCN_HOUR = { morning: 'dawn', afternoon: 'day', evening: 'night' }

const S = {
  view: 'sleep',          // sleep | home | work
  mode: 'sleep',          // home: brief | talk | idle
  scenario: params.get('scn') || clockScenario(),
  sound: store.get('sound', true),
  now: 0,
  panels: new Map(),      // id → { el, side }
  notices: [],
  talk: null,             // active listen handle (home)
  dict: null,             // active listen handle (dictation)
  sayToken: 0,
  briefToken: 0,
  idleTimer: 0,
  deckIndex: 0,
  ws: null, session: null,
  lastUndo: null,
  dictLang: 'zh-CN',
}
S.now = SCN_NOW[S.scenario]
document.documentElement.dataset.hour = params.get('hour') || SCN_HOUR[S.scenario]
let D = makeData()

/* ═════════ layout ═════════════════════════════════════════════
   The entity is drawn on the canvas, so the DOM around it is placed from
   the same numbers: --ex/--ey/--er feed the caption, deck and panels. */

const narrow = () => innerWidth < 1100
const DECK_H = 360 // keep in step with .deck height in styles.css
function layoutHome() {
  const vw = innerWidth, vh = innerHeight
  const m = S.view === 'sleep' ? 'sleep' : S.mode
  let x = vw / 2, y, R, sl = 0
  if (m === 'sleep') {
    R = Math.min(170, vh * 0.17, vw * 0.24); y = vh * 0.44
  } else if (narrow() && (m === 'present' || m === 'idle')) {
    R = Math.min(58, vw * 0.14); y = 14 + R * 1.35
  } else if (narrow()) {
    R = Math.min(vw * 0.22, 100, vh * 0.13); y = vh * 0.3
  } else if (m === 'present') {
    // Alfred steps aside: a column on the left for it and what it says,
    // the rest of the screen for the result
    sl = Math.round(Math.max(340, Math.min(480, vw * 0.33)))
    R = Math.min(140, sl * 0.3, vh * 0.16); x = sl / 2; y = Math.max(32 + R * 1.35, vh * 0.34)
  } else if (m === 'idle') {
    R = Math.max(64, Math.min(124, (vh - 96 - DECK_H - 60) / 2.7)); y = 28 + R * 1.3
  } else {
    R = Math.min(200, vh * 0.2, vw * 0.17); y = vh * 0.4
  }
  stage.place(x, y, R)
  const root = document.documentElement.style
  root.setProperty('--ex', x + 'px'); root.setProperty('--ey', y + 'px'); root.setProperty('--er', R + 'px')
  // just under the entity's dotted outline (1.22 R)
  root.setProperty('--below', Math.round(y + R * 1.36) + 'px')
  root.setProperty('--sl', sl + 'px')
  // the talk bar and caption follow Alfred's column
  const col = sl ? sl - 48 : Math.min(600, vw - 32)
  root.setProperty('--tx', (sl ? sl / 2 : vw / 2) + 'px')
  root.setProperty('--tw', col + 'px')
  root.setProperty('--cw', (sl ? sl - 48 : Math.min(640, vw - 32)) + 'px')
}
addEventListener('resize', () => { if (S.view !== 'work') layoutHome() })

/* ═════════ caption: what Alfred says, and what you're saying ═══ */

const cap = { meta: $('#captionMeta'), text: $('#captionText'), actions: $('#captionActions'), el: $('#caption') }

function setActions(actions = []) {
  cap.actions.innerHTML = ''
  actions.forEach(a => {
    const b = document.createElement('button')
    b.className = 'btn' + (a.primary ? ' primary' : ' ghost')
    b.textContent = a.label
    b.onclick = () => { blip('tick', S.sound); bump(); a.run() }
    cap.actions.append(b)
  })
}

/** Alfred speaks: caption reveals with the voice; the entity speaks too. */
async function say(text, { actions = [], meta = 'ALFRED', mood } = {}) {
  const token = ++S.sayToken
  cap.el.dataset.who = 'alfred'
  cap.meta.textContent = `${meta} · ${hm(S.now)}`
  cap.text.innerHTML = `<span class="said"></span><span class="unsaid">${esc(text)}</span>`
  setActions([])
  cap.el.classList.add('on')
  stage.setMood('speaking'); stage.setLevel(0.75)
  const said = cap.text.querySelector('.said'), unsaid = cap.text.querySelector('.unsaid')
  await speak(text, {
    sound: S.sound,
    onWord: i => { if (token !== S.sayToken) return; said.textContent = text.slice(0, i); unsaid.textContent = text.slice(i); stage.pulse(0.85) },
  })
  if (token !== S.sayToken) return false
  stage.setLevel(0)
  stage.setMood(mood || (S.view === 'sleep' ? 'sleep' : 'idle'))
  setActions(actions)
  return true
}
/** A quiet line: no voice, no mood change. For clicks, confirmations, undo. */
function note(text, actions = []) {
  S.sayToken++
  cap.el.dataset.who = 'note'
  cap.meta.textContent = `ALFRED · ${hm(S.now)}`
  cap.text.innerHTML = `<span class="said">${esc(text)}</span>`
  cap.el.classList.add('on')
  setActions(actions)
}
function interrupt() { S.sayToken++; S.briefToken++; hush(); stage.setLevel(0) }

/* ═════════ panels ═════════════════════════════════════════════ */

const cols = { L: null, R: null }
function ensureCols() {
  if (cols.L) return
  const p = $('#panels')
  p.innerHTML = '<div class="col" data-side="L"></div><div class="col" data-side="R"></div>'
  cols.L = p.querySelector('[data-side=L]'); cols.R = p.querySelector('[data-side=R]')
}
const sheet = { el: $('#sheet'), on: false }
const usedCols = () => [cols.L, cols.R].filter(c => c && c.children.length).length

/** Alfred glides aside and the sheet comes up on the other side. */
async function openSheet({ kicker, title, meta = '', n = 1 } = {}) {
  ensureCols()
  $('#sheetKicker').textContent = kicker || ''
  $('#sheetTitle').textContent = title || ''
  $('#sheetMeta').textContent = meta
  sheet.el.dataset.cols = Math.max(n, usedCols(), 1)
  if (S.mode !== 'present') setMode('present')
  if (sheet.on) return
  sheet.on = true
  sheet.el.classList.add('on')
  stage.buildIn($('#sheetHead'), 420)
  await wait(220) // let Alfred get going before the first section lands
}
function closeSheet() {
  if (!sheet.on) return
  sheet.on = false
  stage.takeDown($('#sheetHead'), 260).then(() => { if (!sheet.on) sheet.el.classList.remove('on') })
}

const RENDER = {}

/** Show a section on the sheet. Alfred turns to it and a link runs to it. */
async function showPanel(id, side, { flash, look = true } = {}) {
  ensureCols()
  const exist = S.panels.get(id)
  if (exist) {
    exist.el.querySelector('.p-body').innerHTML = RENDER[id].body()
    exist.el.querySelector('.p-count').textContent = RENDER[id].count?.() ?? ''
    wire(exist.el, id)
    if (flash) { exist.el.classList.remove('flash'); void exist.el.offsetWidth; exist.el.classList.add('flash'); attend(exist.el) }
    return exist.el
  }
  if (!sheet.on) await openSheet({ kicker: RENDER[id].title.split(' · ')[0], title: RENDER[id].title.split(' · ')[1] || '' })
  const r = RENDER[id]
  const el = document.createElement('article')
  el.className = 'panel'
  el.dataset.id = id
  el.innerHTML = `<header class="p-head">${glyphSVG(r.glyph)}<span class="p-title">${r.title}</span><span class="p-count">${r.count?.() ?? ''}</span></header><div class="p-body">${r.body()}</div>`
  ;(side === 'L' ? cols.L : cols.R).append(el)
  sheet.el.dataset.cols = Math.max(+sheet.el.dataset.cols || 1, usedCols())
  wire(el, id)
  S.panels.set(id, { el, side })
  stage.buildIn(el, 560)
  if (look) attend(el)
  return el
}
/** Alfred looks at one thing at a time; the link follows its gaze. */
function attend(el) {
  $$('.panel.attn').forEach(p => { if (p !== el) p.classList.toggle('attn', false) })
  el.classList.add('attn')
  stage.clearLinks()
  // a link only to the column next to Alfred; further out, the gaze and the highlight do it
  if (!narrow() && (el.parentElement === cols.L || !cols.L.children.length)) stage.link(el)
  stage.lookAtEl(el)
}

async function hidePanel(id, { auto = true } = {}) {
  const p = S.panels.get(id)
  if (!p) return
  S.panels.delete(id)
  stage.unlink(p.el)
  p.el.dataset.state = 'out'
  await stage.takeDown(p.el, 340)
  p.el.remove()
  if (sheet.on) sheet.el.dataset.cols = Math.max(1, usedCols())
  // nothing left to show: Alfred comes back to the middle
  if (auto && !S.panels.size && S.mode === 'present') { closeSheet(); stage.lookAt(null); setMode('talk') }
}
/** Only what's being talked about stays open. */
async function focusPanels(list, head) {
  const want = new Set(list.map(([id]) => id))
  ;[...S.panels.keys()].forEach(id => { if (!want.has(id)) hidePanel(id, { auto: false }) })
  const first = RENDER[list[0][0]].title.split(' · ')
  await openSheet({ kicker: head?.kicker || first[0], title: head?.title || first[1] || '', meta: head?.meta || '', n: new Set(list.map(([, side]) => side)).size })
  for (const [id, side, opt] of list) { await showPanel(id, side, opt); await wait(140) }
}
function refresh(id, flash = true) { if (S.panels.has(id)) showPanel(id, null, { flash }) }

function wire(el, id) { RENDER[id].wire?.(el) }

/* mail */
RENDER.mail = {
  title: 'MAIL · 需要你看', glyph: 'mail',
  count: () => D.emails.filter(e => e.attention).length || '✓',
  body: () => {
    const rows = D.emails.filter(e => e.attention)
    const rest = D.emails.length - rows.length
    if (!rows.length) return `<div class="empty">都处理完了。其余 ${rest} 封不需要你。</div>`
    return rows.map(e => `
      <div class="row mail" data-id="${e.id}">
        <div class="row-main">
          <div class="row-title"><span class="from">${esc(e.from)}</span> ${esc(e.subject)}</div>
          <div class="row-sub">${esc(e.summary)}</div>
        </div>
        <div class="row-act">
          <button class="act ok" data-ok title="${esc(e.action)}">✓ ${esc(e.action)}</button>
          <button class="act no" data-no title="不处理">✕</button>
        </div>
      </div>`).join('') + `<div class="foot">另有 ${rest} 封已归档，不需要你。</div>`
  },
  wire: el => el.querySelectorAll('.row.mail').forEach(row => {
    const e = D.emails.find(x => x.id === row.dataset.id)
    row.querySelector('[data-ok]').onclick = () => { blip('done', S.sound); approveMail(e, row) }
    row.querySelector('[data-no]').onclick = () => { blip('down', S.sound); dismissMail(e, row) }
  }),
}
async function approveMail(e, row) {
  row.classList.add('gone-ok')
  await wait(380)
  e.attention = false
  if (e.todo) {
    const t = { id: 't' + Date.now(), title: e.todo, due: '今天', done: false, fresh: true }
    D.todos.unshift(t)
    if (!S.panels.has('todos')) await showPanel('todos', 'R'); else refresh('todos')
    note(`已加入待办：${e.todo}`, [{ label: '撤销', run: () => { D.todos = D.todos.filter(x => x !== t); e.attention = true; refresh('todos'); refresh('mail'); note('已撤销。') } }])
  } else note(`${e.subject} · 已标记已读。`)
  refresh('mail', false)
  bump()
}
async function dismissMail(e, row) {
  row.classList.add('gone-no')
  await wait(320)
  e.attention = false
  refresh('mail', false)
  note(`不处理：${e.subject}`, [{ label: '撤销', run: () => { e.attention = true; refresh('mail'); note('已撤销。') } }])
}

/* calendar: a day as a strip of cells */
RENDER.cal = {
  title: 'TODAY · 日程', glyph: 'cal',
  count: () => D.events.length,
  body: () => {
    const from = 8 * 60, to = 20 * 60, H = 9 * 26 // px, a multiple of the grid
    const y = m => ((m - from) / (to - from)) * H
    const hours = []
    for (let h = 8; h <= 20; h += 2) hours.push(`<div class="cal-h" style="top:${y(h * 60)}px">${String(h).padStart(2, '0')}</div>`)
    const ev = [...D.events, ...(S.proposal || []).map(p => ({ ...p, ghost: true }))].map(e => `
      <div class="cal-ev k-${e.kind}${e.ghost ? ' ghost' : ''}${e.fresh ? ' fresh' : ''}" style="top:${y(e.start)}px;height:${Math.max(16, y(e.end) - y(e.start) - 2)}px">
        <span class="t">${hm(e.start)}</span> ${esc(e.title)}
      </div>`).join('')
    return `<div class="cal" style="height:${H}px">${hours.join('')}<div class="cal-now" style="top:${y(S.now)}px"><span>${hm(S.now)}</span></div>${ev}</div>`
  },
}

/* todos, with a gentle push on the nearest deadline */
RENDER.todos = {
  title: 'TODO · 待办', glyph: 'check',
  count: () => D.todos.filter(t => !t.done).length,
  body: () => {
    const rows = D.todos.map(t => `
      <label class="row todo${t.done ? ' done' : ''}${t.fresh ? ' fresh' : ''}" data-id="${t.id}">
        <input type="checkbox" ${t.done ? 'checked' : ''} /><span class="box"></span>
        <span class="row-title">${esc(t.title)}</span>
        <span class="due${t.ddl ? ' ddl' : ''}">${t.ddl ? 'DDL ' : ''}${esc(t.due)}</span>
      </label>`).join('')
    const next = D.todos.find(t => t.ddl && !t.done)
    const push = next && !S.pushSnoozed ? `<div class="push"><div>${esc(next.title)} · ${esc(next.due)}截止。今天留一小时给它？</div>
      <div class="push-act"><button class="btn small primary" data-push-yes>排一小时</button><button class="btn small ghost" data-push-no>稍后</button></div></div>` : ''
    return rows + push
  },
  wire: el => {
    el.querySelectorAll('.row.todo input').forEach(cb => cb.onchange = () => {
      const t = D.todos.find(x => x.id === cb.closest('.row').dataset.id)
      t.done = cb.checked; t.fresh = false
      blip(t.done ? 'done' : 'down', S.sound)
      refresh('todos', false)
      bump()
    })
    const yes = el.querySelector('[data-push-yes]'), no = el.querySelector('[data-push-no]')
    if (yes) yes.onclick = () => { const t = D.todos.find(x => x.ddl && !x.done); blockFor(t, 60) }
    if (no) no.onclick = () => { S.pushSnoozed = true; refresh('todos', false); note('好，下午四点再提一次。') }
  },
}

/* the brief: news + the sections you asked for */
RENDER.brief = {
  title: 'BRIEF · 早报', glyph: 'news',
  count: () => '06:30',
  body: () => D.news.map(n => `<div class="row news"><span class="tag">${n.tag}</span><span>${esc(n.text)}</span></div>`).join('') +
    `<div class="sub-h">你的栏目</div>` +
    D.briefRules.map(r => `<div class="row rule${r.fresh ? ' fresh' : ''}"><span class="tag">${r.once ? '一次' : '每天'}</span><span>${esc(r.text)}</span><span class="faint mono small">${r.since}</span></div>`).join(''),
}

/* runs: automations, investigations, Pi sessions */
RENDER.runs = {
  title: 'RUNS · 后台', glyph: 'run',
  count: () => D.runs.filter(r => r.status === 'running').length + ' 运行中',
  body: () => D.runs.map(r => `
    <div class="row run s-${r.status}">
      <div class="row-main"><div class="row-title">${esc(r.name)}</div><div class="row-sub">${esc(r.note || '')}</div></div>
      <div class="bar" style="--p:${Math.round(r.progress * 12)}"><i></i></div>
    </div>`).join(''),
}

/* a proposed plan, waiting for a yes */
RENDER.plan = {
  title: 'PLAN · 建议安排', glyph: 'cal',
  count: () => (S.proposal || []).length + ' 段',
  body: () => (S.proposal || []).map(p => `
    <div class="row plan"><span class="t mono">${hm(p.start)}–${hm(p.end)}</span><div class="row-main"><div class="row-title">${esc(p.title)}</div><div class="row-sub">${esc(p.why)}</div></div></div>`).join('') +
    (S.proposalNote ? `<div class="foot">${esc(S.proposalNote)}</div>` : ''),
}

/* an investigation's result */
RENDER.result = {
  title: 'REPORT · 调查结果', glyph: 'flask',
  count: () => '',
  body: () => {
    const r = S.report
    if (!r) return ''
    return `<div class="rep-title">${esc(r.title)}</div><ul class="rep">${r.points.map(p => `<li>${esc(p)}</li>`).join('')}</ul><div class="foot">${r.sources} 个来源 · ${r.took}</div>`
  },
}

/* ═════════ home modes ═════════════════════════════════════════ */

function setMode(mode) {
  const was = S.mode
  if (mode !== 'idle') hideDeck() // before the layout moves, so it's taken down where it stood
  S.mode = mode
  document.body.dataset.mode = mode
  layoutHome()
  if (mode === 'idle') showDeck()
  if (was === 'idle' && mode !== 'idle') stage.lookAt(null)
}

function bump() {
  clearTimeout(S.idleTimer)
  if (S.view !== 'home' || S.mode === 'idle') return
  S.idleTimer = setTimeout(() => { if (!S.talk && S.view === 'home') goIdle() }, 45000)
}

async function goIdle() {
  if (S.view !== 'home') return
  clearTimeout(S.idleTimer)
  ;[...S.panels.keys()].forEach(id => hidePanel(id, { auto: false }))
  closeSheet()
  S.proposal = null
  cap.el.classList.remove('on')
  stage.clearLinks()
  await wait(250)
  setMode('idle')
}

/* ── the deck: the island under Alfred ──────────────────────
   Tabs along the top: 今天 first, then each workspace. The body previews the
   selected one, so you can see what's in a room before walking into it. */
const TABS = () => [{ id: 'today', name: '今天', en: 'TODAY', glyph: 'cal', stat: `${D.todos.filter(t => !t.done).length} 待办 · ${D.events.filter(e => e.start > S.now).length} 安排` }, ...D.workspaces]
const span = m => m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时${m % 60 ? ' ' + (m % 60) + ' 分' : ''}`

const PREVIEW = {
  today() {
    const nx = nextEvent()
    const rest = [...D.events].sort((a, b) => a.start - b.start)
    const open = D.todos.filter(t => !t.done)
    const waiting = S.notices.length
    return `
      <div class="pv-main">
        <div class="pv-k mono">下一个</div>
        <div class="pv-big">${nx ? `<span class="mono">${hm(nx.start)}</span> ${esc(nx.title)}` : '今天没有别的安排了'}</div>
        <div class="pv-sub">${nx ? `还有 ${span(nx.start - S.now)}` : '可以整块做事'}</div>
        <div class="pv-strip">${rest.map(e => `<div class="pv-ev k-${e.kind}${e.end <= S.now ? ' past' : ''}" style="--a:${(e.start - 480) / 780};--b:${(e.end - 480) / 780}" title="${esc(e.title)}"></div>`).join('')}
          <div class="pv-now" style="--a:${Math.max(0, (S.now - 480) / 780)}"></div></div>
        <div class="pv-ticks mono"><span>08</span><span>12</span><span>16</span><span>21</span></div>
        ${waiting ? `<div class="pv-wait"><span class="dot s-amber"></span>${waiting} 个结果在等你看</div>` : ''}
      </div>
      <div class="pv-side">
        <div class="sub-h">待办 · ${open.length}</div>
        ${open.map(t => `<div class="pv-row"><span class="box"></span><span class="grow">${esc(t.title)}</span><span class="due${t.ddl ? ' ddl' : ''}">${esc(t.due)}</span></div>`).join('') || '<div class="empty">都做完了。</div>'}
      </div>`
  },
  ws(w) {
    const list = D.sessions[w.id] || []
    return `
      <div class="pv-main">
        <div class="pv-k mono">${w.en}</div>
        <div class="pv-big">${esc(w.name)}</div>
        <div class="pv-sub">${esc(w.stat)}</div>
        <ul class="pv-points">${(w.points?.(D) || []).map(p => `<li>${esc(p)}</li>`).join('')}</ul>
      </div>
      <div class="pv-side">
        <div class="sub-h">会话 · ${list.length}</div>
        ${list.map(x => `<div class="pv-row"><span class="dot s-${x.status}"></span><span class="grow">${esc(x.title)}</span><span class="due">${esc(x.when)}</span></div>`).join('')}
      </div>`
  },
}

function showDeck() {
  const deck = $('#deck')
  delete deck.dataset.leaving // coming back before the take-down finished
  deck.style.top = ''
  $('#deckTabs').innerHTML = TABS().map((w, i) => `
    <button class="deck-tab" role="tab" data-i="${i}">
      <span class="tab-top">${glyphSVG(w.glyph)}<span class="tab-en mono">${w.en}</span></span>
      <span class="tab-name">${w.name}</span>
      <span class="tab-stat mono">${esc(w.stat)}</span>
    </button>`).join('')
  deck.classList.add('on')
  $$('#deckTabs .deck-tab').forEach((t, i) => {
    t.onclick = () => { if (i === S.deckIndex) openTab(i); else selectTile(i) }
  })
  stage.buildIn(deck, 520)
  selectTile(Math.min(S.deckIndex, TABS().length - 1), true)
}
function hideDeck() {
  const deck = $('#deck')
  if (!deck.classList.contains('on') || deck.dataset.leaving) return
  // pin it where it is while it's taken down; the layout is about to move
  deck.style.top = deck.getBoundingClientRect().top + 'px'
  deck.dataset.leaving = '1'
  stage.takeDown(deck, 300).then(() => {
    delete deck.dataset.leaving
    deck.style.top = ''
    if (S.mode !== 'idle') deck.classList.remove('on')
  })
}
function selectTile(i, quiet) {
  const tabs = $$('#deckTabs .deck-tab')
  if (!tabs.length) return
  const next = (i + tabs.length) % tabs.length
  const changed = next !== S.deckIndex || quiet
  S.deckIndex = next
  tabs.forEach((t, k) => { t.classList.toggle('sel', k === next); t.setAttribute('aria-selected', k === next) })
  const tab = TABS()[next]
  if (changed) {
    const body = $('#deckBody')
    body.innerHTML = (tab.id === 'today' ? PREVIEW.today() : PREVIEW.ws(tab)) + `
      <div class="pv-foot">${tab.id === 'today'
        ? '<button class="btn primary small" data-go="plan">计划今天</button><button class="btn ghost small" data-go="brief">再听一遍早报</button>'
        : `<button class="btn primary small" data-go="open">进入${esc(tab.name)} <span class="kbd">↵</span></button>`}<span class="grow"></span><span class="mono faint small only-wide">← → 切换 · ↵ 进入</span></div>`
    body.querySelectorAll('[data-go]').forEach(b => b.onclick = () => openTab(S.deckIndex, b.dataset.go))
    if (!quiet) stage.buildIn(body, 300)
  }
  stage.lookAtEl(tabs[next])
  if (!quiet) blip('tick', S.sound)
}
function openTab(i, how) {
  const tab = TABS()[i]
  blip('up', S.sound)
  if (tab.id !== 'today') return openWorkspace(tab.id)
  if (how === 'brief') return replayBrief()
  handle('计划一下今天')
}

/* ═════════ waking up ══════════════════════════════════════════ */

async function wake() {
  if (S.view !== 'sleep') return
  S.view = 'home'
  document.body.dataset.view = 'home'
  $('#wake').classList.add('gone')
  blip('up', S.sound)
  stage.boot()
  stage.setMood('idle')
  const scn = S.scenario
  if (scn === 'morning') {
    setMode('talk')
    await wait(700)
    if (!await say('Welcome back, Bruce.')) return
    await replayBrief()
  } else if (scn === 'afternoon') {
    setMode('idle')
    await wait(700)
    await say('Welcome back, Bruce.')
    await say('你离开的时候有两件事完成了，放在右上角，有空再看。')
    notify(NOTICES.pi())
    await wait(500)
    notify(NOTICES.jobs())
  } else {
    setMode('talk')
    await wait(700)
    await say('Welcome back, Bruce.')
    showPanel('todos', 'R')
    await say('明晚交 Math 197 修改稿，还没开始。今晚留四十分钟，还是明早九点做？', { actions: [
      { label: '今晚 21:30', primary: true, run: () => ddlChoose('tonight') },
      { label: '明早 9:00', run: () => ddlChoose('morning') },
      { label: '稍后再说', run: () => { note('好，十点前再提醒你一次。'); bump() } },
    ] })
    bump()
  }
}
/** The morning brief: Alfred steps aside and talks the sheet through, one
 *  section per sentence, turning to each as it lands. */
async function replayBrief() {
  interrupt()
  const token = ++S.briefToken
  const d = new Date()
  const n = D.emails.filter(e => e.attention).length
  await openSheet({ kicker: 'BRIEF', title: `早报 · ${d.getMonth() + 1}月${d.getDate()}日 周${'日一二三四五六'[d.getDay()]}`, meta: '06:30 生成', n: 2 })
  const parts = [
    ['mail', 'L', `早上好。${n ? `${'零一两三四五'[n] || n}封邮件要你看一下。` : '邮件都处理完了。'}`],
    ['cal', 'R', '今天两个会：十点站会，十一点半和 Lin 一对一。'],
    ['todos', 'R', '周五的面试还差系统设计，明晚交 Math 197。'],
    ['brief', 'L', '市场上半导体领涨；你订的求职栏目，有四个新岗位。'],
  ]
  for (const [id, side, line] of parts) {
    if (token !== S.briefToken) return
    await showPanel(id, side)
    await wait(180)
    if (token !== S.briefToken || !await say(line, { mood: 'speaking' })) return
  }
  if (token !== S.briefToken) return
  stage.setMood('idle')
  stage.lookAt(null)
  setActions([
    { label: '计划今天', primary: true, run: () => handle('计划一下今天') },
    { label: '先这样', run: () => goIdle() },
  ])
  bump()
}

function ddlChoose(when) {
  const t = D.todos.find(x => x.id === 't3')
  const start = when === 'tonight' ? 21 * 60 + 30 : 9 * 60
  D.events.push({ id: 'c' + Date.now(), title: 'Math 197 修改稿', start, end: start + 40, kind: 'focus', fresh: true })
  t.due = when === 'tonight' ? '今晚 21:30' : '明早 9:00'
  refresh('todos')
  showPanel('cal', 'R')
  say(when === 'tonight' ? '排在九点半，四十分钟。' : '排在明早九点，提前十分钟叫你。')
}

/* ═════════ talking ════════════════════════════════════════════ */

function startTalk() {
  if (S.talk) return
  if (S.view === 'sleep') return wake()
  interrupt()           // barge in: Alfred stops the moment you speak
  bump()
  if (S.mode === 'idle') setMode('talk')
  stage.lookAt(null)
  stage.setMood('listening')
  document.body.classList.add('listening')
  cap.el.dataset.who = 'you'
  cap.meta.textContent = canRecognise ? '你 · 在听' : '你 · 在听（模拟）'
  cap.text.innerHTML = '<span class="interim">…</span>'
  setActions([])
  cap.el.classList.add('on')
  blip('up', S.sound)
  S.talk = listen({
    mode: 'talk', lang: 'zh-CN',
    onInterim: (fin, inter) => { cap.text.innerHTML = `<span class="said">${esc(fin)}</span><span class="interim">${esc(inter)}</span>` },
    onLevel: (lv, spec) => { stage.setLevel(lv); if (spec) stage.setSpectrum(spec) },
    onError: err => { cap.meta.textContent = `你 · 模拟输入（${err === 'not-allowed' ? '没有麦克风权限' : err}）` },
    onEnd: (text, m) => {
      S.talk = null
      document.body.classList.remove('listening')
      stage.releaseSpectrum(); stage.setLevel(0)
      if (m.firstPartial != null && !m.simulated) cap.meta.dataset.metric = `首字 ${(m.firstPartial / 1000).toFixed(2)}s`
      if (text) handle(text)
      else { stage.setMood('idle'); cap.el.classList.remove('on') }
    },
  })
  if (S.talk.simulated) cap.meta.textContent = '你 · 模拟输入（浏览器不支持语音识别）'
}
function stopTalk() { S.talk?.stop() }

/** Everything you say or type at home comes through here. */
async function handle(raw) {
  const text = raw.trim()
  if (!text) return
  if (S.view === 'sleep') await wake()
  interrupt()
  bump()
  if (S.mode === 'idle') setMode('talk')
  cap.el.dataset.who = 'you'
  cap.meta.textContent = '你'
  cap.text.innerHTML = `<span class="said">${esc(text)}</span>`
  setActions([])
  cap.el.classList.add('on')
  stage.lookAt(null)
  stage.setMood('thinking')
  await wait(450 + Math.random() * 350)
  const intent = INTENTS.find(i => i.match.test(text))
  if (intent) await intent.run(text)
  else await say('这句我在原型里还接不住。要先记成待办吗？', { actions: [
    { label: '记成待办', primary: true, run: () => { D.todos.unshift({ id: 't' + Date.now(), title: text, due: '今天', done: false, fresh: true }); showPanel('todos', 'R'); note('记下了。') } },
    { label: '算了', run: () => note('好。') },
  ] })
}

/* time words → minutes: 四点 / 4点 / 下午三点半 / 16:00 / 4pm */
function parseTime(t) {
  const CN = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 }
  let m = t.match(/(\d{1,2})[:：](\d{2})/)
  if (m) return +m[1] * 60 + +m[2]
  m = t.match(/(上午|早上|中午|下午|晚上|傍晚)?\s*(\d{1,2}|十一|十二|[一二两三四五六七八九十])\s*(点|pm|am)\s*(半|一刻|三刻|(\d{1,2})\s*分?)?/i)
  if (!m) return null
  let h = /\d/.test(m[2]) ? +m[2] : CN[m[2]]
  const pm = /下午|晚上|傍晚|pm/i.test((m[1] || '') + m[3])
  if (pm && h < 12) h += 12
  else if (!m[1] && !/am/i.test(m[3]) && h < 8) h += 12
  const mins = m[4] === '半' ? 30 : m[4] === '一刻' ? 15 : m[4] === '三刻' ? 45 : m[5] ? +m[5] : 0
  return h * 60 + mins
}

const NVDA = { 英伟达: 'NVDA', 苹果: 'AAPL', 特斯拉: 'TSLA', 微软: 'MSFT', 谷歌: 'GOOGL', 台积电: 'TSM' }

const INTENTS = [
  { match: /^(好了|先这样|没事了|谢谢|thanks|bye|ok就这样)/i, run: async () => { await say('好。'); goIdle() } },
  { match: /计划|规划|安排一下|plan/i, run: planDay },
  { match: /(改|挪|移|推|调)(到|至|成)|reschedule|move/i, run: moveEvent },
  { match: /(做完|完成|搞定|弄完|done|finished)/i, run: completeTodo },
  { match: /(调查|研究一下|查一下|帮我查|look into|research)/i, run: startResearch },
  { match: /(早报|晨报|brief)/i, run: addBriefRule },
  { match: /(自动任务|后台|进度|跑得怎么样|怎么样了|结束了吗|session|会话)/i, run: runStatus },
  { match: /(日程|日历|今天有什么|calendar|schedule)/i, run: async () => { await focusPanels([['cal', 'R']]); await say(`今天还有 ${D.events.filter(e => e.start > S.now).length} 个安排，下一个是 ${nextEvent()?.title || '无'}。`) } },
  { match: /(邮件|email|mail)/i, run: async () => { await focusPanels([['mail', 'L']]); const n = D.emails.filter(e => e.attention).length; await say(n ? `${n} 封需要你决定，都在右边。` : '没有需要你处理的邮件。') } },
  { match: /(打开|进入|去).*(求职|研究|产品|pi|会话|晨报)/i, run: async t => {
    const id = /求职/.test(t) ? 'jobs' : /研究/.test(t) ? 'research' : /产品/.test(t) ? 'product' : /晨报/.test(t) ? 'brief' : 'pi'
    await say('好。'); openWorkspace(id)
  } },
]
const nextEvent = () => [...D.events].sort((a, b) => a.start - b.start).find(e => e.start > S.now)

async function planDay() {
  const open = D.todos.filter(t => !t.done)
  const slots = freeSlots(D.events, Math.max(S.now + 20, 540), 1260)
  const plan = []
  const why = ['截止最近，先做', '需要整块时间', '短，顺手处理']
  for (const t of open.slice(0, 3)) {
    const len = t.ddl ? 90 : /回复|邮件|发给/.test(t.title) ? 30 : 60
    const slot = slots.find(([a, b]) => b - a >= len)
    if (!slot) break
    plan.push({ id: 'p' + plan.length, title: t.title, start: slot[0], end: slot[0] + len, kind: 'focus', why: why[plan.length], todo: t.id })
    slot[0] += len + 15
  }
  plan.sort((a, b) => a.start - b.start)
  S.proposal = plan
  const lin = D.events.find(e => e.id === 'c2')
  S.proposalNote = lin ? `避开了 ${hm(lin.start)} 的 ${lin.title}，健身没动。` : ''
  await focusPanels([['plan', 'L'], ['cal', 'R']], { kicker: 'PLAN', title: '今天的建议安排', meta: `${plan.length} 段 · 等你确认` })
  const spoken = plan.map(p => `${hm(p.start)} ${p.title.replace(/[:：].*$/, '')}`).join('，')
  await say(`排了 ${plan.length} 段：${spoken}。按这个来吗？`, { actions: [
    { label: '应用安排', primary: true, run: applyPlan },
    { label: '改一下', run: () => { $('#talkInput').focus(); note('直接说要改哪段，比如「面试准备挪到下午」。') } },
  ] })
}
async function applyPlan() {
  const plan = S.proposal || []
  plan.forEach(p => D.events.push({ id: 'c' + p.id + Date.now(), title: p.title, start: p.start, end: p.end, kind: 'focus', fresh: true }))
  S.proposal = null
  hidePanel('plan')
  refresh('cal')
  blip('done', S.sound)
  await say(`已写进日历，${plan.length} 段。开始前五分钟提醒你。`, { actions: [
    { label: '撤销', run: () => { D.events = D.events.filter(e => !plan.some(p => e.title === p.title && e.start === p.start)); refresh('cal'); note('已从日历移除。') } },
  ] })
}
async function blockFor(t, len) {
  const slot = freeSlots(D.events, Math.max(S.now + 20, 540), 1260).find(([a, b]) => b - a >= len)
  if (!slot) return say('今天排不下一小时了，明早可以吗？')
  D.events.push({ id: 'c' + Date.now(), title: t.title, start: slot[0], end: slot[0] + len, kind: 'focus', fresh: true })
  await showPanel('cal', 'R'); refresh('cal')
  say(`排在 ${hm(slot[0])}，一小时。`)
}

async function moveEvent(text) {
  const to = parseTime(text)
  const ev = D.events.find(e => text.includes(e.title.replace(/\s*·.*$/, '')) || (e.title.includes('Lin') && /lin|林|一对一|1:1/i.test(text))) || nextEvent()
  if (!ev) return say('今天后面没有安排可以挪。')
  if (to == null) return say(`${ev.title}挪到几点？`)
  const len = ev.end - ev.start
  const clash = D.events.find(e => e !== ev && e.start < to + len && e.end > to)
  await focusPanels([['cal', 'R']])
  const apply = () => {
    const old = ev.start
    ev.start = to; ev.end = to + len; ev.fresh = true
    refresh('cal')
    S.lastUndo = () => { ev.start = old; ev.end = old + len; refresh('cal') }
  }
  if (clash) {
    return say(`${hm(to)} 和${clash.title}重叠了。还是挪过去吗？`, { actions: [
      { label: '照样挪', primary: true, run: async () => { apply(); await say(`好，${ev.title}在 ${hm(to)}。`) } },
      { label: '不挪了', run: () => note('保持原样。') },
    ] })
  }
  apply()
  await say(`${ev.title}改到 ${hm(to)} 了。`, { actions: [{ label: '撤销', run: () => { S.lastUndo?.(); note('改回去了。') } }] })
}

async function completeTodo(text) {
  const open = D.todos.filter(t => !t.done)
  const words = text.replace(/(那个|的事|做完了|完成了|搞定了|弄完了|已经|我|了)/g, ' ').split(/\s+/).filter(w => w.length > 1)
  const t = open.find(t => words.some(w => t.title.toLowerCase().includes(w.toLowerCase()))) || null
  if (!t) return say('没对上是哪件。现在还有：' + open.map(t => t.title).join('；') + '。')
  t.done = true
  await focusPanels([['todos', 'R']])
  refresh('todos')
  blip('done', S.sound)
  const left = D.todos.filter(x => !x.done).length
  await say(`划掉了。还剩 ${left} 件。`, { actions: [{ label: '撤销', run: () => { t.done = false; refresh('todos'); note('已恢复。') } }] })
}

async function runStatus(text) {
  await focusPanels([['runs', 'R']])
  const pi = D.runs.find(r => r.kind === 'pi')
  if (/pi|会话|session/i.test(text) && pi) {
    return say(pi.status === 'running' ? `${pi.name.replace('Pi · ', '')}还在跑，大约 ${Math.round(pi.progress * 100)}%，${pi.note}。` : `${pi.name.replace('Pi · ', '')}已经结束：${pi.note}。`)
  }
  const done = D.runs.filter(r => r.status === 'done'), run = D.runs.filter(r => r.status === 'running')
  await say(`${done.length} 个跑完，${run.length} 个在跑。${done[0] ? done[0].name + '：' + done[0].note + '。' : ''}${run[0] ? run[0].name.replace('Pi · ', 'Pi 的') + '大约 ' + Math.round(run[0].progress * 100) + '%。' : ''}`)
}

async function startResearch(text) {
  const topic = (text.replace(/^(帮我|请|你)?\s*(调查|研究一下|查一下|帮我查|look into|research)\s*(一下)?/i, '').trim() || '本地语音转写方案').replace(/[。.!！]$/, '')
  const run = { id: 'r' + Date.now(), kind: 'research', name: '调查 · ' + topic, status: 'running', progress: 0.1, note: '刚开始' }
  D.runs.unshift(run)
  refresh('runs')
  showStatus(run)
  await say('好，查完告诉你。')
  goIdleSoon()
  const started = performance.now()
  const tick = setInterval(() => {
    run.progress = Math.min(0.95, (performance.now() - started) / 14000)
    run.note = run.progress < 0.4 ? '在找资料' : run.progress < 0.8 ? '在比对' : '在写结论'
    showStatus(run); refresh('runs', false)
  }, 700)
  run.finish = () => { clearInterval(tick); finishResearch(run, topic) }
  setTimeout(() => run.status === 'running' && run.finish(), 14000)
}
function goIdleSoon() { clearTimeout(S.idleTimer); S.idleTimer = setTimeout(() => { if (!S.talk && S.view === 'home' && S.mode !== 'idle') goIdle() }, 6000) }
function finishResearch(run, topic) {
  run.status = 'done'; run.progress = 1; run.note = '结论已整理'
  showStatus(null); refresh('runs', false)
  notify(NOTICES.research(topic))
}
function showStatus(run) {
  const el = $('#statusLine')
  if (!run) { el.classList.remove('on'); return }
  const cells = 10, on = Math.round(run.progress * cells)
  el.innerHTML = `<span class="mono">${esc(run.name)}</span> <span class="cells">${'▮'.repeat(on)}${'▯'.repeat(cells - on)}</span> <span class="faint">${esc(run.note)}</span>`
  el.classList.add('on')
}

async function addBriefRule(text) {
  const name = Object.keys(NVDA).find(k => text.includes(k))
  const ticker = name ? NVDA[name] : (text.match(/\b[A-Z]{2,5}\b/) || [])[0]
  const subject = ticker ? `${ticker} · 前一交易日表现` : text.replace(/.*(加上|加|关注|告诉我)/, '').replace(/[。.]$/, '').trim() || '你提到的内容'
  const once = /只.*明|就明天|明天一次/.test(text)
  const rule = { id: 'b' + Date.now(), text: subject, since: once ? '明早' : '从明早', once, fresh: true }
  D.briefRules.push(rule)
  await focusPanels([['brief', 'L']])
  refresh('brief')
  await say(once ? `明早那期加上 ${subject.replace(' · ', ' ')}。` : `记下了，从明早起每天早报都有 ${subject.replace(' · ', ' ')}。`, { actions: [
    once ? { label: '改成每天', run: () => { rule.once = false; rule.since = '从明早'; refresh('brief'); note('改成每天了。') } }
         : { label: '只要明天', run: () => { rule.once = true; rule.since = '明早'; refresh('brief'); note('只加明天这一期。') } },
  ] })
}

/* ═════════ quiet notices ══════════════════════════════════════
   They appear and wait. The entity shows one amber block on its ring; the
   dock gets a dot. Nothing speaks until you ask it to. */

const NOTICES = {
  research: topic => ({ kind: 'research', glyph: 'flask', title: '调查完成', body: topic, report: {
    title: topic,
    points: /语音|转写|stt|asr/i.test(topic) ? [
      '结论：流式听写选 Deepgram Nova-3，首字约 0.3s，中英混说最好；Higgs 只给最终转写，留给实时对话。',
      '本地兜底：whisper.cpp large-v3-turbo 在 M 系列上约 1.2× 实时，适合离线，不适合边说边出字。',
      '风险：浏览器 Web Speech 只适合原型，结果走第三方服务，也不能加术语表。',
      '下一步：用你的 20 段中英混合录音跑对照，比首字延迟和改字耗时。',
    ] : [
      `结论：关于「${topic}」，主流做法有两种，差别在成本和维护量。`,
      '风险：公开资料较旧，有一处数据需要你确认。',
      '下一步：要的话我整理成一页对比，放进研究工作区。',
    ],
    sources: 9, took: '用时 14s',
    speech: /语音|转写/.test(topic)
      ? '查完了。听写用 Deepgram，首字大约零点三秒，中英混说最好；实时对话继续用 Higgs。本地 whisper 只适合兜底。下一步建议用你自己的录音跑一次对照。'
      : `查完了。${topic}有两种主流做法，差别在成本和维护。有一处数据要你确认，详情在卡片里。`,
  } }),
  pi: () => ({ kind: 'pi', glyph: 'term', title: 'Pi 会话结束', body: 'alfred-proto 重构 · 42/42 测试通过', report: {
    title: 'Pi · alfred-proto 重构',
    points: ['改了 6 个文件，42 个测试全部通过。', '没有需要你决定的事。', '留了一个 TODO：dock 的 3px 网格在 1.5× 屏幕上有半像素偏移。'],
    sources: 0, took: '运行 38 分钟',
    speech: '重构会话结束了。四十二个测试全过，改了六个文件，没有要你决定的。留了一个小问题在卡片里。',
  }, onOpen: () => { const r = D.runs.find(x => x.kind === 'pi'); if (r) { r.status = 'done'; r.progress = 1; r.note = '42/42 测试通过' } } }),
  jobs: () => ({ kind: 'auto', glyph: 'case', title: '求职扫描完成', body: '新增 4 个匹配岗位', report: {
    title: '求职 portal 扫描',
    points: ['新增 4 个岗位，2 个匹配度高：Anthropic · Product Engineer，Figma · AI Platform。', '另外 2 个要求 5 年以上经验，先不推荐。'],
    sources: 37, took: '06:40 完成',
    speech: '扫描完了，新增四个岗位，两个值得看：Anthropic 和 Figma。另外两个经验要求太高，先不推荐。',
  } }),
  ddl: () => ({ kind: 'ddl', glyph: 'check', title: '明天截止', body: 'Math 197 修改稿 · 明天 23:59', ddl: true }),
}

function notify(n) {
  n.id = 'n' + Date.now() + Math.random().toString(36).slice(2, 5)
  S.notices.push(n)
  n.onOpen?.()
  const el = document.createElement('div')
  el.className = 'notice' + (n.ddl ? ' ddl' : '')
  el.dataset.id = n.id
  el.innerHTML = `
    <div class="n-head">${glyphSVG(n.glyph)}<span class="n-title">${esc(n.title)}</span><span class="n-time mono">${hm(S.now)}</span>
      <button class="n-x" aria-label="收起">—</button></div>
    <div class="n-body">${esc(n.body)}</div>
    <div class="n-act">${n.ddl
      ? '<button class="btn small primary" data-act="plan">今晚 21:30</button><button class="btn small ghost" data-act="later">稍后</button>'
      : '<button class="btn small primary" data-act="hear">听汇报</button><button class="btn small ghost" data-act="read">看结果</button>'}</div>`
  $('#notices').prepend(el)
  el.querySelector('.n-x').onclick = () => el.classList.toggle('min')
  el.querySelectorAll('[data-act]').forEach(b => b.onclick = () => { blip('tick', S.sound); act(n, b.dataset.act, el) })
  stage.buildIn(el, 420)
  if (S.view === 'home') setTimeout(() => stage.lookAtEl(el, 1300), 260)
  syncNoticeMarks()
}
function closeNotice(n, el) {
  S.notices = S.notices.filter(x => x !== n)
  stage.takeDown(el, 260).then(() => el.remove())
  syncNoticeMarks()
}
function syncNoticeMarks() {
  const n = S.notices.length
  stage.setNotice(n)
  $('#dockDot').textContent = n || ''
  $('#dockDot').classList.toggle('on', n > 0)
}
async function act(n, what, el) {
  if (what === 'plan') { closeNotice(n, el); if (S.view !== 'home') goHome(); ddlChoose('tonight'); return }
  if (what === 'later') { closeNotice(n, el); note('好，晚上九点再提醒。'); return }
  stage.absorb()
  closeNotice(n, el)
  S.report = n.report
  if (S.view === 'home') {
    if (S.mode === 'idle') setMode('talk')
    await focusPanels([['result', 'L']], { kicker: 'REPORT', title: n.report.title, meta: `${n.report.sources ? n.report.sources + ' 个来源 · ' : ''}${n.report.took}` })
    refresh('result', false)
  } else renderCtx()
  if (what === 'hear') await say(n.report.speech)
  else note(n.report.title + ' · 结果在右边。')
  bump()
}

/* ═════════ workspace: the Pi-style chat ═══════════════════════ */

function openWorkspace(id) {
  interrupt()
  clearTimeout(S.idleTimer)
  S.ws = D.workspaces.find(w => w.id === id)
  S.view = 'work'
  document.body.dataset.view = 'work'
  hideDeck()
  ;[...S.panels.keys()].forEach(id => hidePanel(id, { auto: false }))
  closeSheet()
  cap.el.classList.remove('on')
  stage.clearLinks()
  stage.showHero(false)
  const work = $('#work')
  work.hidden = false
  $('#wsName').textContent = S.ws.name
  stage.setDock($('#dock'), true)
  stage.setMood('idle')
  const list = D.sessions[id] || []
  openSession(list[0]?.id)
  renderSessions()
  ;['.work-side', '.work-main', '.work-ctx'].forEach((s, i) => setTimeout(() => stage.buildIn($(s), 460), i * 90))
  setTimeout(() => $('#draft').focus({ preventScroll: true }), 500)
}
function goHome() {
  if (S.view !== 'work') return
  stopDictation(true)
  S.view = 'home'
  document.body.dataset.view = 'home'
  $('#work').hidden = true
  $('#work').classList.remove('side-open')
  stage.setDock($('#dock'), false)
  stage.showHero(true)
  setMode('idle')
  blip('down', S.sound)
}

function renderSessions() {
  const list = D.sessions[S.ws.id] || []
  $('#sessions').innerHTML = list.map(s => `
    <button class="sess${s.id === S.session ? ' on' : ''}" data-id="${s.id}">
      <span class="dot s-${s.status}"></span><span class="sess-t">${esc(s.title)}</span><span class="sess-w mono">${esc(s.when)}</span>
    </button>`).join('')
  $$('#sessions .sess').forEach(b => b.onclick = () => { openSession(b.dataset.id); renderSessions(); $('#work').classList.remove('side-open') })
}
function openSession(id) {
  const list = D.sessions[S.ws.id] || []
  const s = list.find(x => x.id === id) || list[0]
  S.session = s?.id
  $('#sessionTitle').textContent = s?.title || '新会话'
  $('#sessionMeta').textContent = s ? `${S.ws.en} · ${s.status === 'running' ? '运行中' : s.status === 'done' ? '已结束' : '空闲'} · ${s.when}` : ''
  if (s && !D.threads[s.id]) D.threads[s.id] = [{ role: 'assistant', text: `这是「${s.title}」。上次停在整理阶段，接着做吗？` }]
  renderThread()
  renderCtx()
}
function msgHTML(m) {
  const tools = (m.tools || []).map(t => `
    <details class="tool"><summary><span class="tool-n mono">${esc(t.name)}</span> <span class="mono faint">${esc(t.arg)}</span></summary><pre>${esc(t.out)}</pre></details>`).join('')
  return `<div class="msg ${m.role}"><div class="msg-who mono">${m.role === 'user' ? 'YOU' : 'PI'}</div><div class="msg-body"><div class="msg-text">${esc(m.text)}</div>${tools}</div></div>`
}
function renderThread() {
  const th = $('#thread')
  th.innerHTML = (D.threads[S.session] || []).map(msgHTML).join('')
  th.scrollTop = th.scrollHeight
}
function renderCtx() {
  const ctx = $('#ctx')
  const r = S.report
  const files = { pi: ['prototype/js/stage.js', 'prototype/js/voice.js', 'prototype/styles.css'], jobs: ['jobs/stripe-onsite.md', 'cv/2026-11.pdf'], research: ['notes/stt-compare.md', 'data/recordings/ (20)'], product: ['docs/SESSION-HANDOFF.md', 'prototype/'], brief: ['brief/rules.json'] }[S.ws?.id] || []
  ctx.innerHTML = `
    <div class="ctx-h mono">CONTEXT</div>
    <div class="ctx-sec"><div class="sub-h">文件</div>${files.map(f => `<div class="ctx-file mono">${esc(f)}</div>`).join('')}</div>
    <div class="ctx-sec"><div class="sub-h">后台</div>${D.runs.slice(0, 3).map(x => `<div class="ctx-run"><span class="dot s-${x.status}"></span>${esc(x.name)}</div>`).join('')}</div>
    ${r ? `<div class="ctx-sec rep-card"><div class="sub-h">最近的汇报</div><div class="rep-title">${esc(r.title)}</div><ul class="rep">${r.points.map(p => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}`
}

const REPLIES = [
  { text: '收到。我先看一下相关文件，再改。', tools: [{ name: 'read', arg: 'prototype/js/stage.js', out: 'MOODS · RINGS · MOTES — 3 rings, 22 motes' }, { name: 'edit', arg: 'prototype/js/stage.js', out: '+6 −3' }], tail: '改好了：idle 的转速降到 0.7，粒子从 22 个减到 14 个。要我跑一下测试吗？' },
  { text: '好，我来跑一下。', tools: [{ name: 'bash', arg: 'npm test', out: '✓ 42 passed (3.1s)' }], tail: '全部通过。' },
]
let replyIndex = 0
async function sendDraft() {
  const ta = $('#draft')
  const text = ta.value.trim()
  if (!text || !S.session) return
  stopDictation()
  ta.value = ''; autoGrow()
  const th = D.threads[S.session] || (D.threads[S.session] = [])
  th.push({ role: 'user', text })
  renderThread()
  blip('tick', S.sound)
  const r = REPLIES[replyIndex++ % REPLIES.length]
  const msg = { role: 'assistant', text: '', tools: [] }
  th.push(msg)
  await wait(380)
  await stream(msg, r.text)
  for (const t of r.tools) { await wait(420); msg.tools.push(t); renderThread() }
  await wait(300)
  await stream(msg, msg.text + '\n' + r.tail, msg.text.length + 1)
}
async function stream(msg, full, from = 0) {
  for (let i = from; i <= full.length; i += 2) {
    msg.text = full.slice(0, i)
    const last = $('#thread .msg:last-child .msg-text')
    if (last) last.textContent = msg.text
    else renderThread()
    $('#thread').scrollTop = $('#thread').scrollHeight
    await wait(16)
  }
  msg.text = full
  renderThread()
}

/* ── dictation: preview while you speak, editable draft when you stop ── */
const levelsCtx = $('#levels').getContext('2d')
function drawLevels(spec) {
  const c = $('#levels'), w = c.width, h = c.height
  levelsCtx.clearRect(0, 0, w, h)
  if (!spec) return
  levelsCtx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent')
  for (let i = 0; i < 20; i++) {
    const v = spec[i] || 0
    const bh = Math.max(1, Math.round(v * 6)) * 3
    levelsCtx.fillRect(i * 6, h - bh, 4, bh)
  }
}
function startDictation() {
  if (S.dict) return stopDictation()
  const ta = $('#draft'), box = $('#composerBox'), interim = $('#interim')
  const before = ta.value
  const sep = before && !/\s$/.test(before) ? ' ' : ''
  box.classList.add('rec')
  $('#dictMetric').textContent = canRecognise ? '听写中…' : '模拟听写'
  interim.innerHTML = `<span class="faint">${esc(before + sep)}</span><span class="caret"></span>`
  stage.setMood('listening')
  S.dict = listen({
    mode: 'dictate', lang: S.dictLang,
    onInterim: (fin, inter) => { interim.innerHTML = `<span class="faint">${esc(before + sep)}</span>${esc(fin)}<span class="faint">${esc(inter)}</span><span class="caret"></span>` },
    onLevel: (lv, spec) => { drawLevels(spec); stage.setLevel(lv) },
    onError: err => { $('#dictMetric').textContent = err === 'not-allowed' ? '无麦克风权限 · 模拟' : '模拟 · ' + err },
    onEnd: (text, m) => {
      S.dict = null
      box.classList.remove('rec')
      drawLevels(null)
      interim.innerHTML = ''
      stage.setMood('idle'); stage.setLevel(0)
      if (S.dictCancelled) { S.dictCancelled = false; return }
      if (text) {
        ta.value = before + sep + text
        autoGrow()
        ta.focus()
        ta.setSelectionRange(ta.value.length, ta.value.length)
      }
      if (m.simulated) { $('#dictMetric').textContent = '模拟听写 · 不计延迟'; return }
      const fp = m.firstPartial != null ? `首字 ${(m.firstPartial / 1000).toFixed(2)}s` : ''
      const fn = m.final != null ? ` · 定稿 ${(m.final / 1000).toFixed(2)}s` : ''
      $('#dictMetric').textContent = (fp + fn) || ''
    },
  })
  if (S.dict.simulated) $('#dictMetric').textContent = '模拟听写（浏览器不支持）'
}
function stopDictation(cancel) {
  if (!S.dict) return
  if (cancel) { S.dictCancelled = true; S.dict.cancel() } else S.dict.stop()
}
function autoGrow() { const ta = $('#draft'); ta.style.height = 'auto'; ta.style.height = Math.min(200, ta.scrollHeight) + 'px' }

/* ═════════ input wiring ═══════════════════════════════════════ */

// wake on any gesture (it's also what lets the browser speak)
$('#wake').addEventListener('click', wake)
document.addEventListener('keydown', e => { if (S.view === 'sleep' && !e.metaKey && !e.ctrlKey && e.key !== 'Tab') { e.preventDefault(); wake() } })
$('#entityHit').addEventListener('click', () => {
  if (S.view === 'sleep') return wake()
  if (S.notices.length) { const n = S.notices[0]; act(n, 'hear', $(`.notice[data-id="${n.id}"]`)); return }
  if (S.mode === 'idle') startTalk()
})

// talk: hold the button (push-to-talk) or tap it (ends on its own)
let pressAt = 0
$('#talkMic').addEventListener('pointerdown', e => { e.preventDefault(); pressAt = performance.now(); if (S.talk) { stopTalk(); pressAt = 0 } else startTalk() })
$('#talkMic').addEventListener('pointerup', () => { if (pressAt && performance.now() - pressAt > 350) stopTalk() })
$('#talk').addEventListener('submit', e => { e.preventDefault(); const i = $('#talkInput'); const v = i.value; i.value = ''; handle(v) })
$('#talkInput').addEventListener('input', () => { bump(); if (S.mode === 'idle' && $('#talkInput').value) { /* stay put until sent */ } })

// space: hold to talk, when you're not typing
let spaceDown = false
document.addEventListener('keydown', e => {
  const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName)
  if (S.view === 'home' && e.code === 'Space' && !typing && !e.repeat) { e.preventDefault(); spaceDown = true; startTalk() }
  if (e.key === 'Escape') {
    if (S.dict) return stopDictation(true)
    if (S.talk) return S.talk.cancel()
    if (S.view === 'work') return goHome()
    if (S.view === 'home') { interrupt(); stage.setMood('idle'); goIdle() }
  }
  if (S.view === 'home' && S.mode === 'idle' && !typing) {
    if (e.key === 'ArrowRight') selectTile(S.deckIndex + 1)
    if (e.key === 'ArrowLeft') selectTile(S.deckIndex - 1)
    if (e.key === 'Enter') openTab(S.deckIndex)
  }
  if (S.view === 'home' && e.key === '/' && !typing) { e.preventDefault(); $('#talkInput').focus() }
})
document.addEventListener('keyup', e => { if (e.code === 'Space' && spaceDown) { spaceDown = false; stopTalk() } })
document.addEventListener('pointerdown', () => bump(), { passive: true })

// workspace
$('#dock').addEventListener('click', goHome)
$('#backHome').addEventListener('click', goHome)
$('#sideToggle').addEventListener('click', () => $('#work').classList.toggle('side-open'))
$('#newSession').addEventListener('click', () => {
  const list = D.sessions[S.ws.id] || (D.sessions[S.ws.id] = [])
  const s = { id: 'x' + Date.now(), title: '新会话', status: 'idle', when: '现在' }
  list.unshift(s); D.threads[s.id] = []
  openSession(s.id); renderSessions(); $('#draft').focus()
})
$('#composer').addEventListener('submit', e => { e.preventDefault(); sendDraft() })
$('#draft').addEventListener('input', autoGrow)
$('#draft').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendDraft() }
})
$('#dictBtn').addEventListener('click', startDictation)
const LANGS = [['zh-CN', '中'], ['en-US', 'EN'], ['cmn-Hans-CN', '混']]
$('#langChip').addEventListener('click', () => {
  const i = (LANGS.findIndex(l => l[0] === S.dictLang) + 1) % LANGS.length
  S.dictLang = LANGS[i][0]; $('#langChip').textContent = LANGS[i][1]
})

// prototype controls
$('#protoChip').addEventListener('click', () => { $('#proto').hidden = !$('#proto').hidden })
const goWith = (k, v) => { const p = new URLSearchParams(location.search); p.set(k, v); location.search = p.toString() }
$$('#proto [data-scn]').forEach(b => b.onclick = () => goWith('scn', b.dataset.scn))
$$('#proto [data-entity]').forEach(b => b.onclick = () => goWith('entity', b.dataset.entity))
$$('#proto [data-hour]').forEach(b => b.onclick = () => { document.documentElement.dataset.hour = b.dataset.hour; markProto() })
$$('#proto [data-ev]').forEach(b => b.onclick = async () => {
  const ev = b.dataset.ev
  if (S.view === 'sleep' && ev !== 'sound' && ev !== 'reset') await wake()
  if (ev === 'research') {
    const r = D.runs.find(x => x.kind === 'research' && x.status === 'running')
    if (r) r.finish(); else notify(NOTICES.research('本地语音转写方案'))
  }
  if (ev === 'pi') notify(NOTICES.pi())
  if (ev === 'ddl') notify(NOTICES.ddl())
  if (ev === 'idle') { if (S.view === 'work') goHome(); else goIdle() }
  if (ev === 'sound') { S.sound = !S.sound; store.set('sound', S.sound); if (!S.sound) hush(); markProto() }
  if (ev === 'reset') location.reload()
})
function markProto() {
  $('#soundBtn').textContent = '声音：' + (S.sound ? '开' : '关')
  $$('#proto [data-scn]').forEach(b => b.classList.toggle('on', b.dataset.scn === S.scenario))
  $$('#proto [data-entity]').forEach(b => b.classList.toggle('on', b.dataset.entity === ENTITY))
  $$('#proto [data-hour]').forEach(b => b.classList.toggle('on', b.dataset.hour === document.documentElement.dataset.hour))
}
markProto()

new ResizeObserver(() => document.documentElement.style.setProperty('--cap-h', cap.el.offsetHeight + 'px')).observe(cap.el)

/* ═════════ start: asleep, centred, breathing ═══════════════════ */
layoutHome()
stage.snap()
stage.setMood('sleep')
stage.pointWedge(-Math.PI / 2)
document.body.dataset.mode = 'sleep'
if (params.has('awake')) wake()
