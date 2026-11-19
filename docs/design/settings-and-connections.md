# 设置与连接（草案）

> 状态：草案 v0.1（2026-11-18），**尚未批准**，没有据此改代码。
> 依据：Robin 的 `components/robin/SettingsPanel.tsx`、`extension/robin/google-calendar.ts`；Alfred 的 `packages/engine-pi/src/worker.ts`；`node_modules/@earendil-works/` 里 pi-ai、pi-mcp、pi-coding-agent 1.5.2 的类型和文档；Google Workspace MCP 的官方配置页（2026-11-18 读）。
> 原型：`prototype/workspace.html?page=settings`。
> 标记：**【事实】** 读代码或文档核实过；**【建议】** 本草案的提案；**【待定】** 见第 7 节。

## 0. 结论

1. **一个设置页，三种连接**：模型（谁来想）、账户（Google 这类，你的数据）、连接器（其它 MCP 服务）。三者的「连接」都是同一个动作：点一下 → 系统浏览器里同意 → 回到 Alfred 显示「已连接」。没有复制 client ID、粘贴密钥这一步。
2. **模型和连接器，Pi 已经会做，Alfred 只做界面和转发。** pi-ai 有订阅登录（Claude Pro/Max、ChatGPT、Copilot 等），pi-mcp 有完整的 MCP OAuth（自动注册客户端）。两边的凭证存储都可以由 Alfred 自己提供，所以能放进钥匙串。
3. **Google 是唯一需要 Alfred 自己出力的。** Google 不支持自动注册客户端，所以「一键」的前提是：**Alfred 项目自己注册一个 Google OAuth 客户端，发行版里内置它**。Robin 的「自己去 Google Cloud 建客户端再粘贴」保留成高级选项。
4. **凭证只在主节点上**，放钥匙串。界面只负责发起、显示和回答提问。
5. **连接不等于授权动作。** 连上 Gmail 只是 Alfred 能读；发邮件、改日程照旧走现有的闸门（每次问）和工作台方案里的「提议」。

## 1. 现在到哪了

【事实】

- Alfred 的 worker 用的是**你自己 Pi 的设置**：模型凭证读 `~/.pi/agent/auth.json`，MCP 的 OAuth token 也落在 Pi 的 agent 目录（`mcp-auth.json`）。没有任何登录界面；每个对话能选模型，但没有全局默认值。
- MCP 服务器靠手写 `<数据目录>/mcp.json`。
- 设置只有托盘菜单里的两项（显示形象、登录时打开）。原型里的「设置」是空的。
- Robin 有一个完整的设置面板：偏好（通用、语音、通知）、连接（Google、外联邮箱、Notion、Telegram、浏览器）、高级（转写、隐私）。其中 Google 要用户自己建 Google Cloud 项目、粘贴 client ID 和 secret、再把回调地址填回 Google。这一步是「一键」最大的障碍。

## 2. 各家怎么授权

| | 机制 | 用户要做什么 | Alfred 要做什么 |
|---|---|---|---|
| 模型订阅：Claude Pro/Max、ChatGPT Plus/Pro（Codex）、SuperGrok、Kimi | pi-ai 的 OAuth 登录，浏览器加本机回调，或者粘贴授权码 | 点「登录」，在浏览器里同意 | 把 Pi 的登录过程转给界面 |
| GitHub Copilot | pi-ai 的设备码登录 | 点「登录」，在网页上输入一个短码 | 同上，显示短码 |
| 模型 API key：Anthropic、OpenAI、Gemini、OpenRouter、DeepSeek 等 | pi-ai 的 api_key 登录（会提问要 key） | 粘贴一个 key | 同上，显示一个密码输入框 |
| 远程 MCP（支持 OAuth 自动注册的，比如 Pi 文档里举的 Sentry；Notion、Linear 的官方远程 MCP 应该也属于这类，接入时逐个核实） | pi-mcp：发现授权服务器、自动注册或用 Client ID Metadata Document、PKCE、刷新 | 点「连接」，在浏览器里同意 | 提供 token 存储和「打开网址」的方法 |
| Google 日历、Gmail | 标准 OAuth 2.0，**必须有预先注册的客户端**，不支持自动注册 | 点「连接 Google」，同意 | **注册并内置一个客户端**（3.1 节） |
| Telegram 机器人 | BotFather 给的 token，没有 OAuth | 粘贴 token | 存钥匙串 |

