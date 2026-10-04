# ACP（Agent Client Protocol）

ama 在 ACP 两侧都能用：

- **服务端**：`ama --mode acp` 把 ama 暴露为 ACP Agent，供 Zed、JetBrains、Armadra 的 ACP 节点驱动；
- **客户端**：ama 经 ACP 驱动外部 Agent（Gemini CLI、OpenCode、Kimi、Copilot 等原生 ACP，或装了适配器的 Claude Code / Codex），见 [agents.md](agents.md)。

协议栈零依赖、手写，只维护一份：`@armadra/agent/acp` 导出类型、分帧、客户端与假 Agent，Armadra 直接复用。设计依据见 [wave5-plan.md](wave5-plan.md) §5（D14）。

## 线路

JSON-RPC 2.0 over NDJSON（stdio）：只按 `\n` 切行，64 KiB 分片写并等待背压，与 [rpc.md](rpc.md) 的「线路」一致。stdout 只有协议行，诊断写 stderr。由客户端以 `initialize` 起头，没有 `hello`。

## `ama --mode acp`

```sh
ama --mode acp                      # 与 -p 互斥；其余参数（--model、--profile、--trust 等）照常
```

| 方法                     | ama 的行为                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize`             | `protocolVersion: 1`；`loadSession: true`，`sessionCapabilities: { list, resume, close }`，`promptCapabilities: { image: true, embeddedContext: true }`；不要认证 |
| `session/new`            | 新开会话（启动时那个空会话第一次直接认领）；`cwd` 必须是 ama 的启动目录（按 realpath 比较），否则 invalid params                                                  |
| `session/load`           | 切到该会话并以 `session/update` 回放历史（用户消息、回复、思考、工具调用）                                                                                        |
| `session/resume`         | 切到该会话，不回放                                                                                                                                                |
| `session/list`           | 启动目录下的会话（标题取会话名或首条提示）                                                                                                                        |
| `session/close`          | 中断运行并释放活动会话                                                                                                                                            |
| `session/prompt`         | 文本与图片照收；`resource_link` 以 `@uri` 文本给出，嵌入资源取文本。回合结束：中断 → `cancelled`，输出截断 → `max_tokens`，出错 → JSON-RPC 错误                   |
| `session/cancel`（通知） | 中断当前回合                                                                                                                                                      |
| `session/set_mode`       | 模式 id 就是 ama 的权限模式（`plan`、`allowlist`、`default`、`auto-edit`、`auto`、`full-auto`）                                                                   |

一次只有一个活动会话；对非活动会话发 `session/prompt` 时（空闲）先切过去，运行中切换报 invalid request。

### 事件映射

| ama                 | `session/update`                                                                   |
| ------------------- | ---------------------------------------------------------------------------------- |
| 文本增量 / 思考增量 | `agent_message_chunk` / `agent_thought_chunk`                                      |
| 模型发出工具调用    | `tool_call`（`pending`，带 `rawInput`、`kind`、`locations`）                       |
| 工具开始 / 结束     | `tool_call_update`（`in_progress` → `completed` / `failed`，结果只带前 4 KB 文本） |
| `todo` 更新         | `plan`                                                                             |
| 每轮结束            | `usage_update`（上下文已用、窗口、会话累计美元）                                   |
| 权限模式变化        | `current_mode_update`                                                              |

codemode 内层调用不单列。`session/prompt` 的结果带本回合 token 用量（`inputTokens`、`outputTokens`、`cachedReadTokens`、`cachedWriteTokens`、`totalTokens`）。

### 审批

ama 需要询问的调用经 `session/request_permission` 交给客户端，三个选项：`allow_once`（允许）、`allow_always`（本会话允许）、`reject_once`（拒绝）。`toolCall.toolCallId` 关联到先前 `tool_call` 的 id。客户端回 `cancelled`、连接断开或回合被中断时，按无人作答处理（拒绝）。auto 模式下 ama 自己的分类器照常工作——这只影响 ama 自己的工具；ama 驱动的外部 Agent 发来的请求只交给人（见 [agents.md](agents.md)）。

不声明、也不使用客户端的 `fs` / `terminal` 能力：ama 自己读写、自己跑命令，按自己的权限管线。

### 退出

stdin 关闭后等已开始的运行结束再退出（0）；SIGINT / SIGTERM 中断后退出 130 / 143。宿主看到的模式是 `rpc`（`HostApi.mode`）。SDK 直接 `bootstrap(--mode acp)` 时得到 `mode: "rpc"` 的 Runtime，再交给 `runAcpMode`。

## 作为客户端

模型经 `task(agent="acp:<程序>")` 使用 ACP Agent（ama 自己是 `task(agent="acp:ama")`，见 [agents.md](agents.md)「在 task 里使用」）。

`AcpClient`（`@armadra/agent/acp`）：`initialize`、`newSession`、`resumeSession`（优先，不回放）、`loadSession`、`listSessions`、`closeSession`、`prompt`、`setMode`、`cancel`。

- 声明的客户端能力为空：Agent 发来的 `fs/*`、`terminal/*` 请求回 method not found。
- `session/request_permission` 交给 `onPermission`；没有处理器时回首个 `reject_once`（无人值守）。
- `cancel(sessionId)` 发 `session/cancel`，并让该会话挂起的权限请求回 `cancelled`（规范要求）。
- 只接受 Agent 自己给出的 `optionId`。
- 开会话（`newSession` / `resumeSession` / `loadSession`）的 `mcpServers` 缺省为空数组；宿主可传第三个参数
  `{ mcpServers }`（如 stdio 的 `{ name, command, args, env: [{ name, value }] }`），原样转发给 Agent。
  `AcpClient.features.mcpServers === true` 表示支持（旧版没有 `features`）。ama 自己作客户端时仍不传。
- `elicitation/create`（Agent 向人要结构化输入）：构造参数给了 `onElicitation(params, signal)` 才在 `initialize` 声明
  `clientCapabilities.elicitation` 并接这个请求；没给时不声明、请求回 method not found（与旧版相同）。答复收成
  `{ action: "accept" | "decline" | "cancel", content? }`（`content` 只随 accept，不认识的动作当 cancel）；`cancel(sessionId)`
  与连接关闭时挂起的一律回 `{ action: "cancel" }`。ama 自己作客户端时不给处理器，从不替人填表。
- 会话配置项：开会话（new / load / resume）答的 `configOptions` 原样交回；`setConfigOption(sessionId, configId, value)` 发
  `session/set_config_option`，答复是全部配置项的新状态。
- `AcpClient.features`：`{ mcpServers, elicitation, configOptions }`，宿主据此做特性检测。

`AcpDriver` 在客户端之上实现驱动契约（`AgentDriver`）：续接优先 `session/resume`，其次 `session/load`（回放的历史丢弃），都不支持就新开并提示；按 ama 模式 `session/set_mode`，只读模式找不到对应模式 id 时拒绝启动。

## 测试替身

`runFakeAcpAgent(input, output)` 是进程内的假 ACP Agent，`fakeAcpAgentPath()` 是它的可执行入口（`node <path> [--minimal]`）。行为由提示里的标记决定：`[permission]`（请求权限，四个选项）、`[slow]`（等到 cancel）、`[plan]`、`[think]`、`[refuse]`，其余回 `echo: <文本>`。`--minimal` 不声明 resume / load / list / close，也不给模式，用来测降级路径。另有 `[elicit]`（发 `elicitation/create`，客户端没声明能力时回 `elicit: unsupported`）、`[model]`、`[env NAME]`（只回值的 sha256）三个标记；`--config-options`（进程内 `{ configOptions: true }`）让开会话答一个 `model` 配置项并接 `session/set_config_option`。

黄金记录在 `test/fixtures/acp/`：`driver-{allow,reject,cancel}.jsonl`（ama 驱动假 Agent 的三条路径）与 `mode-prompt.jsonl`（`ama --mode acp` 一轮往返）。`UPDATE_GOLDEN=1` 重写。

## 兼容性

按 ACP v1（含 2026 年稳定的 `session/list`、`session/resume`、`session/close`、`usage_update`）。v2 计划取消 `session/load`，ama 作客户端时已优先 `resume`。
