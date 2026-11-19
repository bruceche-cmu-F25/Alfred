# 多设备：远程访问怎么做（调研）

> 状态：调研 v0.2（2026-11-18）。**已定：先 Serve 后 tsnet；手机默认装 Tailscale，原生 App 时再内嵌**（第 7 节第 1、3 条）；其余待定。还没有据此改代码。
> 承接：`docs/ARCHITECTURE.md` 5.7 节（「推荐 Tailscale Serve」）和第 3 步「多设备」；`docs/design/settings-and-connections.md`（「一键连接」的思路）。
> 标记：**【事实】** 读代码、文档或本机核实过；**【建议】** 本文的提案；**【待定】** 见第 7 节。

## 实现状态（2026-11-18）

已做「先 Serve」这一步，在真实 tailnet 上验证过：

- **开关**：设置 → 设备 →「从其他设备使用 Alfred」。打开后，Alfred 往本机的 Tailscale Serve 里加一条 `https://<本机>.ts.net:4443` → `127.0.0.1:<端口+10>`（入口端口），只动自己这一条，关掉时只删这一条。端口被别的东西占了就不碰，并报出来。
- **入口端口**：Serve 转过来的请求一律不算本机。除了界面文件和配对，都要设备令牌（HttpOnly、Secure、SameSite=Strict 的 cookie）。Serve 会保留 Host，也会带上 `Tailscale-User-Login`；别的 Tailscale 账号来的请求直接拒绝。
- **配对**：扫码加一次性配对码。一次只有一个码，10 分钟有效，错 5 次作废。码由 Mac 发，手机打开带码的链接就自动配上；也可以手输。
- **设备的权限**：能对话、改待办、处理提议、改语言。账户（`/api/connections`）、远程开关、配对、设备管理只能在 Mac 上做。
- **吊销**：立即生效，正开着的事件流当场断掉。手机自己也能「断开这台设备」。
- **PWA**：加了 manifest，可以加到主屏幕。

代码：`packages/core/src/devices.ts`、`packages/server/src/{remote,tailscale}.ts`、`http.ts` 的 `createIngressServer`、`packages/ui/src/{Devices,Pair}.tsx`；测试在 `packages/server/test/remote.test.ts`。

- **推送（Web Push）**：手机上「设置 → 这台设备 → 推送通知」打开。通知只给一台设备：正在用的窗口或者有人在用的 Mac 会在一两秒内认领；20 秒后仍没人认领的，推送给开了推送的设备，并记为被 `push` 认领（12 小时）。Mac 锁屏或 2 分钟没有操作时，不再认领，留给手机。点开通知：结果类的算已读；问题和提议要回答或决定后才算完。VAPID 私钥在钥匙串里，订阅在 `<数据目录>/push.json`。只接受 Apple、Google、Mozilla、Microsoft 的推送地址。

还没做：tsnet（第 3 节 B）、设备改名。

## 0. 结论

1. **Tailscale 能集成进来，而且应该用它。** 客户端核心（`tailscaled`、CLI、DERP 中继、`tsnet` 库）是 BSD-3 开源，可以打包进 Alfred；闭源的只有 macOS / iOS / Windows 的图形界面和 Tailscale 公司托管的协调服务器。协调服务器可以换成开源的 Headscale。
2. **推荐做法：主节点内嵌 `tsnet`，让 Alfred 以自己的名字加入用户的 tailnet**，比如 `https://alfred.tail1234.ts.net`。用户在设置里点「连接 Tailscale」，浏览器里登录一次，就完成了。不依赖 Mac 上装没装 Tailscale App，也不和 Robin 抢 Mac 的 443 端口。
3. **手机上仍然要装 Tailscale App。** 这是 PWA 的硬限制：浏览器只能发 HTTPS / WebSocket / WebRTC，进不了 WireGuard 网络。手机要不装就能连，只有两条路：把入口放到公网上（Funnel、Cloudflare Tunnel），或者以后做原生 App、把 libtailscale 编进去。两条都不放进第一版。
4. **Tailscale 只解决「连得上」，不解决「谁能做什么」。** 设备令牌、按设备分配的能力、吊销，照架构草案 5.7 节做，一条不省。Tailscale 能帮的是「认出这台设备是谁的」，这样配对时不用扫码，在 Mac 上点「允许」就行。
5. **界面上把它藏成一个开关**：设置 → 设备 →「从其他设备使用 Alfred」。网络层（内嵌 tsnet、借用已装的 Tailscale、局域网、Headscale）做成可替换的「通道」，高级选项里才看得到。

