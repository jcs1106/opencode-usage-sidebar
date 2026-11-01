import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { UsagePanel } from "./panel"
import {
  errorText,
  estimateTokens,
  fetchModelPrices,
  fetchQuota,
  fetchStats,
  modelKey,
  MIN_RATE_TOKENS,
  type ModelCost,
  type QuotaState,
  type RateState,
  type StatsState,
} from "./data"

const DEFAULT_SECTIONS = ["go", "session", "today", "week", "month"]
const DEFAULT_REFRESH_MS = 60_000
const STATS_DEBOUNCE_MS = 5_000
const RATE_TICK_MS = 250

type InternalRate = {
  sessionID: string
  messageID?: string
  model?: string
  startedAt?: number
  active: boolean
  window: Array<{ at: number; tokens: number }>
  stepChars: number
  live?: number
  exact?: number
  samples: number[]
  at?: number
  loggedLive?: boolean
}

function debugLogger(): (message: string) => void {
  const path = join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "opencode",
    "usage-sidebar.log",
  )
  return (message: string) => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, `${new Date().toISOString()} ${message}\n`)
    } catch {
      // debugging must never break the panel
    }
  }
}

function clampRefresh(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_REFRESH_MS
  return Math.min(30 * 60_000, Math.max(15_000, Math.round(value)))
}

function clampWindow(value: number): number {
  if (!Number.isFinite(value)) return 4000
  return Math.min(15_000, Math.max(1000, Math.round(value)))
}

