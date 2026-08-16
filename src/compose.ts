/**
 * Hand-composed dsh runtime: the plugin set is fixed in code, not assembled
 * through dsh's profile/patch tree.
 *
 * Why not the loader: (1) the sidecar's composition is a platform decision and
 * must not be user-patchable; (2) dsh's HMR machinery requires Node loader
 * internals that Bun (the bundled runtime this sidecar targets) does not
 * provide — hand composition sidesteps it entirely.
 *
 * MVP composition: chat only (no tools, no persistence). Tools and
 * session-persistence join in milestone 2 (session/load).
 */

import { Context } from "@deepseek-ai/cordis"
import LlmRuntime from "@deepseek-ai/dsh-llm"
import SessionStore from "@deepseek-ai/dsh-session"
import SystemPrompt from "@deepseek-ai/dsh-system-prompt"
import ToolRuntime from "@deepseek-ai/dsh-tools"
import AgentRegistry from "@deepseek-ai/dsh-agent"
import AgentLoop from "@deepseek-ai/dsh-agent-loop"
// Namespace import rather than default: a default export drops `inject`
// (see dsh postmortem 0001).
import * as LlmDeepseek from "@deepseek-ai/dsh-llm-deepseek"

export async function composeRuntime(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LlmDeepseek)
  return ctx
}