【事实】Pi 里 Alfred 要用的接口：

- `Models.login(providerId, "oauth" | "api_key", interaction)`：`interaction.notify` 收到 `auth_url`（要打开的网址）、`device_code`（短码和网址）、`progress`；`interaction.prompt` 问 `text`、`secret`、`select` 或 `manual_code`（粘贴回调网址）。`OAuthAuth.isSubscription` 标出哪些是订阅。
- `ModelRuntime.create({ credentials })`、`createAgentSession({ modelRuntime })`：凭证存储（`CredentialStore`：`read`、`list`、`modify`、`delete`）由应用提供。
- `createMcpExtension({ credentials, openUrl })`：MCP 的 token 存储和「打开授权页」都由应用提供。pi-mcp 还把登录拆成 `startMcpSignIn` / `completeMcpSignIn` 两半，回调可以走本机端口，也可以走应用自己的地址。

【事实】Google 的限制：

- Google 自己的 Workspace 远程 MCP（`gmailmcp.googleapis.com`、`calendarmcp.googleapis.com` 等）现在是**开发者预览**，要加入预览计划，要开发者自己建客户端并勾选「AI-powered agent」。Gmail 那边只列出了搜索、读和起草，没有列出发送。**现在不能当成面向用户的路径。**
- 权限范围分级：日历（`calendar.events`）是「敏感」，上线前要做免费的应用验证；Gmail 读（`gmail.readonly`、`gmail.modify`）是「受限」，验证之外还可能要做每年一次的安全评估（CASA）。有资料说只有数据经过开发者服务器时才需要评估，本地桌面应用可能豁免，**要在申请时和 Google 确认**。`gmail.send` 是「敏感」，不是「受限」。
- 没验证的应用：同意页上有「Google 尚未验证此应用」的提示，最多 100 个用户。
- 发布状态是「测试」时，refresh token **7 天就失效**；所以第一阶段要用「已发布但未验证」，不是「测试」。
- Google 不允许在内嵌网页里登录，必须用系统浏览器。

## 3. 方案

### 3.1 Google 一键连接

【建议】

**客户端。** Alfred 项目在 Google Cloud 注册一个「桌面应用」类型的 OAuth 客户端，client ID 打进发行版。桌面客户端的 secret 按 Google 的说法本来就不算机密，可以随应用发；仓库里的开发构建从环境变量读，没有就提示用高级选项。

**流程。**

```text
设置页「连接 Google」
  → 主节点：生成 PKCE 和 state，在 127.0.0.1 随机端口起回调，返回授权网址
  → Mac App：用系统浏览器打开（shell.openExternal）
  → Google 同意页（只要这一步需要的权限）
  → 浏览器跳回 127.0.0.1 → 主节点换 token → refresh token 进钥匙串
  → 事件 connection.connected → 所有设备上这一行变成「已连接 · 邮箱」
```

**一个 Google 账号是一个连接，日历和 Gmail 是它上面的开关。** 打开哪个开关才去要哪组权限（增量授权，`include_granted_scopes=true`），同意页上永远只出现这一次需要的东西：

| 开关 | 权限 | 级别 |
|---|---|---|
| 日历：读 | `calendar.readonly` | 敏感 |
| 日历：替你加和改日程 | `calendar.events` | 敏感 |
| Gmail：读 | `gmail.readonly` | 受限 |
| Gmail：替你发 | `gmail.send`（草稿先存在 Alfred 里，你点头才发） | 敏感 |

打标签、归档要 `gmail.modify`，它同时允许发信，范围太宽，第一版不要。

可以连多个 Google 账号（Robin 的「外联邮箱」就是第二个账号加「替你发」）。

**断开**：先在 Google 那边撤销 token（`oauth2.googleapis.com/revoke`），再删钥匙串里的条目。Google 那边被撤销了（用户在 Google 账号页里移除了 Alfred），下次调用失败时发一条通知：「Google 需要重新连接」，点一下重走流程。

**上线分两步。**

1. 现在：「已发布、未验证」。Bruce 和朋友能用，同意页有未验证提示，上限 100 人，token 不会每周失效。
2. 开源发布前：做品牌验证和敏感权限验证（免费）；Gmail 受限权限先问清本地应用是否要做安全评估，要做就评估成本，不行就先只发日历和「替你发」，「读 Gmail」走高级选项。

