# Alfred 视觉语言调查（2026-11-18，第二版）

> **用途**：给 Alfred 定一套颜色和层次，作为「底座」的一部分。
>
> **状态**：调查加样品，还没定稿。
> - 颜色都已接在 `prototype/workspace.html` 上，顶部的「配色」可以切换主题和明暗。
> - `prototype/style-report.html` 并排展示所有颜色。
> - `packages/ui` 没有动。
>
> **第二版改了什么**：第一版只定了中性色和一个 Alfred 色。你的反馈是颜色太少、太平，看不出重点，所以这一版补上了：
> - 领域色（日历、待办的种类）；
> - 状态色；
> - 强调阶梯；
> - 字号和字重；
> - 文字对比。
>
> **怎么读**：
> - 第 2 节是参考里看到的事实；第 3–6 节是建议，还不是已批准的方案。
> - 参考里的色值，除了 Linear、Apple、Atlassian、Radix、APCA 的官方说法，多数来自第三方整理，只能当近似值。

## 1. 结论

- **颜色可以多，但每个颜色只有一个固定意思。** 颜色分四类：
  - **领域色**：工作、生活、学习等。日程、待办和其他模块共用同一套。
  - **状态色**：「等你决定」用琥珀，「现在 / 危险」用红。
  - **Alfred 色**：只用在 Alfred 本人和它做过的事上。
  - **中性色**：底、线、文字。

  颜色有了意思，多也不乱：Notion、Google Calendar、Amie 都是这样做的。
- **领域色有 7 个，顺序固定**：蓝、绿、紫、橙、青、黄、粉。
  - 用 dataviz 的配色校验器验过：按这个顺序，相邻两色在浅色和深色下都分得开，色弱读者也一样。
  - 红色不进领域色，它留给「现在」和危险。
- **每个颜色有四个用法**：实色（点、条、图标）、浅底、同色文字、描边。分法学的是 Atlassian 的 accent token 和 Notion 的标签色。
- **层次靠「强调阶梯」，不靠一律加粗加色。** 一共四级：
  - 0 静：灰字；
  - 1 标识：色点、彩色图标；
  - 2 着色：浅底加同色文字；
  - 3 实色：实色底加白字，每个区域最多一个。

  重点之所以突出，是因为周围都比它安静。
- **明暗适中**：
  - 标题对比约 14:1，正文约 7:1，次要文字至少 4.5:1。不用纯黑字，也不用纯白底。
  - 深色模式的底是柔和的深灰（OKLCH L 0.20），不是近黑，这样彩色的浅底才有位置。
- **底座仍是配色生成器**：中性色和 Alfred 色由主题的几个输入算出来，领域色和状态色不随主题变。默认主题推荐「纸」：暖白的底，靛蓝的 Alfred。

## 2. 参考，以及值得借的东西

