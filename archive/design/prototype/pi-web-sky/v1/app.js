import { createSky } from './sky.js';

// All state is deliberately page-local. No fetch, persistence, microphone or speech APIs.
const $ = selector => document.querySelector(selector);
const sky = createSky();
const dialog = $('#companionDialog');
const messages = $('#messages');
const input = $('#chatInput');
const pages = { home: '首页', notes: '笔记', sessions: 'Pi Web 会话' };
let page = 'home', opener = null, pending = false, replyTimer = null, voiceTimers = [], voiceActive = false, toastTimer = null;

function setState(state) {
  sky.setState(state);
  const copy = {
    idle: ['RIGHT HERE', '我在，慢慢说。', '打字就可以。\n语音也可以等你准备好了再开始。'],
    listening: ['LISTENING · DEMO', '在听你说。', '这是倾听状态演示。\n没有开启或采集麦克风。'],
    thinking: ['THINKING · DEMO', '让我理一理。', '正在切换到示例结果。\n没有请求真实模型。'],
    speaking: ['SPEAKING · DEMO', '我们可以这样开始。', '这是说话状态演示。\n不会播放声音。'],
    notice: ['SOMETHING FOR YOU', '有个结果，给你看看。', '先看结论，再决定要不要展开。\n这里使用的是演示内容。'],
  }[state] ?? ['RIGHT HERE', '我在。', ''];
  $('#stateEyebrow').textContent = copy[0];
  $('#dialogTitle').textContent = copy[1];
  $('#stateDescription').textContent = copy[2];
  $('#stateDescription').style.whiteSpace = 'pre-line';
  $('#privacyStatus').textContent = voiceActive ? '语音状态演示 · 未采集声音' : '麦克风未开启';
}
function toast(text) {
  clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 2800);
}
function showPage(next, { scroll = true } = {}) {
  if (!pages[next]) return;
  page = next;
  for (const key of Object.keys(pages)) $(`#${key}Page`).hidden = key !== next;
  $('#pageName').textContent = pages[next];
  document.querySelectorAll('[data-page]').forEach(button => {
    if (button.dataset.page === next) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  history.replaceState(null, '', `#${next}`);
  // This changes the next request's context, not any existing message.
  $('#contextLabel').textContent = `当前页面 · ${pages[next]}`;
  if (scroll) window.scrollTo({ top: 0, behavior: 'auto' });
  sky.refresh();
}
function openConversation(trigger) {
  if (!dialog.open) {
    opener = trigger instanceof HTMLElement ? trigger : document.activeElement;
    dialog.showModal();
    $('#closeDialog').focus({ preventScroll: true });
  }
  $('#contextLabel').textContent = `当前页面 · ${pages[page]}`;
  sky.refresh();
}
function stopVoice() {
  voiceTimers.forEach(clearTimeout); voiceTimers = []; voiceActive = false;
  $('#voiceDemo').setAttribute('aria-pressed', 'false');
  $('#voiceDemo span').textContent = '体验语音状态';
  if (!pending) setState('idle');
}
function closeConversation() {
  stopVoice(); dialog.close();
  if (opener?.isConnected && opener.getClientRects().length) opener.focus({ preventScroll: true });
  else document.querySelector(`.nav-item[data-page="${page}"], .mobile-nav [data-page="${page}"]`)?.focus({ preventScroll: true });
  sky.refresh();
}
$('#closeDialog').addEventListener('click', closeConversation);
dialog.addEventListener('cancel', event => { event.preventDefault(); closeConversation(); });
dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeConversation();
});
function scrollMessages() { messages.scrollTop = messages.scrollHeight; }
function appendText(role, text) {
  const node = document.createElement(role === 'user' ? 'p' : 'div');
  node.className = role === 'user' ? 'user-bubble' : 'assistant-message';
  if (role === 'user') node.textContent = text;
  else {
    const label = document.createElement('span'); label.className = 'message-label'; label.textContent = 'ROBIN · 演示回复';
    const body = document.createElement('p'); body.textContent = text;
    node.append(label, body);
  }
  messages.append(node); scrollMessages(); return node;
}
function setBusy(value) {
  pending = value; $('#chatSend').disabled = value; $('#voiceDemo').disabled = value;
  document.querySelectorAll('[data-prompt], [data-research]').forEach(button => { button.disabled = value; });
}
function planResult() {
  const node = appendText('assistant', '先保留已经有的安排，再留一小段时间给最重要的事。不把整个下午排满。');
  const card = document.createElement('div'); card.className = 'result-card';
  card.innerHTML = `<p class="eyebrow">PLAN PREVIEW · 演示方案</p><h3>给下午留一点余地</h3>
    <div class="result-row"><time>14:00</time><span>项目讨论<small>已有安排 · 不变</small></span></div>
    <div class="result-row"><time>15:00</time><span>整理讨论里的三个想法<small>建议留 25 分钟，然后休息</small></span></div>
    <div class="result-row"><time>16:30</time><span>出去走一走<small>已有安排 · 不变</small></span></div>
    <p>这里只展示计划的样子，没有写入任何日历或待办。</p><button data-preview-plan>在首页对照看看 <svg><use href="#arrow"/></svg></button>`;
  node.append(card); scrollMessages();
}
function submit(text, trigger) {
  text = text.trim();
  openConversation(trigger);
  if (!text || pending) return;
  stopVoice(); setBusy(true); appendText('user', text);
  const requestPage = page;
  setState('thinking');
  const waiting = document.createElement('p'); waiting.className = 'pending-message'; waiting.textContent = '正在展示示例回复…'; messages.append(waiting); scrollMessages();
  replyTimer = setTimeout(() => {
    waiting.remove();
    if (/安排|下午|今天|先做/.test(text)) planResult();
    else if (/语音|研究|方案/.test(text)) researchResult();
    else appendText('assistant', `收到。这句话来自「${pages[requestPage]}」。这份样稿不连接模型，所以不会真的分析或执行；你可以收起我，换一个页面再打开，刚才的对话仍会留在这里。`);
    setBusy(false); setState('idle'); replyTimer = null;
  }, 650);
}
$('#homeForm').addEventListener('submit', event => {
  event.preventDefault(); const homeInput = $('#homeInput');
  if (homeInput.value.trim() && !pending) { submit(homeInput.value, homeInput); homeInput.value = ''; }
  else openConversation(homeInput);
});
$('#chatForm').addEventListener('submit', event => {
  event.preventDefault(); if (!input.value.trim() || pending) return;
  submit(input.value, input); input.value = '';
});
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#chatForm').requestSubmit(); }
});

