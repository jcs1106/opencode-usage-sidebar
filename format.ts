import type { TokenUsage } from "./data"

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

export function costLabel(input: {
  real: number
  estimated?: number
  providers: readonly string[]
}): string {
  if (input.real > 0) return usd(input.real)
  const covered =
    input.providers.length > 0 && input.providers.every((provider) => provider === "opencode-go")
  const estimate = input.estimated !== undefined && input.estimated > 0 ? `≈${usd(input.estimated)}` : undefined
  if (covered) return estimate ? `套餐内 · ${estimate}` : "套餐内"
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
  const minutes = Math.floor(diff / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d${hours % 24}h`
  if (hours > 0) return `${hours}h${minutes % 60}m`
  return `${Math.max(1, minutes)}m`
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

export function truncate(text: string, width: number): string {
  if (text.length <= width) return text
  return `${text.slice(0, Math.max(1, width - 1))}…`
}
