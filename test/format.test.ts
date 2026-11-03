import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  age,
  bar,
  cacheHitRate,
  cacheLabel,
  cacheSavings,
  clock,
  compact,
  contextLabel,
  contextPercent,
  costLabel,
  countdown,
  duration,
  isFontSize,
  layoutFor,
  sparkline,
  sparklineFixed,
  sumTokens,
  totalTokens,
  truncate,
  usd,
} from "../dist/format.js"

describe("compact", () => {
  it("keeps small numbers as integers", () => {
    assert.equal(compact(0), "0")
    assert.equal(compact(-10), "0")
    assert.equal(compact(Number.NaN), "0")
    assert.equal(compact(999), "999")
    assert.equal(compact(12.4), "12")
  })

  it("scales to K/M/B and trims trailing zeros", () => {
    assert.equal(compact(1_000), "1K")
    assert.equal(compact(1_500), "1.5K")
    assert.equal(compact(12_345), "12.3K")
    assert.equal(compact(123_456), "123K")
    assert.equal(compact(1_234_567), "1.23M")
    assert.equal(compact(2_000_000_000), "2B")
  })
})

describe("usd", () => {
  it("formats zero, tiny and normal values", () => {
    assert.equal(usd(0), "$0")
    assert.equal(usd(Number.NaN), "$0")
    assert.equal(usd(0.00001), "<$0.0001")
    assert.equal(usd(0.001), "$0.0010")
    assert.equal(usd(1.2345), "$1.23")
  })
})

describe("sparkline", () => {
  it("returns empty for no samples", () => {
    assert.equal(sparkline([]), "")
  })

  it("scales samples and keeps the last `width` values", () => {
    assert.equal(sparkline([1, 2, 3]), "▃▆█")
    assert.equal(sparkline([1, 2, 3, 4], 2), "▆█")
    assert.equal(sparkline([0, 0]), "▁▁")
  })
})

describe("sparklineFixed", () => {
  it("pads missing samples on the left with the lowest block", () => {
    assert.equal(sparklineFixed([1, 2, 3], 5), "▁▁▃▆█")
  })

  it("keeps a full width even without samples", () => {
    assert.equal(sparklineFixed([], 4), "▁▁▁▁")
  })

  it("trims to the requested width", () => {
    assert.equal(sparklineFixed([1, 2, 3, 4], 2), "▆█")
  })
})

describe("costLabel", () => {
  it("prefers real cost", () => {
    assert.equal(costLabel({ real: 1.5, providers: [] }), "$1.50")
  })

  it("shows only the estimate for Go subscription coverage", () => {
    assert.equal(costLabel({ real: 0, providers: ["opencode-go"] }), "")
    assert.equal(
      costLabel({ real: 0, providers: ["opencode-go"], estimated: 0.02 }),
      "$0.02",
    )
  })

  it("falls back to estimates and dashes", () => {
    assert.equal(costLabel({ real: 0, providers: ["anthropic"], estimated: 0.02 }), "$0.02")
    assert.equal(costLabel({ real: 0, providers: [] }), "—")
    assert.equal(costLabel({ real: 0, providers: ["opencode-go", "anthropic"] }), "—")
  })
})

describe("bar", () => {
  it("uses 8 cells by default and never hides a nonzero value", () => {
    assert.equal(bar(0), "░".repeat(8))
    assert.equal(bar(100), "█".repeat(8))
    assert.equal(bar(50), "█".repeat(4) + "░".repeat(4))
    assert.equal(bar(1), "█" + "░".repeat(7))
    assert.equal(bar(99), "█".repeat(7) + "░")
  })

  it("clamps out-of-range input", () => {
    assert.equal(bar(-5), "░".repeat(8))
    assert.equal(bar(250), "█".repeat(8))
  })
})

describe("countdown", () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0)

  it("rounds minutes up like the console", () => {
    assert.equal(countdown(now + 36 * 60_000 + 20_000, now), "37m")
    assert.equal(countdown(now + 60_000, now), "1m")
  })

  it("shows hours and days for longer windows", () => {
    assert.equal(countdown(now + 2 * 3_600_000, now), "2h0m")
    assert.equal(countdown(now + 26 * 3_600_000, now), "1d2h")
  })

  it("handles past and invalid timestamps", () => {
    assert.equal(countdown(now - 1, now), "即将重置")
    assert.equal(countdown(Number.NaN, now), "")
  })
})

describe("age", () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0)

  it("describes freshness", () => {
    assert.equal(age(undefined, now), "")
    assert.equal(age(now - 3_000, now), "刚刚")
    assert.equal(age(now - 30_000, now), "30s前")
    assert.equal(age(now - 5 * 60_000, now), "5m前")
    assert.equal(age(now - (3 * 3_600_000 + 5 * 60_000), now), "3h5m前")
  })

  it("never goes negative for future timestamps", () => {
    assert.equal(age(now + 60_000, now), "刚刚")
  })
})