function researchResult() {
  const node = appendText('assistant', '先把三条路径放在一起。这里演示的是结果的呈现方式，不是真实调研结论。');
  const card = document.createElement('div'); card.className = 'result-card';
  card.innerHTML = `<p class="eyebrow">RESEARCH NOTE · 示例结果</p><h3>让语音更自然的三条路径</h3>
    <div class="result-row"><span>01</span><span>本地识别 + 文本助手<small>这里放适用场景、取舍与来源</small></span></div>
    <div class="result-row"><span>02</span><span>实时语音 + 后台委派<small>这里放延迟、打断与执行边界</small></span></div>
    <div class="result-row"><span>03</span><span>语音作为输入，文字确认<small>这里放需要明确确认的操作</small></span></div>
    <button data-preview-note>打开示例笔记 <svg><use href="#arrow"/></svg></button>`;
  node.append(card); scrollMessages();
}
function startVoice(trigger) {
  openConversation(trigger);
  if (pending) return;
  if (voiceActive) { stopVoice(); return; }
  voiceActive = true; $('#voiceDemo').setAttribute('aria-pressed', 'true'); $('#voiceDemo span').textContent = '结束状态演示';
  setState('listening');
  voiceTimers.push(setTimeout(() => { if (voiceActive) setState('thinking'); }, 1800));
  voiceTimers.push(setTimeout(() => { if (voiceActive) setState('speaking'); }, 3000));
  voiceTimers.push(setTimeout(() => {
    if (!voiceActive) return;
    appendText('assistant', '刚才依次演示了倾听、思考和说话的形象变化。没有录音，也没有播放声音。真实版本会由实际语音与执行状态驱动。');
    stopVoice();
  }, 5100));
}
$('#voiceDemo').addEventListener('click', event => startVoice(event.currentTarget));

