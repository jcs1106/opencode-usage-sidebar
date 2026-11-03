import { createComponent, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { testRender } from "@opentui/solid"
import { PluginContextProvider } from "@opencode/plugin/tui"
import plugin from "./tui.tsx"

const now = Date.now()
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
const listeners = new Map()
const slots = []
const layers = []
const toasts = []

const ctx = {
  options: {},
  client: {},
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
  storage: {
    store: (_key, settings) => {
      const [state, setState] = createStore(settings.initial)
      return [state, async (mutation) => setState(mutation)]
    },
  },
  data: {
    location: { default: () => ({ directory: "/tmp" }) },
    on: (name, listener) => {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
    session: {
      family: () => ["s1"],
      get: () => session,
      status: () => "idle",
      message: { list: () => [message], get: () => message },
    },
  },
  keymap: {
    layer: (factory) => {
      layers.push(factory())
      return () => {}
    },
    shortcuts: () => [],
  },
  ui: {
    slot: (claim) => {
      slots.push(claim)
      return () => {}
    },
    toast: { show: (toast) => toasts.push(toast) },
  },
}

console.log("setup start")
const cleanup = await plugin.setup(ctx)
console.log("setup done", { slots: slots.length, layers: layers.length })

const node = () =>
  createComponent(PluginContextProvider, {
    value: ctx,
    get children() {
      return slots[0].render({ sessionID: "s1" })
    },
  })

const setup = await testRender(node, { width: 46, height: 24 })
try {
  await setup.renderOnce()
  const frame = setup.captureCharFrame()
  console.log("frame-length", frame.trim().length)
  console.log(frame)
} finally {
  await setup.dispose()
  cleanup?.()
}
