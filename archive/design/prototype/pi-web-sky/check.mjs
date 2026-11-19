// Isolated Chromium smoke check. Uses an existing installation; no new dependencies.
// node check.mjs [http://127.0.0.1:4173]
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { criticalStep } from './stage-spring.mjs';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/bruce/pi-web-robin/node_modules/playwright/index.mjs');
const base = process.argv[2] || 'http://127.0.0.1:4173';
const output = fileURLToPath(new URL('./previews/v3/', import.meta.url));
const reference = await readFile(new URL('../forms.html', import.meta.url), 'utf8');
// A retarget is a new force, not a new starting position/velocity.
let x = 0, velocity = 0;
for (let i = 0; i < 12; i++) [x, velocity] = criticalStep(x, velocity, 100, 1 / 60);
assert.ok(x > 0 && x < 100 && velocity > 0);
assert.deepEqual(criticalStep(x, velocity, 0, 0), [x, velocity]);
const redirected = criticalStep(x, velocity, 0, .00001);
assert.ok(Math.abs(redirected[0] - x) < .01 && Math.abs(redirected[1] - velocity) < 1);
for (let i = 0; i < 90; i++) [x, velocity] = criticalStep(x, velocity, 0, 1 / 60);
assert.ok(Math.abs(x) < .01 && Math.abs(velocity) < .01);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [], unexpected = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    window.__forbidden = [];
    const deny = name => () => { window.__forbidden.push(name); throw new Error(`Mock must not use ${name}`); };
    window.fetch = deny('fetch'); window.WebSocket = deny('WebSocket'); window.XMLHttpRequest = deny('XMLHttpRequest');
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = deny('microphone');
    if (window.speechSynthesis) speechSynthesis.speak = deny('audio');
    Storage.prototype.setItem = deny('persistent storage');
    indexedDB.open = deny('indexedDB'); navigator.sendBeacon = deny('beacon');
  });
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== new URL(base).origin || request.method() !== 'GET' || url.pathname.startsWith('/api/')) {
      unexpected.push(`${request.method()} ${url}`); return route.abort();
    }
    return route.continue();
  });
  context.on('page', page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' || message.text().startsWith('Sky uses')) errors.push(message.text()); });
  });
  const page = await context.newPage();
  const beat = () => page.locator('#stage').getAttribute('data-beat');
  async function reach(name) {
    for (let i = 0; i < 20 && await beat() !== name; i++) await page.locator('#advanceCue').click();
    assert.equal(await beat(), name);
  }
  async function pause() {
    if (await page.locator('#pauseSequence').getAttribute('aria-label') === '暂停讲解') await page.locator('#pauseSequence').click();
  }
  async function capture(name) {
    await page.waitForTimeout(850);
    await page.screenshot({ path: `${output}/${name}.png` });
  }
  async function safeLayout(label) {
    await page.waitForTimeout(850);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `horizontal overflow: ${label}`);
    const send = await page.locator('.send-button').boundingBox();
    assert.ok(send.y >= 0 && send.y + send.height <= page.viewportSize().height + 1, `composer reachable: ${label}`);
    const box = await page.locator('#spokenLine').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= page.viewportSize().width + 1, `speech fits: ${label}`);
    const paper = await page.locator('#surfaceSpace').boundingBox();
    const active = await page.locator('#stage').getAttribute('data-surface') !== 'none';
    const orb = await page.locator('#entityButton').boundingBox();
    const zone = await page.locator('#interactionZone').boundingBox();
    if (active) {
      assert.ok(paper.y + paper.height <= zone.y + 1, `paper must not overlap composer: ${label}`);
      if (page.viewportSize().width >= 1200) {
        assert.ok(paper.width / page.viewportSize().width > .75, `content owns the space: ${label}`);
        assert.ok(orb.x < 52, `Sky retreats to the left edge: ${label}`);
        assert.ok(box.x + box.width < paper.x, `caption stays out of the paper: ${label}`);
        assert.ok(Math.abs(zone.x + zone.width / 2 - paper.x - paper.width / 2) < 2, `composer follows content: ${label}`);
      }
    } else {
      assert.ok(zone.y - (box.y + box.height) < 90, `no dead band below the greeting: ${label}`);
    }
    assert.deepEqual(await page.evaluate(() => window.__forbidden), []);
  }
  async function submit(text) { await page.locator('#askInput').fill(text); await page.locator('#askInput').press('Enter'); }
  await page.goto(base);
  await page.waitForSelector('.entity.sky-ready');
  assert.equal(await page.locator('.surface.is-visible').count(), 0);
  assert.equal(await page.locator('dialog').count(), 0, 'one scene, not a modal chat');
  await capture('home-dark');

  // Real-time playback: the paper arrives first; then the spoken item is indicated.
  await page.locator('#tourToggle').click();
  await page.waitForSelector('#stage[data-beat="bring-calendar"]');
  assert.equal(await page.locator('#calendarSurface').getAttribute('aria-hidden'), 'false');
  await page.waitForSelector('#stage[data-beat="meeting"]');
  assert.equal(await page.locator('[data-cue="meeting"]').getAttribute('class'), 'agenda-event is-cued');
  assert.match(await page.locator('#spokenLine').innerText(), /两点/);
  assert.equal(await page.locator('#tether, #thread, #threadEnd').count(), 0, 'no connector between Sky and desktop content');
  await pause();
  const held = await beat();
  await page.waitForTimeout(2700);
  assert.equal(await beat(), held, 'pause must hold the whole narrative');
  await capture('calendar-dark');
  await safeLayout('desktop calendar');
  await page.locator('#askInput').fill('尚未发送的草稿');
  await page.locator('#advanceCue').click();
  assert.equal(await beat(), 'space');
  assert.match(await page.locator('[data-cue="space"]').getAttribute('class'), /is-cued/);
  await reach('note-idea');
  assert.equal(await page.locator('#calendarSurface').evaluate(element => element.inert), true);
  assert.equal(await page.locator('.surface.is-visible').count(), 1);
  assert.equal(await page.locator('#askInput').inputValue(), '尚未发送的草稿');
  await capture('notes-dark');
  await page.locator('#readingToggle').click();
  assert.equal(await beat(), 'reading');
  assert.match(await page.locator('#stage').getAttribute('class'), /is-reading/);
  await capture('reading-dark');
  await safeLayout('desktop reading');
  await page.keyboard.press('Escape');
  assert.equal(await beat(), 'rest');
  assert.equal(await page.locator('.surface.is-visible').count(), 0);
  assert.equal(await page.locator('#askInput').inputValue(), '尚未发送的草稿');
  assert.equal(await page.locator('#askInput').evaluate(element => element === document.activeElement), true);

  // A second request supersedes the first; closing never lets a late step reopen a paper.
  await submit('今天有什么安排？');
  await submit('项目讨论的笔记呢？');
  await page.waitForSelector('#stage[data-beat="bring-notes"]');
  await page.locator('#homeButton').click();
  await page.waitForTimeout(1600);
  assert.equal(await beat(), 'rest');
  assert.equal(await page.locator('#stage').getAttribute('data-surface'), 'none');

  await page.locator('#askInput').fill('<img src=x onerror="window.__xss=1">');
  await page.locator('.send-button').click();
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.match(await page.locator('#requestText').innerText(), /<img/);
  assert.match(await page.locator('#spokenLine').innerText(), /日程和笔记/);
  await page.locator('#voiceDemo').click();
  assert.equal(await beat(), 'voice-listen');
  assert.match(await page.locator('#speechDetail').innerText(), /没有录音/);
  await page.locator('#stopSequence').click();
  assert.equal(await page.locator('#stage').getAttribute('data-phase'), 'idle');

  // Walk the complete tour without waiting for every caption's reading time.
  await page.locator('#tourToggle').click(); await pause(); await reach('reading');
  assert.equal(await page.locator('#tourToggle').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#stage').getAttribute('data-surface'), 'notes');
  assert.equal(await page.locator('#playbackControls').isVisible(), false);
  await page.locator('#homeButton').click();
  await page.locator('#themeToggle').click();
  await capture('home-light');
  await page.locator('#suggestions [data-intent="calendar"]').click(); await pause(); await reach('meeting');
  await capture('calendar-light');
  await page.locator('#homeButton').click();

  // A hidden tab pauses instead of racing to a different scene on return.
  await page.locator('#tourToggle').click();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(await page.locator('#pauseSequence').getAttribute('aria-label'), '继续讲解');
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(await page.locator('#pauseSequence').getAttribute('aria-label'), '继续讲解');
  await page.locator('#stopSequence').click();

  // Exact source palette tokens, actual pixels, independent light/dark material,
  // URL restoration, and changing an hour without resetting an active scene/draft.
  await page.locator('#homeButton').click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const palettePixels = new Set();
  for (const hour of ['dawn', 'day', 'dusk', 'night']) {
    await page.locator(`.hours [data-hour="${hour}"]`).click();
    const sourceBlock = hour === 'dusk' ? reference.match(/:root\s*\{([\s\S]*?)\}/)[1]
      : reference.match(new RegExp(":root\\[data-hour='" + hour + "'\\]\\s*\\{([\\s\\S]*?)\\}"))[1];
    const actual = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      return ['heat-1', 'heat-2', 'heat-3', 'heat-4', 'sky-amber', 'sky-ink'].map(key => css.getPropertyValue(`--${key}`).trim());
    });
    const expected = ['heat-1', 'heat-2', 'heat-3', 'heat-4', 'amber', 'ink'].map(key => sourceBlock.match(new RegExp('--' + key + ':\\s*(#[a-fA-F0-9]{6})'))[1]);
    assert.deepEqual(actual, expected, `exact forms.html ${hour} palette`);
    assert.equal(new URL(page.url()).searchParams.get('hour'), hour);
    assert.equal(await page.locator('.hours [aria-pressed="true"]').count(), 1);
    palettePixels.add(await page.locator('[data-sky]').evaluate(canvas => canvas.toDataURL()));
    await capture(`palette-${hour}`);
  }
  assert.equal(palettePixels.size, 4, 'all four hours actually change the shader');
  const beforeMaterial = await page.locator('[data-sky]').evaluate(canvas => canvas.toDataURL());
  await page.locator('#themeToggle').click();
  assert.equal(await page.locator('[data-sky]').evaluate(canvas => canvas.toDataURL()), beforeMaterial, 'paper theme must not recolor Sky');
  await submit('今天的日程'); await reach('meeting');
  await page.locator('#askInput').fill('配色切换不丢草稿');
  await page.locator('.hours [data-hour="dawn"]').click();
  assert.equal(await beat(), 'meeting');
  assert.equal(await page.locator('#askInput').inputValue(), '配色切换不丢草稿');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // Retarget mid-flight: no jump to the old or new logical target on the click.
  await page.locator('#homeButton').click(); await page.waitForTimeout(900);
  await submit('今天的日程');
  await page.waitForSelector('#stage[data-beat="bring-calendar"]');
  await page.waitForTimeout(60);
  const transforms = await page.evaluate(() => {
    const entity = document.querySelector('#entity');
    const before = getComputedStyle(entity).transform;
    document.querySelector('#homeButton').click();
    return [before, getComputedStyle(entity).transform];
  });
  assert.equal(transforms[0], transforms[1], 'interrupt starts at the presentation value');
  await page.waitForTimeout(1000);
  assert.equal(await page.locator('#stage').getAttribute('data-surface'), 'none');

  for (const [width, height] of [[320, 740], [375, 812], [390, 844], [768, 1024], [812, 375], [1440, 900], [1920, 1080], [390, 500]]) {
    await page.setViewportSize({ width, height }); await page.goto(base);
    await page.waitForSelector('.entity.sky-ready');
    await safeLayout(`home ${width}x${height}`);
    if (width === 390 && height === 844) await capture('home-mobile');
    // Reduced-motion stops the shader and makes narration opt-in, one cue at a time.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(100);
    const first = await page.locator('[data-sky]').evaluate(canvas => canvas.toDataURL());
    await page.waitForTimeout(160);
    assert.equal(await page.locator('[data-sky]').evaluate(canvas => canvas.toDataURL()), first);
    // Entity is still a real keyboard-operable control in reduced-motion/fallback modes.
    await page.locator('#entityButton').click();
    assert.equal(await page.locator('#pauseSequence').getAttribute('aria-label'), '继续讲解');
    await reach('meeting'); await safeLayout(`calendar ${width}x${height}`);
    if (width === 390 && height === 844) await capture('calendar-mobile');
    await page.locator('#calendarSurface [data-intent="notes"]').last().click();
    await reach('note-idea'); await safeLayout(`notes ${width}x${height}`);
    if (width === 390 && height === 844) await capture('notes-mobile');
    await page.locator('#readingToggle').click(); await safeLayout(`reading ${width}x${height}`);
    await page.locator('#notesSurface [data-gather]').click();
    assert.equal(await page.locator('.surface.is-visible').count(), 0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  }
  // A continuing question changes the paper, not a detour back to a centered hero.
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(base); await page.emulateMedia({ reducedMotion: 'reduce' });
  await submit('项目笔记'); await reach('notes-ready');
  await page.locator('#notesSurface [data-intent="calendar"]').click();
  assert.equal(await beat(), 'find-calendar');
  assert.equal(await page.locator('#stage').getAttribute('data-surface'), 'notes');
  assert.ok((await page.locator('#entityButton').boundingBox()).x < 52);
  await page.locator('#homeButton').click();

  // Larger text grows the compact speech/header allocation instead of covering the paper.
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(base);
  await page.evaluate(() => { document.documentElement.style.fontSize = '24px'; });
  await submit('项目笔记'); await reach('note-idea');
  await safeLayout('150% text on phone');
  const largeSpeech = await page.locator('#speech').boundingBox();
  const largePaper = await page.locator('#surfaceSpace').boundingBox();
  assert.ok(largeSpeech.y + largeSpeech.height < largePaper.y, 'large text and paper do not overlap');

  const fallback = await context.newPage();
  await fallback.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) { return type === 'webgl2' ? null : original.call(this, type, ...args); };
  });
  await fallback.goto(base);
  assert.equal(await fallback.locator('.entity').evaluate(element => getComputedStyle(element, '::before').display), 'block');
  await fallback.locator('#suggestions [data-intent="notes"]').click();
  await fallback.waitForSelector('#notesSurface.is-visible');
  const fallbackPalette = await fallback.locator('.entity').evaluate(element => getComputedStyle(element, '::before').backgroundImage);
  await fallback.locator('.hours [data-hour="dawn"]').click();
  assert.notEqual(await fallback.locator('.entity').evaluate(element => getComputedStyle(element, '::before').backgroundImage), fallbackPalette);
  await fallback.locator('#homeButton').click();
  assert.equal(await fallback.locator('#stage').getAttribute('data-surface'), 'none');
  assert.deepEqual(await fallback.evaluate(() => window.__forbidden), []);
  assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
  console.log('PASS: source-exact four palettes + shader pixels, material independence, left-edge/content geometry, spring reversal, timed cues, pause/step/stop, supersession, focus/drafts, wide/mobile/short viewport, reduced motion, WebGL fallback, zero APIs/mic/audio/storage.');
  console.log(`Previews: ${output}`);
} finally { await browser.close(); }
