import { For, Show, createMemo, onMount } from "solid-js"
import type { Accessor } from "solid-js"
import { usePlugin } from "@opencode/plugin/tui"
import {
  bar,
  clock,
  compact,
  costLabel,
  countdown,
  sparkline,
  sumTokens,
  totalTokens,
  truncate,
  usd,
} from "./format"
import {
  estimateCost,
  MIN_RATE_TOKENS,
  modelKey,
  type ModelCost,
  type QuotaState,
  type RateState,
  type SessionStats,
  type StatsState,
  type TokenUsage,
} from "./data"

const GO_WINDOWS = [
  ["rolling", "5h"],
  ["weekly", "周"],
  ["monthly", "月"],
] as const

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
  prices: Accessor<Map<string, ModelCost[]>>
  showRate: boolean
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
  const info = () => theme().text.feedback.info.base

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
            const costs = props.prices().get(modelKey(message.model.providerID, message.model.id))
            if (!costs || costs.length === 0) continue
            estimated += estimateCost(message.tokens, costs)
            priced = true
          }
        }
        if (!priced) {
          const session = context.data.session.get(props.sessionID)
          const costs = session?.model
            ? props.prices().get(modelKey(session.model.providerID, session.model.id))
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
      const costs = props.prices().get(modelKey(providerID, modelID))
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

  const fallbackRate = createMemo(() => {
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

  const rateText = createMemo(() => {
    const current = rate()
    if (!current) return "—"
    if (current.active && current.live !== undefined) {
      const chart = sparkline(current.samples)
      return `~${current.live.toFixed(1)} tok/s${chart ? `  ${chart}` : ""}`
    }
    if (current.exact !== undefined) return `${current.exact.toFixed(1)} tok/s · 上一步`
    return "—"
  })

  const rateColor = () => {
    const current = rate()
    if (current?.active) return info()
    if (current?.exact !== undefined) return base()
    return faint()
  }

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
    if (percent >= 80) return theme().text.feedback.warning.base
    return theme().text.feedback.success.base
  }

  return (
    <box ref={(element) => { box = element }} flexDirection="column" marginTop={1}>
      <Show when={props.sections.has("go")}>
        <text>
          <span style={{ fg: muted() }}>用量 · 剩余</span>
          <span style={{ fg: faint() }}>
            {props.quota().fetchedAt ? `  ${clock(props.quota().fetchedAt)}` : ""}
          </span>
          <Show when={props.quota().error && props.quota().data}>
            <span style={{ fg: danger() }}> · 失败</span>
          </Show>
        </text>

        <Show when={quotaHint()}>
          <text style={{ fg: faint() }}>{quotaHint()}</text>
        </Show>

        <For each={windows()}>
          {(window) => (
            <text>
              <span style={{ fg: muted() }}>{`${window.label} `}</span>
              <span style={{ fg: windowColor(window.percent, window.limited) }}>
                {bar(window.percent)}
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
                {budget.resetsAt ? ` · ${countdown(budget.resetsAt)}` : ""}
              </span>
            </text>
          )}
        </For>
      </Show>

      <Show when={props.sections.has("session")}>
        <text style={{ fg: muted() }}>Token · 本会话</text>
        <text>
          <span style={{ fg: muted() }}>in </span>
          <span style={{ fg: base() }}>{compact(sessionUsage().tokens.input)}</span>
          <span style={{ fg: muted() }}> · out </span>
          <span style={{ fg: base() }}>{compact(sessionUsage().tokens.output)}</span>
        </text>
        <text>
          <span style={{ fg: muted() }}>cache </span>
          <span style={{ fg: base() }}>{compact(sessionUsage().tokens.cache.read)}</span>
          <Show when={sessionUsage().tokens.cache.write > 0}>
            <span style={{ fg: muted() }}>+</span>
            <span style={{ fg: base() }}>{compact(sessionUsage().tokens.cache.write)}</span>
          </Show>
          <span style={{ fg: muted() }}> · think </span>
          <span style={{ fg: base() }}>{compact(sessionUsage().tokens.reasoning)}</span>
        </text>
        <text>
          <span style={{ fg: muted() }}>总 </span>
          <span style={{ fg: base() }}>{compact(totalTokens(sessionUsage().tokens))}</span>
          <span style={{ fg: muted() }}>{` · ${costLabel(sessionUsage())}`}</span>
        </text>
        <Show when={props.showRate}>
          <text>
            <span style={{ fg: muted() }}>速率 </span>
            <span style={{ fg: rateColor() }}>{rateText()}</span>
          </text>
        </Show>
      </Show>

      <Show
        when={
          props.sections.has("today") ||
          props.sections.has("week") ||
          props.sections.has("month")
        }
      >
        <text style={{ fg: muted() }}>Token · 统计</text>
        <Show when={statsHint()}>
          <text style={{ fg: faint() }}>{statsHint()}</text>
        </Show>
        <For each={ranged()}>
          {(range) => (
            <text>
              <span style={{ fg: muted() }}>{range.label}</span>
              <span style={{ fg: base() }}>{` ${compact(totalTokens(range.stats?.tokens))}`}</span>
              <span style={{ fg: muted() }}>{` · ${costLabel(statsCost(range.stats))}`}</span>
              <span style={{ fg: faint() }}>{` · ${range.stats?.steps ?? 0}步`}</span>
            </text>
          )}
        </For>
        <Show when={topModel()}>
          {(model) => (
            <text>
              <span style={{ fg: faint() }}>Top </span>
              <span style={{ fg: muted() }}>{truncate(model().name, 22)}</span>
              <span style={{ fg: faint() }}>{` · ${model().steps}步`}</span>
            </text>
          )}
        </Show>
      </Show>
    </box>
  )
}
