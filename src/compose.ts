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
}

export async function composeRuntime(options: ComposeOptions = {}): Promise<Context> {
  const workspaceRoot = options.workspaceRoot ?? process.cwd()
  const permissionMode = options.permissionMode ?? "workspace-write"
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
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
  // Model-facing tools (configs mirror dsh's shipped base bundle).
  await ctx.plugin(ToolFs)
  await ctx.plugin(ToolBash)
  await ctx.plugin(ToolTodo, { allowParallelInProgress: true })
  return ctx
}
