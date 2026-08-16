/**
 * Interactive ACP v2 bridge for DeepSeek Harness: exposes a harness agent as a
 * chat backend consumable by ACP v2 hosts such as ALwith Desktop.
 *
 * Built on the SDK's `experimental/v2` runtime (typed method router and typed
 * `session/update` notifications — `state_update` is a first-class frame).
 * The dsh-facing half (agent creation, prompt settlement, approval waterfall,
 * quiescing) adapts @deepseek-ai/dsh-acp (MIT, the automation-only v1 bridge).
 *
 * v2 contract notes:
 * - turn completion is announced by an `idle` state frame carrying
 *   `stopReason`; the `session/prompt` response body is `_meta`-only;
 * - reporting discipline mirrors alwith-cli, the authoritative v2
 *   implementation: `running` when the turn starts, `requires_action` while a
 *   client answer is pending, closing `idle` at settlement;
 * - permission requests use the v2 `subject` scheme with a required `title`.
 *
 * MVP scope: session/new + prompt + cancel. session/resume is the next
 * milestone (v2 renamed v1's session/load; it carries a client-driven
 * replayFrom cursor — omitted means context-only restore, { type: "start" }
 * means replay the whole conversation as session/update frames).
 */

import type { Context } from "@deepseek-ai/cordis"
import { randomUUID } from "node:crypto"
import { isAbsolute } from "node:path"
import { Readable, Writable } from "node:stream"
import Schema from "@deepseek-ai/schemastery"
import { createUserMessage, errorChain } from "@deepseek-ai/dsh-llm"
import {
  RequestError,
  agent as createAgentApp,
  ndJsonStream,
  type AgentConnection,
  type AgentContext,
  type CancelSessionNotification,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type MessageId,
  type UpdateSessionNotification,
  type StopReason,
  type Stream,
} from "@agentclientprotocol/sdk/experimental/v2"
import type { Agent } from "@deepseek-ai/dsh-agent"
import { SessionId, type SessionEvent, type TurnEndReason } from "@deepseek-ai/dsh-session"
// Side-effect type imports: declaration-merge the approval/request waterfall
// types and the ctx.sessionPersistence key.
import type {} from "@deepseek-ai/dsh-user-approval"
import type {} from "@deepseek-ai/dsh-session-persistence"
import { acpPromptToText, promptHasUnsupportedContent, turnEndToStopReason } from "./codec.ts"

export const name = "alwith-dsh-acp"
/** The bridge creates and owns agents; every other concern is carried by the composition. */
export const inject = ["agents"]

/** Wire protocol version; moves in lockstep with the ALwith Desktop client. */
export const ACP_PROTOCOL_VERSION = 2

/** Plugin config: the provider/model selection used for each ACP-created agent. */
export interface AcpConfig {
  provider?: string
  model?: string
  /** Test-only transport override; production uses stdio. */
  stream?: Stream
}

export const Config: Schema<AcpConfig> = Schema.object({
  provider: Schema.string(),
  model: Schema.string(),
})

/** Per-session protocol state. */
interface SessionRecord {
  agent: Agent
  dispose: () => Promise<void>
  /** In-flight prompt and its captured turn number for exact settlement. */
  inflight: {
    resolve: () => void
    reject: (error: Error) => void
    messageId: string
    turn: number | undefined
    endReason: TurnEndReason | undefined
  } | undefined
  /** Pending permission requests; while > 0 the reported state is requires_action. */
  pendingPermissions: number
  /** Last emitted state_update value, deduplicating consecutive identical frames. */
  lastState: "running" | "idle" | "requires_action" | undefined
}

/** Brand a string as a v2 MessageId (the schema type is a branded string). */
function MessageId(id: string): MessageId {
  return id as MessageId
}

function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail)
}

/**
 * Mount the ACP v2 server.
 * @param ctx - Cordis context carrying the agent factory and session events.
 * @param config - provider/model selection and optional test transport.
 */
