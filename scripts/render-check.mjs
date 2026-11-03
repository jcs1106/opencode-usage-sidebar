// Render smoke test. Runs the real panel through the OpenTUI test renderer.
// OpenCode loads plugin TSX through Bun with the browser condition, so this
// script mirrors that: `bun --conditions=browser scripts/render-check.mjs`.
import { createComponent, createSignal } from "solid-js"
import { testRender } from "@opentui/solid"
import { PluginContextProvider } from "@opencode/plugin/tui"
import { UsagePanel } from "../dist/panel.js"

const now = Date.now()
const failures = []
function check(label, condition) {
  if (!condition) failures.push(label)
}

const tokens = { input: 42000, output: 1200, reasoning: 300, cache: { read: 180000, write: 2000 } }
const message = {
  type: "assistant",
  model: { providerID: "opencode-go", id: "glm" },
  tokens,
  time: { created: now - 5000, streamed: now - 1000 },
}
const session = {
  id: "s1",
  tokens,
  cost: 0.02,
  time: { created: now - 600000, updated: now },
  model: { providerID: "opencode-go", id: "glm" },
}
const context = {
  theme: {
    text: {
      muted: "#808080",
      faint: "#606060",
      base: "#ffffff",
      feedback: {
        error: { base: "#ff5555" },
        warning: { base: "#ffb86c" },
        info: { base: "#8be9fd" },
        success: { base: "#50fa7b" },
      },
    },
  },
  data: {
    session: {
      family: () => ["s1"],
      get: () => session,
      status: () => "idle",
      message: { list: () => [message], get: () => message },
    },
  },
}

const [quota, setQuota] = createSignal({ data: null, loading: true })
const [stats, setStats] = createSignal({ ranges: [], loading: true })
const [version, setVersion] = createSignal(0)
const [collapsed, setCollapsed] = createSignal(false)
const models = new Map([
  [
    "opencode-go/glm",
    {
      cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }],
      limit: { context: 200000, output: 32000 },
      name: "GLM",
    },
  ],
])

const props = {
  sessionID: "s1",
  quota,
  stats,
  version,
  sections: new Set(["go", "session", "today", "week", "month"]),
  rates: () =>
    new Map([
      ["s1", { active: false, exact: 38.2, samples: [], peak: 82, ttft: 0.8, tools: 12, toolFailures: 1 }],
    ]),
  models: () => models,
  showRate: true,
  fontSize: "md",
  collapsed,
  onToggle: () => setCollapsed((value) => !value),
}

const node = () =>
  createComponent(PluginContextProvider, {
    value: context,
    get children() {
      return createComponent(UsagePanel, props)
    },
  })

const setup = await testRender(node, { width: 46, height: 24 })
try {
  await setup.renderOnce()
  const loading = setup.captureCharFrame()
  check("renders the header while loading", loading.includes("用量"))
  check("renders the session block while loading", loading.includes("本会话"))

  setQuota({
    data: {
      workspace: { id: "w", usageURL: "u" },
      go: {
        rolling: { percent: 42, limited: false, resetsAt: now + 3600000 },
        weekly: { percent: 18, limited: false, resetsAt: now + 86400000 },
        monthly: { percent: 9, limited: false, resetsAt: now + 86400000 },
      },
      budgets: [],
    },
    fetchedAt: now,
    loading: false,
  })
  setStats({
    ranges: [
      {
        key: "today",
        label: "今日",
        from: 0,
        stats: {
          tokens,
          cost: 0.5,
          steps: 42,
          sessions: 5,
          subagents: 2,
          prompts: 12,
          activeDays: 3,
          streak: 2,
          models: [
            { model: { providerID: "opencode-go", id: "glm" }, name: "GLM", steps: 30, tokens, cost: 0.4 },
          ],
          activity: [
            { date: "2026-10-27", steps: 3 },
            { date: "2026-10-28", steps: 8 },
            { date: "2026-10-29", steps: 5 },
            { date: "2026-10-30", steps: 12 },
            { date: "2026-10-31", steps: 9 },
            { date: "2026-11-01", steps: 15 },
            { date: "2026-11-02", steps: 6 },
          ],
          tools: { mode: "summary", totals: { calls: 42, succeeded: 40, failed: 2, unfinished: 0 } },
        },
      },
    ],
    loading: false,
  })
  setVersion(1)
  await setup.flush()
  await setup.renderOnce()

  const expanded = setup.captureCharFrame()
  for (const expected of ["5h", "ctx", "命中", "工具", "近7日", "Top GLM", "本会话"]) {
    check(`expanded view shows ${expected}`, expanded.includes(expected))
  }

  await setup.mockMouse.click(2, 1)
  await setup.flush()
  await setup.renderOnce()
  const collapsedFrame = setup.captureCharFrame()
  check("clicking the header collapses", collapsedFrame.includes("点击展开"))
  check("collapsed view shows quota", collapsedFrame.includes("5h 42%"))
  check("collapsed view hides the token block", !collapsedFrame.includes("本会话"))

  await setup.mockMouse.click(2, 1)
  await setup.flush()
  await setup.renderOnce()
  check("clicking again expands", setup.captureCharFrame().includes("本会话"))

  setCollapsed(false)
  await setup.flush()
  await setup.renderOnce()
} finally {
  await setup.dispose()
}

if (failures.length > 0) {
  console.error("render check failed:")
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log("render check ok")