**高级选项：用自己的 Google 客户端。** 就是 Robin 现在的做法，给 fork、自建和超出上限时用。界面藏在 Google 详情页的「高级」里。

**谁来调用 Google。** token 属于连接；调用 Google 的是日历、邮件模块自己的适配层（工作台方案里说的防腐层），先把 Robin 的 `google-calendar.ts`、`gmail.ts` 搬过来。等 Google 的官方 MCP 正式开放，再看能不能换成它，那时连接和界面都不用变。

### 3.2 模型与订阅

【建议】

- **Alfred 有自己的凭证存储**，实现 Pi 的 `CredentialStore`，背后是钥匙串；worker 用 `ModelRuntime.create({ credentials })` 拿到它。默认不再读 `~/.pi/agent/auth.json`。
- **第一次打开时，发现本机有 Pi 的凭证，就问一句**：「在 Pi 里登录过 Anthropic 和 OpenAI，要直接用吗？」点「导入」才复制进钥匙串。不静默共享，因为那是另一个程序的文件。
- **登录在主节点里跑**（不是 worker），用 `Models.login`。它的提问和通知通过事件流转给发起登录的设备：
  - `auth_url` → 设备打开系统浏览器；同时给一个「浏览器没打开？复制链接」。
  - `device_code` → 显示短码，按钮「打开网页」。
  - `prompt: secret` → 一个密码框（API key）。
  - `prompt: manual_code` → 「把浏览器最后的网址贴在这里」，给回调到不了本机的情况用。
  - 完成后通知各 worker 刷新模型列表。
- **界面分两组**：「用订阅」（`isSubscription`）和「用 API key」。每家一行：状态、来源（钥匙串 / 环境变量 / 从 Pi 导入）、登录或退出。
- **默认值**：默认模型、默认思考强度、后台模型（自动任务和整理用的便宜模型）。对话里的模型选择照旧覆盖默认值。
- **用量**：Robin 有按家查订阅用量的接口；Alfred 先不做，等第一版模型设置用起来再说。
- **条款风险**：订阅账号在第三方应用里用，取决于各家条款，Anthropic 以前限制过。设置页上照实写「用的是你的订阅额度，是否允许以对方条款为准」，API key 永远是稳妥的那条路。

### 3.3 连接器（MCP）

【建议】

- **目录**：内置一份精选的远程 MCP 列表（名字、图标、网址、能做什么）。支持 OAuth 自动注册的，点「连接」就走 pi-mcp 的登录，体验和 Google 一样。
- **添加**：高级里可以填网址或命令自己加；存储格式仍是 `mcp.json`（和 Pi、Claude Desktop 兼容），但 token 和 header 里的密钥进钥匙串，不进这个文件。
- 每个服务一行：已连接 / 需要登录 / 出错，工具数，有多少个是只读（只读的直接用，其它的每次问——这是 worker 里现有的闸门，不变）。
- Alfred 给 `createMcpExtension` 传自己的 `credentials`（钥匙串）和 `openUrl`（转给设备），不再落到 Pi 的 `mcp-auth.json`。

### 3.4 在哪台设备上授权

【建议】凭证在主节点上，浏览器回调要回到主节点那台机器的 127.0.0.1。所以：

- **Mac App**：全程一键。
- **手机或别的电脑**：能看状态、能断开、能开关能力；要走浏览器的那一步，点「连接」后主节点在 Mac 上打开登录页，手机显示「已在 Mac 上打开，去那边点同意」。设备码（Copilot）和粘贴 key 在任何设备上都能完成。
- 动凭证的操作需要桌面类设备的能力范围（架构草案 5.7 节的设备能力），手机默认只能看和断开。

### 3.5 存储

【建议】

- **密钥**：钥匙串，服务名 `Alfred`，条目 `model:<provider>`、`google:<邮箱>`、`mcp:<server>`、`telegram`、`voice:boson`。
- **不是密钥的设置**（连了哪些、开了哪些能力、默认模型）：世界里的事件和状态，`connection.connected`、`connection.capability_changed`、`connection.disconnected`、`settings.changed`。设置改动因此和别的操作一样有审计。
- Node 访问钥匙串的方式【待定】，见第 7 节。

### 3.6 协议改动

