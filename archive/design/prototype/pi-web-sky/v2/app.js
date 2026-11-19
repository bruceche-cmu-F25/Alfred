import { createSky } from './sky.js';

// A scripted scene, not an assistant backend. All data and drafts die with this document.
const $ = selector => document.querySelector(selector);
const sky = createSky();
const stage = $('#stage'), entity = $('#entity'), speech = $('#speech'), input = $('#askInput');
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const surfaces = { calendar: $('#calendarSurface'), notes: $('#notesSurface') };
let surface = 'none', reading = false, phase = 'idle', cue = null;
let steps = [], stepIndex = -1, timer = null, dueAt = 0, remaining = 0, paused = false, tour = false;

function setPhase(next) {
  phase = next;
  const displayed = steps.length && paused ? 'paused' : next;
  stage.dataset.phase = displayed; sky.setState(displayed === 'paused' ? 'idle' : displayed);
  $('#phaseLabel').textContent = {
    idle: reading ? 'ROBIN · 在旁边' : 'ROBIN · 在这里', paused: 'ROBIN · 暂停讲解',
    listening: 'ROBIN · 倾听演示', thinking: 'ROBIN · 正在找', speaking: 'ROBIN · 正在介绍',
  }[displayed];
}
function say(line, detail = '') {
  $('#spokenLine').textContent = line;
  $('#speechDetail').textContent = detail;
  layoutStage();
}
function request(text, simulated = false) {
  $('#requestAuthor').textContent = simulated ? '演示提问' : '你';
  $('#requestText').textContent = text;
  $('#requestLine').hidden = false;
}
function pointAt(next, scroll = true) {
  cue = next;
  document.querySelectorAll('[data-cue]').forEach(element => {
    const active = element.dataset.cue === next;
    element.classList.toggle('is-cued', active);
    if (active && scroll) {
      const body = element.closest('.sheet-body');
      // Only the paper scrolls, never the stage or the user's composer.
      const top = element.offsetTop, bottom = top + element.offsetHeight;
      if (top < body.scrollTop || bottom > body.scrollTop + body.clientHeight) body.scrollTop = Math.max(0, top - 20);
    }
  });
  drawThread();
}
function showSurface(next, focusReading = false) {
  if (surface !== next) pointAt(null);
  for (const [key, element] of Object.entries(surfaces)) {
    const visible = key === next;
    // A scene change must not leave keyboard focus in an inert, departing surface.
    if (!visible && element.contains(document.activeElement)) input.focus({ preventScroll: true });
    element.inert = !visible;
    element.setAttribute('aria-hidden', String(!visible));
    element.classList.toggle('is-visible', visible);
    if (visible && next !== surface) element.querySelector('.sheet-body').scrollTop = 0;
  }
  surface = next; reading = focusReading;
  stage.dataset.surface = next; stage.classList.toggle('is-reading', reading);
  $('#readingToggle').setAttribute('aria-pressed', String(reading));
  $('#readingToggle').firstChild.textContent = reading ? '继续一起看 ' : '我先读一下 ';
  $('#sceneTrail').textContent = next === 'calendar' ? '你问起今天，它把日程带来了。' : next === 'notes' ? (reading ? '内容在你面前，它在你身边。' : '从日程，接到相关的笔记。') : '只是你，和 Robin。';
  sky.setGaze(next === 'none' ? -.12 : .55, .2);
  layoutStage();
}

// The whole scene shares one clock: speech, pose, paper, and the item being indicated.
// Replacing a request clears that clock. No old reply can bring a previous paper back.
function controls() {
  const active = steps.length > 0;
  if (!active && $('#playbackControls').contains(document.activeElement)) input.focus({ preventScroll: true });
  $('#playbackControls').hidden = !active;
  $('#playbackLabel').textContent = active ? (paused ? '已暂停 · 可逐句看' : '静音台词演示 · 无录音') : '独立样稿 · 无录音、无真实操作';
  $('#pauseSequence span').textContent = paused ? '继续' : '暂停';
  $('#pauseSequence').setAttribute('aria-label', paused ? '继续讲解' : '暂停讲解');
  $('#pauseSequence use').setAttribute('href', paused ? '#play' : '#pause');
  $('#tourToggle').setAttribute('aria-pressed', String(tour));
  $('#tourToggle span').textContent = tour ? '结束演示' : '看一段演示';
  $('#entityButton').setAttribute('aria-label', active ? (paused ? '继续 Robin 的讲解' : '暂停 Robin 的讲解') : '让 Robin 介绍今天的安排（无录音演示）');
  setPhase(phase);
}
function cancelSequence() {
  clearTimeout(timer); timer = null; steps = []; stepIndex = -1; tour = false; paused = false;
  controls();
}
function scheduleNext() {
  clearTimeout(timer); timer = null;
  if (paused || !steps.length) return;
  dueAt = performance.now() + remaining;
  timer = setTimeout(advance, remaining);
}
function applyStep(step) {
  if (step.request) request(step.request, true);
  if (step.surface) showSurface(step.surface, step.reading ?? false);
  if ('cue' in step) pointAt(step.cue);
  setPhase(step.phase ?? 'speaking');
  say(step.line, step.detail);
  stage.dataset.beat = step.id;
}
function advance() {
  clearTimeout(timer); timer = null;
  if (!steps.length) return;
  stepIndex++;
  if (stepIndex >= steps.length) { cancelSequence(); setPhase('idle'); return; }
  const step = steps[stepIndex];
  applyStep(step);
  remaining = step.hold ?? 2400;
  // A final frame remains on screen. Completing a demo never closes the user's paper.
  if (stepIndex === steps.length - 1) { cancelSequence(); setPhase('idle'); }
  else { controls(); scheduleNext(); }
}
function play(sequence, isTour = false) {
  cancelSequence(); steps = sequence; tour = isTour; paused = reduce.matches || document.hidden;
  advance();
}
function togglePause() {
  if (!steps.length) return;
  if (paused) { paused = false; scheduleNext(); }
  else { remaining = Math.max(0, dueAt - performance.now()); paused = true; clearTimeout(timer); timer = null; }
  controls();
}
function stopIntroduction() {
  cancelSequence(); pointAt(null); setPhase('idle');
  say(surface === 'none' ? '我在。想看什么，再告诉我。' : '好，先停在这里。', surface === 'none' ? '' : '东西留在面前，慢慢看。');
}

