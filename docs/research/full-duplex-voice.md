# 全双工语音模型调查（2026-11-13）

> 用途：为 Alfred 的语音层选型和接口设计留底。
> 状态：只读调查，没有做任何实测。评测数字多数是厂商自报。
> 本文区分事实和当时的建议；建议不是已批准方案。

## 1. 结论

- Boson 有两个模型。Robin 现在接的 `higgs-realtime`（2026-08 发布）靠停顿检测判断轮次，不是真正的全双工。真全双工的 **Higgs Realtime Duplex** 2026-11-05 才预告，API 在 waitlist，没有价格，也没写是否支持中文。
- Duplex 的形态是"前台对话模型 + 后台大模型"，两边互不阻塞。这和 Robin 的 `ask_robin` 委派是同一个形态。
- 今天能买到的同形态模型只有 OpenAI 的 `gpt-live-1`（2026-09-10 进 API），但中文是弱项。
- 适合 Alfred 的是"前台交互模型 + 后台自己的 agent"，语音模型不直接干活。

## 2. 候选模型

| 模型 | 真全双工 | 委派给自己的 agent | 中文 | 可用性 | 价格 |
|---|---|---|---|---|---|
| Higgs Realtime Duplex | 是，160ms 一块，能看屏幕 | 是，后台异步 | 未说明 | waitlist | 未公布 |
| Higgs Realtime（现用） | 否，server_vad / semantic_vad | 函数调用 | 明确支持，含中英混说 | 可用 | 约 $0.0023/分钟输入，$0.014/分钟输出（按 token 计的估算） |
| GPT-Live-1 | 是（厂商自称） | 是，client delegation 可接任意模型或 agent | 无中文声音，无语言清单 | 可用 | $0.05/分钟连接时长，空闲也计费，后台模型另算 |
| Gemini 3.8 Live | 否，停顿检测 | 非阻塞函数调用 | 在语言表里 | 可用 | 约 $0.005/分钟输入，$0.018/分钟输出 |
| 豆包 Seeduplex（实时语音 3.0） | 是（厂商自称） | 函数调用 | 最强，含方言 | 邀测 | 未公布 |
| Thinking Machines TML-Interaction-Small | 是，200ms 一块 | 是，后台异步 | 未说明 | 研究预览 | 无 |
| MiniCPM-o 4.5（开源，Apache-2.0） | 是，每秒决定一次说或听 | 未说明 | 中英双语，偶有串语言 | 本机跑不了全双工 | 免费 |

Moshi、PersonaPlex、NVIDIA VoiceChat 只支持英文，排除。

## 3. 影响 Alfred 的事实

- **Higgs Realtime 的会话限制**：单次最长 60 分钟，5 分钟没有用户语音就断。"一直在场"不能靠一直连着。
- **Higgs Realtime 的协议**：WebSocket，兼容 OpenAI Realtime 协议，WebRTC 还在做。支持自定义声音和内置 web_search。
- **GPT-Live-1 的回注**：`session.commentary.append`（说出来）、`session.thinking.append`（静默上下文）、`session.instructions.append`（改指令），每段不超过 500 token。不支持图像和视频输入。
- **Gemini 3.8 Live**：能判断一句话不是对它说的就不回应，且关不掉。音频会话 15 分钟，需要压缩或续连。没有自定义声音。
- **工具调用不可靠**：Full-Duplex-Bench v3 里最好的 gpt-realtime 一次做对的比例是 0.60。评测只有英文。
- **Duplex 的自报分数**：Full-Duplex-Bench v1.5 平均 75.5，低于 Thinking Machines 的 77.8 和 GPT-Live-1 的 80.1；Big Bench Audio 98.9 是它领先的一项。
- **本机**：Apple M4 / 16GB。MiniCPM-o 4.5 的全双工模式要求 M4 Max 且 24GB 以上。
- **计费**：ChatGPT 订阅不包含 `gpt-live-1` 的 API 用量，API 要单独充值。

## 4. 口碑