| 参考 | 看到的 | Alfred 借什么 |
|---|---|---|
| **Atlassian Design System**（官方） | accent 色分「背景」和「文字/图标」两组。背景有四级，从 subtlest 到 bolder；文字有两级。规定了哪级文字能放在哪级背景上。黄色为了对比会变成褐色，官方建议少用。 | 每个颜色四个用法，文字和底按规定搭配；黄色压低使用 |
| **Notion**（社区整理） | 10 个颜色，每个都有文字色、背景色、图标色；深色模式单独一套值。 | 标签 = 浅底 + 同色字，深色单独调 |
| **Google Calendar**（官方，2026-06） | 事件颜色从 11 个扩到 24 个，网页版还能自定义 RGB。2024 年改版时加了深色模式。 | 颜色多是用户真正想要的，但我们先给一套校验过的默认 |
| **Amie**（第三方分析） | 用柔和的浅色日程块承担几乎所有的「色彩时刻」，界面其他部分保持安静。 | 日程块用浅底，周围安静 |
| **Things 3** | 侧栏的每个入口有自己颜色的图标：收件箱蓝、今天黄星、计划红。正文绝大部分是中性色。 | 每个页面一个识别色，用在图标上 |
| **Linear**（2026-03 改版，官方） | 更暖的灰，更暗的侧栏，更少、更淡的线；主题由三个输入在 LCH 里生成。 | 配色生成器；少画线；侧栏暗一档 |
| **GitHub Primer**（官方） | 颜色按功能命名，浅色、深色、高对比各自映射；强调色背景上的文字一律用专门的 on-emphasis 色。 | 实色底上统一用白字 |
| **APCA**（WCAG 3 草案用的对比算法） | 正文推荐 Lc 90，最低 Lc 75；非正文文字 Lc 60；大标题 Lc 45。它比 WCAG 2 的比值更贴近人眼。 | 正文、次要文字、标签各有目标对比 |
| **视觉层次的文章**（设计博客，偏经验） | 强调是相对的：靠大小、字重、颜色、位置一起；一个区域只放一个主要按钮；字重控制在两种，文字颜色两到三种。 | 强调阶梯；每个区域最多一个实色 |
| **dataviz 配色方法**（本机的 dataviz skill） | 类别色要固定顺序、亮度在一个范围内、饱和度够；相邻色要用色弱模拟检查。所有颜色两两相邻时最多保证三色，再多要靠文字标注。 | 领域色按这个方法生成和校验 |
| **macOS Tahoe / Liquid Glass**（WWDC25） | 侧栏是玻璃；强调色只给重要控件。macOS 27 又把侧栏图标的颜色加了回来。 | 「雾」主题；侧栏图标可以有颜色 |
| **Claude / Raycast / Vercel**（第三方提取） | Claude 用暖纸底加陶土色；Raycast 是近黑底，靠灰阶分层；Vercel 是灰加一套蓝。 | 暖中性色的人味；深色靠明暗分层 |

## 3. 颜色体系（建议）

所有值都在 `prototype/tokens.css` 里，以 OKLCH 为准，下面的 hex 是「纸」主题的近似值。

### 3.1 中性色（纸）

| | bg 页面 | paper 侧栏 | raise 卡片 | wash 悬停 | line 线 | muted 次要字 | copy 正文 | ink 标题 |
|---|---|---|---|---|---|---|---|---|
| 浅 | `#fcf9f6` | `#f5f2ee` | `#fffdfc` | `#eae7e5` | `#d6d4d1` | `#6e6d6b` | `#535251` | `#272625` |
| 深 | `#171613` | `#13110f` | `#201e1b` | `#292725` | `#3d3b39` | `#acaaa8` | `#cfcdcb` | `#e9e8e6` |

**暖度递减**（2026-11-18 调整）：你说中间那块饱和度太暖、有点不和谐。

原因：同样的色度（chroma），在接近白的底上只是一点纸色，到了中间调和深色文字上就显得浓得多，变成米黄、卡其、灰褐，和 Alfred 的靛蓝不搭。

现在主题的色度 `--c` 按层级递减：

| 层级 | 用多少 |
|---|---|
| 页面底 bg（中间那块） | 约 55% |
| 侧栏 | 60% |
| 卡片 | 30% |
| 悬停、选中的填充 | 50% |
| 线 | 45% |
| 文字 | 30% 到 40%，接近中性 |

结果：中间从奶油色 `#fef9f4` 变成米白 `#fcf9f6`，和右边 Alfred 面板、左边侧栏是同一种「纸」，只差明暗。

次要字顺带调深一点，在侧栏上也到 4.5:1（之前是 4.4）。深色也一样递减，所以不再发棕。四个主题共用这个规则。

### 3.2 领域色

用法：
- **实色**：点、日程左边的色条、待办圆圈、图标。
- **浅底**：日程块、标签、头像。
- **文字**：放在浅底或页面上。
- **描边**：边框（表里没列，见 `tokens.css`）。

| 领域 | 颜色 | 浅：实色 / 浅底 / 文字 | 深：实色 / 浅底 / 文字 |
|---|---|---|---|
| 工作 | 蓝 250 | `#2784d5` `#dff3ff` `#00579a` | `#418ad1` `#19324b` `#aad9ff` |
| 生活 | 绿 142 | `#4a9c42` `#e3f7e1` `#1f661a` | `#579c50` `#1f371d` `#b5e3af` |
| 学习 | 紫 300 | `#8962c5` `#f3ebff` `#614092` | `#9372c8` `#352a48` `#dcc8ff` |
| 出行 | 橙 45 | `#d16631` `#ffe9dd` `#8d3700` | `#c86d41` `#472718` `#ffc3a6` |
| 健康 | 青 188 | `#00a89d` `#d7f8f4` `#006a63` | `#00a49b` `#003935` `#90e7de` |
| 财务 | 黄 88 | `#cfa529` `#faefd6` `#734e00` | `#b68c00` `#3c2e0a` `#ecd293` |
| 家人朋友 | 粉 355 | `#c95a8b` `#ffe7f1` `#892f59` | `#c5658d` `#462432` `#ffbdd7` |