const calendarSteps = () => [
  { id: 'find-calendar', phase: 'thinking', surface: 'none', line: '我把今天的安排拿给你。', detail: '不用打开日历，我们就在这里看。', hold: 900 },
  { id: 'bring-calendar', surface: 'calendar', cue: null, line: '今天下午，有两件事。', detail: '先看已经安排好的。', hold: 1000 },
  { id: 'meeting', cue: 'meeting', line: '两点，有一场项目讨论。', detail: '产品方向和下一步，留了 45 分钟。', hold: 2500 },
  { id: 'space', cue: 'space', line: '讨论之后，这里是空的。', detail: '可以留给自己，不急着再安排。', hold: 2400 },
  { id: 'walk', cue: 'walk', line: '四点半，出去走一走。', detail: '也给眼睛和脑袋一点休息。', hold: 2400 },
  { id: 'calendar-ready', phase: 'idle', cue: null, line: '要把讨论的笔记也拿来吗？', detail: '你接着问就好，不用去找。' },
];
const noteSteps = () => [
  { id: 'find-notes', phase: 'thinking', cue: null, line: '和这场讨论有关的，是这一份。', detail: '日程先放下，我把笔记拿过来。', hold: 850 },
  { id: 'bring-notes', surface: 'notes', cue: null, line: '接着上次的想法。', detail: '《一个一直在场的助手》', hold: 1100 },
  { id: 'note-idea', cue: 'idea', line: '你想要的，是它把东西带来。', detail: '而不是再多一个需要打开的窗口。', hold: 2800 },
  { id: 'notes-ready', phase: 'idle', cue: null, line: '这份先放在这里。', detail: '想自己读一会儿，我就让开。' },
];
function gather() {
  cancelSequence(); showSurface('none'); setPhase('idle');
  say('好，先把这些收起来。', '需要什么，再叫我。');
  $('#requestLine').hidden = true;
  stage.dataset.beat = 'rest';
}
function readQuietly() {
  cancelSequence(); pointAt(null); showSurface('notes', true); setPhase('idle');
  say('嗯，你慢慢看。', '我在旁边。'); stage.dataset.beat = 'reading';
}
function ask(intent, text, { simulated = false } = {}) {
  request(text, simulated);
  if (intent === 'calendar') play(calendarSteps());
  else if (intent === 'notes') play(noteSteps());
  else if (intent === 'read') readQuietly();
  else if (intent === 'rest') gather();
  else {
    cancelSequence(); pointAt(null); setPhase('idle');
    say('这次，我们先试日程和笔记。', '这是固定场景样稿，不会真的分析或执行。');
  }
}
const prompts = { calendar: '今天有什么安排？', notes: '项目讨论的笔记呢？' };
function intentFor(text) {
  // ponytail: two fixed scenes only. This is deliberately not natural-language understanding.
  if (/收起|静一会|不用|休息|结束/.test(text)) return 'rest';
  if (/读一下|自己读|先读|阅读/.test(text)) return 'read';
  if (/笔记|资料|讨论/.test(text)) return 'notes';
  if (/日程|安排|今天|下午/.test(text)) return 'calendar';
  return 'unknown';
}
function startTour() {
  cancelSequence(); showSurface('none');
  const day = calendarSteps(), note = noteSteps();
  // This explicit demo can be stopped, paused or advanced. It never auto-starts on page load.
  play([
    { id: 'tour-listen', request: prompts.calendar, phase: 'listening', line: '嗯，我在。', detail: '倾听状态示意，没有开启麦克风。', hold: 900 },
    ...day.slice(0, -1),
    { ...day.at(-1), hold: 1800 },
    { ...note[0], request: prompts.notes },
    ...note.slice(1, -1),
    { ...note.at(-1), hold: 1900 },
    { id: 'reading', request: '我先读一下。', surface: 'notes', reading: true, cue: null, phase: 'idle', line: '嗯，你慢慢看。', detail: '我在旁边。' },
  ], true);
}