## 1. 现在到哪了

【事实】

- 主节点只绑 `127.0.0.1`，并且只接受 Host 是 loopback 的请求（`packages/server/src/http.ts:29`、`packages/server/src/cli.ts:61`）。没有设备、令牌、配对。
- 本机 Tailscale：1.102.3，独立下载版（`io.tailscale.ipn.macsys`），CLI 在 `/usr/local/bin/tailscale`，已登录。本机名 `mac-mini.tail1234.ts.net`，tailnet 里另有 2 台 macOS、2 台 iOS。
- 本机已经在用 Tailscale Serve：`https://mac-mini…:443` → `127.0.0.1:30141`（一个 Next 服务，应该是 Robin），`:8443` → `127.0.0.1:8788`。**这台 Mac 的 443 已经被占了。**
- Tailscale 免费个人版：第三方来源称 2026-04 起为 6 个用户、用户设备不限量，仅限非商业用途。没能打开官方价格页核实。

## 2. Tailscale 哪些开源，能不能集成

| 部分 | 开源吗 | 对 Alfred 意味着什么 |
|---|---|---|
| `tailscaled`、`tailscale` CLI | 开源（BSD-3） | 可以照着做，也可以通过 CLI / LocalAPI 驱动用户已装的那份 |
| `tsnet`（Go 库，把一个 Tailscale 节点嵌进程序里） | 开源 | **可以直接编进 Alfred**，用户态网络，不需要 VPN 权限、不需要 root |
| `libtailscale`（tsnet 的 C 封装） | 开源 | 以后原生手机 App 用；第三方 Flutter 包已经在 iOS 上这样用，不需要 VPN 权限 |
| DERP 中继服务器 | 开源 | 用不着自己跑；Tailscale 公共中继免费 |
| macOS / iOS / Windows 图形界面 | **闭源** | 不能打包进 Alfred；用户自己装 |
| 托管的协调服务器（登录、发钥、ACL） | **闭源**，SaaS | 用户需要一个 Tailscale 账号；不想要的话换 Headscale |
| Headscale（社区写的协调服务器） | 开源（BSD-3） | 「全开源、全自托管」的选项：tsnet 填 `ControlURL` 即可 |

商标：可以写「通过 Tailscale 连接」「Works with Tailscale」，不能把功能叫成 Tailscale 或用它的标志当 Alfred 的图标。

## 3. 三种接法

### A. 借用 Mac 上已装的 Tailscale（`tailscale serve`）

主节点执行 `tailscale serve --bg --https=<端口> http://127.0.0.1:<远程入口端口>`，关掉时 `tailscale serve --https=<端口> off`。

- 好处：几十行代码；复用已有登录；HTTPS 证书 Tailscale 自动给。Serve 会加 `Tailscale-User-Login` / `Tailscale-User-Name` 头并去掉伪造的同名头，可以用来认用户。
- 坏处：
  - 只能挂在 Mac 自己的名字下。443、8443 在 Bruce 这台机器上已被占，只能用别的端口，地址变成 `https://mac-mini…:4443` 这种。
  - 动的是用户全局的 Serve 配置，必须只碰自己的端口。
  - 只认得出用户，认不出设备（Serve 的头里没有设备）。
  - 用户没装 Tailscale 就走不通，得先引导去装闭源 App。
- 想要独立名字，Tailscale Services（2026-02 GA）能给 `svc:alfred` 一个专用名字。但要先在管理后台定义服务、批准主机，离「一键」太远。

### B. 主节点内嵌 tsnet（推荐）

一个很小的 Go 辅助程序 `alfred-net`（约 20–30 MB），由主节点拉起。它以主机名 `alfred` 加入 tailnet，用 `ListenTLS(":443")` 拿到自己的证书，把请求转给主节点。

