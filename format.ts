import type { ModelCost, TokenUsage } from "./data.js"
import { pickPrice } from "./data.js"

/** 1234 -> 1.2K, 1234567 -> 1.23M */
export function compact(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0"
  const units: ReadonlyArray<readonly [number, string]> = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ]
  for (const [base, suffix] of units) {
    if (value >= base) {
      const scaled = value / base
      const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2
      return `${trimZeros(scaled.toFixed(digits))}${suffix}`
    }
  }
  return String(Math.round(value))
}

function trimZeros(text: string): string {
  return text.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1")
}

export function usd(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "$0"
  if (value < 0.0001) return "<$0.0001"
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

const SPARK_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]

/** Tiny inline chart for the last N rate samples. */
export function sparkline(values: readonly number[], width = 8): string {
  if (values.length === 0) return ""
  const slice = values.slice(-width)
  const max = Math.max(...slice, 1)
  return slice
    .map((value) => {
      const index = Math.min(7, Math.max(0, Math.round((value / max) * 7)))
      return SPARK_BLOCKS[index]
    })
    .join("")
}

/** Same chart, but always exactly `width` cells so surrounding columns never shift. */
export function sparklineFixed(values: readonly number[], width = 8): string {
  const chart = sparkline(values, width)
  if (chart.length >= width) return chart.slice(-width)
  return SPARK_BLOCKS[0].repeat(width - chart.length) + chart
}

export function costLabel(input: {
  real: number
  estimated?: number
  providers: readonly string[]
}): string {
  if (input.real > 0) return usd(input.real)
  const estimate = input.estimated !== undefined && input.estimated > 0 ? usd(input.estimated) : undefined
  const covered =
    input.providers.length > 0 && input.providers.every((provider) => provider === "opencode-go")
  if (covered) return estimate ?? ""
  if (estimate) return estimate
  return "—"
}

/** 8 cells by default, filled blocks are whole characters. */
export function bar(percent: number, width = 8): string {
  const clamped = Math.max(0, Math.min(100, percent))
  let filled = Math.round((clamped / 100) * width)
  if (clamped > 0 && filled === 0) filled = 1
  if (clamped < 100 && filled === width) filled = width - 1
  return "█".repeat(filled) + "░".repeat(width - filled)
}

export function countdown(at: number, now = Date.now()): string {
  if (!Number.isFinite(at)) return ""
  const diff = at - now
  if (diff <= 0) return "即将重置"
  // Round up like the console: "Resets in 0h 37m" for 36m20s left.
  const minutes = Math.ceil(diff / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d${hours % 24}h`
  if (hours > 0) return `${hours}h${minutes % 60}m`
  return `${Math.max(1, minutes)}m`
}

/** Age of a snapshot, for data-freshness labels; includes the trailing 前. */
export function age(at?: number, now = Date.now()): string {
  if (!at) return ""
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 5) return "刚刚"
  if (seconds < 60) return `${seconds}s前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m前`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${minutes % 60}m前`
}

export function clock(at?: number): string {
  if (!at) return ""
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
}

export function totalTokens(tokens?: TokenUsage): number {
  if (!tokens) return 0
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

export function sumTokens(left: TokenUsage, right?: TokenUsage): TokenUsage {
  if (!right) return left
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cache: {
      read: left.cache.read + right.cache.read,
      write: left.cache.write + right.cache.write,
    },
  }
}

/**
 * Share of prompt tokens served from cache (0-100).
 * The denominator is every input-side token: uncached input + cache reads + cache writes.
 */
export function cacheHitRate(tokens?: TokenUsage): number | undefined {
  if (!tokens) return undefined
  const prompt = tokens.input + tokens.cache.read + tokens.cache.write
  if (!Number.isFinite(prompt) || prompt <= 0) return undefined
  const rate = (tokens.cache.read / prompt) * 100
  return Math.min(100, Math.max(0, Math.round(rate)))
}

/** Label for the prompt cache hit rate, empty when there is no prompt data. */
export function cacheLabel(tokens?: TokenUsage): string {
  const rate = cacheHitRate(tokens)
  return rate === undefined ? "" : `命中${rate}%`
}

/** Share of the model's context window that the last prompt occupied. */
export function contextPercent(used?: number, limit?: number): number | undefined {
  if (!used || !limit || !Number.isFinite(limit) || limit <= 0) return undefined
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)))
}

/** `42K/200K 21%`, or "" when the limit is unknown. */
export function contextLabel(used?: number, limit?: number): string {
  const percent = contextPercent(used, limit)
  if (percent === undefined) return ""
  return `${compact(used ?? 0)}/${compact(limit ?? 0)} ${percent}%`
}

/**
 * Notional saving from prompt caching: the extra input price that cache reads avoided.
 * Reflects list prices, so it is informational only on subscription plans.
 */
export function cacheSavings(
  tokens: TokenUsage | undefined,
  costs: readonly ModelCost[] | undefined,
): number {
  if (!tokens || !costs || costs.length === 0) return 0
  const prompt = tokens.input + tokens.cache.read + tokens.cache.write
  const price = pickPrice(costs, prompt)
  if (!price) return 0
  const saved = (tokens.cache.read * (price.input - price.cache.read)) / 1_000_000
  return Number.isFinite(saved) && saved > 0 ? saved : 0
}

/** Elapsed time as `45s`, `12m`, `2h5m` or `3d2h`. */
export function duration(ms?: number): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return ""
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${Math.max(1, seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d${hours % 24}h`
}

export type FontSize = "sm" | "md" | "lg"

export type Layout = {
  /** Cells in the quota bar. */
  bar: number
  /** Points in the rate sparkline. */
  spark: number
  /** Max label width before truncation. */
  truncate: number
}

/** Terminal cells cannot change glyph size, so this scales the width budget instead. */
export function layoutFor(size: FontSize = "md"): Layout {
  if (size === "sm") return { bar: 6, spark: 6, truncate: 16 }
  if (size === "lg") return { bar: 10, spark: 12, truncate: 28 }
  return { bar: 8, spark: 8, truncate: 22 }
}

export function isFontSize(value: unknown): value is FontSize {
  return value === "sm" || value === "md" || value === "lg"
}

export function truncate(text: string, width: number): string {
  if (text.length <= width) return text
  return `${text.slice(0, Math.max(1, width - 1))}…`
}
