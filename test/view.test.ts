import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { counterLine, quotaOverview, rangeOverview, sessionOverview } from "../dist/view.js"
import type { QuotaState, RangeStats, SessionStats } from "../dist/data.js"

const emptyTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

function quota(overrides: Partial<QuotaState> = {}): QuotaState {
  return { data: null, loading: false, ...overrides }
}

function range(overrides: Partial<SessionStats> = {}): RangeStats {
  return {
    key: "today",
    label: "今日",
    from: 0,
    stats: {
      tokens: { ...emptyTokens, input: 3_000_000, output: 400_000 },
      cost: 1.2,
      steps: 42,
      sessions: 5,
      models: [],
      ...overrides,
    },
  }
}

describe("quotaOverview", () => {
  it("describes unsupported, loading and signed-out states", () => {
    assert.equal(quotaOverview(quota({ unsupported: true })), "额度不可用")
    assert.equal(quotaOverview(quota({ loading: true })), "读取中…")
    assert.equal(quotaOverview(quota({ error: "boom" })), "读取失败")
  })

  it("falls back to a budget percentage", () => {
    const state = quota({
      data: {
        workspace: { id: "w", usageURL: "u" },
        budgets: [{ id: "b", limit: 100, spent: 50 }],
      },
    })
    assert.equal(quotaOverview(state), "预算 50%")
  })

  it("summarizes every Go window", () => {
    const meter = (percent: number) => ({ percent, limited: false, resetsAt: 0 })
    const state = quota({
      data: {
        workspace: { id: "w", usageURL: "u" },
        budgets: [],
        go: { rolling: meter(42.4), weekly: meter(18), monthly: meter(9) },
      },
    })
    assert.equal(quotaOverview(state), "5h 42% 周18% 月9%")
  })
})

describe("sessionOverview", () => {
  it("combines tokens, cost, cache and rate", () => {
    const tokens = { ...emptyTokens, input: 1_000, output: 200, cache: { read: 500, write: 0 } }
    assert.equal(
      sessionOverview(tokens, "$0.31", "命中87%", {
        active: true,
        live: 42.14,
        samples: [],
      }),
      "1.7K $0.31 命中87% 42t/s",
    )
  })

  it("prefers an exact rate once the step ends", () => {
    const tokens = { ...emptyTokens, input: 1_000 }
    assert.equal(
      sessionOverview(tokens, "", "", { active: false, exact: 38.24, samples: [] }),
      "1K 38t/s",
    )
  })

  it("omits missing pieces", () => {
    assert.equal(sessionOverview(emptyTokens, "—", ""), "0 —")
  })
})

describe("rangeOverview", () => {
  it("summarizes tokens, cost, steps and sessions", () => {
    assert.equal(rangeOverview(range(), "$1.20"), "3.4M $1.20 42步 5会话")
  })

  it("omits sessions when there are none and tolerates missing stats", () => {
    assert.equal(rangeOverview(range({ sessions: 0 }), "$1.20"), "3.4M $1.20 42步")
    assert.equal(rangeOverview(undefined, "$1.20"), "")
    assert.equal(rangeOverview({ key: "today", label: "今日", from: 0, stats: null }, "$1.20"), "")
  })
})

describe("counterLine", () => {
  it("stays empty until something happened", () => {
    assert.equal(counterLine(undefined), "")
    assert.equal(counterLine({ active: false, samples: [] }), "")
  })

  it("lists tools, failures, retries and compactions", () => {
    assert.equal(
      counterLine({
        active: false,
        samples: [],
        tools: 12,
        toolFailures: 1,
        failures: 2,
        retries: 3,
        compactions: 1,
      }),
      "工具12 失败3 重试3 压缩1",
    )
  })
})
