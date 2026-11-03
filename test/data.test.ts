import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  errorText,
  estimateCost,
  estimateTokens,
  fetchModelCatalog,
  fetchQuota,
  fetchStats,
  modelKey,
  pickPrice,
  rangeStarts,
  RANGE_LABELS,
  MIN_RATE_TOKENS,
  type ModelCost,
} from "../dist/data.js"

describe("estimateTokens", () => {
  it("returns zero for empty text", () => {
    assert.equal(estimateTokens(""), 0)
  })

  it("uses ~4 chars per token for latin and ~1.5 for CJK", () => {
    assert.equal(estimateTokens("abcd"), 1)
    assert.equal(estimateTokens("a".repeat(400)), 100)
    assert.equal(estimateTokens("你好"), 2 / 1.5)
    assert.equal(estimateTokens("你好abcd"), 2 / 1.5 + 1)
  })
})

describe("modelKey", () => {
  it("joins provider and model ids", () => {
    assert.equal(modelKey("anthropic", "claude"), "anthropic/claude")
  })
})

describe("pickPrice", () => {
  const tiered: ModelCost[] = [
    { tier: { type: "context", size: 200_000 }, input: 1, output: 2, cache: { read: 0.1, write: 1 } },
    { tier: { type: "context", size: 1_000_000 }, input: 2, output: 3, cache: { read: 0.2, write: 2 } },
  ]

  it("returns undefined without prices", () => {
    assert.equal(pickPrice(undefined, 0), undefined)
    assert.equal(pickPrice([], 0), undefined)
  })

  it("picks the largest matching context tier", () => {
    assert.equal(pickPrice(tiered, 100_000)?.input, 1)
    assert.equal(pickPrice(tiered, 500_000)?.input, 1)
    assert.equal(pickPrice(tiered, 1_500_000)?.input, 2)
  })

  it("falls back to the first entry when nothing matches", () => {
    assert.equal(pickPrice(tiered, 0)?.input, 1)
    const untiered: ModelCost[] = [
      { input: 5, output: 6, cache: { read: 0, write: 0 } },
      { input: 7, output: 8, cache: { read: 0, write: 0 } },
    ]
    assert.equal(pickPrice(untiered, 10)?.input, 5)
  })
})

