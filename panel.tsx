/** @jsxImportSource @opentui/solid */

import { For, Show, createMemo, onMount } from "solid-js"
import type { Accessor } from "solid-js"
import { usePlugin } from "@opencode/plugin/tui"
import {
  age,
  bar,
  cacheLabel,
  cacheSavings,
  clock,
  compact,
  contextLabel,
  contextPercent,
  costLabel,
  countdown,
  duration,
  layoutFor,
  sparkline,
  sparklineFixed,
  sumTokens,
  totalTokens,
  truncate,
  usd,
  type FontSize,
} from "./format.js"
import {
  estimateCost,
  MIN_RATE_TOKENS,
  modelKey,
  type ModelEntry,
  type QuotaState,
  type RateState,
  type SessionStats,
  type StatsState,
  type TokenUsage,
} from "./data.js"
import { counterLine, quotaOverview, rangeOverview, sessionOverview } from "./view.js"

const GO_WINDOWS = [
  ["rolling", "5h"],
  ["weekly", "周"],
  ["monthly", "月"],
] as const

/** Rate digits are padded so the sparkline and trailing labels stop shifting. */
const RATE_DIGITS = 3

const EMPTY_TOKENS: TokenUsage = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
}

function nodeText(node: any): string {
  if (node == null) return ""
  if (typeof node === "string") return node
  const children = node.children
  if (Array.isArray(children)) return children.map(nodeText).join("")
  if (typeof node.plainText === "string") return node.plainText
  return ""
}

type CostParts = {
  real: number
  estimated?: number
  providers: string[]
}

export type PanelProps = {
  sessionID: string
  quota: Accessor<QuotaState>
  stats: Accessor<StatsState>
  version: Accessor<number>
  sections: ReadonlySet<string>
  rates: Accessor<Map<string, RateState>>
  models: Accessor<Map<string, ModelEntry>>
  showRate: boolean
  fontSize: FontSize
  collapsed: Accessor<boolean>
  onToggle: () => void
  log?: (message: string) => void
}