**页面识别色**（侧栏和标题上的图标）借用同一套色相：
- 通知：琥珀
- 日程：红
- 待办：蓝
- 邮件：青
- 调研：紫
- 自动任务：绿

### 3.3 状态色（不随主题变，总是带文字或数字出现）

| | 浅：实色 / 浅底 / 文字 | 深：实色 / 浅底 / 文字 | 用在哪 |
|---|---|---|---|
| 等你决定（琥珀 70） | `#d28500` `#ffedd7` `#814400` | `#e29e47` `#422b0d` `#f9cb97` | 侧栏通知数、「等你决定」标签、逾期 |
| 现在 / 危险（红 25） | `#db4241` `#ffe8e4` `#90302e` | `#f05653` `#482422` `#ffbfb8` | 现在的时间线、今天的日期、删除 |
| 完成（绿） | `#318f5a` | `#6ac48c` | 自动任务成功的点、开关 |

琥珀特意偏金色，和「出行」的橙色拉开。

### 3.4 Alfred 色

- 浅色是靛蓝 `#4967c5`，深色是 `#8fabf6`。
- 用在形象、链接、回执，以及「Alfred 在做」的标记上。
- Alfred 排进日程的块不改颜色，保留领域色，只加虚线边和一个 Alfred 色的小点。这样颜色始终表示「是什么事」，虚线表示「是谁排的」。

### 3.5 校验结果

| 检查 | 结果 |
|---|---|
| 相邻两色，色弱模拟（OKLab ΔE×100，目标 ≥ 8） | 最差 12.3，通过 |
| 相邻两色，正常视力（硬门槛 ≥ 15） | 最差 19.2，通过 |
| 亮度范围、饱和度下限 | 浅色和深色都通过 |
| 浅底上的同色文字（APCA） | 约 Lc 76（浅）/ −73（深），够做 12px 的标签和日程标题 |
| 实色对页面底的对比（目标 ≥ 3:1） | 浅色下青 2.8:1、黄 2.2:1 不够，所以这两色永远带文字出现 |
| 任意两色相邻（一周的日程里常见） | 有两组会接近：蓝↔紫（色弱下 ΔE 2.7），绿↔青（正常视力 ΔE 11.2 / 9.8）。所以每个日程块和标签都显示名字，日历上方有图例，点图例可以隐藏某个领域 |
| 琥珀（状态）↔ 橙 / 黄（领域） | 正常视力 ΔE 8.2 / 7.7（浅）。状态色永远带文字或数字，不会单独出现 |

## 4. 层次（建议）

### 4.1 强调阶梯

| 级 | 样子 | 用在哪 |
|---|---|---|
| 0 静 | 灰字，没有颜色 | 过去的日程（半透明）、已完成的待办、时间、元信息 |
| 1 标识 | 色点、彩色图标、彩色圆圈 | 侧栏图标、列表的色点、待办圆圈、筛选和图例 |
| 2 着色 | 浅底加同色文字 | 日程块、领域标签、头像、「等你决定」标签、Alfred 回执 |
| 3 实色 | 实色底加白字 | 每个区域最多一个：侧栏的「等你」数字、今天的日期、主要按钮 |

### 4.2 文字

| 层级 | 浅色对比 | 深色对比 |
|---|---|---|
| 标题 `ink` | 14.4:1（APCA Lc 99） | 14.7:1（Lc −92） |
| 正文 `copy` | 7.4:1（Lc 84） | 约 11:1（Lc 约 −76） |
| 次要 `muted` | 4.6:1（Lc 69） | 约 7:1（Lc 约 −55） |

不用纯黑。纯黑配纯白是 21:1，长时间看刺眼。

### 4.3 字号和字重

