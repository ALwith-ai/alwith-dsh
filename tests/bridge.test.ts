/** Protocol behavior tests over in-memory transport with a mock adapter; no real model calls. */

import { describe, expect, test } from "bun:test"
import { makeHarness, textResponse, untilFrame } from "./harness.ts"

describe("alwith-dsh-acp bridge", () => {
  test("initialize reports protocolVersion 2 with v2 info", async () => {
    const h = await makeHarness([])
    const result = await h.initialize()
    expect(result.protocolVersion).toBe(2)
    expect(result.info.name).toBe("alwith-dsh-acp")
    await h.dispose()
  })

  test("prompt streams token by token; concatenation equals the full text exactly once", async () => {
    const h = await makeHarness([textResponse("hello")])
    await h.initialize()
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
    await h.initialize()
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
    await h.initialize()
    const { sessionId } = await h.agent.request("session/new", { cwd: "/tmp" })
    await h.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "   " }] })
    await untilFrame(() => h.states().at(-1)?.state === "idle")
    const last = h.states().at(-1)
    expect(last?.state).toBe("idle")
    expect(last?.stopReason).toBe("end_turn")
    await h.dispose()
  })
})
