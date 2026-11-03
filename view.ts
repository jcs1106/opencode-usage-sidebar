import type { QuotaState, RangeStats, RateState, TokenUsage } from "./data.js"
import { compact, totalTokens } from "./format.js"

const GO_WINDOWS = [
  ["rolling", "5h"],
  ["weekly", "周"],
  ["monthly", "月"],
] as const

/** One line of quota state for the collapsed panel. */
export function quotaOverview(quota: QuotaState): string {
  if (quota.unsupported) return "额度不可用"
  const go = quota.data?.go
  if (!go) {
    const budget = quota.data?.budgets.find((item) => item.limit > 0)
    if (budget) {
      return `预算 ${Math.round((budget.spent / budget.limit) * 100)}%`
    }
    if (quota.loading) return "读取中…"
    if (quota.error) return "读取失败"
    return "未登录 Console"
  }
  return GO_WINDOWS.map(([key, label]) => {
    const gap = /[A-Za-z0-9]$/.test(label) ? " " : ""
    return `${label}${gap}${Math.round(go[key].percent)}%`
  }).join(" ")
}

/** One line of session usage for the collapsed panel. */
export function sessionOverview(
  tokens: TokenUsage,
  cost: string,
  hit: string,
  rate?: RateState,
): string {
  const parts = [compact(totalTokens(tokens)), cost, hit].filter(Boolean)
  const speed =
    rate?.active && rate.live !== undefined
      ? `${Math.round(rate.live)}t/s`
      : rate?.exact !== undefined
        ? `${Math.round(rate.exact)}t/s`
        : ""
  if (speed) parts.push(speed)
  return parts.join(" ")
}

/** One line of range stats for the collapsed panel. */
export function rangeOverview(range: RangeStats | undefined, cost: string): string {
  if (!range?.stats) return ""
  const parts = [compact(totalTokens(range.stats.tokens)), cost, `${range.stats.steps ?? 0}步`].filter(Boolean)
  if ((range.stats.sessions ?? 0) > 0) parts.push(`${range.stats.sessions}会话`)
  return parts.join(" ")
}

/** Counters that only appear once something went wrong, so the panel stays quiet. */
export function counterLine(rate?: RateState): string {
  if (!rate) return ""
  const parts: string[] = []
  if ((rate.tools ?? 0) > 0) parts.push(`工具${rate.tools}`)
  const failed = (rate.toolFailures ?? 0) + (rate.failures ?? 0)
  if (failed > 0) parts.push(`失败${failed}`)
  if ((rate.retries ?? 0) > 0) parts.push(`重试${rate.retries}`)
  if ((rate.compactions ?? 0) > 0) parts.push(`压缩${rate.compactions}`)
  return parts.join(" ")
}
