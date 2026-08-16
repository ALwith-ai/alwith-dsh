/** Preset compositions: each preset yields exactly its documented tool surface. */

import { describe, expect, test } from "bun:test"
import { composeRuntime } from "../src/compose.ts"

async function toolNames(preset: "standard" | "minimal"): Promise<string[]> {
  const ctx = await composeRuntime({ preset })
  const names = (ctx.tools as unknown as { schemas: (c: unknown) => Array<{ name: string }> })
    .schemas(ctx)
    .map(schema => schema.name)
    .sort()
  await ctx.fiber.dispose()
  return names
}

describe("harness presets", () => {
  test("standard composes the coding-agent tool surface", async () => {
    expect(await toolNames("standard")).toEqual(["bash", "edit", "read", "todo_write", "write"])
  })

  test("minimal composes exactly the two-tool agent (persistent bash + str_replace_editor)", async () => {
    expect(await toolNames("minimal")).toEqual(["bash", "str_replace_editor"])
  })
})
