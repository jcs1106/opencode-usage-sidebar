import assert from "node:assert/strict"
import { describe, it } from "node:test"
import plugin from "../dist/tui.js"

type Listener = (event: any) => void

type Stub = ReturnType<typeof makeContext>

function makeContext(options: Record<string, unknown> = {}, withLocation = true) {
  const listeners = new Map<string, Set<Listener>>()
  const registrations: string[] = []
  const unsubscribed: string[] = []
  const slots: any[] = []
  const layers: any[] = []
  const toasts: any[] = []
  const state = { defaultLocationCalls: 0 }
  let view: { collapsed: boolean } = { collapsed: false }

  const context: any = {
    options,
    client: {},
    storage: {
      store: (_key: string, settings: { initial: Record<string, unknown> }) => {
        const draft = { ...settings.initial } as { collapsed: boolean }
        view = draft
        return [
          draft,
          async (mutation: (value: any) => void) => {
            mutation(draft)
          },
        ] as const
      },
    },
    data: {
      location: {
        default: () => {
          state.defaultLocationCalls += 1
          return { id: "default-location" }
        },
      },
      on: (name: string, listener: Listener) => {
        registrations.push(name)
        const set = listeners.get(name) ?? new Set<Listener>()
        set.add(listener)
        listeners.set(name, set)
        return () => {
          unsubscribed.push(name)
          set.delete(listener)
          if (set.size === 0) listeners.delete(name)
        }
      },
      session: { message: { get: () => undefined } },
    },
    keymap: {
      layer: (factory: () => unknown) => {
        layers.push(factory())
        return () => {}
      },
    },
    ui: {
      slot: (claim: unknown) => {
        slots.push(claim)
        return () => {}
      },
      toast: { show: (toast: unknown) => toasts.push(toast) },
    },
  }
  if (withLocation) context.location = { id: "location" }

  const emit = (name: string, data: Record<string, unknown> = {}) => {
    for (const listener of listeners.get(name) ?? []) listener({ data, created: Date.now() })
  }

  return {
    context,
    listeners,
    registrations,
    unsubscribed,
    slots,
    layers,
    toasts,
    state,
    emit,
    view: () => view,
  }
}

async function setup(stub: Stub) {
  const cleanup = await plugin.setup(stub.context)
  assert.equal(typeof cleanup, "function")
  return cleanup as unknown as () => void
}

describe("plugin definition", () => {
  it("exposes the id OpenCode registers", () => {
    assert.equal(plugin.id, "usage-sidebar")
    assert.equal(typeof plugin.setup, "function")
  })
})

describe("plugin setup", () => {
  it("registers the sidebar slot and the refresh command", async () => {
    const stub = makeContext()
    const cleanup = await setup(stub)
    try {
      assert.equal(stub.slots.length, 1)
      assert.equal(stub.slots[0].append, "sidebar.content")
      assert.equal(typeof stub.slots[0].render, "function")

      assert.equal(stub.layers.length, 1)
      const command = stub.layers[0].commands[0]
      assert.equal(command.id, "usage-sidebar.refresh")
      assert.equal(command.slash.name, "usage-stats")

      await command.run()
      assert.equal(stub.toasts.length, 1)
      assert.equal(stub.toasts[0].message, "已刷新用量")
      assert.equal(stub.toasts[0].variant, "success")
    } finally {
      cleanup()
    }
  })

  it("toggles the collapsed view through durable storage", async () => {
    const stub = makeContext()
    const cleanup = await setup(stub)
    try {
      const toggle = stub.layers[0].commands.find(
        (command: any) => command.id === "usage-sidebar.toggle",
      )
      assert.ok(toggle)
      assert.equal(toggle.slash.name, "usage-toggle")
      assert.equal(toggle.palette, true)
      assert.equal(toggle.bind, false)

      assert.equal(stub.view().collapsed, false)
      await toggle.run()
      assert.equal(stub.view().collapsed, true)
      await toggle.run()
      assert.equal(stub.view().collapsed, false)
    } finally {
      cleanup()
    }
  })

  it("starts collapsed when configured", async () => {
    const stub = makeContext({ collapsed: true })
    const cleanup = await setup(stub)
    try {
      assert.equal(stub.view().collapsed, true)
    } finally {
      cleanup()
    }
  })

  it("subscribes to the session events it needs", async () => {
    const stub = makeContext()
    const cleanup = await setup(stub)
    try {
      assert.deepEqual(stub.registrations.slice().sort(), [
        "credential.switched",
        "credential.updated",
        "model.updated",
        "session.compaction.ended",
        "session.execution.failed",
        "session.execution.interrupted",
        "session.execution.succeeded",
        "session.idle",
        "session.reasoning.delta",
        "session.retry.scheduled",
        "session.step.ended",
        "session.step.failed",
        "session.step.started",
        "session.text.delta",
        "session.tool.called",
        "session.tool.failed",
        "session.usage.updated",
      ])
    } finally {
      cleanup()
    }
  })

  it("releases every subscription on dispose", async () => {
    const stub = makeContext()
    const cleanup = await setup(stub)
    cleanup()
    assert.deepEqual(stub.unsubscribed.slice().sort(), stub.registrations.slice().sort())
    assert.equal(stub.listeners.size, 0)
  })

  it("survives session events without a renderer", async () => {
    const stub = makeContext()
    const cleanup = await setup(stub)
    try {
      stub.emit("session.step.started", {
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        model: { providerID: "opencode-go", id: "glm" },
        started: Date.now(),
      })
      stub.emit("session.text.delta", { sessionID: "ses_1", delta: "hello world" })
      stub.emit("session.reasoning.delta", { sessionID: "ses_1", delta: "think" })
      const notice = stub.listeners.get("session.usage.updated")?.size ?? 0
      assert.equal(notice, 1)
      stub.emit("session.usage.updated")
      stub.emit("session.step.ended", {
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        tokens: { output: 100, reasoning: 10 },
      })
      stub.emit("session.execution.succeeded", { sessionID: "ses_1" })
      stub.emit("session.idle", { sessionID: "ses_1" })
      stub.emit("session.tool.called", { sessionID: "ses_1", id: "bash" })
      stub.emit("session.tool.failed", { sessionID: "ses_1", id: "bash" })
      stub.emit("session.step.failed", { sessionID: "ses_1" })
      stub.emit("session.retry.scheduled", { sessionID: "ses_1" })
      stub.emit("session.compaction.ended", { sessionID: "ses_1" })
    } finally {
      cleanup()
    }
  })

  it("adds the tool-delta listener only when rateIncludeTools is set", async () => {
    const plain = makeContext({ rateIncludeTools: false })
    ;(await setup(plain))()
    assert.equal(plain.registrations.includes("session.tool.input.delta"), false)

    const withTools = makeContext({ rateIncludeTools: true })
    const cleanup = await setup(withTools)
    try {
      assert.equal(withTools.registrations.includes("session.tool.input.delta"), true)
    } finally {
      cleanup()
    }
  })

  it("falls back to the default location when none is provided", async () => {
    const stub = makeContext({}, false)
    const cleanup = await setup(stub)
    try {
      assert.equal(stub.state.defaultLocationCalls, 1)
    } finally {
      cleanup()
    }
  })
})