好评：

- 自然度公认是一大步；OpenAI 称盲测 75.7% 偏好 GPT-Live。
- 字节称豆包接入 Seeduplex 后抢话下降 40%，误打断减半（厂商 A/B）。

差评：

- 附和太多（"嗯""哦"），还会复述用户的话。
- 会在用户没说完时插嘴。
- 前台模型不聪明，不委派时回答偏浅。
- OpenAI 计划 2026-12-11 下线旧语音模式，有用户说新模型常打断、丢上下文、回答不如以前详细（Neowin 报道，原文未读到）。
- 非英语质量：印地语演示有美式口音；GPT-Live-1.1 新增六种语言的声音，没有中文。

开发者侧：

- 音频进、音频出，难调试，转写看不出重叠时序。
- 模型生成得比播放快，会以为用户已经听到没播完的内容。
- 用户的一声附和会被当成新一轮。
- 后台没算完，前台自己先编答案。

## 5. 在做同类 personal agent 的项目

| 项目 | 语音 | 形象 | 委派给谁 | 短板 |
|---|---|---|---|---|
| OpenAI Dots（2026-09-29） | GPT-Live 通话 | 卡通小人 | GPT-6 Astra，自带电脑 | 不主动，慢，一次一个 |
| Hermes Agent（Nous Research，MIT） | 串联加打断，或 gpt-live-1 | 置顶宠物浮层 | 自己的 agent 和子代理 | 部分命令自动批准 |
| Qwen Audio Agent（Apache-2.0） | 八家实时模型 | 桌面 orb 和任务卡 | ACP agent，含 Pi | 默认走云，Pi 驱动不支持权限 |
| Personal Jarvis | GPT-Live 或 Gemini Live | orb 和任务面板 | Claude Code、Codex | 单人项目，跳过权限检查 |
| Jarvis-Live | Gemini Live | 写实头像 | Claude Code、Codex | 只记最近几轮 |
| N.E.K.O / AIRI | 全双工 | Live2D 角色 | 浏览器和电脑操作 | 偏陪伴 |

从项目说明看，没人做好的部分：由真实事件驱动的主动汇报、跨会话的长期记忆、权限和回执、生活协调、统一稳定的形象。

## 6. 两份源码的要点

只通过 GitHub API 读了文档和具体文件，没有克隆或运行。

### Hermes Agent：最小的 gpt-live-1 接法

文件：`tools/voice_live.py`、`apps/desktop/src/lib/voice-live.ts`、`apps/desktop/src/app/chat/composer/hooks/use-voice-live-conversation.ts`，合计约一千行。

- 桌面端发起 WebRTC，本机 gateway 带 key 去 `POST /v1/live/sessions`，会话配置含 `delegation: { type: "client" }`。key 不到前端。
- 语音模型没有工具。`session.delegation.created` 只带 id，没有文字。
- 客户端取最近 5 分钟、最多 80 段转写：最后一句用户的话当请求，整段当上下文。
- 后台回复按句子流式送入 `commentary.append`；工具活动走 `thinking.append`。
- 只认当前委派 id，旧 id 的迟到结果丢弃。
- 新委派到来时会中断正在跑的那一轮。
- 语音人设很短：角色、附和程度、被打断就停、委派规则、"等结果时不要猜"。
- 给后台的每轮提示：这是转写，可能听错；回复会被念出来，要短、不要 markdown；没成功不要说成功。

### Qwen Audio Agent：完整的规则

文件：`docs/architecture/deep-dive.md`、`config/frontend-agent/PROMPT.md`、`server/src/voice/`、`server/src/backend/backend-port.mjs`。

