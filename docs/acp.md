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

| 方法                     | ama 的行为                                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize`             | `protocolVersion: 1`；`loadSession: true`，`sessionCapabilities: { list, resume, close }`，`promptCapabilities: { image: true, embeddedContext: true }`；认证见「无模型时」 |
| `session/new`            | 新开会话（启动时那个空会话第一次直接认领）；`cwd` 必须是 ama 的启动目录（按 realpath 比较），否则 invalid params                                                            |
| `session/load`           | 切到该会话并以 `session/update` 回放历史（用户消息、回复、思考、工具调用）                                                                                                  |
| `session/resume`         | 切到该会话，不回放                                                                                                                                                          |
| `session/list`           | 启动目录下的会话（标题取会话名或首条提示）                                                                                                                                  |
| `session/close`          | 中断运行并释放活动会话                                                                                                                                                      |
| `session/prompt`         | 文本与图片照收；`resource_link` 以 `@uri` 文本给出，嵌入资源取文本。回合结束：中断 → `cancelled`，输出截断 → `max_tokens`，出错 → JSON-RPC 错误                             |
| `session/cancel`（通知） | 中断当前回合                                                                                                                                                                |
| `session/set_mode`       | 模式 id 就是 ama 的权限模式（`plan`、`allowlist`、`default`、`auto-edit`、`auto`、`full-auto`）                                                                             |

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

### 无模型时

没有可用模型（没配 key、没 `--model`、`config.defaultModel` 不可用）时 `ama --mode acp` 不再以退出码 4 结束，而是照常握手，等用户登录：

| 请求                    | 无模型时的行为                                                                                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `initialize`            | 照常回答；客户端声明 `clientCapabilities.auth.terminal` 时 `authMethods` 给两条 terminal 方法，否则为空                                                                                                                                                      |
| 会话方法（`session/*`） | 先重试整段启动（距上次失败至少 1 s，并发请求共用一次）：成功则同一条连接交给正常的服务端处理本次与之后的请求（不必重新 `initialize`）；仍无模型 → `-32000`，`message` 是无模型引导（列出 key 环境变量与 `ama auth set`），`data.authMethods` 是已给方法的 id |
| `authenticate`          | `-32602`：terminal 方法按规范不经 `authenticate`                                                                                                                                                                                                             |
| 其它                    | `-32601`；交接前的通知忽略                                                                                                                                                                                                                                   |

两条 terminal 方法（客户端用启动 Agent 的同一条命令、换成这些参数在终端里起子进程）：

| id        | 参数                 | 作用                                                                 |
| --------- | -------------------- | -------------------------------------------------------------------- |
| `chatgpt` | `auth login chatgpt` | ChatGPT 订阅登录（浏览器 OAuth）                                     |
| `api-key` | `auth set`           | 方向键选内置的需 key 供应商，再粘贴 key（不回显，写 auth.json 0600） |

启动时给了 `--auth-file`（或 profile 的 `authFile`）时两条方法都追加 `--auth-file <绝对路径>`，登录写到 ama 读的同一个文件。登录完成后客户端再开会话即可，不用重启 ama。stdin 关闭时退出 0（已交接则同下节）。失败的重试停在模型解析这一步，不加载宿主、不跑 SessionStart Hook。

Zed 的配置（`settings.json`）：

```json
{
  "agent_servers": {
    "ama": {
      "type": "custom",
      "command": "ama",
      "args": ["--mode", "acp"],
      "env": {}
    }
  }
}
```

没配模型时 Zed 打开 ama 的线程会提示登录，点登录方式后在 Zed 的终端里跑上表的命令；也可以先在任意终端 `ama auth set` / `ama auth login chatgpt`，或在 `env` 里给 key 环境变量。

### 配置项与命令

开会话（new / load / resume）的答复带 `configOptions`，之后发一条 `available_commands_update`：

| 配置项 id  | category        | 可选值                                                                                                                                                                                                                                                                       |
| ---------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`    | `model`         | 按供应商分组，值 `provider/model-id`（多渠道的渠道行带 `@渠道`）；口径与 TUI `/model` 的「已配置」视图相同：只列有 key、OAuth 已登录或本地的供应商，设了 `models.enabled` 只列清单内的，测试供应商 `fake` 缺省藏起；当前模型总在列。没配 key 的供应商不列，先 `ama auth set` |
| `thinking` | `thought_level` | 当前模型支持的思考级别（`off`…`xhigh`，非推理模型只有 `off`）                                                                                                                                                                                                                |

- 不给 `mode` 类别的配置项：模式只走 `modes` / `session/set_mode`，免得客户端出现两个模式切换。没有 boolean 型配置项。
- `session/set_config_option`：`model` → 切模型，`thinking` → 改思考级别，答复是全部配置项的新状态；未知 id、找不到的模型、不认识的级别回 invalid params（-32602）。模型或级别在会话里变了（含 plan 流程自动切换）时发 `config_option_update`。
- 命令表：Skill 列为 `skill:<名字>`，提示模板列为 `<名字>`（frontmatter 的 `argument-hint` 作 `input.hint`）。这两类在 prompt 文本里本来就会展开（`/skill:<名字> …`、`/<名字> …`）。`/new`、`/compact` 等内置斜杠命令在 ACP 下不执行，不列。

### 退出

stdin 关闭后等已开始的运行结束再退出（0）；`ama` 进程的 stdout 从启动第一步起只给协议（宿主 / Hook 加载期的 `console.log` 改写到 stderr）；SIGINT / SIGTERM 中断后退出 130 / 143。宿主看到的模式是 `rpc`（`HostApi.mode`）。SDK 直接 `bootstrap(--mode acp)` 时得到 `mode: "rpc"` 的 Runtime，再交给 `runAcpMode`。

## 作为客户端

模型经 `task(agent="acp:<程序>")` 使用 ACP Agent（ama 自己是 `task(agent="acp:ama")`，见 [agents.md](agents.md)「在 task 里使用」）。

`AcpClient`（`@armadra/agent/acp`）：`initialize`、`newSession`、`resumeSession`（优先，不回放）、`loadSession`、`listSessions`、`closeSession`、`prompt`、`setMode`、`cancel`。

- 声明的客户端能力：`session.configOptions: {}`（接 select 型配置项，不声明 boolean）；不声明 `fs` / `terminal`（Agent 发来的
  `fs/*`、`terminal/*` 请求回 method not found），也不声明 `auth.terminal`（ama 没有可借给 Agent 的交互终端）。
- 线路两侧开 `$/cancel_request`：本端请求的 `signal` 在发出后 abort 会通知 Agent 撤回；Agent 撤回挂起的
  `session/request_permission` / `elicitation/create` 时处理器的 `signal` abort，答 `cancelled` / `cancel`（处理器之后给的选择不作数）。
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

`AcpDriver` 在客户端之上实现驱动契约（`AgentDriver`）：

- 续接优先 `session/resume`，其次 `session/load`（回放的历史丢弃），都不支持就新开并提示。
- 按 ama 模式 `session/set_mode`；Agent 不给 `modes` 时退到 `configOptions` 里 category `mode` 的选择项，同一映射找值后经
  `session/set_config_option` 设置。两处都找不到对应模式时：只读模式拒绝启动，其它模式用 Agent 的缺省模式并提示。
- 开会话回 -32000（需要登录）时报 `agent_auth_required`，文案列出 `initialize` 给的认证方法；terminal 型附上要在终端里跑的
  命令（Agent 程序 + 它的参数 + 方法的 `args`）。ama 不替人登录。
- 取消回合后 Agent 以 -32800（请求被撤回）答 `session/prompt` 时视为 `cancelled`；没取消时照常报错。
- 工具内容里 `diff` 的 `path` 并入该调用的 `locations`，调用完成后计入 `filesTouched`（不论 Agent 报的工具种类）。

## 测试替身

`runFakeAcpAgent(input, output)` 是进程内的假 ACP Agent，`fakeAcpAgentPath()` 是它的可执行入口（`node <path> [--minimal]`）。行为由提示里的标记决定：`[permission]`（请求权限，四个选项）、`[slow]`（等到 cancel）、`[plan]`、`[think]`、`[refuse]`，其余回 `echo: <文本>`。`--minimal` 不声明 resume / load / list / close，也不给模式，用来测降级路径。另有 `[elicit]`（发 `elicitation/create`，客户端没声明能力时回 `elicit: unsupported`）、`[model]`、`[env NAME]`（只回值的 sha256）三个标记；`--config-options`（进程内 `{ configOptions: true }`）让开会话答一个 `model` 配置项（选项按组给出）并接 `session/set_config_option`。

| 标记 / 参数                                          | 行为                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--config-only`（`{ configOnly: true }`）            | 开会话不给 `modes`，改在 `configOptions` 里给 category `mode` 的选择项（id `mode`），经 `session/set_config_option` 切换；可与 `--config-options` 同开 |
| `--auth-required`（`{ authRequired: true }`）        | `initialize` 给一条 terminal 型认证方法（id `login`），`session/new` / `load` / `resume` 一律回 -32000                                                 |
| `[cancel-request]`（`{ cancelRequestMs }` 缺省 2 s） | 发权限请求，挂起到期后 Agent 自己发 `$/cancel_request` 撤回，工具调用 failed，回 `permission withdrawn` 与 `end_turn`                                  |

假 Agent 的线路两侧都开着 `$/cancel_request`。仓库内的 `test/helpers/acp-schema.ts` 用官方 v1 schema（1.24.1，`test/fixtures/acp/schema-v1.24.1.json`）逐条校验线路：`assertAcpWire(wire)`。

黄金记录在 `test/fixtures/acp/`：`driver-{allow,reject,cancel}.jsonl`（ama 驱动假 Agent 的三条路径）与 `mode-prompt.jsonl`（`ama --mode acp` 一轮往返）。`UPDATE_GOLDEN=1` 重写。

## 兼容性

按 ACP v1（含 2026 年稳定的 `session/list`、`session/resume`、`session/close`、`usage_update`）。v2 计划取消 `session/load`，ama 作客户端时已优先 `resume`。