export function apply(ctx: Context, config: AcpConfig): void {
  const agents = ctx.agents
  const logger = ctx.logger
  const sessions = new Map<SessionId, SessionRecord>()
  /** In-flight resume acquisitions by id: a second prepare while the first is publishing would hit the live gate. */
  const resumes = new Map<SessionId, Promise<SessionRecord>>()
  let closed = false
  let client: AgentContext

  const ownedRecord = (agent: Agent): SessionRecord | undefined => {
    const record = sessions.get(agent.session.id)
    return record?.agent === agent ? record : undefined
  }

  const assertOpen = (): void => {
    if (closed) throw internalError("the ACP bridge has been disposed")
  }

  const requireSession = (sessionId: string): SessionRecord => {
    const record = sessions.get(SessionId(sessionId))
    if (record === undefined) throw invalidParams(`unknown session: ${sessionId}`)
    return record
  }

  const notify = (notification: UpdateSessionNotification): void => {
    void client.notify("session/update", notification).catch((error: unknown) => {
      logger.warn(`acp: session/update failed: ${String(error)}`)
    })
  }

  // Reporting discipline mirrors alwith-cli: running when the turn starts,
  // requires_action while any client answer is pending (flipping back to
  // running when the last one settles, deduplicated); idle only at settlement,
  // always sent, carrying stopReason.
  const notifyState = (record: SessionRecord, state: "running" | "requires_action"): void => {
    if (record.lastState === state) return
    record.lastState = state
    notify({
      sessionId: record.agent.session.id,
      update: { sessionUpdate: "state_update", state },
    })
  }

  const reportIdle = (record: SessionRecord, stopReason: StopReason): void => {
    record.lastState = "idle"
    notify({
      sessionId: record.agent.session.id,
      update: { sessionUpdate: "state_update", state: "idle", stopReason },
    })
  }

  const settlePrompt = (record: SessionRecord): void => {
    const inflight = record.inflight
    if (inflight === undefined) return
    record.inflight = undefined
    inflight.resolve()
  }

  /** Live-first session acquisition for resume: reuse a bridge-owned live agent, else cold-resume from persistence. */
  const acquireSession = async (sessionId: SessionId, cwd: string): Promise<SessionRecord> => {
    const live = sessions.get(sessionId)
    if (live !== undefined) {
      const storedCwd = live.agent.session.header.cwd
      if (storedCwd !== undefined && storedCwd !== cwd) {
        throw invalidParams(`cwd mismatch: session was created in ${storedCwd}`)
      }
      return live
    }
    if (ctx.agents.get(sessionId) !== undefined) {
      // In the sidecar composition every agent is bridge-owned; an unowned live
      // agent means another frontend shares this context — refuse rather than
      // adopt an agent this bridge cannot dispose.
      throw internalError(`session ${sessionId} is live outside the bridge`)
    }
    const persistence = ctx.get("sessionPersistence")
    if (persistence === undefined) {
      throw internalError("session persistence is not configured; session/resume is unavailable")
    }
    let inspection: Awaited<ReturnType<typeof persistence.inspect>>
    try {
      inspection = await persistence.inspect(sessionId)
    } catch (error: unknown) {
      throw invalidParams(`unknown session: ${sessionId} (${errorChain(error)})`)
    }
    if (inspection.meta.cwd !== undefined && inspection.meta.cwd !== cwd) {
      throw invalidParams(`cwd mismatch: session was created in ${inspection.meta.cwd}`)
    }
    const handle = await agents.resume({ resumeSessionId: sessionId, agentOptions: agentOptions(config) })
    if (closed) {
      await handle.dispose()
      throw internalError("connection closed during session/resume")
    }
    const record: SessionRecord = {
      agent: handle.agent,
      dispose: () => handle.dispose(),
      inflight: undefined,
      pendingPermissions: 0,
      lastState: undefined,
    }
    sessions.set(sessionId, record)
    return record
  }

  /**
   * Replay the whole conversation as session/update frames (the replayFrom
   * { type: "start" } cursor). Committed messages only: user text as
   * user_message_chunk, assistant text/reasoning as message/thought chunks,
   * images as placeholders — mirroring the live-stream vocabulary.
   */
  const replayHistory = (record: SessionRecord): void => {
    const sessionId = record.agent.session.id
    for (const event of record.agent.session.events) {
      if (event.type === "user/message") {
        const message = event.data
        for (const block of message.content) {
          if (block.type === "text" && block.text.length > 0) {
            notify({
              sessionId,
              update: { sessionUpdate: "user_message_chunk", messageId: MessageId(message.id), content: { type: "text", text: block.text } },
            })
          }
        }
      } else if (event.type === "assistant/message") {
        const message = event.data.message
        for (const block of message.content) {
          if (block.type === "text" && block.text.length > 0) {
            notify({
              sessionId,
              update: { sessionUpdate: "agent_message_chunk", messageId: MessageId(message.id), content: { type: "text", text: block.text } },
            })
          } else if (block.type === "reasoning" && block.text.length > 0) {
            notify({
              sessionId,
              update: {
                sessionUpdate: "agent_thought_chunk",
                messageId: MessageId(`${message.id}/thought`),
                content: { type: "text", text: block.text },
              },
            })
          } else if (block.type === "image") {
            notify({
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                messageId: MessageId(message.id),
                content: { type: "text", text: `[image attachment ${block.attachment.attachmentId}]` },
              },
            })
          }
        }
      }
    }
  }

  // Token-level streaming: text-delta → agent_message_chunk, reasoning-delta →
  // agent_thought_chunk. Committed assistant/message text is NOT re-emitted
  // (only image placeholders), or the client would render it twice.
  // Note: chunks of a retried model request have already streamed out — the
  // same live-stream behavior CLI frontends exhibit.
  ctx.on("session/event", (session, event: SessionEvent) => {
    const record = sessions.get(session.header.id)
    if (record === undefined || record.agent.session !== session) return
    try {
      if (event.type === "assistant/chunk") {
        const chunk = event.data.chunk
        // v2 ContentChunk requires messageId (chunks of one message share it; a
        // change starts a new message). One dsh step is one model response, so
        // a session/turn/step composite is a stable per-message identity.
        const messageId = MessageId(`${record.agent.session.id}/${event.data.turn}/${event.data.step}`)
        if (chunk.type === "text-delta" && chunk.text.length > 0) {
          notify({
            sessionId: record.agent.session.id,
            update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: chunk.text } },
          })
        } else if (chunk.type === "reasoning-delta" && chunk.text.length > 0) {
          notify({
            sessionId: record.agent.session.id,
            update: {
              sessionUpdate: "agent_thought_chunk",
              messageId: MessageId(`${messageId}/thought`),
              content: { type: "text", text: chunk.text },
            },
          })
        }
      } else if (event.type === "assistant/message") {
        for (const block of event.data.message.content) {
          if (block.type === "image") {
            notify({
              sessionId: record.agent.session.id,
              update: {
                sessionUpdate: "agent_message_chunk",
                messageId: MessageId(event.data.message.id),
                content: { type: "text", text: `[image attachment ${block.attachment.attachmentId}]` },
              },
            })
          }
        }
      }
    } finally {
      const inflight = record.inflight
      if (inflight !== undefined && event.type === "turn/end" && inflight.turn === event.data.turn) {
        if (event.data.reason.kind === "error") {
          record.inflight = undefined
          reportIdle(record, "end_turn")
          inflight.reject(internalError(`turn failed: ${event.data.reason.error.message}`))
        } else {
          inflight.endReason = event.data.reason
        }
      }
    }
  })

  ctx.on("agent/inbox/claimed", ({ agent, message, turn }) => {
    const record = ownedRecord(agent)
    const inflight = record?.inflight
    if (inflight !== undefined && inflight.messageId === message.id) inflight.turn = turn
  })

  ctx.on("agent/error", ({ agent, turn, error }) => {
    const record = ownedRecord(agent)
    const inflight = record?.inflight
    if (record === undefined || inflight === undefined || inflight.turn === turn) return
    record.inflight = undefined
    reportIdle(record, "end_turn")
    inflight.reject(internalError(`turn failed: ${errorChain(error)}`))
  })

  // One-shot permission decisions via the v2 subject scheme (required title);
  // requires_action is reported while awaiting the client answer.
  ctx.on("approval/request", (request, next) => {
    const record = ownedRecord(request.agent)
    if (record === undefined || request.callId === undefined) return next()
    const callId = request.callId
    record.pendingPermissions += 1
    if (record.pendingPermissions === 1) notifyState(record, "requires_action")
    return client
      .request("session/request_permission", {
        sessionId: record.agent.session.id,
        title: request.reason ?? `Allow ${request.toolName}?`,
        subject: { type: "tool_call", toolCall: { toolCallId: callId } },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      })
      .then(({ outcome }) => {
        if (outcome.outcome === "cancelled") return "cancelled" as const
        return outcome.outcome === "selected" && outcome.optionId === "allow-once"
          ? ("allowed-once" as const)
          : ("rejected" as const)
      })
      .finally(() => {
        record.pendingPermissions -= 1
        if (record.pendingPermissions === 0) notifyState(record, "running")
      })
  })

  const app = createAgentApp()
    .onConnect(connected => {
      client = connected.client
    })
    .onRequest("initialize", (): InitializeResponse => {
      return {
        protocolVersion: ACP_PROTOCOL_VERSION,
        info: { name: "alwith-dsh-acp", title: "ALwith dsh bridge", version: "0.1.0" },
        authMethods: [],
        capabilities: { session: { prompt: {} } },
      }
    })
    .onRequest("session/new", async (context): Promise<NewSessionResponse> => {
      assertOpen()
      const params: NewSessionRequest = context.params
      validateSessionParams(params)
      const sessionId = SessionId(randomUUID())
      const handle = await agents.create({
        sessionId,
        meta: { cwd: params.cwd },
        agentOptions: agentOptions(config),
      })
      if (closed) {
        await handle.dispose()
        throw internalError("connection closed during session/new")
      }
      sessions.set(sessionId, {
        agent: handle.agent,
        dispose: () => handle.dispose(),
        inflight: undefined,
        pendingPermissions: 0,
        lastState: undefined,
      })
      return { sessionId }
    })
    .onRequest("session/resume", async (context): Promise<ResumeSessionResponse> => {
      assertOpen()
      const params: ResumeSessionRequest = context.params
      if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
      const sessionId = SessionId(params.sessionId)
      let pending = resumes.get(sessionId)
      if (pending === undefined) {
        pending = acquireSession(sessionId, params.cwd)
        resumes.set(sessionId, pending)
        void pending.catch(() => {}).finally(() => resumes.delete(sessionId))
      }
      const record = await pending
      // Replay is client-driven: an omitted/null cursor means context-only
      // restore (the client already has the history); { type: "start" } means
      // replay the whole conversation.
      if (params.replayFrom !== undefined && params.replayFrom !== null) {
        if (params.replayFrom.type !== "start") {
          throw invalidParams(`unsupported replayFrom cursor: ${params.replayFrom.type}`)
        }
        replayHistory(record)
      }
      return {}
    })
    .onRequest("session/prompt", async (context): Promise<PromptResponse> => {
      assertOpen()
      const params: PromptRequest = context.params
      const record = requireSession(params.sessionId)
      if (promptHasUnsupportedContent(params.prompt)) {
        throw invalidParams("only text and resource_link prompt content is supported")
      }
      const text = acpPromptToText(params.prompt)
      if (text.trim().length === 0) {
        // Mirror alwith-cli: an empty prompt reports idle(end_turn) and returns; it is not a protocol error.
        reportIdle(record, "end_turn")
        return {}
      }

      // Bridge contract: never drive a retired agent — a loop-only reload disposes agents while bridge records survive.
      if (ctx.agents.get(record.agent.id) !== record.agent) {
        throw internalError("prompt was not queued: the agent was disposed outside the bridge")
      }
      const message = createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } })
      if (record.inflight !== undefined) {
        // Another prompt while a turn is running: it enters the dsh inbox and
        // is claimed by the driver at the next step boundary (approximating
        // alwith-cli's mid-turn steering); completion is still announced by
        // the in-flight turn's idle frame.
        record.agent.followup(message)
        return {}
      }
      await new Promise<void>((resolve, reject) => {
        const inflight: NonNullable<SessionRecord["inflight"]> = {
          resolve,
          reject,
          messageId: message.id,
          turn: undefined,
          endReason: undefined,
        }
        record.inflight = inflight
        try {
          record.agent.followup(message)
          notifyState(record, "running")
        } catch (error: unknown) {
          record.inflight = undefined
          const detail = error instanceof Error ? error.message : String(error)
          throw internalError(`prompt was not queued: ${detail}`)
        }
        // Settlement waits for whole-agent idle: a correlated turn/end arms
        // endReason first; a turnless slot (admission discarded the prompt)
        // stays cancelled. Since v2 the stop reason travels on the idle state
        // frame; the prompt response body is _meta-only.
        void record.agent.whenIdle().then(() => {
          if (record.inflight !== inflight) return
          record.inflight = undefined
          const end = inflight.endReason
          const reason: StopReason =
            end === undefined ? "cancelled" : end.kind === "max-tokens" ? "end_turn" : turnEndToStopReason(end)
          reportIdle(record, reason)
          inflight.resolve()
        })
      })
      return {}
    })
    .onNotification("session/cancel", context => {
      const params: CancelSessionNotification = context.params
      const record = sessions.get(SessionId(params.sessionId))
      if (record === undefined) return
      record.agent.cancel({ kind: "user" })
      reportIdle(record, "cancelled")
      settlePrompt(record)
    })

  const stream: Stream =
    config.stream ??
    ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
    )
  const connection: AgentConnection = app.connect(stream)

  let quiescing: Promise<void> | undefined
  const quiesce = (): Promise<void> => {
    if (quiescing !== undefined) return quiescing
    closed = true
    const records = [...sessions.values()]
    sessions.clear()
    for (const record of records) {
      record.agent.cancel({ kind: "user" })
      settlePrompt(record)
    }
    quiescing = (async () => {
      const disposals = await Promise.allSettled(records.map(record => record.dispose()))
      const failures: unknown[] = []
      for (const result of disposals) {
        if (result.status === "rejected") failures.push(result.reason as unknown)
      }
      if (failures.length > 0) {
        const detail = failures.map(failure => errorChain(failure)).join("; ")
        throw new AggregateError(failures, `ACP agent teardown failed for ${failures.length} session(s): ${detail}`)
      }
    })()
    return quiescing
  }

  void connection.closed
    .catch((error: unknown) => {
      logger.warn(`acp: connection closed with an error: ${String(error)}`)
    })
    .then(quiesce)
    .catch((error: unknown) => {
      logger.warn(`acp: connection-close teardown failed: ${String(error)}`)
    })

  ctx.effect(() => quiesce, "alwith-dsh-acp.connection")
}

function agentOptions(config: AcpConfig): { provider?: string; model?: string } {
  return {
    ...(config.provider !== undefined ? { provider: config.provider } : {}),
    ...(config.model !== undefined ? { model: config.model } : {}),
  }
}

/** Reject session features outside the bridge contract. */
function validateSessionParams(params: NewSessionRequest): void {
  if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  if (params.additionalDirectories !== undefined && params.additionalDirectories.length > 0) {
    throw invalidParams("additionalDirectories is not supported")
  }
  if (params.mcpServers !== undefined && params.mcpServers.length > 0) {
    throw invalidParams("mcpServers is not supported")
  }
}
