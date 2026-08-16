/**
 * stdio entry: `bun src/main.ts` starts an ACP v2 server for a host to spawn.
 * The DeepSeek key resolves through llm-deepseek's default credential lookup
 * ($DEEPSEEK_API_KEY).
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { composeRuntime } from "./compose.ts"
import * as Bridge from "./bridge.ts"

const provider = process.env.ALWITH_DSH_PROVIDER ?? "deepseek-official"
const model = process.env.ALWITH_DSH_MODEL ?? "deepseek-v4-flash"
// Session logs live under the sidecar's own home by default; the host
// (ALwith Desktop) overrides this to its managed location.
const sessionsRoot = process.env.ALWITH_DSH_SESSIONS_ROOT ?? join(homedir(), ".alwith-dsh", "sessions")

const ctx = await composeRuntime({ sessionsRoot })
await ctx.plugin(
  { name: Bridge.name, inject: [...Bridge.inject], apply: (inner: typeof ctx) => Bridge.apply(inner, { provider, model }) },
)
// stdin keeps the process alive; the bridge's quiesce handles connection close.