- 好处：
  - 自己的名字 `alfred.<tailnet>.ts.net`，不和 Robin 或其他 Serve 冲突。PWA 的来源（origin）干净，以后搬到常开的 Mac mini 或服务器上，名字也跟着走。
  - 不依赖 Mac 上的 Tailscale App。用户没装也能一键：设置里拿到登录网址，系统浏览器打开，登录后自动连上。
  - 每个请求都能 `WhoIs`：知道来自哪个用户的哪台设备（「Bruce 的 iPhone，iOS」）。配对因此能做成「新设备出现 → Mac 上点允许」。
  - 填 `ControlURL` 就能接 Headscale，满足「全开源」。
- 坏处：
  - 构建多一个 Go 工具链和一个要签名、公证的二进制。
  - 要跟 Tailscale 的版本，安全更新要跟上。
  - 交互登录出来的节点归用户所有，默认 180 天密钥过期。设置里要提示「在 Tailscale 后台关掉 alfred 的密钥过期」，或者到期前发一条「需要重新连接」的通知。
- 怎么拿登录网址【事实】：tsnet 把 AuthURL 打到 `UserLogf`；通过它的 LocalClient 读状态也能拿到。`alfred-net` 把状态（需要登录 + 网址 / 已连接 + 名字）用 JSON 报给主节点，界面照抄 Google 连接那套「打开浏览器 → 等待 → 已连接」。

### C. 不用 Tailscale

| 方案 | 手机要装东西吗 | 进公网吗 | 结论 |
|---|---|---|---|
| 局域网 + 长密码 | 不用 | 不进 | 只在家里能用；没有可信的 HTTPS，PWA 安装、推送、麦克风都用不了。只保留为备选 |
| Tailscale Funnel / Cloudflare Tunnel | 不用 | **进** | 手机免装，但主节点就暴露在公网上了，安全全压在设备令牌一层。只做成高级选项、默认关，开的时候明确警告 |
| NetBird / ZeroTier | 要（各自的 App） | 不进 | 和 Tailscale 同一类，但管理服务器是 AGPL（NetBird，v0.53 起）或「源码可见」（ZeroTier 的控制器）；生态和 tsnet 这种嵌入库都不如 Tailscale。不做 |
| iroh 一类 P2P 库（MIT / Apache） | 要原生 App | 不进 | 浏览器用不了；适合以后的原生 App，不适合 PWA |
| 自建中继（端到端加密） | 不用 | 中继在公网 | 开源项目就得替所有用户运营一台服务器。不做 |

关键约束只有一条：**PWA 跑在浏览器里，要么手机系统层面进了私有网络（Tailscale App），要么入口在公网。** 所以「默认私有」和「手机免装」不能兼得，第一版选默认私有。

## 4. 推荐方案

【建议】

1. **网络层抽象成「通道」（RemoteChannel）。** 主节点只关心三件事：开 / 关、当前地址、对端是谁。实现有：
   - `tailscale-embedded`（B，默认）
   - `tailscale-installed`（A：检测到已装并登录时可选，也是开发期最快能跑起来的）
   - `lan`
   - 以后可能有 `funnel`
2. **远程流量走单独的入口，永远不算「本机」。** 现在的安全模型是「loopback 就是本机」。A 和 B 都会把远程请求代理到 127.0.0.1，如果走同一个端口，手机就被当成本机了。所以：
   - 远程入口用另一个 loopback 端口或 unix socket，在那里一律要求设备令牌，并带上通道报来的对端身份（用户、设备、系统）。
   - 本机端口的 Host 检查保持不变。
3. **两层身份。**
   - Tailscale 说「这是 Bruce 账号下的 iPhone」，作为配对的线索。
   - Alfred 自己发设备令牌，按设备给能力（5.7 节：手机能对话、改记录、收推送；不能开终端、不能动 Mac 本机能力）。
   - tailnet 里别的用户（被分享进来的节点）默认拒绝。
4. **先 A 后 B。**
   - 第 3 步先用 A 跑通配对、设备令牌、PWA、推送。这是一天的量，Bruce 现在就能用。
   - 然后换成 B 作为默认。界面和协议不变，只换通道。

## 5. 界面：怎么「藏」进 App

设置里新增「设备」一栏（和「连接」并列），一屏讲完：

