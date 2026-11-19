/** Sample data. Everything the prototype shows comes from here, so the real
 *  app's adapters (mail, calendar, todos, runs, Pi sessions) have one shape
 *  to match. Times are minutes from midnight. */

export const hm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

export function makeData() {
  return {
    user: 'Bruce',
    emails: [
      { id: 'e1', from: 'Stripe Recruiting', subject: '面试时间确认：周五 2pm', summary: '要你在周三前确认周五下午的 onsite 时段，附了 4 位面试官名单。', action: '加入待办', todo: '回复 Stripe 确认周五面试', attention: true },
      { id: 'e2', from: 'Prof. Lin', subject: 'Re: 研究进度', summary: '想看一下语音转写对比的初步数据，下周一组会前发给他。', action: '加入待办', todo: '整理转写对比数据发给 Lin', attention: true },
      { id: 'e3', from: 'AWS Billing', subject: '本月账单预估 $42.18', summary: '比上月高 31%，主要是 Lambda 调用。', action: '标记已读', attention: true },
      { id: 'e4', from: 'GitHub', subject: '[pi-web] 2 new PR reviews', summary: '两个 review，均无阻塞意见。', attention: false },
      { id: 'e5', from: 'Newsletter', subject: 'The Batch #312', summary: '本周 AI 新闻合集。', attention: false },
    ],
    events: [
      { id: 'c1', title: '站会', start: 600, end: 615, kind: 'meet' },
      { id: 'c2', title: '1:1 · Prof. Lin', start: 690, end: 720, kind: 'meet' },
      { id: 'c3', title: '午饭', start: 750, end: 810, kind: 'life' },
      { id: 'c4', title: '健身', start: 1080, end: 1140, kind: 'life' },
    ],
    todos: [
      { id: 't1', title: '准备周五 Stripe 面试：系统设计', due: '周五', ddl: true, done: false },
      { id: 't2', title: 'Alfred 原型：实体渲染', due: '今天', done: false },
      { id: 't3', title: '交 Math 197 proposal 修改稿', due: '明天 23:59', ddl: true, done: false },
    ],
    news: [
      { tag: '市场', text: '美股收涨，纳指 +0.9%，半导体领涨。' },
      { tag: 'AI', text: '开源语音模型又刷新中文转写基准，延迟降到 300ms 内。' },
      { tag: '本地', text: '匹兹堡今天多云 4–11°C，傍晚有小雨。' },
    ],
    briefRules: [
      { id: 'b1', text: '求职：新出现的匹配岗位', since: '10/02' },
    ],
    runs: [
      { id: 'r1', kind: 'auto', name: '求职 portal 扫描', status: 'done', progress: 1, note: '新增 4 个匹配岗位' },
      { id: 'r2', kind: 'pi', name: 'Pi · alfred-proto 重构', status: 'running', progress: 0.7, note: '在跑测试' },
      { id: 'r3', kind: 'auto', name: '晨报生成', status: 'done', progress: 1, note: '06:30 已生成' },
    ],
    workspaces: [
      { id: 'jobs', name: '求职', en: 'CAREER', stat: '3 待投 · 1 面试', glyph: 'case', points: () => [
        'Stripe onsite · 周五 14:00 · 系统设计还没准备',
        '本周新岗位 4 个，2 个高匹配：Anthropic、Figma',
        '待投：Linear · Vercel · Notion',
      ] },
      { id: 'research', name: '研究', en: 'RESEARCH', stat: '1 调查进行中', glyph: 'flask', points: D => [
        ...D.runs.filter(r => r.kind === 'research').map(r => `${r.name} · ${r.status === 'running' ? Math.round(r.progress * 100) + '%' : '已完成'}`),
        'Higgs Realtime 延迟：p50 420ms（周一测）',
        'Lin 想在组会前看到转写对比数据',
      ] },
      { id: 'product', name: '产品', en: 'PRODUCT', stat: 'Alfred · 原型', glyph: 'cube', points: () => [
        'Alfred 交互原型：实体、早报、Deck',
        '下一步：真麦克风与语音实测',
        '数据模型草案等你评审',
      ] },
      { id: 'pi', name: 'Pi 会话', en: 'SESSIONS', stat: '2 活跃', glyph: 'term', points: D => [
        ...D.runs.filter(r => r.kind === 'pi').map(r => `${r.name.replace('Pi · ', '')} · ${r.status === 'running' ? Math.round(r.progress * 100) + '% · ' + r.note : r.note}`),
        'pi-web · 会话恢复修复已结束',
        '1 个会话在等你回复',
      ] },
      { id: 'brief', name: '晨报', en: 'BRIEFING', stat: '明早 06:30', glyph: 'sun', points: D => [
        '明早 06:30 生成，07:45 前播报',
        ...D.briefRules.map(r => `栏目：${r.text}（${r.once ? '只一次' : '每天'}）`),
        '今天这期：已听完',
      ] },
    ],
    sessions: {
      pi: [
        { id: 's1', title: 'alfred-proto · 实体渲染', status: 'running', when: '2 分钟前' },
        { id: 's2', title: 'pi-web · 会话恢复修复', status: 'done', when: '1 小时前' },
        { id: 's3', title: 'career-ops · JD 批量评估', status: 'idle', when: '昨天' },
      ],
      jobs: [
        { id: 'j1', title: 'Stripe · 面试准备', status: 'running', when: '今天' },
        { id: 'j2', title: '本周新岗位评估（4）', status: 'idle', when: '06:40' },
      ],
      research: [
        { id: 'q1', title: '本地语音转写方案对比', status: 'running', when: '进行中' },
        { id: 'q2', title: 'Higgs Realtime 延迟测量', status: 'done', when: '周一' },
      ],
      product: [
        { id: 'p1', title: 'Alfred · 交互原型', status: 'running', when: '现在' },
        { id: 'p2', title: 'Alfred · 数据模型草案', status: 'idle', when: '昨天' },
      ],
      brief: [
        { id: 'w1', title: '晨报栏目与规则', status: 'idle', when: '—' },
      ],
    },
    threads: {
      s1: [
        { role: 'user', text: '把 entity 的环改成 3D 投影到 9px 网格上，参考 portfolio 的 BlackHole。' },
        { role: 'assistant', text: '好。我先读一下 BlackHole.tsx 的量化方式，再改 stage.js。', tools: [
          { name: 'read', arg: 'bruce-portfolio/components/home/BlackHole.tsx', out: '472 lines · BAYER 4×4 · 5 bands (heat-1…4 + hot)' },
          { name: 'edit', arg: 'prototype/js/stage.js', out: '+212 −40' },
        ] },
        { role: 'assistant', text: '改完了：球体用 Lambert + 边缘光，三条环在各自平面旋转后正交投影，再和球做深度测试。idle 时 20fps，隐藏标签页停止。' },
      ],
      s2: [
        { role: 'user', text: '会话恢复时偶尔丢最后一条消息。' },
        { role: 'assistant', text: '找到了：分页游标在写入完成前就被读取。已修复并补了回归测试。', tools: [{ name: 'bash', arg: 'npm test -- session-reader', out: '✓ 14 passed' }] },
      ],
    },
  }
}

