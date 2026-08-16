/**
 * Hand-composed dsh runtime: the plugin set is fixed in code, not assembled
 * through dsh's profile/patch tree.
 *
 * Why not the loader: (1) the sidecar's composition is a platform decision and
 * must not be user-patchable; (2) dsh's HMR machinery requires Node loader
 * internals that Bun (the bundled runtime this sidecar targets) does not
 * provide — hand composition sidesteps it entirely.
 *
 * Composition: chat + JSONL session persistence (required for session/resume)
 * + the coding-agent tool surface (filesystem, bash, todo) with one-shot
 * approvals bridged over ACP.
 */

import { Context } from "@deepseek-ai/cordis"
import LlmRuntime from "@deepseek-ai/dsh-llm"
import SessionStore from "@deepseek-ai/dsh-session"
import SystemPrompt from "@deepseek-ai/dsh-system-prompt"
import ToolRuntime from "@deepseek-ai/dsh-tools"
import AgentRegistry from "@deepseek-ai/dsh-agent"
import AgentLoop from "@deepseek-ai/dsh-agent-loop"
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl"
import LocalSubprocessRuntime from "@deepseek-ai/dsh-subprocess-local"
import LocalSandboxProvider from "@deepseek-ai/dsh-sandbox-local"
import SandboxPolicyService from "@deepseek-ai/dsh-sandbox-policy"
import SandboxBashExecutor from "@deepseek-ai/dsh-bash-sandbox"
import SandboxedFileSystem from "@deepseek-ai/dsh-fs-sandbox"
import LocalJobRegistry from "@deepseek-ai/dsh-jobs-local"
import PermissionPresetService from "@deepseek-ai/dsh-permission-presets"
import ApprovalService from "@deepseek-ai/dsh-user-approval"
// Namespace imports rather than default: a module-plugin default export drops
// `inject` (see dsh postmortem 0001). Service classes above carry inject as a
// static and are safe as defaults.
import * as LlmDeepseek from "@deepseek-ai/dsh-llm-deepseek"
import * as ShellEnv from "@deepseek-ai/dsh-shell-env"
import * as FsObservationPolicy from "@deepseek-ai/dsh-fs-observation-policy"
import * as ToolFs from "@deepseek-ai/dsh-tool-fs"
import * as ToolBash from "@deepseek-ai/dsh-tool-bash"
import * as ToolTodo from "@deepseek-ai/dsh-tool-todo"
import * as ToolFsSearch from "@deepseek-ai/dsh-tool-fs-search"
import * as ToolWeb from "@deepseek-ai/dsh-tool-web"
import * as WebSearchDeepseek from "@deepseek-ai/dsh-web-search-deepseek"
import * as AnchoredToolBootstrap from "./vendor/anchored-tool-bootstrap.mjs"
import CodeRuntimeWorker from "@deepseek-ai/dsh-code-runtime-worker-thread"
import CordisHostRunner from "@deepseek-ai/dsh-cordis-host-runner"
import * as ToolCordis from "@deepseek-ai/dsh-tool-cordis"
import WebRuntime from "@deepseek-ai/dsh-web"
import TerminalSessionService from "@deepseek-ai/dsh-terminal"
import * as TerminalBash from "@deepseek-ai/dsh-terminal-bash"
import * as ToolBashPersistent from "@deepseek-ai/dsh-tool-bash-persistent"
import * as ToolStrReplaceEditor from "@deepseek-ai/dsh-tool-str-replace-editor"

/**
 * Agent preset: which tool surface the composed agent gets. Mirrors dsh's
 * built-in presets; `code` (Code Mode) and `cordis` (self-modification) are
 * not composed by this sidecar yet and are rejected at the entry.
 */
export type HarnessPreset = "standard" | "minimal" | "anchored" | "code" | "cordis"

export interface ComposeOptions {
  /**
   * Root directory for JSONL session logs. Absent means no persistence —
   * session/resume then fails loud (`session persistence is not configured`).
   */
  sessionsRoot?: string
  /** Sandbox workspace root (writes allowed under it in workspace-write mode). */
  workspaceRoot?: string
  /** Deployment permission mode; mirrors dsh's DSH_PERMISSION_MODE. */
  permissionMode?: "read-only" | "workspace-write" | "danger-full-access"
  /** Tool-surface preset; defaults to the standard coding agent. */
  preset?: HarnessPreset
}

