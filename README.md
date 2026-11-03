# usage-sidebar

OpenCode v2 TUI 插件：在右侧边栏追加一个用量面板。

## 显示内容

- **OpenCode Go 额度**：5 小时 / 本周 / 本月三个窗口，显示已用百分比、剩余百分比、重置倒计时。
- **Console 预算**：`/api/experimental/usage/limits` 返回 `budgets` 时显示已花/上限。
- **本会话 Token**：当前会话及子会话的 input / output / cache / reasoning / 合计 / 费用；头部附带步数与耗时。
- **上下文占用**：`ctx 42K/200K 21%`，按最后一步的 `input + cache.read + cache.write` 与模型 `limit.context` 计算，80% 黄色、95% 红色。
- **缓存**：本会话与今日/本周/本月统计显示 `命中xx%`（`cache.read / (input + cache.read + cache.write)`），并按目录单价估算 `省$x`（Go 套餐仅作标价参考）。
- **输出速率**：流式中以绿色显示整数 `t/s` 估算值，右侧固定 8 格（`sm`/`lg` 为 6/12）绿色迷你趋势条，再跟 `τ₁`（TTFT）与 ▲（本次峰值）；每步结束后切换为灰色的 `⏸` 精确值，趋势条保留上一步的走势，宽度始终不变。
- **今日 / 本周 / 本月 Token**：总量、费用、步数、会话数、缓存命中率，以及今日步数最多的模型。
- **工具与活动**：统计范围内显示工具调用总数、失败数、调用最多的工具；近 7 日步数趋势与连续活跃天数。
- **工具与异常计数**：本会话有工具调用或异常时追加一行 `工具N 失败x 重试x 压缩x`，无数据时不显示。
- **折叠概览**：点击面板标题 `▾ 用量`，或在命令面板/斜杠命令执行 `usage-toggle`，折叠为 3 行概览（额度 / 本会话 / 当前统计区间）。
- **数据新鲜度**：额度行头部显示取数时刻和年龄（如 `23:54 (12s前)`）；倒计时每秒重算，分钟向上取整，与 console 的 “Resets in 0h 37m” 一致。

### 刷新时机

- 额度与统计：默认每 60s 轮询一次（`refreshMs`，最小 15s）。
- 本会话出现用量变化后，额度与统计各自防抖 5s 后刷新；一轮任务结束（`session.idle`）时立即刷新一次。
- 面板每秒重绘一次，用于走倒计时和“数据年龄”，不额外请求接口。

### 费用口径

API 的 `cost` 是实际记账成本。OpenCode Go 套餐内的请求通常返回 `0`，此时面板不显示费用，只用模型目录的单价给出 `$x` 标价估算。估算不包含 Go 的高峰加价，仅供参考。

### 速率口径

- 流式中：按 4 秒滚动窗口统计 `text.delta` / `reasoning.delta` 字符数，按中英文估算 token；每 1 秒刷新一次，窗口内累计不足 1 秒流式时间时显示 `▸采样中…`（更短的窗口会把速率放大数倍）。每完成一步用真实 token 数校准该模型的 chars/token 比例（仅当 `rateIncludeTools` 打开时）。
- 步骤结束后：与内置 footer 相同，`(output + reasoning) / ((time.streamed - time.created) / 1000)`。
- 趋势条：固定宽度（`sm`/`md`/`lg` = 6/8/12 格，与 `fontSize` 联动），颜色与额度条的正常余量一致；样本不足时左侧用 `▁` 补齐，步骤结束后保留上一步的样本，所以空闲时也照常显示。
- 首字（TTFT）：`step.started` 到第一个 `text.delta` / `reasoning.delta` 的时间差，显示为 `τ₁x.xs`。
- 峰值：当前步骤内实时速率样本的最大值，显示为 `▲N`。
- 插件加载时如果当前会话已有历史消息，会直接显示最后一步的精确速率。

数据来源：

| 数据 | 接口 |
| --- | --- |
| Go 额度、预算 | `client.experimental.usage.limits` → `GET /api/experimental/usage/limits` |
| 时间区间统计 | `client.experimental.session.stats` → `GET /api/experimental/session/stats` |
| 模型价格与上下文上限 | `client.model.list`（模型目录） |
| 当前会话 | TUI `context.data.session` 缓存 |
| 工具/重试/压缩计数 | TUI `context.data.on` 事件流 |

