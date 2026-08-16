/**
 * `plugins` subcommand: lets a host read and edit the plugin overrides file
 * without a live session (`bun src/main.ts plugins list --json`).
 *
 * Output is JSON on stdout; validation failures throw (non-zero exit) with
 * the reason on stderr — the host surfaces it verbatim.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import {
  HARNESS_PRESETS,
  type HarnessPreset,
  loadPluginOverrides,
  pluginRows,
  resolvePlugins,
  savePluginOverrides,
} from "./plugins.ts"

export function defaultPluginsFile(): string {
  return process.env.ALWITH_DSH_PLUGINS_FILE ?? join(homedir(), ".alwith-dsh", "plugins.json")
}

interface CliFlags {
  preset: HarnessPreset
  file: string
  positional: string[]
}

function parseFlags(argv: string[]): CliFlags {
  let preset = process.env.ALWITH_DSH_PRESET ?? "standard"
  let file = defaultPluginsFile()
  const positional: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === "--preset") {
      const value = argv[index + 1]
      if (value === undefined) throw new Error("--preset requires a value")
      preset = value
      index += 1
    } else if (argument === "--file") {
      const value = argv[index + 1]
      if (value === undefined) throw new Error("--file requires a value")
      file = value
      index += 1
    } else if (argument.startsWith("--")) {
      throw new Error(`unknown flag ${argument}`)
    } else {
      positional.push(argument)
    }
  }
  if (!(HARNESS_PRESETS as readonly string[]).includes(preset)) {
    throw new Error(`unsupported preset "${preset}": expected one of ${HARNESS_PRESETS.join(", ")}`)
  }
  return { preset: preset as HarnessPreset, file, positional }
}

function listingFor(preset: HarnessPreset, file: string) {
  const overrides = loadPluginOverrides(file)
  // Listing does not touch the sandbox or session log; placeholder roots keep
  // the row configs representative without requiring the host's real paths.
  const rows = pluginRows({
    sessionsRoot: join(homedir(), ".alwith-dsh", "sessions"),
    workspaceRoot: process.cwd(),
    permissionMode: "workspace-write",
    preset,
  })
  return { preset, file, plugins: resolvePlugins(rows, overrides).listing }
}

/** Rejects an overrides state that any preset would refuse to compose. */
function assertValidAcrossPresets(overrides: ReturnType<typeof loadPluginOverrides>): void {
  for (const preset of HARNESS_PRESETS) {
    const rows = pluginRows({ sessionsRoot: "/", workspaceRoot: "/", permissionMode: "workspace-write", preset })
    resolvePlugins(rows, overrides)
  }
}

export async function runPluginsCli(argv: string[]): Promise<void> {
  const { preset, file, positional } = parseFlags(argv)
  const [command, ...rest] = positional
  if (command === "list") {
    process.stdout.write(`${JSON.stringify(listingFor(preset, file))}\n`)
    return
  }
  if (command === "set") {
    const [id, state] = rest
    if (id === undefined || (state !== "enabled" && state !== "disabled")) {
      throw new Error('usage: plugins set <id> <enabled|disabled> [--file <path>]')
    }
    const overrides = loadPluginOverrides(file)
    const disabled = new Set(overrides.disabled ?? [])
    if (state === "disabled") disabled.add(id)
    else disabled.delete(id)
    const next = { ...overrides, disabled: [...disabled].sort() }
    // Validate before touching disk: the file must never hold a state compose would refuse.
    assertValidAcrossPresets(next)
    savePluginOverrides(file, next)
    process.stdout.write(`${JSON.stringify(listingFor(preset, file))}\n`)
    return
  }
  throw new Error(`unknown plugins command "${command ?? ""}": expected list or set`)
}