```
从其他设备使用 Alfred                                   [ 开关 ]
  关：只有这台 Mac 能用。
  开（未连接）：「Alfred 通过 Tailscale 让你的手机安全地连回这台 Mac，不经过公网。」
               [ 用 Tailscale 登录 ]  → 系统浏览器 → 「等待登录…」
  开（已连接）：https://alfred.tail1234.ts.net   [复制] [二维码]

已连接的设备
  这台 Mac         本机 · 全部能力
  Bruce 的 iPhone  手机 · 对话、待办、推送、语音    最近 3 分钟前   [吊销]
  ⓘ 新设备「iPad」想连接   [允许] [拒绝]

高级（折叠）
  通道：Alfred 自带（推荐） / 使用这台 Mac 上的 Tailscale / 仅局域网
  协调服务器：Tailscale（默认） / 自定义地址（Headscale）
```

（公网访问 / Funnel 不提供，见第 7 节第 3 条。）

手机上手流程（二维码页里分两步写）：

1. 手机装 Tailscale，用同一个账号登录（附 App Store 链接）。
2. 扫码打开 `https://alfred.…ts.net/pair?code=…` → 加到主屏幕 → Mac 上弹「Bruce 的 iPhone 想连接」→ 点允许。

页面打不开，基本就是第 1 步没做；配对页的离线提示里直接写这一句。

其他：

- 动凭证、改通道的操作只在桌面类设备上能做（同设置草案第 5 节）。
- 手机上的设置页只显示状态、自己的设备、吊销自己。

## 6. 和现有文档的出入

- 架构草案 5.7 写的是「推荐 Tailscale Serve」。本文把它降为备选（A），默认改成内嵌 tsnet（B）。理由：Bruce 的 Mac 上 443 已经被占；要一键、不依赖 Mac 上的 Tailscale App；能 `WhoIs` 认出设备。
- 待定第 14 条（远程访问默认方案）建议改为：「内嵌 tsnet；已装 Tailscale 时可改用 Serve；局域网备选」。

## 7. 待定

1. ~~默认通道是 B（内嵌 tsnet），还是先只做 A、B 以后再说？~~ **已定（2026-11-18，Bruce）：先 Serve 后 tsnet。** 第 3 步用 A 跑通配对、设备令牌、PWA、推送；之后把默认换成 B，界面和协议不变。
2. 配对用「Mac 上点允许」，还是扫码？【建议】因为先做 Serve，扫码加一次性配对码作为基础。Serve 只给用户、不给设备，「Mac 上点允许」认不出是哪台设备，所以等 tsnet 上了（能 `WhoIs`）再加；扫码那套在局域网通道里也能用。
3. ~~Funnel（手机免装 Tailscale）要不要做成高级选项，还是干脆不提供？~~ **已定（2026-11-18，Bruce）：默认手机上要装 Tailscale；不做 Funnel / 公网入口。** 以后做原生 App 时把 libtailscale 编进去，那时手机才免装。
4. 密钥过期：提示用户去 Tailscale 后台关，还是到期前提醒重新登录？
5. 构建里加 Go 工具链能不能接受（`alfred-net` 进 `packages/net/`，CI 交叉编译 arm64 / x64）？

## 来源

- [Open source at Tailscale](https://tailscale.com/opensource)：哪些开源、哪些闭源
- [tsnet 包文档](https://pkg.go.dev/tailscale.com/tsnet)、[tsnet.Server API](https://tailscale.com/docs/reference/tsnet-server-api)：`UserLogf` 里的 AuthURL、`ControlURL`、`ListenTLS`
- [Tailscale Serve](https://tailscale.com/kb/1312/serve)：身份头
- [Tailscale Services GA](https://tailscale.com/blog/services-ga)、[Services 文档](https://tailscale.com/kb/1552/tailscale-services)
- [Headscale](https://pkg.go.dev/github.com/juanfont/headscale)
- [NetBird 改用 AGPL](https://netbird.io/knowledge-hub/netbird-agpl-announcement)
- [libtailscale Dart 包](https://pub.dev/packages/libtailscale)、[tsnet_flutter](https://pub.dev/documentation/tsnet_flutter/0.3.0)：iOS 上嵌入、不需要 VPN 权限的先例
- 免费版额度（第三方，未核实官方页）：[costbench](https://www.costbench.com/software/business-vpn/tailscale/free-plan/)
- 本机：`tailscale version`、`tailscale status --json`、`tailscale serve status`（2026-11-18）