- 三层：前台 Agent（实时模型加提示词加工具）、编排运行时（纯代码，没有模型）、后台 Agent（通过 BackendPort）。
- 所有模型档案都用停顿检测；名为"gpt-live"的适配器实际是 `gpt-realtime-2.1`。
- 前台固定六个工具：`spawn_thinking`、`update_agent_task`、`get_agent_task_status`、`cancel_agent_task`、`respond_permission`、`get_current_time`。
- `spawn_thinking` 从不等待；新任务不取消旧任务；打断、静音、休眠、断线都不取消后台工作。
- 三种投递：只进上下文、等空档再说、打断后立刻说。
- 空档判断：用户在说话、当前轮没答完、有音频排队时不播。
- 客户端回报开始播放才算送达；开播后被打断不重播；多个前端不重复播。
- 工具活动只进界面；阶段进展最多 60 秒念一次，且要在安静时。
- 权限请求的信封只能由运行时写；没有真实请求时不暴露回应工具；模型只能转达用户当轮明确的决定。
- 记忆三份：人设（助手不能自己改）、用户偏好（当指令）、事实（不当指令）。会话结束后有一次提取。
- 任务记录是送达回执，不是后台内部状态的镜像。
- 没看到由"人回来了"这类在场事件触发的开口。

## 7. 语音层接口草案

```ts
interface VoiceLayer {
  // 往上报
  onTranscript(speaker, text, startMs, endMs)
  onDelegation(id, recentTranscript)
  onSpeakingChange(speaking)
  onClosed(reason, usageSeconds)

  // 往下发
  deliver(route: 'context' | 'respond' | 'interrupt', text, delegationId?)
  instruct(text)
  mute(on); close()
}
```

- GPT-Live-1：三个路由对应 `thinking.append`、`commentary.append`、`instructions.append`。
- OpenAI Realtime 协议的模型（含 Higgs Realtime）：对应写入对话项、创建回复、取消后再创建回复。Higgs 的映射没有验证。

## 8. 未核实

- Duplex 是否支持中文、定价、API 开放时间。
- GPT-Live-1 的中文质量（只有二手说法）。
- Seeduplex 的价格，邀测是否对个人开放。
- 中文侧的负面反馈没找到成规模的样本。
- 开源项目都没有实际运行过。

## 9. 来源

模型：

- https://www.boson.ai/blog/higgs-realtime-duplex
- https://docs.boson.ai/models/higgs-realtime/overview
- https://www.boson.ai/blog/higgs-realtime
- https://docs.boson.ai/pricing
- https://openai.com/index/introducing-gpt-live-1-in-the-api/
- https://developers.openai.com/api/docs/models/gpt-live-1
- https://developers.openai.com/api/docs/guides/live-delegation
- https://aistudio.google.com/docs/live-api
- https://aistudio.google.com/docs/models/gemini-3.8-live
- https://docs.volcengine.com/docs/doubao-voice/end-to-end-real-time-voice-full-duplex-version?lang=zh
- https://arxiv.org/html/2604.27393v1
- https://huggingface.co/openbmb/MiniCPM-o-4_5
- https://arxiv.org/html/2604.04847v1
- https://arxiv.org/html/2609.21967

口碑：

- https://techcrunch.com/2026/07/08/openai-releases-new-voice-models-for-more-natural-live-conversations/
- https://www.neowin.net/news/openai-is-retiring-chatgpts-advanced-and-standard-voice-modes-sparking-user-backlash/
- https://help.openai.com/en/articles/20001638-retiring-advanced-and-standard-voice-in-chatgpt
- https://news.ycombinator.com/item?id=48834405
- https://www.eesel.ai/blog/gpt-live-1-review
- https://roark.ai/blog/testing-full-duplex-voice-agents-gpt-live
- https://lukeocodes.dev/full-duplex-voice-ai-new-architecture

同类项目：

- https://techcrunch.com/2026/09/29/openai-launches-dots-its-bubbly-agentic-avatar/
- https://www.promptadvisers.com/openai-dots-review
- https://github.com/csells/awesome-jarvis
- https://github.com/NousResearch/hermes-agent
- https://github.com/QwenAudio/qwen-audio-agent
- https://github.com/gustavorigazzo-rgb/PersonalJarvis
- https://github.com/samukbg/Jarvis-Live