const presenceNote = $('#noteArticle').innerHTML;
function selectNote(name) {
  document.querySelectorAll('[data-note]').forEach(button => button.classList.toggle('selected', button.dataset.note === name));
  $('#noteArticle').innerHTML = name === 'voice' ? `<p class="note-meta">想法 / NOV 18 · 示例笔记</p><h2>关于语音的几个想法</h2><p class="note-lead">能够听见，不代表需要一直听着。</p><p>文字和语音是两种表达方式，不应该变成两个互不认识的助手。</p><blockquote>在场感来自连续性，不来自常驻麦克风。</blockquote><h3>最重要的三个边界</h3><p>打开对话，不等于开麦。打断说话，不等于取消任务。模型说完成，不等于已经保存。</p><h3>让画面说清楚</h3><p>倾听、等待、说话和结果待查看，应该各有可辨认的状态，也要有文字说明。</p><div class="note-margin"><span>独立样稿</span>这是一篇写在 HTML 里的示例笔记，不是你的真实资料。</div>` : presenceNote;
}

document.addEventListener('click', event => {
  const target = event.target.closest('button'); if (!target) return;
  if (target.dataset.page) showPage(target.dataset.page);
  else if (target.hasAttribute('data-calendar')) { showPage('home'); $('#schedule').scrollIntoView({ block: 'center', behavior: 'auto' }); }
  else if (target.hasAttribute('data-open')) openConversation(target);
  else if (target.hasAttribute('data-voice')) startVoice(target);
  else if (target.dataset.prompt) submit(target.dataset.prompt, target);
  else if (target.hasAttribute('data-research') || target.id === 'noticeButton') { openConversation(target); researchResult(); if (!pending && !voiceActive) setState('notice'); }
  else if (target.hasAttribute('data-preview-plan')) { closeConversation(); showPage('home'); $('#schedule').scrollIntoView({ block: 'center', behavior: 'auto' }); toast('只是对照演示，日历没有发生任何修改。'); }
  else if (target.hasAttribute('data-preview-note')) { closeConversation(); showPage('notes'); selectNote('voice'); }
  else if (target.dataset.note) selectNote(target.dataset.note);
});
$('#themeToggle').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#themeToggle').setAttribute('aria-label', dark ? '切换到浅色' : '切换到夜色');
  document.querySelector('meta[name="theme-color"]').content = dark ? '#0e1018' : '#f4f3f5';
});
$('#motionToggle').addEventListener('click', () => {
  const paused = $('#motionToggle').getAttribute('aria-pressed') !== 'true';
  $('#motionToggle').setAttribute('aria-pressed', String(paused));
  $('#motionToggle').setAttribute('aria-label', paused ? '恢复形象动画' : '暂停形象动画');
  $('#motionToggle').title = paused ? '恢复形象动画' : '暂停形象动画';
  sky.setPaused(paused);
});
document.querySelectorAll('.todo-row input').forEach(checkbox => checkbox.addEventListener('change', () => {
  const remaining = [...document.querySelectorAll('.todo-row input')].filter(input => !input.checked).length;
  $('#todoCount').textContent = `${remaining} 件`; toast('演示状态已变化；没有保存到真实待办。');
}));
document.addEventListener('visibilitychange', () => { if (document.hidden) stopVoice(); });
addEventListener('pagehide', () => { stopVoice(); clearTimeout(replyTimer); clearTimeout(toastTimer); });
showPage(pages[location.hash.slice(1)] ? location.hash.slice(1) : 'home', { scroll: false });
setState('idle');