/** Free gaps between events, within working hours. */
export function freeSlots(events, from = 540, to = 1260) {
  const sorted = [...events].sort((a, b) => a.start - b.start)
  const slots = []
  let cur = from
  for (const e of sorted) {
    if (e.start > cur) slots.push([cur, Math.min(e.start, to)])
    cur = Math.max(cur, e.end)
  }
  if (cur < to) slots.push([cur, to])
  return slots.filter(([a, b]) => b - a >= 30)
}

/* pixel glyphs (9×9), authored as text like the portfolio's sprites */
export const GLYPHS = {
  case: ['...###...', '..#...#..', '#########', '#.......#', '####.####', '#...#...#', '#.......#', '#########', '.........'],
  flask: ['..#####..', '...#.#...', '...#.#...', '..#...#..', '.#.....#.', '#..###..#', '#.#####.#', '#########', '.........'],
  cube: ['....#....', '..##.##..', '##.....##', '#.##.##.#', '#...#...#', '#...#...#', '##..#..##', '..#####..', '.........'],
  term: ['#########', '#.......#', '#.#.....#', '#..#....#', '#.#..##.#', '#.......#', '#########', '.........', '.........'],
  sun: ['....#....', '.#.....#.', '...###...', '..#####..', '#.#####.#', '..#####..', '...###...', '.#.....#.', '....#....'],
  mail: ['#########', '##.....##', '#.#...#.#', '#..#.#..#', '#...#...#', '#.......#', '#########', '.........', '.........'],
  cal: ['.#.....#.', '#########', '#.......#', '#.#.#.#.#', '#.......#', '#.#.#.#.#', '#.......#', '#########', '.........'],
  check: ['.........', '........#', '.......##', '#.....##.', '##...##..', '.##.##...', '..###....', '...#.....', '.........'],
  news: ['#########', '#.......#', '#.###.#.#', '#.......#', '#.#####.#', '#.#####.#', '#.......#', '#########', '.........'],
  run: ['..#####..', '.#.....#.', '#...#...#', '#...#...#', '#...###.#', '#.......#', '.#.....#.', '..#####..', '.........'],
}

export function glyphSVG(name) {
  const rows = GLYPHS[name] || GLYPHS.cube
  let d = ''
  rows.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      if (row[x] !== '#') { x++; continue }
      const s = x
      while (x < row.length && row[x] === '#') x++
      d += `M${s} ${y}h${x - s}v1h-${x - s}z`
    }
  })
  return `<svg class="glyph" viewBox="0 0 9 9" shape-rendering="crispEdges" aria-hidden="true"><path d="${d}" fill="currentColor"/></svg>`
}