## 安装

```sh
npm install -g @shaojc/opencode-usage-sidebar
```

或直接在 `~/.config/opencode/cli.json` 中注册：

```json
{
  "plugins": [
    {
      "package": "@shaojc/opencode-usage-sidebar",
      "options": {
        "refreshMs": 60000,
        "sections": ["go", "session", "today", "week", "month"],
        "showRate": true,
        "rateWindowMs": 4000,
        "rateIncludeTools": true,
        "statsTools": "summary",
        "fontSize": "md",
        "collapsed": false
      }
    }
  ]
}
```

本地开发时把 `package` 改为 `"./usage-sidebar"` 即可（改源码后需要先 `npm run build`）。

## 选项

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `refreshMs` | `60000` | 轮询间隔，限制在 15s ~ 30min |
| `sections` | 全部 | 可选 `go`、`session`、`today`、`week`、`month` |
| `showRate` | `true` | 是否显示输出速率行 |
| `rateWindowMs` | `4000` | 实时速率滚动窗口，限制在 1s ~ 15s |
| `rateIncludeTools` | `false` | 是否把工具调用参数计入速率与校准 |
| `statsTools` | `"summary"` | 统计接口的工具明细：`none` / `summary` / `detail`，`detail` 额外返回每工具调用数 |
| `fontSize` | `"md"` | `sm` / `md` / `lg`。终端无法改变字形大小，这里按字符宽度缩放进度条、趋势条与标题截断宽度 |
| `collapsed` | `false` | 首次启动时的折叠状态；之后由面板标题或 `usage-toggle` 切换并持久化 |
| `debug` | `false` | 写入 `~/.local/share/opencode/usage-sidebar.log` |

## 命令

- 命令面板：`刷新用量统计` / `折叠/展开用量面板`
- 斜杠命令：`/usage-stats` / `/usage-toggle`
- 鼠标：点击面板标题 `▾ 用量` 折叠，点击 `▸ 用量` 展开（需 TUI 开启 `mouse`）
- 折叠状态通过 `context.storage.store` 持久化，热重载和多 TUI 实例共享。
- 如需快捷键，可在 `tui.jsonc` 的 `keybinds` 中绑定命令 id `usage-sidebar.toggle`（命令本身不自动占键）。

## 开发

```sh
npm install
npm run build      # 编译到 dist/（.js + .d.ts）
npm run verify     # 构建 + 全部测试 + 类型检查，发布前跑这一条即可
npm run check:render  # 用 OpenTUI 测试渲染器真渲染一遍面板（首次会通过 npm 下载 bun）
npm test           # 只跑测试（会先自动 build）
npm run typecheck
```

需要 Node ≥ 22.18 跑测试（Node 内置 runner 直接执行 `.ts`），发布后的包本身在 Bun 中运行。

发布包只包含 `dist/`，`tui.tsx` / `panel.tsx` 等源码不会进入 tarball。`npm publish` 会先由 `prepack` 构建，再由 `prepublishOnly` 执行 `npm run verify`（构建 + 测试 + 类型检查），任何一步失败都会中止发布。

测试用 Node 内置 runner，覆盖：

- `format.ts` / `view.ts` / `data.ts` 的纯函数（格式化、上下文占用、缓存节省、折叠概览、计费、时间区间、接口适配）。
- 编译产物 `dist/tui.js` 的插件契约（`id`、sidebar slot、刷新/折叠命令、折叠状态持久化、事件订阅与释放）。
- `npm run check:render` 用 OpenTUI 测试渲染器实际渲染面板：加载态、数据到达后的展开视图、点击标题折叠/展开。这类渲染期异常单元测试抓不到。
- 真实 `npm pack` 产物：检查文件清单、相对导入可解析、JSX 运行时存在，并把 tarball 装进临时 consumer 目录验证 `@shaojc/opencode-usage-sidebar/tui` 能被解析。

修改后保存配置文件，或在 TUI 执行 `/reload`，插件会热重载。
