/**
 * Subscription OAuth for the pi-ai seat.
 *
 * pi-ai ships the flows (anthropic = Claude Pro/Max, openai-codex, …) and
 * refreshes stored OAuth credentials inside `Models.getAuth()` under the
 * store lock; what it does not own is persistence and login orchestration —
 * both app-owned by contract. This module provides:
 *
 * - a file-backed CredentialStore (`ALWITH_DSH_OAUTH_CREDENTIALS`, default
 *   `~/.alwith-dsh/credentials.json`, mode 0600, per-provider serialized
 *   writes) injected into the patched adapter (see patches/),
 * - the `oauth login/status/logout` CLI. `login` emits interaction events as
 *   JSON lines on stdout (`{"type":"url",…}` → the host opens the browser);
 *   the flow's local callback server completes the exchange.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { AuthInteraction, Credential, CredentialInfo, CredentialStore, OAuthAuth } from "@earendil-works/pi-ai"

export function defaultCredentialsFile(): string {
  return process.env.ALWITH_DSH_OAUTH_CREDENTIALS ?? join(homedir(), ".alwith-dsh", "credentials.json")
}

/** Providers with a wired subscription login. Extending = one line per flow. */
const OAUTH_PROVIDERS: Record<string, () => Promise<OAuthAuth>> = {
  anthropic: async () => {
    const { anthropicProvider } = await import("@earendil-works/pi-ai/providers/anthropic")
    const oauth = anthropicProvider().auth.oauth
    if (!oauth) throw new Error("pi-ai anthropic provider no longer declares an OAuth flow")
    return oauth
  }
}

export const OAUTH_PROVIDER_IDS = Object.keys(OAUTH_PROVIDERS)

/**
 * File-backed pi-ai CredentialStore: one JSON object keyed by provider id,
 * mode 0600. Writes are serialized per provider through a promise chain
 * (`modify` is the only write path — pi-ai refreshes tokens inside it).
 */
export class FileCredentialStore implements CredentialStore {
  private readonly chains = new Map<string, Promise<unknown>>()

  constructor(private readonly file: string) {}

  private load(): Record<string, Credential> {
    if (!existsSync(this.file)) return {}
    return JSON.parse(readFileSync(this.file, "utf8")) as Record<string, Credential>
  }

  private save(all: Record<string, Credential>): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, `${JSON.stringify(all, null, 2)}\n`)
    chmodSync(this.file, 0o600)
  }

  private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(providerId) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.chains.set(providerId, next)
    return next
  }

  read(providerId: string): Promise<Credential | undefined> {
    return Promise.resolve(this.load()[providerId])
  }

  list(): Promise<readonly CredentialInfo[]> {
    return Promise.resolve(
      Object.entries(this.load()).map(([providerId, credential]) => ({ providerId, type: credential.type }))
    )
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    return this.enqueue(providerId, async () => {
      const all = this.load()
      const next = await fn(all[providerId])
      if (next !== undefined) {
        all[providerId] = next
        this.save(all)
      }
      return all[providerId]
    })
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(providerId, async () => {
      const all = this.load()
      if (providerId in all) {
        delete all[providerId]
        this.save(all)
      }
    })
  }
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

async function flowOf(providerId: string): Promise<OAuthAuth> {
  const load = OAUTH_PROVIDERS[providerId]
  if (!load) {
    throw new Error(`no subscription login wired for "${providerId}" (available: ${OAUTH_PROVIDER_IDS.join(", ")})`)
  }
  return load()
}

/**
 * Interaction callbacks for a host-driven login. Events pass through verbatim
 * as JSON lines (auth_url / info / progress / device_code) — the host opens
 * auth_url. A prompt carrying `signal` is an alternative input path raced
 * against the flow's callback server (e.g. anthropic's paste-the-redirect-URL
 * `manual_code`); answering is optional, so it stays pending until pi-ai
 * aborts it after login settles (the rejection lands in the flow's own
 * `.catch`). A signal-less prompt is required input this non-interactive host
 * cannot supply — fail loud rather than hang.
 */
export function hostLoginInteraction(): AuthInteraction {
  return {
    notify: event => emit({ ...event }),
    prompt: prompt =>
      new Promise<string>((_resolve, reject) => {
        if (!prompt.signal) {
          reject(new Error(`interactive prompt not supported in host login flow: ${JSON.stringify(prompt)}`))
          return
        }
        prompt.signal.addEventListener(
          "abort",
          () => reject(new Error(`prompt "${prompt.type}" cancelled: login settled out of band`)),
          { once: true }
        )
      })
  }
}

/** `oauth login <provider>` / `oauth status` / `oauth logout <provider>`; stdout is JSON lines. */
export async function runOauthCli(argv: string[]): Promise<void> {
  const [command, providerId] = argv
  const store = new FileCredentialStore(defaultCredentialsFile())

  if (command === "status") {
    emit({ type: "status", credentials: await store.list() })
    return
  }
  if (command === "logout") {
    if (!providerId) throw new Error("usage: oauth logout <provider>")
    await store.delete(providerId)
    emit({ type: "logged-out", providerId })
    return
  }
  if (command === "login") {
    if (!providerId) throw new Error("usage: oauth login <provider>")
    const flow = await flowOf(providerId)
    const credential = await flow.login(hostLoginInteraction())
    await store.modify(providerId, async () => credential)
    emit({ type: "logged-in", providerId })
    return
  }
  throw new Error(`unknown oauth command "${command ?? ""}": expected login, status or logout`)
}