| 用途 | 字号 / 字重 |
|---|---|
| 页面标题 | 30 / 650，前面加页面识别色的图标 |
| 详情标题 | 24 / 650 |
| 小节标题 | 13–15 / 600 |
| 正文 | 15 / 400，行高 1.6 |
| 列表次要行 | 13 / 400 |
| 标签、日程标题 | 12 / 500–600 |
| 时间、数字 | 11–12，等宽 |

字重只用 400、500–600、650 三档，层次主要靠字重和颜色，不靠把字号拉得很大。

## 5. 主题

生成器的输入只有：中性色的色相和冷暖，加上 Alfred 色。四个主题都保留，领域色和状态色在所有主题里一样。

| 主题 | 感觉 | 中性色 | Alfred 色 |
|---|---|---|---|
| **纸**（推荐默认） | 好纸上的墨水，安静、有人味 | 暖白 | 靛蓝 |
| 石 | 精确、像工具，对比最高 | 近中性冷灰 | 紫 |
| 雾 | Mac 原生，侧栏是毛玻璃 | 冷灰 | 系统蓝 |
| 夜 | Robin 的延续，以深色为主 | 深蓝 | 月光色 |

## 6. 风险和还没定的

- **颜色多了以后，最大的风险是变花。** 守住两条：一个区域最多一个实色；除了日程块和标签，彩色都只用在点、图标和圆圈这类小面积上。
- **领域可以自定义。** 新建的日历或领域按 7 色的顺序依次分配，第 8 个开始复用，同时靠名字区分。要不要像 Google 那样开放任意颜色，还没定。
- **形象的颜色**：是不是就用 Alfred 色？
- **高对比主题**：要不要做，也就是生成器的 `contrast` 输入。
- **P3 广色域**：要不要用。
- **品牌字体**：还没定。

## 7. 下一步

1. 在原型里各页看一遍（日程、待办、通知、邮件、自动任务），浅色、深色都看。说哪里太花、哪里还太平。
2. 定了以后，把 `tokens.css` 搬进 `packages/ui/src/styles.css`，日程和待办的数据模型加上「领域」字段。

## 来源

- [Atlassian: accent colors](https://atlassian.design/foundations/color/accents)
- [Notion colors (community reference)](https://matthiasfrank.de/en/notion-colors/)
- [Notion color reference, light and dark (community)](https://thomasfrank.notion.site/Color-Reference-0877519165f34930ad1fe53071e54155)
- [Google Workspace Updates: custom event colors (2026-06)](https://workspaceupdates.googleblog.com/2026/06/custom-event-colors-in-google-calendar.html?m=0)
- [TechCrunch: Google Calendar design refresh and dark mode (2024)](https://techcrunch.com/2024/10/24/google-calendar-gets-a-design-refresh-along-with-dark-mode)
- [Amie design guide (third-party)](https://blakecrosley.com/guides/design/amie)
- [Things 3 design study](https://blakecrosley.com/blog/design-study-things)
- [MacStories: Things 3 review](https://www.macstories.net/reviews/things-3-beauty-and-delight-in-a-task-manager/)
- [Linear: behind the latest design refresh (2026-03)](https://linear.app/now/behind-the-latest-design-refresh)
- [Linear: how we redesigned the Linear UI (2024)](https://linear.app/now/how-we-redesigned-the-linear-ui)
- [Primer: color overview](https://primer.style/foundations/color/overview)
- [Primer: color considerations](https://primer.style/guides/accessibility/color-considerations)
- [APCA introduction](https://github.com/Myndex/apca-introduction)
- [Visual emphasis and hierarchy (practitioner guide)](https://skills.sh/dembrandt/dembrandt-skills/visual-emphasis-and-hierarchy)
- [Radix Colors: understanding the scale](https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale)
- [Apple WWDC25: Build an AppKit app with the new design](https://developer.apple.com/videos/play/wwdc2025/310/)
- [MacRumors: Liquid Glass changes in macOS Golden Gate](https://www.macrumors.com/2026/06/09/macos-golden-gate-liquid-glass/)
- [open-design.ai: Claude design system (third-party)](https://open-design.ai/systems/claude/)
- [open-design.ai: Raycast design system (third-party)](https://open-design.ai/systems/raycast/)
- [Vercel Geist colors](https://examples.vercel.com/geist/colors)
- [Dark mode palette guide (OKLCH, elevation)](https://kuler.pages.dev/blog/dark-mode-palette-guide)
