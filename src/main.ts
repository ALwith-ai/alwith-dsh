/**
 * stdio entry: `bun src/main.ts` starts an ACP v2 server for a host to spawn.
 * The DeepSeek key resolves through llm-deepseek's default credential lookup
 * ($DEEPSEEK_API_KEY).
 */

import { composeRuntime } from "./compose.ts"
import * as Bridge from "./bridge.ts"

const provider = process.env.ALWITH_DSH_PROVIDER ?? "deepseek-official"
const model = process.env.ALWITH_DSH_MODEL ?? "deepseek-v4-flash"

const ctx = await composeRuntime()
await ctx.plugin(
  { name: Bridge.name, inject: [...Bridge.inject], apply: (inner: typeof ctx) => Bridge.apply(inner, { provider, model }) },
)
// stdin keeps the process alive; the bridge's quiesce handles connection close.
