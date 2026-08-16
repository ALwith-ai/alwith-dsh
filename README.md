# alwith-dsh

English | [中文](README.zh.md)

An **interactive ACP v2 bridge** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): exposes a dsh agent as a chat backend that desktop/editor clients can host — token-level streaming, run-state reporting (`state_update`), permission bridging, and cancellation. Ships as an out-of-tree plugin: no fork of dsh, dependencies pinned to exact npm versions.

Maintained by [ALwith](https://github.com/ALwith-ai); **ALwith Desktop is its reference client** (the desktop form of dsh). Upstream's own ACP surface is deliberately automation-only (fresh sessions, committed output only); this bridge provides the interactive side.

> Status: developer preview. Covers `session/new` + prompt + streaming + run-state reporting + cancel + `session/resume` (live-first reattach, cold resume from JSONL persistence, client-driven `replayFrom` history replay) + sandbox-first tools with escalation approvals + in-session model switching (`session/set_config_option`) + session titles + presets (`standard` / `minimal` / `anchored`).

## Layout

| File | Responsibility |
|---|---|
| `src/bridge.ts` | ACP v2 server plugin (adapted from upstream's automation-only v1 bridge, MIT) |
| `src/codec.ts` | Pure wire-format translation (adapted from the upstream codec) |
| `src/compose.ts` | Hand-composed plugin set (no dsh loader/profile — deterministic composition, runs on Bun) |
| `src/main.ts` | stdio entry for hosts to spawn |

## Run

```sh
DEEPSEEK_API_KEY=… bun src/main.ts   # ACP v2 server over stdio
bun test                              # protocol tests with a mock adapter; no real model calls
```

`session/resume` semantics: an omitted `replayFrom` means context-only restore; `{ type: "start" }` replays the whole conversation as `session/update` frames. Session logs live under `$ALWITH_DSH_SESSIONS_ROOT` (default `~/.alwith-dsh/sessions`).

## License

[MIT](LICENSE); portions adapted from upstream `@deepseek-ai/dsh-acp` are noted in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
