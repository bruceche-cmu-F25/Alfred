# Sky × Pi Web · 独立交互样稿

**Throwaway mock，非正式功能。** 验证：Sky 在首页有自己的位置；对话时展开；工作时退到导航中；Pi Web 项目会话仍独立。

## 打开

```bash
python3 -m http.server 4173 --bind 127.0.0.1 --directory /Users/bruce/Alfred/prototype/pi-web-sky
```

浏览器访问 http://127.0.0.1:4173/ 。静态服务器只监听本机，与 Pi Web 的 30141 端口独立。

## 可以体验

- 首页：Sky、文字输入、示例日历／待办；勾选只改本页状态。
- 点 Sky 展开同一个对话面；「一起安排下午」显示固定的计划示例。
- 收起后进「笔记」，点右上角小 Sky：对话和未发送草稿仍在。
- 「会话」是静态 Pi Web 项目会话示意，不是实际运行的 Agent。
- 顶部太阳切换浅色／夜色；暂停键停止形象动画。
- 「体验语音状态」依次展示倾听／等待／说话，不申请麦克风，也不播放声音。
- 提供窄屏、横屏、减少动态效果及 WebGL 不可用时的静态降级。

## 隔离边界

- 没有修改、导入或调用 `pi-web-robin` 的运行代码。
- 没有真实日程、任务、笔记、用户聊天、密钥或模型。
- 无 API 请求、WebSocket、外部字体、音频、数据库或浏览器持久存储。
- CSP `connect-src 'none'` / `media-src 'none'` / `form-action 'none'`。
- 所有文案、时间、结果都是样稿；回复由固定分支生成，不代表模型能力。
- 对话和草稿仅在当前文档内延续，刷新即清空；不是跨设备／重启恢复实现。

## 文件

- `index.html`：三个静态页面和一个原生对话框。
- `styles.css`：仅本 mock 使用的浅／深配色及布局，没有全局主题修改。
- `app.js`：页内切换、模拟回复和语音状态；只使用内存。
- `sky.js`：从 Alfred `prototype/forms.html` 的 Sky / Clouds 抽出的 WebGL shader；一个 512px 离屏画布绘制到可见槽位，空闲约 20fps、交互约 30fps，隐藏暂停，减少动态效果保持静止，失败显示 CSS 静态形象。沿用原 shader 的 MIT 来源标注。
- `check.mjs`：使用 Pi Web 已安装的 Playwright，无需新增依赖。
- `previews/`：测试生成的首页、对话、工作区与手机预览截图。

## 检查

保持静态服务器运行：

```bash
node /Users/bruce/Alfred/prototype/pi-web-sky/check.mjs
```

默认读取 `/Users/bruce/pi-web-robin/node_modules/playwright/index.mjs`；其他机器可以用 `PLAYWRIGHT_MODULE` 指定已安装的模块。

检查 320／390／768／1440px、812×375 横屏、两种配色、对话／草稿续接、模拟语音、文本安全、减少动态效果和 WebGL 降级；拦截网络／麦克风／持久存储以保证没有真实动作。仅桌面 Chromium 和尺寸模拟，不是手机真机性能或麦克风验收。
