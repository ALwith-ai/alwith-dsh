/**
 * stdio entry: `bun src/main.ts` starts an ACP v2 server for a host to spawn.
 * The DeepSeek key resolves through llm-deepseek's default credential lookup
 * ($DEEPSEEK_API_KEY).
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { composeRuntime } from "./compose.ts"
import { loadPluginOverrides } from "./plugins.ts"
import { defaultPluginsFile, runPluginsCli } from "./plugins-cli.ts"
import * as Bridge from "./bridge.ts"

// `plugins` / `sessions` subcommands: host-facing management without an ACP
// server. Failures exit 1 with the reason as a single stderr line — the host
// surfaces stderr verbatim, so no runtime stack noise here.
if (process.argv[2] === "plugins" || process.argv[2] === "sessions") {
  try {
    if (process.argv[2] === "plugins") await runPluginsCli(process.argv.slice(3))
    else await (await import("./sessions-cli.ts")).runSessionsCli(process.argv.slice(3))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
  process.exit(0)
}

const provider = process.env.ALWITH_DSH_PROVIDER ?? "deepseek-official"
const model = process.env.ALWITH_DSH_MODEL ?? "deepseek-v4-flash"
// Host-facing provider identity for _meta.alwith turn metadata (the ALwith
// Desktop provider vocabulary, not the dsh adapter route).
const providerId = process.env.ALWITH_DSH_PROVIDER_ID ?? "deepseek"
// Background LLM session titles ride the session's model unless overridden.
const titleModel = process.env.ALWITH_DSH_TITLE_MODEL ?? model
// Session logs live under the sidecar's own home by default; the host
// (ALwith Desktop) overrides this to its managed location.
const sessionsRoot = process.env.ALWITH_DSH_SESSIONS_ROOT ?? join(homedir(), ".alwith-dsh", "sessions")
// The host spawns one sidecar per session and pins the sandbox workspace to
// that session's cwd; standalone runs default to the process cwd.
const workspaceRoot = process.env.ALWITH_DSH_WORKSPACE_ROOT ?? process.cwd()
const permissionMode = (process.env.ALWITH_DSH_PERMISSION_MODE ?? "workspace-write") as
  | "read-only"
  | "workspace-write"
  | "danger-full-access"
// Preset gate fails loud on the modes this sidecar does not compose yet —
// the host UI disables them, and a misrouted value must not silently degrade.
const rawPreset = process.env.ALWITH_DSH_PRESET ?? "standard"
const PRESETS = ["standard", "minimal", "anchored", "code", "cordis"] as const
if (!(PRESETS as readonly string[]).includes(rawPreset)) {
  throw new Error(`unsupported harness preset "${rawPreset}": this sidecar composes ${PRESETS.join(", ")}`)
}

// Per-plugin enable/disable + config; invalid content fails the spawn loud.
const overrides = loadPluginOverrides(defaultPluginsFile())

const ctx = await composeRuntime({ sessionsRoot, workspaceRoot, permissionMode, preset: rawPreset as (typeof PRESETS)[number], overrides })
await ctx.plugin(
  { name: Bridge.name, inject: [...Bridge.inject], apply: (inner: typeof ctx) => Bridge.apply(inner, { provider, model, providerId, titleModel }) },
)
// stdin keeps the process alive; the bridge's quiesce handles connection close.
