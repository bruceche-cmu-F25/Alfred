# Alfred · interaction prototype

No build step, no dependencies. Static HTML + ES modules, sample data only.

```bash
python3 -m http.server 4173 --directory prototype
```

Open <http://localhost:4173>. Use Chrome or Safari for real speech recognition. Elsewhere, and when the mic is blocked, voice input falls back to a labelled simulation so every flow can still be clicked through.

## What's in it

| File | Role |
|---|---|
| `js/stage.js` | One canvas on the 9px grid. Entity = lit sphere + gyroscope rings + motes, projected from 3D and quantised to the hour's heat ramp with a 4×4 Bayer dither (same method as `bruce-portfolio/components/home/BlackHole.tsx`). Also draws panel links, build-in sweeps, cursor trail, and the docked entity. |
| `js/voice.js` | SpeechRecognition (interim results) + mic analyser for the waveform ring; speechSynthesis for replies; latency metrics. The seam where Higgs Realtime / a streaming STT go later. |
| `js/main.js` | States (sleep → home: brief / talk / idle → workspace), panels, intents, quiet notices, Deck, Pi-style chat, dictation. |
| `js/data.js` | All sample data, plus pixel glyphs authored as text. |

**The entity** has a lit core sphere, three gyroscope rings and motes. Its outermost ring (bracket arcs, ticks, and the amber notice block) is the equator of one big sphere around everything. A dotted outline marks that sphere and always stays round.

Entity moods: `sleep`, `idle`, `listening` (your voice wraps the core as a circular waveform), `thinking` (rings spin up, scanline), `speaking` (the whole entity swells with each word).

**Alternative entity: the point sphere** (`?entity=swarm`, or PROTOTYPE → 形象 → 点阵球). It's one material: about 380 points spread evenly on a sphere, one pixel each, with its colour set by depth. It reads as 3D from motion parallax as it turns, and it has no face. Each state is the same points moving differently:

| State | What the points do |
|---|---|
| Asleep | Settle low and dim |
| Waking | Gather in from across the grid |
| Listening | Your voice ripples the surface |
| Thinking | Latitude bands flow at different speeds |
| Speaking | The ball puffs with each word |
| Attending | Points gather and brighten on the side it faces, and it leans in |

Its one decoration is a dotted horizon. Each waiting result is an amber satellite on that horizon, and opening the result flies its satellite into the ball.

**It turns toward what it's attending to.** At rest the outer ring faces you flat. When something appears, the ring tilts toward it like a dish turning. Tilt and position run on springs, so turns overshoot slightly and settle. It turns toward:
- the section it's talking about;
- the selected Deck tab;
- a notice as it arrives (a glance only, it says nothing);
- you, while you speak;
- otherwise, your pointer.

**Three home layouts.**
- `talk`: Alfred in the centre.
- `present`: Alfred glides to a left column with its caption and the talk bar, and one large sheet holds the result on the right.
- `idle`: Alfred stands on the Deck.

## How to test

Use **PROTOTYPE** (bottom-left) to switch scenario (早晨 / 下午回来 / 晚上), palette (dawn / day / dusk / night), and to fire events.

1. **Morning**: wake, and Alfred says "Welcome back, Bruce." in the centre. It then steps aside and talks the brief through one sentence per section (mail, calendar, todos, news). Each section builds in as Alfred turns to it. Click ✓ 加入待办 on an email and check the todo appears, then use 撤销 to undo.
2. **Talk**: hold Space, click the mic, or type. Try 计划一下今天 → 应用安排, 把站会改到四点, Stripe 那个做完了, 自动任务怎么样了, 明早早报加上英伟达.
3. **Quiet result**: 帮我调查一下本地语音转写. After about 14s a notice appears top-right and an amber block shows on the ring. Nothing speaks until you click 听汇报.
4. **Idle / Deck**: Esc, or 45s without input. Tabs along the top are 今天 plus each workspace, and the body previews the selected one. Use ←/→ to switch (Alfred turns to the tab) and Enter or a second click to go in. On 今天, Enter plans the day.
5. **Workspace**: the entity docks top-left (click it or press Esc to go home). Click the mic to dictate: a live preview shows while you speak, and you get an editable draft when you stop. The bar shows time-to-first-word and stop-to-final.
6. **Evening**: a gentle deadline nudge with 今晚 / 明早 / 稍后.

Performance: the loop only runs while something moves. A calm idle entity runs at about 20fps, a hidden tab stops, and `prefers-reduced-motion` draws still frames.