describe("estimateCost", () => {
  const prices: ModelCost[] = [
    { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
  ]

  it("returns zero when data is missing", () => {
    assert.equal(estimateCost(undefined, prices), 0)
    assert.equal(
      estimateCost({ input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, undefined),
      0,
    )
  })

  it("prices input, output+reasoning and cache buckets per million", () => {
    const cost = estimateCost(
      {
        input: 1_000_000,
        output: 500_000,
        reasoning: 100_000,
        cache: { read: 1_000_000, write: 1_000_000 },
      },
      prices,
    )
    assert.equal(Number(cost.toFixed(6)), Number((3 + 9 + 0.3 + 3.75).toFixed(6)))
  })
})

describe("rangeStarts", () => {
  it("starts today, week and month at local boundaries", () => {
    // 2024-05-15 is a Wednesday.
    const now = new Date(2024, 4, 15, 12, 34, 56).getTime()
    const starts = rangeStarts(now)
    assert.equal(starts.today, new Date(2024, 4, 15).getTime())
    assert.equal(starts.week, new Date(2024, 4, 13).getTime())
    assert.equal(starts.month, new Date(2024, 4, 1).getTime())
  })

  it("keeps Sunday in the week that started on Monday", () => {
    const sunday = new Date(2024, 4, 19, 23, 0, 0).getTime()
    assert.equal(rangeStarts(sunday).week, new Date(2024, 4, 13).getTime())
  })
})

describe("errorText", () => {
  it("unwraps errors and stringifies the rest", () => {
    assert.equal(errorText(new Error("boom")), "boom")
    assert.equal(errorText("boom"), "boom")
    assert.equal(errorText(42), "42")
  })
})

describe("fetchQuota", () => {
  it("reports unsupported clients instead of throwing", async () => {
    const state = await fetchQuota({}, { id: "loc" }, new AbortController().signal)
    assert.equal(state.unsupported, true)
    assert.equal(state.data, null)
    assert.equal(state.loading, false)
  })

  it("forwards location/signal and stamps freshness", async () => {
    const calls: any[] = []
    const payload = { workspace: { id: "w", usageURL: "u" }, budgets: [] }
    const client = {
      experimental: {
        usage: {
          limits: async (options: any, request: any) => {
            calls.push({ options, request })
            return { data: payload }
          },
        },
      },
    }
    const location = { id: "loc" }
    const signal = new AbortController().signal
    const state = await fetchQuota(client, location, signal)
    assert.deepEqual(state.data, payload as any)
    assert.equal(state.loading, false)
    assert.equal(typeof state.fetchedAt, "number")
    assert.equal(state.lastGoodAt, state.fetchedAt)
    assert.deepEqual(calls[0].options, { location })
    assert.equal(calls[0].request.signal, signal)
  })
})

describe("fetchStats", () => {
  it("reports unsupported clients instead of throwing", async () => {
    const state = await fetchStats({}, new AbortController().signal)
    assert.equal(state.unsupported, true)
    assert.deepEqual(state.ranges, [])
  })

  it("queries every range with the local timezone", async () => {
    const calls: any[] = []
    const client = {
      experimental: {
        session: {
          stats: async (options: any, request: any) => {
            calls.push({ options, request })
            return { tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 3, write: 4 } }, cost: 0.5, steps: 2, sessions: 1, models: [] }
          },
        },
      },
    }
    const now = new Date(2024, 4, 15, 12, 0, 0).getTime()
    const signal = new AbortController().signal
    const state = await fetchStats(client, signal, now)
    const starts = rangeStarts(now)
    assert.deepEqual(
      state.ranges.map((range) => range.key),
      RANGE_LABELS.map(([key]) => key),
    )
    assert.deepEqual(
      state.ranges.map((range) => range.label),
      RANGE_LABELS.map(([, label]) => label),
    )
    for (const range of state.ranges) {
      assert.equal(range.from, starts[range.key])
      assert.equal(range.stats?.steps, 2)
    }
    assert.equal(calls.length, 3)
    assert.equal(calls[0].options.tools, "summary")
    assert.equal(calls[0].options.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone)
    assert.equal(calls[0].request.signal, signal)
    assert.equal(state.loading, false)
  })

  it("passes the requested tool detail level", async () => {
    const calls: any[] = []
    const client = {
      experimental: {
        session: {
          stats: async (options: any) => {
            calls.push(options)
            return { tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0, steps: 0, sessions: 0, models: [] }
          },
        },
      },
    }
    await fetchStats(client, new AbortController().signal, Date.now(), "detail")
    assert.equal(calls[0].tools, "detail")
  })

  it("propagates abort errors", async () => {
    const client = {
      experimental: {
        session: {
          stats: async () => {
            throw new DOMException("aborted", "AbortError")
          },
        },
      },
    }
    await assert.rejects(fetchStats(client, new AbortController().signal), /aborted/)
  })
})

describe("fetchModelCatalog", () => {
  it("returns an empty map without a model client", async () => {
    const catalog = await fetchModelCatalog({}, { id: "loc" })
    assert.equal(catalog.size, 0)
  })

  it("keys by provider/model and keeps cost, limit and name", async () => {
    const calls: any[] = []
    const client = {
      model: {
        list: async (options: any) => {
          calls.push(options)
          return {
            data: [
              {
                providerID: "opencode-go",
                id: "glm",
                name: "GLM",
                cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }],
                limit: { context: 200_000, output: 32_000 },
              },
              { providerID: "missing-id" },
            ],
          }
        },
      },
    }
    const catalog = await fetchModelCatalog(client, { id: "loc" })
    assert.equal(catalog.size, 1)
    const entry = catalog.get("opencode-go/glm")
    assert.ok(entry)
    assert.equal(entry.name, "GLM")
    assert.equal(entry.limit?.context, 200_000)
    assert.equal(entry.cost[0].input, 1)
    assert.deepEqual(calls[0], { location: { id: "loc" } })
  })
})

describe("MIN_RATE_TOKENS", () => {
  it("guards against noisy short steps", () => {
    assert.equal(MIN_RATE_TOKENS, 20)
  })
})