export async function composeRuntime(options: ComposeOptions = {}): Promise<Context> {
  const workspaceRoot = options.workspaceRoot ?? process.cwd()
  const permissionMode = options.permissionMode ?? "workspace-write"
  const preset = options.preset ?? "standard"
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  // The anchored preset's phase 1 is persona-only, so the persona must be the
  // exact Minimal one-liner (dsh-persona is an agent-scope shadow and collides
  // process-wide; configuring the prompt runtime directly is the host-plane way).
  await ctx.plugin(
    SystemPrompt,
    preset === "anchored" ? { persona: "You are a helpful software engineer assistant." } : undefined,
  )
  // Context-global presentation is the tools row's `mode` field (presentAs is
  // the per-agent-scope variant used by dsh's preset realms).
  await ctx.plugin(ToolRuntime, preset === "code" ? { mode: "code" } : undefined)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LlmDeepseek)
  if (options.sessionsRoot !== undefined) {
    await ctx.plugin(JsonlSessionPersistence, { root: options.sessionsRoot })
  }
  // Execution world, sandbox-first as in dsh's shipped base bundle: commands
  // run inside the OS sandbox; a denial asks the user only when the model
  // escalates with sandbox_permissions. Configs mirror the bundle rows.
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalSandboxProvider)
  await ctx.plugin(SandboxPolicyService, { mode: permissionMode, workspaceRoot })
  await ctx.plugin(SandboxBashExecutor, { timeoutMs: 60000 })
  await ctx.plugin(SandboxedFileSystem)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(ShellEnv)
  await ctx.plugin(FsObservationPolicy)
  // One-shot approvals ('ask' pairs with read-only/workspace-write presets);
  // the ACP bridge answers them over the wire.
  await ctx.plugin(ApprovalService, { policy: permissionMode === "danger-full-access" ? "never" : "ask" })
  await ctx.plugin(PermissionPresetService, {
    presets: {
      "read-only": { sandbox: "read-only", approval: "ask" },
      "workspace-write": { sandbox: "workspace-write", approval: "ask" },
      "danger-full-access": { sandbox: "danger-full-access", approval: "never" },
    },
  })
  // Model-facing tools per preset (configs mirror dsh's shipped rows).
  if (preset === "minimal") {
    // dsh's minimal preset: a two-tool coding agent — persistent bash + str_replace_editor.
    await ctx.plugin(TerminalSessionService)
    await ctx.plugin(TerminalBash)
    await ctx.plugin(ToolBashPersistent)
    await ctx.plugin(ToolStrReplaceEditor, { maxOutputChars: 16000 })
  } else if (preset === "anchored") {
    // Community "anchored standard" (dsh-liangshen / xiaobright): the FIRST
    // model request sees only the Minimal two-tool surface plus a one-line
    // persona (DeepSeek V4 Pro conditions its trajectory on the first-request
    // tool catalog: Minimal 99/96 vs Standard 91/92 in the community eval);
    // after the anchor the full native catalog and prompt sections open.
    // Note: the reference numbers were measured with Code Mode promotion;
    // this composition promotes to the native catalog (Code Mode is not
    // composed here).
    await ctx.plugin(TerminalSessionService)
    await ctx.plugin(TerminalBash)
    await ctx.plugin(ToolBashPersistent) // registers "bash"; the ephemeral tool-bash stays out (name collision)
    await ctx.plugin(ToolStrReplaceEditor, { maxOutputChars: 16000 })
    await ctx.plugin(ToolFs)
    await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: false })
    await ctx.plugin(ToolTodo, { allowParallelInProgress: true })
    await ctx.plugin(WebRuntime, { searchProvider: "deepseek-official" })
    await ctx.plugin(WebSearchDeepseek, { apiKeyEnv: "DEEPSEEK_API_KEY" })
    await ctx.plugin(ToolWeb, { fetch: false, searchTimeoutMs: 60000 })
    await ctx.plugin(AnchoredToolBootstrap, {
      shellTools: ["bash"],
      commonTools: ["str_replace_editor"],
      messageSources: ["user"],
      anchorGate: true,
      maxBootstrapSteps: 4,
      promoteAfterFirstResponse: true,
      bootstrapMaxTokens: 1024,
      compactionTools: ["read", "write", "edit", "glob", "grep", "todo_write"],
      deferredSources: [],
    })
  } else {
    // standard and code share the coding-agent tool surface; code adds the
    // Code Mode presentation (one run_code tool over the generated SDK) backed
    // by the official worker runtime (Bun-patched: amaro strip + null stdio,
    // see patches/).
    await ctx.plugin(ToolFs)
    await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: false })
    await ctx.plugin(ToolBash)
    await ctx.plugin(ToolTodo, { allowParallelInProgress: true })
    // Web search rides the same DeepSeek key; fetch stays off as in the
    // shipped bundle (tool-web { fetch: false }).
    await ctx.plugin(WebRuntime, { searchProvider: "deepseek-official" })
    await ctx.plugin(WebSearchDeepseek, { apiKeyEnv: "DEEPSEEK_API_KEY" })
    await ctx.plugin(ToolWeb, { fetch: false, searchTimeoutMs: 60000 })
    if (preset === "code") {
      await ctx.plugin(CodeRuntimeWorker)
    }
    if (preset === "cordis") {
      // dsh's creator preset: the standard surface plus the self-referential
      // Cordis toolset (define / run / inspect model-written plugins in a
      // node:vm realm). Trust boundary, not a sandbox — mirrors the preset's
      // own header. The composition-authoring skill is not bundled yet.
      await ctx.plugin(CordisHostRunner)
      await ctx.plugin(ToolCordis)
    }
  }
  return ctx
}