describe("clock", () => {
  it("renders HH:MM and tolerates missing input", () => {
    assert.equal(clock(undefined), "")
    assert.match(clock(Date.UTC(2026, 0, 1, 9, 5, 0)), /^\d{2}:\d{2}$/)
  })
})

describe("cacheHitRate", () => {
  it("returns undefined without prompt tokens", () => {
    assert.equal(cacheHitRate(undefined), undefined)
    assert.equal(
      cacheHitRate({ input: 0, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }),
      undefined,
    )
  })

  it("measures reads against every input-side token", () => {
    assert.equal(
      cacheHitRate({ input: 300, output: 0, reasoning: 0, cache: { read: 700, write: 0 } }),
      70,
    )
    assert.equal(
      cacheHitRate({ input: 0, output: 0, reasoning: 0, cache: { read: 1_000, write: 0 } }),
      100,
    )
    assert.equal(
      cacheHitRate({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 1_000 } }),
      0,
    )
    assert.equal(
      cacheHitRate({ input: 0, output: 0, reasoning: 0, cache: { read: 500, write: 500 } }),
      50,
    )
  })

  it("rounds to whole percent", () => {
    assert.equal(
      cacheHitRate({ input: 1, output: 0, reasoning: 0, cache: { read: 2, write: 0 } }),
      67,
    )
  })
})

describe("cacheLabel", () => {
  it("formats a label, or nothing when there is no prompt data", () => {
    assert.equal(cacheLabel(undefined), "")
    assert.equal(
      cacheLabel({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }),
      "",
    )
    assert.equal(
      cacheLabel({ input: 300, output: 0, reasoning: 0, cache: { read: 700, write: 0 } }),
      "命中70%",
    )
  })
})

describe("context usage", () => {
  it("rounds and clamps the context window share", () => {
    assert.equal(contextPercent(42_000, 200_000), 21)
    assert.equal(contextPercent(250_000, 200_000), 100)
    assert.equal(contextPercent(0, 200_000), undefined)
    assert.equal(contextPercent(1_000, undefined), undefined)
    assert.equal(contextPercent(1_000, 0), undefined)
  })

  it("renders used/limit with a percentage", () => {
    assert.equal(contextLabel(42_000, 200_000), "42K/200K 21%")
    assert.equal(contextLabel(42_000, undefined), "")
  })
})

describe("cacheSavings", () => {
  const costs = [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }]
  const tokens = {
    input: 1_000,
    output: 0,
    reasoning: 0,
    cache: { read: 1_000_000, write: 0 },
  }

  it("values cache reads at the input price difference", () => {
    assert.equal(cacheSavings(tokens, costs), 2.7)
  })

  it("returns zero when nothing was saved or priced", () => {
    assert.equal(cacheSavings(undefined, costs), 0)
    assert.equal(cacheSavings(tokens, undefined), 0)
    assert.equal(
      cacheSavings({ ...tokens, cache: { read: 0, write: 1_000 } }, costs),
      0,
    )
  })
})

describe("duration", () => {
  it("scales from seconds to days", () => {
    assert.equal(duration(undefined), "")
    assert.equal(duration(0), "")
    assert.equal(duration(45_000), "45s")
    assert.equal(duration(12 * 60_000), "12m")
    assert.equal(duration(2 * 3_600_000 + 5 * 60_000), "2h5m")
    assert.equal(duration((3 * 24 + 2) * 3_600_000), "3d2h")
  })
})

describe("layoutFor", () => {
  it("scales bar, sparkline and truncation widths", () => {
    assert.deepEqual(layoutFor("sm"), { bar: 6, spark: 6, truncate: 16 })
    assert.deepEqual(layoutFor("md"), { bar: 8, spark: 8, truncate: 22 })
    assert.deepEqual(layoutFor("lg"), { bar: 10, spark: 12, truncate: 28 })
    assert.deepEqual(layoutFor(), layoutFor("md"))
  })

  it("validates the config value", () => {
    assert.equal(isFontSize("sm"), true)
    assert.equal(isFontSize("xl"), false)
    assert.equal(isFontSize(undefined), false)
  })
})

describe("token helpers", () => {
  const left = { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } }

  it("totals every bucket", () => {
    assert.equal(totalTokens(undefined), 0)
    assert.equal(totalTokens(left), 15)
  })

  it("sums tokens without mutating inputs", () => {
    const sum = sumTokens(left, left)
    assert.deepEqual(sum, { input: 2, output: 4, reasoning: 6, cache: { read: 8, write: 10 } })
    assert.equal(totalTokens(left), 15)
    assert.equal(sumTokens(left, undefined), left)
  })
})

describe("truncate", () => {
  it("keeps short text and ellipsizes long text", () => {
    assert.equal(truncate("abc", 3), "abc")
    assert.equal(truncate("abcdef", 4), "abc…")
    assert.equal(truncate("abcdef", 1), "a…")
  })
})
