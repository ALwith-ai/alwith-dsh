/** Plugin manifest + overrides: listing, toggling, dependency validation, CLI round-trip. */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { composeRuntime } from "../src/compose.ts"
import { pluginRows, resolvePlugins, type PluginOverrides } from "../src/plugins.ts"
import { runPluginsCli } from "../src/plugins-cli.ts"

const OPTIONS = { sessionsRoot: "/", workspaceRoot: "/", permissionMode: "workspace-write" as const }

async function toolNames(overrides: PluginOverrides): Promise<string[]> {
  const ctx = await composeRuntime({ preset: "standard", overrides })
  const names = (ctx.tools as unknown as { schemas: (c: unknown) => Array<{ name: string }> })
    .schemas(ctx)
    .map(schema => schema.name)
    .sort()
  await ctx.fiber.dispose()
  return names
}

describe("plugin manifest", () => {
  test("standard listing exposes every row with core protection marked", () => {
    const { listing } = resolvePlugins(pluginRows({ ...OPTIONS, preset: "standard" }), {})
    const byId = new Map(listing.map(row => [row.id, row]))
    expect(byId.get("session")?.core).toBe(true)
    expect(byId.get("tool-web")?.core).toBe(false)
    expect(byId.get("tool-web")?.requires).toEqual(["web", "web-search-deepseek"])
    expect(listing.every(row => row.enabled)).toBe(true)
    expect(listing.length).toBeGreaterThanOrEqual(20)
  })

  test("disabling the web trio removes web_search from the composed tool surface", async () => {
    expect(await toolNames({ disabled: ["tool-web", "web-search-deepseek", "web"] }))
      .toEqual(["bash", "edit", "glob", "grep", "read", "todo_write", "write"])
  })

  test("disabling a core row fails loud", () => {
    expect(() => resolvePlugins(pluginRows({ ...OPTIONS, preset: "standard" }), { disabled: ["session"] }))
      .toThrow('core row')
  })

  test("disabling a dependency of an enabled row fails loud (cordis would hang, not error)", () => {
    expect(() => resolvePlugins(pluginRows({ ...OPTIONS, preset: "standard" }), { disabled: ["web"] }))
      .toThrow('requires "web"')
  })

  test("unknown plugin id in overrides fails loud", () => {
    expect(() => resolvePlugins(pluginRows({ ...OPTIONS, preset: "standard" }), { disabled: ["not-a-plugin"] }))
      .toThrow('unknown plugin id')
  })

  test("config overrides shallow-merge over the row defaults", () => {
    const { listing } = resolvePlugins(pluginRows({ ...OPTIONS, preset: "standard" }), {
      config: { "tool-web": { searchTimeoutMs: 30000 } },
    })
    const toolWeb = listing.find(row => row.id === "tool-web")
    expect(toolWeb?.config).toEqual({ fetch: false, searchTimeoutMs: 30000 })
  })
})

describe("plugins CLI", () => {
  function captureStdout(): { lines: string[]; restore: () => void } {
    const lines: string[] = []
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(chunk.toString())
      return true
    }) as typeof process.stdout.write
    return { lines, restore: () => { process.stdout.write = original } }
  }

  test("set disabled → file written → list reflects it → set enabled restores", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "alwith-dsh-plugins-")), "plugins.json")
    const stdout = captureStdout()
    try {
      await runPluginsCli(["set", "tool-web", "disabled", "--file", file, "--preset", "standard"])
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ disabled: ["tool-web"] })
      await runPluginsCli(["list", "--file", file, "--preset", "standard"])
      const listed = JSON.parse(stdout.lines.at(-1)!) as { plugins: Array<{ id: string; enabled: boolean }> }
      expect(listed.plugins.find(row => row.id === "tool-web")?.enabled).toBe(false)
      await runPluginsCli(["set", "tool-web", "enabled", "--file", file, "--preset", "standard"])
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ disabled: [] })
    } finally {
      stdout.restore()
    }
  })

  test("set validates before writing: core row and broken dependency both leave the file untouched", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "alwith-dsh-plugins-")), "plugins.json")
    const stdout = captureStdout()
    try {
      await expect(runPluginsCli(["set", "session", "disabled", "--file", file])).rejects.toThrow("core row")
      // "web" alone breaks tool-web's requires in the standard preset.
      await expect(runPluginsCli(["set", "web", "disabled", "--file", file])).rejects.toThrow('requires "web"')
      await expect(runPluginsCli(["set", "nope", "disabled", "--file", file])).rejects.toThrow("unknown plugin id")
      expect(() => readFileSync(file, "utf8")).toThrow() // never created
    } finally {
      stdout.restore()
    }
  })
})
