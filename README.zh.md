# alwith-dsh

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(dsh)的**交互式 ACP v2 桥**:把 dsh agent 暴露成可被桌面/编辑器客户端托管的聊天后端——逐 token 流、运行态直报(`state_update`)、权限桥、取消。树外插件形态,不 fork dsh,依赖钉死 npm 精确版本。

由 [ALwith](https://github.com/ALwith-ai) 维护;**ALwith Desktop 是它的参考客户端**(dsh 的桌面端形态)。上游的 ACP 实现是刻意的 automation-only(仅新会话、只发已提交输出),本桥补齐交互式一侧。

> 状态:developer preview。MVP 覆盖 `session/new` + prompt + 流式 + 状态直报 + cancel;`session/resume`(接上会话 + 历史回放)与 Agent 预设下发开发中。

## 结构

| 文件 | 职责 |
|---|---|
| `src/bridge.ts` | ACP v2 服务器插件(改编自上游 automation-only v1 桥,MIT) |
| `src/codec.ts` | 线格式纯转换(改编自上游 codec) |
| `src/compose.ts` | 手工组合的插件集(不用 dsh loader/profile——组合确定性,Bun 可跑) |
| `src/main.ts` | stdio 入口,供宿主 spawn |

## 运行

```sh
DEEPSEEK_API_KEY=… bun src/main.ts   # stdio 上的 ACP v2 服务器
bun test                              # mock 适配器协议测试,不打真模型
```

MVP 范围:`session/new` + prompt + cancel。`session/resume`(接上会话 + 历史回放)与 Agent 预设下发在里程碑 2。

## License

[MIT](LICENSE);改编自上游 `@deepseek-ai/dsh-acp` 的部分见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