// Read geometry only on scene/viewport changes, never per animation frame.
let position = { x: 0, y: 0, radius: 0 };
function layoutStage() {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  const compact = w < 760, active = surface !== 'none', short = h < 300;
  const size = entity.offsetWidth;
  const textWidth = active ? (compact ? w - 128 : Math.min(330, w * .34)) : Math.min(440, w - 40);
  speech.style.width = `${textWidth}px`;
  let x, y, radius, textX, textY;
  if (active && compact) {
    x = 55; y = short ? 43 : 56; radius = reading ? 26 : 33;
    textX = 106; textY = short ? 7 : 15;
  } else {
    radius = Math.min(size * .305 * (active ? (reading ? .39 : .70) : 1), Math.max(35, (h - 155) / 2));
    x = active ? w * (reading ? .22 : .24) : w / 2;
    y = Math.max(radius + (short ? 0 : 20), (h - speech.offsetHeight - 36) * (reading ? .36 : .46));
    textX = x - textWidth / 2;
    textY = Math.min(h - speech.offsetHeight - 12, y + radius + (short ? 9 : 25));
  }
  entity.style.transform = `translate(${x - size / 2}px, ${y - size / 2}px) scale(${radius / (size * .305)})`;
  speech.style.transform = `translate(${textX}px, ${textY}px)`;
  position = { x, y, radius };
  drawThread();
}
function drawThread() {
  const visible = surface !== 'none' && !reading && !!cue && stage.clientWidth >= 760;
  $('#tether').classList.toggle('is-visible', visible);
  if (!visible) return;
  const box = $('#surfaceSpace').getBoundingClientRect(), root = stage.getBoundingClientRect();
  const target = surfaces[surface].querySelector('.is-cued');
  const body = surfaces[surface].querySelector('.sheet-body');
  const sx = position.x + position.radius * .9, sy = position.y;
  const tx = box.left - root.left + 6;
  const targetY = target ? body.offsetTop + target.offsetTop - body.scrollTop + target.offsetHeight / 2 : 70;
  const ty = box.top - root.top + Math.max(60, Math.min(box.height - 60, targetY));
  $('#thread').setAttribute('d', `M ${sx} ${sy} C ${sx + 72} ${sy}, ${tx - 68} ${ty}, ${tx} ${ty}`);
  $('#threadEnd').setAttribute('cx', tx); $('#threadEnd').setAttribute('cy', ty);
}

$('#askForm').addEventListener('submit', event => {
  event.preventDefault(); const text = input.value.trim();
  if (!text) { input.focus(); return; }
  input.value = ''; ask(intentFor(text), text);
});
// Native input Enter handles composition correctly; no global key handler sends messages.
document.addEventListener('click', event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.intent) ask(button.dataset.intent, prompts[button.dataset.intent]);
  else if (button.hasAttribute('data-gather')) gather();
});
$('#homeButton').addEventListener('click', gather);
$('#entityButton').addEventListener('click', () => {
  if (steps.length) togglePause();
  else ask('calendar', prompts.calendar);
});
$('#tourToggle').addEventListener('click', () => { if (tour) stopIntroduction(); else startTour(); });
$('#readingToggle').addEventListener('click', () => {
  if (reading) ask('notes', '继续一起看看。');
  else { request('我先读一下。'); readQuietly(); }
});
$('#voiceDemo').addEventListener('click', () => {
  request('今天有什么安排？', true);
  play([{ id: 'voice-listen', phase: 'listening', line: '嗯，我在。', detail: '这句提问是预设台词，没有录音。', hold: 1300 }, ...calendarSteps()]);
});
$('#pauseSequence').addEventListener('click', togglePause);
$('#advanceCue').addEventListener('click', advance);
$('#stopSequence').addEventListener('click', stopIntroduction);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { if (steps.length) stopIntroduction(); else gather(); }
});
$('#themeToggle').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#themeToggle').setAttribute('aria-label', dark ? '切换到浅色' : '切换到夜色');
  document.querySelector('meta[name="theme-color"]').content = dark ? '#0d0c12' : '#f4f0ed';
});
$('#motionToggle').addEventListener('click', () => {
  const still = $('#motionToggle').getAttribute('aria-pressed') !== 'true';
  $('#motionToggle').setAttribute('aria-pressed', String(still));
  $('#motionToggle').setAttribute('aria-label', still ? '恢复动态效果' : '减少动态效果');
  document.documentElement.classList.toggle('motion-paused', still); sky.setPaused(still);
});
reduce.addEventListener('change', () => { if (reduce.matches && steps.length && !paused) togglePause(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && steps.length && !paused) togglePause(); });
addEventListener('pagehide', () => { if (steps.length && !paused) togglePause(); });
new ResizeObserver(layoutStage).observe(stage);
for (const element of Object.values(surfaces)) element.querySelector('.sheet-body').addEventListener('scroll', drawThread, { passive: true });
setPhase('idle'); stage.dataset.beat = 'rest'; layoutStage();