export function UsagePanel(props: PanelProps) {
  const context = usePlugin()
  let box: any
  onMount(() => {
    if (!props.log) return
    props.log("panel mounted")
    setTimeout(() => {
      try {
        const layout = box?.getLayout?.()
        props.log?.(`panel layout ${layout?.width ?? "?"}x${layout?.height ?? "?"}`)
        const lines = box?.getChildren?.().map((child: any) => nodeText(child))
        props.log?.(`panel lines ${JSON.stringify(lines)}`)
      } catch (error) {
        props.log?.(`panel inspect failed ${String(error)}`)
      }
    }, 500)
  })
  const theme = () => context.theme
  const muted = () => theme().text.muted
  const faint = () => theme().text.faint
  const base = () => theme().text.base
  const danger = () => theme().text.feedback.error.base
  const warning = () => theme().text.feedback.warning.base
  const info = () => theme().text.feedback.info.base
  const success = () => theme().text.feedback.success.base
  const layout = () => layoutFor(props.fontSize)

  const windows = createMemo(() => {
    const go = props.quota().data?.go
    if (!go) return []
    return GO_WINDOWS.map(([key, label]) => ({ key, label, ...go[key] }))
  })

  const budgets = createMemo(() => props.quota().data?.budgets ?? [])

  const sessionUsage = createMemo(() => {
    props.version()
    let tokens = EMPTY_TOKENS
    let cost = 0
    const providers = new Set<string>()
    let estimated = 0
    let priced = false
    try {
      const ids = context.data.session.family(props.sessionID)
      for (const id of ids) {
        const session = context.data.session.get(id)
        if (!session) continue
        tokens = sumTokens(tokens, session.tokens)
        cost += session.cost ?? 0
        if (session.model) providers.add(session.model.providerID)
      }

      if (cost <= 0) {
        for (const id of ids) {
          for (const message of context.data.session.message.list(id)) {
            if (message.type !== "assistant" || !message.tokens || !message.model) continue
            providers.add(message.model.providerID)
            const costs = props.models().get(
              modelKey(message.model.providerID, message.model.id),
            )?.cost
            if (!costs || costs.length === 0) continue
            estimated += estimateCost(message.tokens, costs)
            priced = true
          }
        }
        if (!priced) {
          const session = context.data.session.get(props.sessionID)
          const costs = session?.model
            ? props.models().get(modelKey(session.model.providerID, session.model.id))?.cost
            : undefined
          if (costs && costs.length > 0) {
            estimated = estimateCost(tokens, costs)
            priced = true
          }
        }
      }
    } catch {
      // session cache can lag right after a switch; keep whatever was computed.
    }
    return {
      tokens,
      real: cost,
      providers: [...providers],
      estimated: priced ? estimated : undefined,
    } satisfies CostParts & { tokens: TokenUsage }
  })

  /** Steps, elapsed time, context pressure and cache savings for the current session family. */
  const sessionDetail = createMemo(() => {
    props.version()
    let steps = 0
    let savings = 0
    let latest: any
    let latestCreated = -1
    try {
      for (const id of context.data.session.family(props.sessionID)) {
        for (const message of context.data.session.message.list(id)) {
          if (message.type !== "assistant") continue
          steps += 1
          if (message.model && message.tokens) {
            const costs = props.models().get(
              modelKey(message.model.providerID, message.model.id),
            )?.cost
            savings += cacheSavings(message.tokens, costs)
          }
          if (message.tokens) {
            const created = (message.time as any)?.created ?? 0
            if (created >= latestCreated) {
              latest = message
              latestCreated = created
            }
          }
        }
      }
    } catch {
      // message cache may not be loaded yet
    }

    let contextInfo: { used: number; limit: number; percent: number } | undefined
    if (latest?.tokens && latest.model) {
      const limit = props.models().get(
        modelKey(latest.model.providerID, latest.model.id),
      )?.limit?.context
      const used =
        (latest.tokens.input ?? 0) +
        (latest.tokens.cache?.read ?? 0) +
        (latest.tokens.cache?.write ?? 0)
      const percent = contextPercent(used, limit)
      if (percent !== undefined && limit) contextInfo = { used, limit, percent }
    }

    const session = context.data.session.get(props.sessionID)
    const created = session?.time?.created
    let running = false
    try {
      running = context.data.session.status?.(props.sessionID) === "running"
    } catch {
      // status cache may not be ready
    }
    const ended = running ? Date.now() : (session?.time?.idle ?? session?.time?.updated)
    const elapsed = created && ended && ended > created ? ended - created : undefined

    return { steps, savings, elapsed, context: contextInfo }
  })

  const statsCost = (stats?: SessionStats | null): CostParts => {
    if (!stats) return { real: 0, providers: [] }
    const providers: string[] = []
    let estimated = 0
    let priced = false
    for (const usage of stats.models ?? []) {
      const providerID = usage.model?.providerID
      const modelID = usage.model?.id
      if (providerID) providers.push(providerID)
      if (!providerID || !modelID) continue
      const costs = props.models().get(modelKey(providerID, modelID))?.cost
      if (!costs || costs.length === 0) continue
      estimated += estimateCost(usage.tokens, costs)
      priced = true
    }
    return { real: stats.cost, providers, estimated: priced ? estimated : undefined }
  }

  const ranged = createMemo(() =>
    props.stats().ranges.filter((range) => props.sections.has(range.key)),
  )

  const topModel = createMemo(() => {
    if (!props.sections.has("today")) return undefined
    const today = props.stats().ranges.find((range) => range.key === "today")
    const model = today?.stats?.models?.[0]
    if (!model) return undefined
    return {
      name: model.name ?? model.model?.id ?? "unknown",
      steps: model.steps ?? 0,
    }
  })

  const toolsInfo = createMemo(() => {
    for (const range of ranged()) {
      const tools = range.stats?.tools
      if (!tools || tools.mode === "none") continue
      const top =
        tools.mode === "detail"
          ? [...(tools.usage ?? [])].sort((left, right) => right.calls - left.calls)[0]
          : undefined
      return { totals: tools.totals, top: top?.name, range }
    }
    return undefined
  })

  const statsExtra = createMemo(() => {
    const stats = ranged()[0]?.stats
    if (!stats) return ""
    const parts: string[] = []
    if ((stats.subagents ?? 0) > 0) parts.push(`子代理${stats.subagents}`)
    if ((stats.prompts ?? 0) > 0) parts.push(`提示${stats.prompts}`)
    if ((stats.activeDays ?? 0) > 0) parts.push(`活跃${stats.activeDays}天`)
    return parts.join(" ")
  })

  const activity = createMemo(() => {    for (const range of ranged()) {
      const days = range.stats?.activity
      if (!days || days.length === 0) continue
      const recent = days.slice(-7)
      if (recent.every((day) => day.steps === 0)) continue
      return {
        chart: sparkline(
          recent.map((day) => day.steps),
          layout().spark,
        ),
        streak: range.stats?.streak ?? 0,
        label: range.label,
      }
    }
    return undefined
  })

  const fallbackRate = createMemo<RateState | undefined>(() => {
    props.version()
    try {
      for (const id of context.data.session.family(props.sessionID)) {
        const messages = context.data.session.message.list(id)
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index]
          if (message.type !== "assistant" || !message.tokens) continue
          const time = message.time as any
          if (!time?.streamed || !time?.created || time.streamed <= time.created) continue
          const tokens = (message.tokens.output ?? 0) + (message.tokens.reasoning ?? 0)
          if (tokens < MIN_RATE_TOKENS) continue
          return {
            exact: tokens / ((time.streamed - time.created) / 1000),
            active: false,
            samples: [],
          } satisfies RateState
        }
      }
    } catch {
      // message cache may not be loaded yet
    }
    return undefined
  })

  const rate = createMemo(() => {
    const current = props.rates().get(props.sessionID)
    if (current?.active || current?.exact !== undefined) return current
    return fallbackRate() ?? current
  })

  const rateLine = createMemo(() => {
    const current = rate()
    if (!current) return undefined
    if (current.active) {
      return {
        live: true,
        icon: "▸",
        value:
          current.live === undefined
            ? "采样中…"
            : `${String(Math.round(current.live)).padStart(RATE_DIGITS)}t/s`,
      }
    }
    if (current.exact === undefined) return undefined
    return {
      live: false,
      icon: "⏸",
      value: `${String(Math.round(current.exact)).padStart(RATE_DIGITS)}t/s`,
    }
  })

  const rateMain = createMemo(() => {
    const line = rateLine()
    return line ? `${line.icon} ${line.value}` : "—"
  })

  /** Always the same width, and kept after a step ends so the column never jumps. */
  const rateChart = createMemo(() => ` ${sparklineFixed(rate()?.samples ?? [], layout().spark)}`)

  const rateSuffix = createMemo(() => {
    const current = rate()
    if (!current) return ""
    const parts: string[] = []
    if (current.ttft !== undefined) parts.push(`τ₁${current.ttft.toFixed(1)}s`)
    if (current.peak !== undefined && current.peak > 0) parts.push(`▲${Math.round(current.peak)}`)
    return parts.length > 0 ? ` ${parts.join(" ")}` : ""
  })

  const rateColor = () => {
    const line = rateLine()
    if (!line) return faint()
    // Green while tokens are still streaming, muted once the number is a finished step.
    return line.live ? success() : muted()
  }

  const sessionCounters = createMemo(() => counterLine(props.rates().get(props.sessionID)))

  const quotaHint = createMemo(() => {
    const snapshot = props.quota()
    if (snapshot.unsupported) return "额度接口不可用"
    if (snapshot.error && !snapshot.data) return "额度读取失败"
    if (!snapshot.data) {
      if (snapshot.loading) return "读取中…"
      return "未登录 OpenCode Console"
    }
    return ""
  })

  const statsHint = createMemo(() => {
    const snapshot = props.stats()
    if (snapshot.unsupported) return "统计接口不可用"
    if (snapshot.error) return "统计刷新失败"
    if (snapshot.loading && snapshot.ranges.length === 0) return "读取中…"
    return ""
  })

  const windowColor = (percent: number, limited: boolean) => {
    if (limited || percent >= 100) return danger()
    if (percent >= 80) return warning()
    return theme().text.feedback.success.base
  }

  const contextColor = (percent: number) => {
    if (percent >= 95) return danger()
    if (percent >= 80) return warning()
    return base()
  }

  const collapsedQuota = createMemo(() =>
    props.sections.has("go") ? quotaOverview(props.quota()) : "",
  )
  const collapsedSession = createMemo(() => {
    if (!props.sections.has("session")) return ""
    const usage = sessionUsage()
    return sessionOverview(usage.tokens, costLabel(usage), cacheLabel(usage.tokens), rate())
  })
  const collapsedRange = createMemo((): { label: string; text: string } | undefined => {
    const range = ranged()[0]
    if (!range) return undefined
    const text = rangeOverview(range, costLabel(statsCost(range.stats)))
    return text ? { label: range.label, text } : undefined
  })

  const body = () => (
    <>
      <text selectable={false} onMouseDown={() => props.onToggle()}>
        <span style={{ fg: muted() }}>{props.collapsed() ? "▸ " : "▾ "}</span>
        <span style={{ fg: muted() }}>用量</span>
        <Show when={!props.collapsed() && props.sections.has("go")}>
          <span style={{ fg: faint() }}>
            {props.quota().fetchedAt ? ` 剩余 ${clock(props.quota().fetchedAt)} (${age(props.quota().fetchedAt)})` : ""}
          </span>
          <Show when={props.quota().error && props.quota().data}>
            <span style={{ fg: danger() }}> 失败</span>
          </Show>
        </Show>
        <Show when={props.collapsed()}>
          <span style={{ fg: faint() }}> 点击展开</span>
        </Show>
      </text>

      <Show when={props.collapsed()}>
        <Show when={collapsedQuota()}>
          <text>
            <span style={{ fg: muted() }}>额度 </span>
            <span style={{ fg: base() }}>{collapsedQuota()}</span>
          </text>
        </Show>
        <Show when={collapsedSession()}>
          <text>
            <span style={{ fg: muted() }}>会话 </span>
            <span style={{ fg: base() }}>{collapsedSession()}</span>
          </text>
        </Show>
        <Show when={collapsedRange()}>
          {(line) => (
            <text>
              <span style={{ fg: muted() }}>{line().label} </span>
              <span style={{ fg: base() }}>{line().text}</span>
            </text>
          )}
        </Show>
      </Show>

      <Show when={!props.collapsed()}>
        <Show when={props.sections.has("go")}>
          <Show when={quotaHint()}>
            <text style={{ fg: faint() }}>{quotaHint()}</text>
          </Show>

          <For each={windows()}>
            {(window) => (
              <text>
                <span style={{ fg: muted() }}>{`${window.label} `}</span>
                <span style={{ fg: windowColor(window.percent, window.limited) }}>
                  {bar(window.percent, layout().bar)}
                </span>
                <span style={{ fg: base() }}>{`${String(Math.round(window.percent)).padStart(3)}%`}</span>
                <span style={{ fg: muted() }}>
                  {` 剩${String(Math.max(0, 100 - Math.round(window.percent))).padStart(3)}%`}
                </span>
                <span style={{ fg: faint() }}>{` ${countdown(window.resetsAt)}`}</span>
              </text>
            )}
          </For>

          <For each={budgets()}>
            {(budget) => (
              <text>
                <span style={{ fg: muted() }}>预算 </span>
                <span style={{ fg: base() }}>{usd(budget.spent)}</span>
                <span style={{ fg: muted() }}>{` / ${usd(budget.limit)}`}</span>
                <span style={{ fg: faint() }}>
                  {budget.resetsAt ? ` ${countdown(budget.resetsAt)}` : ""}
                </span>
              </text>
            )}
          </For>
        </Show>

        <Show when={props.sections.has("session")}>
          <text>
            <span style={{ fg: muted() }}>Token 本会话</span>
            <Show when={sessionDetail().steps > 0}>
              <span style={{ fg: faint() }}>{` ${sessionDetail().steps}步`}</span>
            </Show>
            <Show when={sessionDetail().elapsed}>
              {(elapsed) => (
                <span style={{ fg: faint() }}>{` ${duration(elapsed())}`}</span>
              )}
            </Show>
          </text>
          <Show when={sessionDetail().context}>
            {(contextInfo) => (
              <text>
                <span style={{ fg: muted() }}>ctx </span>
                <span style={{ fg: contextColor(contextInfo().percent) }}>
                  {contextLabel(contextInfo().used, contextInfo().limit)}
                </span>
                <span style={{ fg: faint() }}>
                  {` 剩 ${compact(contextInfo().limit - contextInfo().used)}`}
                </span>
              </text>
            )}
          </Show>
          <text>
            <span style={{ fg: muted() }}>in </span>
            <span style={{ fg: base() }}>{compact(sessionUsage().tokens.input)}</span>
            <span style={{ fg: muted() }}> out </span>
            <span style={{ fg: base() }}>{compact(sessionUsage().tokens.output)}</span>
          </text>
          <text>
            <span style={{ fg: muted() }}>cache </span>
            <span style={{ fg: base() }}>{compact(sessionUsage().tokens.cache.read)}</span>
            <Show when={sessionUsage().tokens.cache.write > 0}>
              <span style={{ fg: muted() }}>+</span>
              <span style={{ fg: base() }}>{compact(sessionUsage().tokens.cache.write)}</span>
            </Show>
            <Show when={cacheLabel(sessionUsage().tokens)}>
              <span style={{ fg: faint() }}>{` ${cacheLabel(sessionUsage().tokens)}`}</span>
            </Show>
            <Show when={sessionDetail().savings > 0.00005}>
              <span style={{ fg: faint() }}>{` 省${usd(sessionDetail().savings)}`}</span>
            </Show>
            <span style={{ fg: muted() }}> think </span>
            <span style={{ fg: base() }}>{compact(sessionUsage().tokens.reasoning)}</span>
          </text>
          <text>
            <span style={{ fg: muted() }}>总 </span>
            <span style={{ fg: base() }}>{compact(totalTokens(sessionUsage().tokens))}</span>
            <Show when={costLabel(sessionUsage())}>
              {(label) => <span style={{ fg: muted() }}>{` ${label()}`}</span>}
            </Show>
          </text>
          <Show when={props.showRate}>
            <text>
              <span style={{ fg: muted() }}>速率 </span>
              <span style={{ fg: rateColor() }}>{rateMain()}</span>
              <span style={{ fg: success() }}>{rateChart()}</span>
              <span style={{ fg: faint() }}>{rateSuffix()}</span>
            </text>
          </Show>
          <Show when={sessionCounters()}>
            <text style={{ fg: faint() }}>{sessionCounters()}</text>
          </Show>
        </Show>

        <Show
          when={
            props.sections.has("today") ||
            props.sections.has("week") ||
            props.sections.has("month")
          }
        >
          <text style={{ fg: muted() }}>Token 统计</text>
          <Show when={statsHint()}>
            <text style={{ fg: faint() }}>{statsHint()}</text>
          </Show>
          <For each={ranged()}>
            {(range) => (
              <text>
                <span style={{ fg: muted() }}>{range.label}</span>
                <span style={{ fg: base() }}>{` ${compact(totalTokens(range.stats?.tokens))}`}</span>
                <Show when={costLabel(statsCost(range.stats))}>
                  {(label) => <span style={{ fg: muted() }}>{` ${label()}`}</span>}
                </Show>
                <span style={{ fg: faint() }}>{` ${range.stats?.steps ?? 0}步`}</span>
                <Show when={(range.stats?.sessions ?? 0) > 0}>
                  <span style={{ fg: faint() }}>{` ${range.stats!.sessions}会话`}</span>
                </Show>
              </text>
            )}
          </For>
          <Show when={statsExtra()}>
            <text style={{ fg: faint() }}>{statsExtra()}</text>
          </Show>
          <Show when={toolsInfo()}>
            {(toolInfo) => (
              <text>
                <span style={{ fg: muted() }}>工具 </span>
                <span style={{ fg: base() }}>{toolInfo().totals.calls}</span>
                <Show when={toolInfo().totals.failed > 0}>
                  <span style={{ fg: danger() }}>{` 失败${toolInfo().totals.failed}`}</span>
                </Show>
                <Show when={toolInfo().top}>
                  {(top) => (
                    <span style={{ fg: faint() }}>
                      {` Top ${truncate(top(), layout().truncate)}`}
                    </span>
                  )}
                </Show>
                <span style={{ fg: faint() }}>{` ${toolInfo().range.label}`}</span>
              </text>
            )}
          </Show>
          <Show when={activity()}>
            {(activeInfo) => (
              <text>
                <span style={{ fg: muted() }}>近7日 </span>
                <span style={{ fg: base() }}>{activeInfo().chart}</span>
                <Show when={activeInfo().streak > 0}>
                  <span style={{ fg: faint() }}>{` 连续${activeInfo().streak}天`}</span>
                </Show>
              </text>
            )}
          </Show>
          <Show when={topModel()}>
            {(model) => (
              <text>
                <span style={{ fg: faint() }}>Top </span>
                <span style={{ fg: muted() }}>{truncate(model().name, layout().truncate)}</span>
                <span style={{ fg: faint() }}>{` ${model().steps}步`}</span>
              </text>
            )}
          </Show>
        </Show>
      </Show>
    </>
  )

  return (
    <box ref={(element) => { box = element }} flexDirection="column" marginTop={1}>
      {/* @opentui/solid re-runs function children in a render effect; the JSX types do not model it. */}
      {body as any}
    </box>
  )
}