export default Plugin.define({
  id: "usage-sidebar",

  setup(context) {
    const options = context.options ?? {}
    const log = options.debug === true ? debugLogger() : undefined
    const refreshMs = clampRefresh(Number(options.refreshMs ?? DEFAULT_REFRESH_MS))
    const rateWindowMs = clampWindow(Number(options.rateWindowMs ?? 4000))
    const rateIncludeTools = options.rateIncludeTools !== false
    const showRate = options.showRate !== false
    const sections = new Set<string>(
      Array.isArray(options.sections) ? options.sections.map(String) : DEFAULT_SECTIONS,
    )

    const [quota, setQuota] = createSignal<QuotaState>({ data: null, loading: true })
    const [stats, setStats] = createSignal<StatsState>({ ranges: [], loading: true })
    const [version, setVersion] = createSignal(0)
    const [rates, setRates] = createSignal<Map<string, RateState>>(new Map())
    const [prices, setPrices] = createSignal<Map<string, ModelCost[]>>(new Map())

    const location = context.location ?? context.data.location.default()
    const rateEntries = new Map<string, InternalRate>()
    const charsPerToken = new Map<string, number>()

    let disposed = false
    let interval: ReturnType<typeof setInterval> | undefined
    let rateTimer: ReturnType<typeof setInterval> | undefined
    let statsTimer: ReturnType<typeof setTimeout> | undefined
    let statsScheduled = false
    let quotaController: AbortController | undefined
    let statsController: AbortController | undefined
    let ratesDirty = false

    const bump = () => {
      if (!disposed) setVersion((value) => value + 1)
    }

    const ensureRate = (sessionID: string): InternalRate => {
      const existing = rateEntries.get(sessionID)
      if (existing) return existing
      if (rateEntries.size >= 32) {
        for (const [id, entry] of rateEntries) {
          if (!entry.active) {
            rateEntries.delete(id)
            break
          }
        }
      }
      const entry: InternalRate = {
        sessionID,
        active: false,
        window: [],
        stepChars: 0,
        samples: [],
      }
      rateEntries.set(sessionID, entry)
      return entry
    }

    const trimWindow = (entry: InternalRate, now: number) => {
      const cutoff = now - rateWindowMs
      while (entry.window.length > 0 && entry.window[0].at < cutoff) entry.window.shift()
    }

    const liveRate = (entry: InternalRate, now: number): number | undefined => {
      trimWindow(entry, now)
      if (entry.window.length === 0) return undefined
      const tokens = entry.window.reduce((sum, sample) => sum + sample.tokens, 0)
      const span = Math.max(500, now - entry.window[0].at)
      return tokens / (span / 1000)
    }

    const publishRates = (force = false) => {
      if (!force && !ratesDirty) return
      ratesDirty = false
      const next = new Map<string, RateState>()
      for (const [sessionID, entry] of rateEntries) {
        if (!entry.active && entry.exact === undefined) continue
        next.set(sessionID, {
          live: entry.live,
          exact: entry.exact,
          active: entry.active,
          samples: entry.samples.slice(-8),
          at: entry.at,
        })
      }
      setRates(next)
    }

    const pushDelta = (sessionID: string, delta: string) => {
      if (!delta) return
      const entry = ensureRate(sessionID)
      const ratio = entry.model ? charsPerToken.get(entry.model) : undefined
      const tokens = ratio ? delta.length / ratio : estimateTokens(delta)
      entry.stepChars += delta.length
      entry.window.push({ at: Date.now(), tokens })
      if (entry.window.length > 800) entry.window.splice(0, entry.window.length - 800)
      entry.active = true
      entry.at = Date.now()
      entry.live = liveRate(entry, entry.at)
      if (!entry.loggedLive && entry.live !== undefined) {
        entry.loggedLive = true
        log?.(`rate live ${sessionID} ${entry.live.toFixed(1)} tok/s`)
      }
      ratesDirty = true
    }

    const finishRate = (sessionID: string) => {
      const entry = rateEntries.get(sessionID)
      if (!entry) return
      entry.active = false
      entry.live = undefined
      entry.window = []
      entry.samples = []
      entry.at = Date.now()
      ratesDirty = true
    }

    const refreshQuota = async () => {
      quotaController?.abort()
      const controller = new AbortController()
      quotaController = controller
      try {
        const next = await fetchQuota(context.client, location, controller.signal)
        if (!disposed) setQuota(next)
        const go = next.data?.go
        log?.(
          go
            ? `quota ok 5h=${go.rolling.percent}% week=${go.weekly.percent}% month=${go.monthly.percent}% budgets=${next.data?.budgets.length ?? 0}`
            : `quota ok data=${next.data ? "yes" : "no"} unsupported=${next.unsupported ?? false}`,
        )
      } catch (error) {
        if (disposed || controller.signal.aborted) return
        log?.(`quota error ${errorText(error)}`)
        setQuota((previous) => ({
          ...previous,
          loading: false,
          fetchedAt: Date.now(),
          error: errorText(error),
        }))
      }
    }

    const refreshStats = async () => {
      statsController?.abort()
      const controller = new AbortController()
      statsController = controller
      setStats((previous) => ({ ...previous, loading: true }))
      try {
        const next = await fetchStats(context.client, controller.signal)
        if (!disposed) setStats(next)
        const today = next.ranges.find((range) => range.key === "today")?.stats
        log?.(
          today
            ? `stats ok ranges=${next.ranges.length} today.in=${today.tokens.input} today.out=${today.tokens.output} today.cache=${today.tokens.cache.read} steps=${today.steps}`
            : `stats ok ranges=${next.ranges.length} unsupported=${next.unsupported ?? false}`,
        )
      } catch (error) {
        if (disposed || controller.signal.aborted) return
        log?.(`stats error ${errorText(error)}`)
        setStats((previous) => ({
          ...previous,
          loading: false,
          fetchedAt: Date.now(),
          error: errorText(error),
        }))
      }
    }

    const refreshAll = async () => {
      await Promise.all([refreshQuota(), refreshStats()])
    }

    const loadPrices = async () => {
      try {
        const next = await fetchModelPrices(context.client, location)
        if (!disposed) setPrices(next)
        log?.(`prices loaded=${next.size}`)
      } catch (error) {
        log?.(`prices error ${errorText(error)}`)
      }
    }

    const scheduleStats = () => {
      if (disposed || statsScheduled) return
      statsScheduled = true
      statsTimer = setTimeout(() => {
        statsScheduled = false
        statsTimer = undefined
        if (!disposed) void refreshStats()
      }, STATS_DEBOUNCE_MS)
    }

    void refreshAll()
    void loadPrices()

    interval = setInterval(() => {
      if (!disposed) void refreshAll()
    }, refreshMs)

    rateTimer = setInterval(() => {
      if (disposed) return
      const now = Date.now()
      let active = false
      for (const entry of rateEntries.values()) {
        if (!entry.active) continue
        active = true
        entry.live = liveRate(entry, now)
        if (entry.live !== undefined) {
          entry.samples.push(entry.live)
          if (entry.samples.length > 8) entry.samples.shift()
        }
        entry.at = now
      }
      if (active) {
        ratesDirty = true
        publishRates()
      }
    }, RATE_TICK_MS)

    const offUsage = context.data.on("session.usage.updated", () => {
      bump()
      scheduleStats()
    })
    const offSucceeded = context.data.on("session.execution.succeeded", (event) => {
      finishRate(event.data.sessionID)
      publishRates(true)
      bump()
      scheduleStats()
    })
    const offFailed = context.data.on("session.execution.failed", (event) => {
      finishRate(event.data.sessionID)
      publishRates(true)
      bump()
    })
    const offInterrupted = context.data.on("session.execution.interrupted", (event) => {
      finishRate(event.data.sessionID)
      publishRates(true)
      bump()
    })
    const offIdle = context.data.on("session.idle", (event) => {
      finishRate(event.data.sessionID)
      publishRates(true)
      bump()
      void refreshStats()
    })
    const offCredential = context.data.on("credential.updated", () => {
      void refreshQuota()
      void loadPrices()
    })
    const offSwitched = context.data.on("credential.switched", () => {
      void refreshQuota()
      void loadPrices()
    })
    const offModel = context.data.on("model.updated", () => {
      void loadPrices()
    })

    const offStepStarted = context.data.on("session.step.started", (event) => {
      const entry = ensureRate(event.data.sessionID)
      entry.messageID = event.data.assistantMessageID
      entry.model = event.data.model
        ? modelKey(event.data.model.providerID, event.data.model.id)
        : entry.model
      entry.startedAt = event.data.started ?? Date.now()
      entry.active = true
      entry.live = undefined
      entry.window = []
      entry.stepChars = 0
      entry.samples = []
      entry.at = Date.now()
      entry.loggedLive = false
      ratesDirty = true
      publishRates(true)
      log?.(`rate step start ${event.data.sessionID} ${entry.model ?? "?"}`)
    })

    const offStepEnded = context.data.on("session.step.ended", (event) => {
      const { sessionID, assistantMessageID, tokens } = event.data
      const entry = ensureRate(sessionID)
      const exactTokens = (tokens?.output ?? 0) + (tokens?.reasoning ?? 0)
      const message = context.data.session.message.get(sessionID, assistantMessageID) as any
      const streamed = message?.time?.streamed as number | undefined
      const created = message?.time?.created as number | undefined
      const durationMs =
        streamed && created
          ? streamed - created
          : entry.startedAt
            ? event.created - entry.startedAt
            : 0
      if (exactTokens >= MIN_RATE_TOKENS && durationMs > 0) {
        entry.exact = exactTokens / (durationMs / 1000)
        if (rateIncludeTools && entry.stepChars > 0 && entry.model) {
          const ratio = entry.stepChars / exactTokens
          if (Number.isFinite(ratio) && ratio >= 0.5 && ratio <= 12) {
            const previous = charsPerToken.get(entry.model)
            charsPerToken.set(entry.model, previous === undefined ? ratio : previous * 0.6 + ratio * 0.4)
          }
        }
      }
      entry.active = false
      entry.live = undefined
      entry.window = []
      entry.samples = []
      entry.at = Date.now()
      ratesDirty = true
      publishRates(true)
      log?.(
        `rate step end ${sessionID} exact=${entry.exact?.toFixed(1) ?? "?"} chars=${entry.stepChars} tokens=${exactTokens} ms=${durationMs}`,
      )
      bump()
    })

    const offText = context.data.on("session.text.delta", (event) => {
      pushDelta(event.data.sessionID, event.data.delta)
    })
    const offReasoning = context.data.on("session.reasoning.delta", (event) => {
      pushDelta(event.data.sessionID, event.data.delta)
    })
    const offToolInput = rateIncludeTools
      ? context.data.on("session.tool.input.delta", (event) => {
          pushDelta(event.data.sessionID, event.data.delta)
        })
      : undefined

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "usage-sidebar.refresh",
          title: "刷新用量统计",
          description: "刷新侧边栏的额度与 token 用量",
          group: "Usage",
          palette: true,
          slash: { name: "usage-stats" },
          run: async () => {
            await refreshAll()
            const go = quota().data?.go
            const summary = go
              ? [`5h ${Math.round(go.rolling.percent)}%`, `周 ${Math.round(go.weekly.percent)}%`, `月 ${Math.round(go.monthly.percent)}%`]
              : []
            context.ui.toast.show({
              message: summary.length > 0 ? `已刷新 · ${summary.join(" · ")}` : "已刷新用量",
              variant: "success",
            })
          },
        },
      ],
    }))

    const unregisterSlot = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => (
        <UsagePanel
          sessionID={sessionID}
          quota={quota}
          stats={stats}
          version={version}
          sections={sections}
          rates={rates}
          prices={prices}
          showRate={showRate}
          log={log}
        />
      ),
    })
    log?.("setup complete, slot registered")

    return () => {
      log?.("disposed")
      disposed = true
      if (interval) clearInterval(interval)
      if (rateTimer) clearInterval(rateTimer)
      if (statsTimer) clearTimeout(statsTimer)
      quotaController?.abort()
      statsController?.abort()
      offUsage()
      offSucceeded()
      offFailed()
      offInterrupted()
      offIdle()
      offCredential()
      offSwitched()
      offModel()
      offStepStarted()
      offStepEnded()
      offText()
      offReasoning()
      offToolInput?.()
      unregisterSlot()
    }
  },
})
