/** Protocol behavior tests over in-memory transport with a mock adapter; no real model calls. */

import { describe, expect, test } from "bun:test"
import { Context } from "@deepseek-ai/cordis"
import {
  client as createClientApp,
  ndJsonStream,
  type ClientConnection,
  type RequestPermissionRequest,
  type UpdateSessionNotification,
  type Stream,
} from "@agentclientprotocol/sdk/experimental/v2"
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from "@deepseek-ai/dsh-llm"
import AgentLoop from "@deepseek-ai/dsh-agent-loop"
import { mountAgentLoopTestDependencies } from "@deepseek-ai/dsh-agent-loop-testkit"
import * as Bridge from "../src/bridge.ts"

class MockAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: StreamChunk[][]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error("MockAdapter: script exhausted")
    for (const chunk of entry) {
      if (options.signal?.aborted) throw new Error("aborted")
      yield chunk
    }
  }
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    ...Array.from(text, (char): StreamChunk => ({ type: "text-delta", index: 0, text: char })),
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "usage", usage: { inputTokens: 5, outputTokens: text.length } },
    { type: "finish", reason: { kind: "stop" } },
  ]
}

type CapturedUpdate = UpdateSessionNotification["update"] & { state?: string; stopReason?: string }

/** Await a real condition (notifications are written asynchronously; crossing the transport needs event-loop turns). */
async function untilFrame(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("untilFrame: condition not met within timeout")
    await new Promise(resolve => setImmediate(resolve))
  }
}

async function makeHarness(script: StreamChunk[][]) {
  const adapter = new MockAdapter(script)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: "" } })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(["mock"], adapter)

  const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const agentStream: Stream = ndJsonStream(agentToClient.writable, clientToAgent.readable)
  const clientStream: Stream = ndJsonStream(clientToAgent.writable, agentToClient.readable)

  const updates: CapturedUpdate[] = []
  const permissionRequests: RequestPermissionRequest[] = []

  await ctx.plugin({
    name: Bridge.name,
    inject: [...Bridge.inject],
    apply: (inner: Context) => {
      Bridge.apply(inner, { provider: "mock", model: "mock", stream: agentStream })
    },
  })

  const connection: ClientConnection = createClientApp()
    .onNotification("session/update", context => {
      updates.push(context.params.update as CapturedUpdate)
    })
    .onRequest("session/request_permission", context => {
      permissionRequests.push(context.params)
      return { outcome: { outcome: "cancelled" as const } }
    })
    .connect(clientStream)

  const states = () =>
    updates.filter(update => update.sessionUpdate === "state_update").map(update => ({ state: update.state, stopReason: update.stopReason }))
  return { ctx, agent: connection.agent, updates, states, permissionRequests, dispose: () => ctx.fiber.dispose() }
}

describe("alwith-dsh-acp bridge", () => {
  test("initialize reports protocolVersion 2 with v2 info", async () => {
    const h = await makeHarness([])
    const result = await h.agent.request("initialize", { protocolVersion: 2, info: { name: "test-client", version: "0.0.0" }, capabilities: {} })
    expect(result.protocolVersion).toBe(2)
    expect(result.info.name).toBe("alwith-dsh-acp")
    await h.dispose()
  })

  test("prompt streams token by token; concatenation equals the full text exactly once", async () => {
    const h = await makeHarness([textResponse("hello")])
    await h.agent.request("initialize", { protocolVersion: 2, info: { name: "test-client", version: "0.0.0" }, capabilities: {} })
    const { sessionId } = await h.agent.request("session/new", { cwd: "/tmp" })
    const response = await h.agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    })
    // v2: the prompt response body is _meta-only; completion travels on the idle state frame
    expect(Object.keys(response)).toEqual([])
    // Notifications are asynchronous; the idle frame is last on the wire, so once
    // it lands every chunk before it has landed too.
    await untilFrame(() => h.states().at(-1)?.state === "idle")
    const chunks = h.updates.filter(update => update.sessionUpdate === "agent_message_chunk")
    // textResponse yields per-character deltas: this must be a multi-frame stream, not one full-text frame
    expect(chunks.length).toBeGreaterThan(1)
    const text = chunks.map(update => (update as { content: { text: string } }).content.text).join("")
    expect(text).toBe("hello")
    await h.dispose()
  })

  test("state_update reports running, then a closing idle frame carrying stopReason", async () => {
    const h = await makeHarness([textResponse("ok")])
    await h.agent.request("initialize", { protocolVersion: 2, info: { name: "test-client", version: "0.0.0" }, capabilities: {} })
    const { sessionId } = await h.agent.request("session/new", { cwd: "/tmp" })
    await h.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] })
    await untilFrame(() => h.states().at(-1)?.state === "idle")
    expect(h.states().map(entry => entry.state)).toContain("running")
    const last = h.states().at(-1)
    expect(last?.state).toBe("idle")
    expect(last?.stopReason).toBe("end_turn")
    await h.dispose()
  })

  test("empty prompt is not an error: announced by an idle(end_turn) frame, then resolves", async () => {
    const h = await makeHarness([])
    await h.agent.request("initialize", { protocolVersion: 2, info: { name: "test-client", version: "0.0.0" }, capabilities: {} })
    const { sessionId } = await h.agent.request("session/new", { cwd: "/tmp" })
    await h.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "   " }] })
    await untilFrame(() => h.states().at(-1)?.state === "idle")
    const last = h.states().at(-1)
    expect(last?.state).toBe("idle")
    expect(last?.stopReason).toBe("end_turn")
    await h.dispose()
  })
})