```text
GET  /api/settings                          SettingsResponse：模型、连接、设备，不含任何密钥
POST /api/settings                          { requestId, patch }：默认模型、思考强度、通用偏好
POST /api/auth/start                        { requestId, target: "model:<id>" | "google" | "mcp:<name>", method?, capabilities? } -> { flow }
POST /api/auth/:flow/answer                 { promptId, value }：回答登录过程中的提问
POST /api/auth/:flow/cancel
POST /api/connections/:id/capabilities      { requestId, capability, enabled }：打开时可能返回一个新的 flow（增量授权）
POST /api/connections/:id/disconnect        { requestId }：撤销加删除
```

登录过程走现有事件流的 `live` 通道（`auth` 更新：`open_url`、`device_code`、`prompt`、`progress`、`done`、`error`），不记录；结果（连上、断开）是 `core` 事件。

### 3.7 设置页的结构（从 Robin 迁过来）

| 组 | 页 | 从 Robin 的哪里来 |
|---|---|---|
| 连接 | 模型与订阅 | Pi Web 的「模型」，加订阅登录 |
| | 账户（Google 等） | Robin「Google」「外联邮箱」，合成一个账户多开关 |
| | 连接器 | Pi Web「MCP」、Robin「Notion」「浏览器」 |
| 偏好 | 通用 | Robin「通用」，加托盘里的显示形象、登录时打开、配色 |
| | 语音 | Robin「语音」「转写」 |
| | 通知 | Robin「通知」，加安静时段 |
| 系统 | 设备 | 新（架构草案 5.7 节） |
| | 隐私与数据 | Robin「隐私」：哪些数据出本机、数据目录、导出 |

Telegram 归到「连接器」里一个特殊条目（只能粘 token）。Robin 设置里的早报、求职汇总、Gmail 汇总、提醒时间这些**不进设置**：它们是自动任务，归工作台的「自动任务」页。

连接放在最前面，因为第一次打开时那是唯一必须做的事：没有模型，Alfred 什么都做不了。第一次启动的引导就是这一页的前两块：「选一个模型登录」「连上 Google（可以跳过）」。

## 4. 安全

- 授权只在系统浏览器里做，Alfred 不碰账号密码。
- 同意页只要这一次需要的权限；关掉一个开关就少一组权限（下次授权时不再要）。
- 设置页每个连接写清楚数据去哪：「日历内容会作为任务上下文发给你选的模型」。
- token 不出主节点，不进数据库，不进日志，也不进 `mcp.json`。
- 发邮件、改日程、付款仍然每次确认；连上不等于预先同意。

## 5. 搭建顺序

每一步都能单独用。

1. **凭证存储和模型设置**：钥匙串存储、从 Pi 导入、`/api/auth` 登录转发、设置页的「模型与订阅」。做完 Alfred 就不依赖你的 Pi 配置了。
2. **Google 连接**：先用高级选项（自带客户端）把流程、钥匙串、增量授权、撤销跑通，再换成内置客户端。
3. **日历和邮件模块**用这个连接（工作台方案的 W6）。
4. **连接器目录**：MCP 登录转发，精选列表。
5. **设备、通知、隐私**。

## 6. 这一轮不做

- 不做自己的云端中转（那样数据就要经过服务器，Gmail 的安全评估一定躲不掉）。
- 不做用量和账单面板。
- 不做 iCloud / Outlook 账户；Mac 上的 EventKit 也先不做（见第 7 节第 5 条）。

## 7. 需要你决定

| # | 问题 | 建议 | 影响 |
|---|---|---|---|
| 1 | 用谁的 Google Cloud 项目注册 Alfred 的客户端 | 你自己的账号下新建一个「Alfred」项目，先「已发布、未验证」 | 一键能不能做；同意页上显示的开发者名字 |
| 2 | Node 怎么访问钥匙串 | 一个小的原生依赖（如 `@napi-rs/keyring`），Linux 上也能用；不用 `security` 命令，它会把密钥放进进程参数 | 第 1 步 |
| 3 | 默认不再读 `~/.pi/agent`，第一次打开时问要不要导入 | 是 | 你自己现在的使用要导入一次 |
| 4 | 设置里放不放 Claude Pro/Max 订阅登录 | 放，并写清条款风险；API key 放在同一页 | 条款风险 |
| 5 | Mac 上的日历要不要也支持 EventKit（系统日历里已加的 Google、iCloud 日历，一个系统授权弹窗就能读） | 先不做，Google 连接能覆盖日历和邮件；以后给不用 Google 的人加 | 要写一个 Swift 小程序 |
