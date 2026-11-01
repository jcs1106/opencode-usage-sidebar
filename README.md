# usage-sidebar

OpenCode v2 TUI 插件：在右侧边栏追加一个用量面板。

## 显示内容

- **OpenCode Go 额度**：5 小时 / 本周 / 本月三个窗口，显示已用百分比、剩余百分比、重置倒计时。
- **Console 预算**：`/api/experimental/usage/limits` 返回 `budgets` 时显示已花/上限。
- **本会话 Token**：当前会话及子会话的 input / output / cache / reasoning / 合计 / 费用。
- **输出速率**：流式中显示 `~tok/s` 估算值和迷你趋势条；每步结束后切换为精确值。
- **今日 / 本周 / 本月 Token**：总量、费用、步数，以及今日步数最多的模型。

### 费用口径

API 的 `cost` 是实际记账成本。OpenCode Go 套餐内的请求通常返回 `0`，面板会显示 `套餐内`，并用模型目录的单价额外给出 `≈$x` 标价估算。估算不包含 Go 的高峰加价，仅供参考。

### 速率口径

- 流式中：按 4 秒滚动窗口统计 `text.delta` / `reasoning.delta` / `tool.input.delta` 字符数，按中英文估算 token；每完成一步用真实 token 数校准该模型的 chars/token 比例。
- 步骤结束后：与内置 footer 相同，`(output + reasoning) / ((time.streamed - time.created) / 1000)`。
- 插件加载时如果当前会话已有历史消息，会直接显示最后一步的精确速率。

数据来源：

| 数据 | 接口 |
| --- | --- |
| Go 额度、预算 | `client.experimental.usage.limits` → `GET /api/experimental/usage/limits` |
| 时间区间统计 | `client.experimental.session.stats` → `GET /api/experimental/session/stats` |
| 当前会话 | TUI `context.data.session` 缓存 |

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
        "rateIncludeTools": true
      }
    }
  ]
}
```

本地开发时把 `package` 改为 `"./usage-sidebar"` 即可。

## 选项

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `refreshMs` | `60000` | 轮询间隔，限制在 15s ~ 30min |
| `sections` | 全部 | 可选 `go`、`session`、`today`、`week`、`month` |
| `showRate` | `true` | 是否显示输出速率行 |
| `rateWindowMs` | `4000` | 实时速率滚动窗口，限制在 1s ~ 15s |
| `rateIncludeTools` | `true` | 是否把工具调用参数计入速率与校准 |
| `debug` | `false` | 写入 `~/.local/share/opencode/usage-sidebar.log` |

## 命令

- 命令面板：`刷新用量统计`
- 斜杠命令：`/usage-stats`

## 开发

```sh
npm install
npx tsc --noEmit
```

修改后保存配置文件，或在 TUI 执行 `/reload`，插件会热重载。
