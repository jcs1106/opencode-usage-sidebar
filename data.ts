// Data layer for the usage sidebar.
//
// Sources (OpenCode v2.2.x):
//   GET /api/experimental/usage/limits         -> OpenCode Go windows + Console budgets
//   GET /api/experimental/session/stats        -> token/cost aggregates for a range
//
// The client is typed as `any` on purpose: these endpoints are experimental and
// their generated method locations changed between releases.

export type TokenUsage = {
  input: number
  output: number
  reasoning: number
  cache: {
    read: number
    write: number
  }
}

export type UsageMeter = {
  percent: number
  limited: boolean
  resetsAt: number
}

export type UsageBudget = {
  id: string
  limit: number
  spent: number
  resetsAt?: number
  scope?: string
  per?: string
}

export type UsageLimits = {
  workspace: {
    id: string
    name?: string
    usageURL: string
  }
  go?: {
    rolling: UsageMeter
    weekly: UsageMeter
    monthly: UsageMeter
  }
  budgets: UsageBudget[]
}

export type ModelUsage = {
  model: {
    id: string
    providerID: string
    variant?: string
  }
  name?: string
  steps: number
  tokens: TokenUsage
  cost: number
}

export type SessionStats = {
  tokens: TokenUsage
  cost: number
  steps: number
  sessions: number
  models: ModelUsage[]
}

export type RangeKey = "today" | "week" | "month"

export type RangeStats = {
  key: RangeKey
  label: string
  from: number
  stats: SessionStats | null
}

export type QuotaState = {
  data: UsageLimits | null
  fetchedAt?: number
  lastGoodAt?: number
  error?: string
  unsupported?: boolean
  loading: boolean
}

export type StatsState = {
  ranges: RangeStats[]
  fetchedAt?: number
  lastGoodAt?: number
  error?: string
  unsupported?: boolean
  loading: boolean
}

export type ModelCost = {
  tier?: {
    type: "context"
    size: number
  }
  input: number
  output: number
  cache: {
    read: number
    write: number
  }
}

export type RateState = {
  live?: number
  exact?: number
  active: boolean
  samples: number[]
  at?: number
}

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/

/** Steps below this output size produce noisy rates; keep the previous value instead. */
export const MIN_RATE_TOKENS = 20

/** Cheap character-based token estimate, used until a real step calibrates it. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  for (const char of text) if (CJK.test(char)) cjk += 1
  const rest = Math.max(0, text.length - cjk)
  return cjk / 1.5 + rest / 4
}

export function modelKey(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`
}

export function pickPrice(costs: readonly ModelCost[] | undefined, contextSize: number): ModelCost | undefined {
  if (!costs || costs.length === 0) return undefined
  let chosen: ModelCost | undefined
  for (const cost of costs) {
    if (!cost.tier) {
      chosen ??= cost
      continue
    }
    if (contextSize >= cost.tier.size) chosen = cost
  }
  return chosen ?? costs[0]
}

export function estimateCost(tokens: TokenUsage | undefined, costs: readonly ModelCost[] | undefined): number {
  if (!tokens) return 0
  const contextSize = tokens.input + tokens.cache.read + tokens.cache.write
  const price = pickPrice(costs, contextSize)
  if (!price) return 0
  return (
    (tokens.input * price.input +
      (tokens.output + tokens.reasoning) * price.output +
      tokens.cache.read * price.cache.read +
      tokens.cache.write * price.cache.write) /
    1_000_000
  )
}

export async function fetchModelPrices(
  client: any,
  location: unknown,
): Promise<Map<string, ModelCost[]>> {
  const prices = new Map<string, ModelCost[]>()
  const list = client?.model?.list
  if (!list) return prices
  const response = await list.call(client.model, { location })
  for (const model of response?.data ?? []) {
    if (!model?.providerID || !model?.id) continue
    prices.set(modelKey(model.providerID, model.id), model.cost ?? [])
  }
  return prices
}

export const RANGE_LABELS: ReadonlyArray<readonly [RangeKey, string]> = [
  ["today", "今日"],
  ["week", "本周"],
  ["month", "本月"],
]

export function rangeStarts(now = Date.now()): Record<RangeKey, number> {
  const date = new Date(now)
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const mondayOffset = (date.getDay() + 6) % 7
  const startOfWeek = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() - mondayOffset,
  ).getTime()
  const startOfMonth = new Date(date.getFullYear(), date.getMonth(), 1).getTime()
  return { today: startOfDay, week: startOfWeek, month: startOfMonth }
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export async function fetchQuota(
  client: any,
  location: unknown,
  signal: AbortSignal,
): Promise<QuotaState> {
  const usage = client?.experimental?.usage
  if (!usage?.limits) {
    return { data: null, unsupported: true, loading: false }
  }

  const response = await usage.limits({ location }, { signal })
  const now = Date.now()
  return {
    data: (response?.data ?? null) as UsageLimits | null,
    fetchedAt: now,
    lastGoodAt: now,
    loading: false,
  }
}

export async function fetchStats(
  client: any,
  signal: AbortSignal,
  now = Date.now(),
): Promise<StatsState> {
  const session = client?.experimental?.session
  if (!session?.stats) {
    return { ranges: [], unsupported: true, loading: false }
  }

  const starts = rangeStarts(now)
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const ranges = await Promise.all(
    RANGE_LABELS.map(async ([key, label]) => {
      const stats = (await session.stats(
        { from: starts[key], to: now, timezone, tools: "none" },
        { signal },
      )) as SessionStats
      return { key, label, from: starts[key], stats } satisfies RangeStats
    }),
  )

  return {
    ranges,
    fetchedAt: now,
    lastGoodAt: now,
    loading: false,
  }
}
