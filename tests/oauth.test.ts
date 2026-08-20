/** Subscription OAuth: file credential store semantics, status CLI, keyless-route composition. */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { composeRuntime } from "../src/compose.ts"
import { FileCredentialStore, runOauthCli } from "../src/oauth.ts"

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "alwith-dsh-oauth-")), "credentials.json")
}

describe("FileCredentialStore", () => {
  test("modify persists 0600, read/list/delete round-trip", async () => {
    const file = tempFile()
    const store = new FileCredentialStore(file)
    await store.modify("anthropic", async () => ({
      type: "oauth",
      refresh: "r1",
      access: "a1",
      expires: 123
    }))
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600")
    expect(await store.read("anthropic")).toMatchObject({ type: "oauth", access: "a1" })
    expect(await store.list()).toEqual([{ providerId: "anthropic", type: "oauth" }])

    // refresh-style modify sees the current credential and replaces it
    await store.modify("anthropic", async current => {
      expect(current).toMatchObject({ access: "a1" })
      return { ...(current as { type: "oauth"; refresh: string; access: string; expires: number }), access: "a2" }
    })
    expect(JSON.parse(readFileSync(file, "utf8")).anthropic.access).toBe("a2")

    // returning undefined leaves the entry unchanged
    await store.modify("anthropic", async () => undefined)
    expect(await store.read("anthropic")).toMatchObject({ access: "a2" })

    await store.delete("anthropic")
    expect(await store.read("anthropic")).toBeUndefined()
  })
})

describe("oauth CLI", () => {
  test("status lists stored credentials without secrets", async () => {
    const file = tempFile()
    process.env.ALWITH_DSH_OAUTH_CREDENTIALS = file
    try {
      await new FileCredentialStore(file).modify("anthropic", async () => ({
        type: "oauth",
        refresh: "r",
        access: "a",
        expires: 1
      }))
      const lines: string[] = []
      const original = process.stdout.write.bind(process.stdout)
      process.stdout.write = ((chunk: string | Uint8Array) => {
        lines.push(chunk.toString())
        return true
      }) as typeof process.stdout.write
      try {
        await runOauthCli(["status"])
      } finally {
        process.stdout.write = original
      }
      const status = JSON.parse(lines.at(-1)!) as { credentials: Array<{ providerId: string; type: string }> }
      expect(status.credentials).toEqual([{ providerId: "anthropic", type: "oauth" }])
      expect(lines.join("")).not.toContain('"a"')
    } finally {
      delete process.env.ALWITH_DSH_OAUTH_CREDENTIALS
    }
  })

  test("login for an unwired provider fails loud", async () => {
    await expect(runOauthCli(["login", "acme"])).rejects.toThrow("no subscription login wired")
  })
})

describe("keyless OAuth route", () => {
  test("a route with no apiKeyEnv composes (auth deferred to pi-ai's store path)", async () => {
    const ctx = await composeRuntime({ preset: "standard", piProviders: { anthropic: {} } })
    const providers = (ctx as unknown as { llm: { listProviders: () => Array<{ id: string }> } }).llm
      .listProviders()
      .map(provider => provider.id)
    expect(providers).toContain("anthropic")
    await ctx.fiber.dispose()
  })
})
