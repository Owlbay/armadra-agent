# ACP（Agent Client Protocol）

[English](en/acp.md) · 简体中文

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

| 方法                        | ama 的行为                                                                                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize`                | `protocolVersion: 1`；`loadSession: true`，`sessionCapabilities: { list, resume, close }`，`promptCapabilities: { image: true, embeddedContext: true }`；有模型时 `authMethods` 为空（无模型见下文「无模型时」） |
| `authenticate`              | -32602：ama 只给 terminal 型认证方法，按规范不经 `authenticate`（有无模型都一样）                                                                                                                                |
| `session/new`               | 新开会话（启动时那个空会话第一次直接认领），运行中也可调；`cwd` 必须是 ama 的启动目录（按 realpath 比较），否则 invalid params                                                                                   |
| `session/load`              | 打开该会话并以 `session/update` 回放历史（用户消息、回复、思考、工具调用）；已打开的直接从内存回放                                                                                                               |
| `session/resume`            | 打开该会话，不回放。load / resume 的 id 找不到会话文件时：是 UUID 就按原 id 新建一个空会话（空会话不落盘，ama 重启后 Zed 的 Reload Agent 等会带着它回来），否则 -32002                                           |
| `session/list`              | 启动目录下的会话：`cwd` 给了别的目录回空列表；每页 50 条（`updatedAt` 降序），`nextCursor` 翻页，非法 `cursor` → invalid params；标题取会话名或首条提示（去掉嵌入资源块后的首行，≤ 80 字）                       |
| `session/close`             | 中断该会话的运行（排队的提示回 `cancelled`），释放并移出本连接；之后对这个 id 发请求回 -32002，要再用先 `session/load` / `session/resume`                                                                        |
| `session/prompt`            | 文本与图片照收；`resource_link` 以 `@uri` 文本给出，嵌入资源取文本。别的会话在跑时排队；未打开的 id 回 -32002。回合结束：中断 → `cancelled`，输出截断 → `max_tokens`，拒答 → `refusal`，出错 → JSON-RPC 错误     |
| `session/cancel`（通知）    | 在跑 → 中断；排队中 → 直接回 `cancelled`                                                                                                                                                                         |
| `$/cancel_request`（通知）  | 撤回一个挂起的 `session/prompt`：等同 `session/cancel`，该请求答 -32800。反方向见「审批」                                                                                                                        |
| `session/set_mode`          | 模式 id 就是 ama 的权限模式（`plan`、`allowlist`、`default`、`auto-edit`、`auto`、`full-auto`）；按会话记，见下文「多会话」                                                                                      |
| `session/set_config_option` | 改会话配置项，答复是全部配置项的新状态；见下文「配置项与命令」                                                                                                                                                   |

`session/new` / `load` / `resume` 的 `mcpServers`、`additionalDirectories` 不生效：非空时 stderr 记一行后照常打开会话（理由见「偏离与不做」）。未实现的方法（`session/delete`、`logout` 等）回 -32601。

### 多会话

一个 `ama --mode acp` 进程可以同时打开多个会话（Zed 的多个线程共用一个连接）：

- 每个打开的会话常驻内存，没发过消息的空会话切走再切回也找得到（空会话不落盘）。
- **同一时刻只跑一个回合**：别的会话在跑时，`session/prompt` 进先进先出队列，前一个结束后再开始，不再报 busy。
  `session/new`、`load`、`resume`、`list`、`set_mode`、`set_config_option`、`close` 随时可调。
- 回合开始时该会话切为「前台」：宿主（`HostApi.session.*`）、Hook 的公共字段、工具看到的会话都换成它，并清掉
  「本会话允许」的记忆（切回来要重新允许，与 TUI `/resume` 一致）。
- 权限模式按会话记：对前台会话 `set_mode` 立即生效；对其它会话只记下（照样发 `current_mode_update`），轮到它跑时
  再应用到权限管线，并再发一条 `current_mode_update`。所以对排队中的会话改模式不会影响正在跑的那个。
- 每个回合结束后发 `session_info_update`（`updatedAt`，标题变了才带 `title`）。
- 关掉一个会话只释放它（跑 SessionEnd Hook）；stdin 关闭时排队的提示回 `cancelled`，等在跑的结束，再依次释放全部会话。

### 事件映射

| ama                                 | `session/update`                                                                                                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 文本增量 / 思考增量                 | `agent_message_chunk` / `agent_thought_chunk`                                                                                                                                                                                  |
| 模型发出工具调用                    | `tool_call`（`pending`，带 `name`、`rawInput`、`kind`、`locations`）                                                                                                                                                           |
| codemode 脚本里的内层调用开始       | `tool_call`（`pending`，`title` 前缀 `codemode › `，`_meta.ama.parentToolCallId` 指向外层 `codemode` 调用），随后 `in_progress`                                                                                                |
| 工具开始                            | `tool_call_update`（`in_progress`）                                                                                                                                                                                            |
| 工具结束（含内层）                  | `tool_call_update`（`completed` / `failed`）；`content` 为 `[diff?, 文本]`：edit / write 带 `diff`（`path`、`oldText`、`newText`，新文件 `oldText: null`），文本只带前 4 KB；`locations[].line` 是首个改动行；不发 `rawOutput` |
| `todo` 更新                         | `plan`                                                                                                                                                                                                                         |
| 每轮结束                            | `usage_update`（上下文已用、窗口、会话累计美元）                                                                                                                                                                               |
| 权限模式变化                        | `current_mode_update`                                                                                                                                                                                                          |
| 模型 / 思考级别变化                 | `config_option_update`（全部配置项）                                                                                                                                                                                           |
| 会话开出（new / load / resume）之后 | `available_commands_update` 与 `config_option_update`                                                                                                                                                                          |
| 回合结束之后                        | `session_info_update`（`updatedAt`；标题与上次不同才带 `title`）                                                                                                                                                               |

diff 的改前 / 改后全文只随实时事件走，不写进会话文件：任一侧超过 256 KiB 不带 diff，`session/load` 回放的工具结果只有前 4 KB 文本。模式列表的 `name` 是显示名（如 `Manual`、`Accept edits`），`description` 随界面语言。`session/prompt` 的结果带本回合 token 用量 `usage`（`inputTokens`、`outputTokens`、`cachedReadTokens`、`cachedWriteTokens`、`totalTokens`）；该字段在 schema 1.24.1 里仍是 UNSTABLE（只在不稳定 schema 中），客户端可以忽略，以 `usage_update` 为准。

`toolCallId` 在会话内唯一：上游供应商给的 id 若在后续回合重复（个别兼容接口的兜底 id、测试用假模型），线上 id 加 `#2`、`#3`… 区分，之后的状态更新、审批与回放都按这个映射（客户端按 id 合并条目，不区分会把不同调用合成一条）。

### 审批

ama 需要询问的调用经 `session/request_permission` 交给客户端，三个选项：`allow_once`（允许）、`allow_always`（本会话允许）、`reject_once`（拒绝）。`toolCall.toolCallId` 关联到先前 `tool_call` 的 id——codemode 内层调用也是，指向那条内层 `tool_call`，不是外层 `codemode`。询问期间该调用的状态回到 `pending`，允许后再 `in_progress`（所以有审批的调用依次是 `pending → in_progress → pending → in_progress → completed`）；拒绝时直接 `failed`。客户端回 `cancelled`、连接断开或回合被中断时，按无人作答处理（拒绝）。ama 这边不再需要答复时（回合被 `session/cancel` / `$/cancel_request` 中断、审批 10 分钟超时），以 `$/cancel_request { requestId }` 撤回挂起的 `session/request_permission`，客户端可以关掉对话框。auto 模式下 ama 自己的分类器照常工作——这只影响 ama 自己的工具；ama 驱动的外部 Agent 发来的请求只交给人（见 [agents.md](agents.md)）。

### 无模型时

没有可用模型（没配 key、没 `--model`、`config.defaultModel` 不可用）时 `ama --mode acp` 不再以退出码 4 结束，而是照常握手，等用户登录：

| 请求                    | 无模型时的行为                                                                                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `initialize`            | 照常回答；客户端声明 `clientCapabilities.auth.terminal` 时 `authMethods` 给两条 terminal 方法，否则为空                                                                                                                                                      |
| 会话方法（`session/*`） | 先重试整段启动（距上次失败至少 1 s，并发请求共用一次）：成功则同一条连接交给正常的服务端处理本次与之后的请求（不必重新 `initialize`）；仍无模型 → `-32000`，`message` 是无模型引导（列出 key 环境变量与 `ama auth set`），`data.authMethods` 是已给方法的 id |
| `authenticate`          | `-32602`：terminal 方法按规范不经 `authenticate`                                                                                                                                                                                                             |
| 其它                    | `-32601`；交接前的通知忽略                                                                                                                                                                                                                                   |

两条 terminal 方法。按规范，客户端把 `args` **追加**到配置好的启动命令后面、在终端里起子进程（例如 `ama --mode acp --acp-terminal-auth api-key`）；ama 见到 `--acp-terminal-auth` 就忽略其余启动参数（`--mode acp`、`--model` 等），改跑对应的 `auth` 子命令，同一条命令里的 `--auth-file`、`--lang` 照用：

| id        | `args`                        | 等同于                   | 作用                                                                 |
| --------- | ----------------------------- | ------------------------ | -------------------------------------------------------------------- |
| `chatgpt` | `--acp-terminal-auth chatgpt` | `ama auth login chatgpt` | ChatGPT 订阅登录（浏览器 OAuth）                                     |
| `api-key` | `--acp-terminal-auth api-key` | `ama auth set`           | 方向键选内置的需 key 供应商，再粘贴 key（不回显，写 auth.json 0600） |

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

没配模型时 Zed 打开 ama 的线程会提示登录，点登录方式后 Zed 在它的终端里跑上表的登录流程，成功退出后自动重试开会话；也可以先在任意终端 `ama auth set` / `ama auth login chatgpt`，或在 `env` 里给 key 环境变量。

### 配置项与命令

开会话（new / load / resume）的答复带 `configOptions`，之后发一条 `available_commands_update`：

| 配置项 id  | category        | 可选值                                                                                                                                                                                                                                                                       |
| ---------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`     | `mode`          | ama 的权限模式（`plan`、`allowlist`、`default`、`auto-edit`、`auto`、`full-auto`），与 `modes` 同一状态                                                                                                                                                                      |
| `model`    | `model`         | 按供应商分组，值 `provider/model-id`（多渠道的渠道行带 `@渠道`）；口径与 TUI `/model` 的「已配置」视图相同：只列有 key、OAuth 已登录或本地的供应商，设了 `models.enabled` 只列清单内的，测试供应商 `fake` 缺省藏起；当前模型总在列。没配 key 的供应商不列，先 `ama auth set` |
| `thinking` | `thought_level` | 当前模型支持的思考级别（`off`…`xhigh`，非推理模型只有 `off`）                                                                                                                                                                                                                |

- `mode` 与 `modes` / `session/set_mode` 是同一状态：规范要求客户端有 `configOptions` 时用它代替 `modes`（Zed 给了就不再看 `modes`），所以模式也放进配置项；`modes` 照给，留给只认 `modes` 的客户端。设 `mode` 与 `session/set_mode` 一样按会话记，变化时 `current_mode_update` 与 `config_option_update` 都发。没有 boolean 型配置项。
- `session/set_config_option`：`mode` → 改权限模式，`model` → 切模型，`thinking` → 改思考级别，答复是全部配置项的新状态；未知 id、找不到的模型、不认识的级别回 invalid params（-32602）。模型或级别在会话里变了（含 plan 流程自动切换）时发 `config_option_update`。
- 命令表：Skill 列为 `skill:<名字>`，提示模板列为 `<名字>`（frontmatter 的 `argument-hint` 作 `input.hint`）。这两类在 prompt 文本里本来就会展开（`/skill:<名字> …`、`/<名字> …`）。`/new`、`/compact` 等内置斜杠命令在 ACP 下不执行，不列。

### 退出

stdin 关闭后等已开始的运行结束再退出（0）；`ama` 进程的 stdout 从启动第一步起只给协议（宿主 / Hook 加载期的 `console.log` 改写到 stderr）；SIGINT / SIGTERM 中断后退出 130 / 143。宿主看到的模式是 `rpc`（`HostApi.mode`）。SDK 直接 `bootstrap(--mode acp)` 时得到 `mode: "rpc"` 的 Runtime，再交给 `runAcpMode`。

## 偏离与不做

以下是有意的取舍，不是遗漏：

| 项目                                            | ama 的做法与理由                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 客户端的 `fs/*`、`terminal/*`                   | 不使用（客户端声明了也不用）。ama 自己读写文件、自己跑命令，全部经自己的权限管线、沙箱与检查点；借客户端的文件系统或终端会绕开这些，也会让 TUI / RPC / ACP 三处行为不一致。                                                                                                                                       |
| MCP（`mcpServers`，含规范要求必须支持的 stdio） | 不连接，`mcpCapabilities` 的 `http` / `sse` 为 false；收到非空 `mcpServers` 时 stderr 记一行后照常开会话。**这偏离了规范「Agent 必须支持 stdio MCP」的 MUST**：ama 的工具只来自自身与宿主（profile），扩展走 Skill；接 MCP 会把外部工具描述放进请求前缀，破坏逐字节稳定的提示词缓存，也绕开权限管线对工具的分类。 |
| elicitation（Agent 向人要结构化输入）           | 作服务端时不发 `elicitation/create`：ama 需要人决定的只有审批，走 `session/request_permission`。作客户端时支持（见下文）。                                                                                                                                                                                        |
| `session/delete`                                | 不实现（-32601）。会话文件的清理走 `ama sessions prune`。                                                                                                                                                                                                                                                         |
| `logout`                                        | 不实现、不声明 `agentCapabilities.auth.logout`（-32601）。退出登录用 `ama auth logout chatgpt` / `ama auth remove <供应商>`。                                                                                                                                                                                     |
| 会话 `cwd`                                      | 固定为 ama 的启动目录，`session/new` 给了别的目录回 -32602，`additionalDirectories` 忽略：信任、项目配置、会话目录与沙箱都按启动目录判定，同一进程里换目录会让它们失效。要换目录就在那个目录另起一个 `ama --mode acp`。                                                                                           |

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

`runFakeAcpAgent(input, output, options?)` 是进程内的假 ACP Agent，`fakeAcpAgentPath()` 是它的可执行入口（`node <path> [参数]`）。行为由提示里的标记与启动参数决定，其余提示回 `echo: <文本>`：

| 标记 / 参数                                          | 行为                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `[permission]`                                       | 请求权限（四个选项）                                                                                                                                   |
| `[slow]`                                             | 等到 `session/cancel`                                                                                                                                  |
| `[plan]` / `[think]` / `[refuse]`                    | 先发 `plan`（两条）/ 先发 `agent_thought_chunk` / 以 `refusal` 结束                                                                                    |
| `[elicit]`                                           | 发 `elicitation/create`；客户端没声明能力时回 `elicit: unsupported`                                                                                    |
| `[model]` / `[env NAME]`                             | 回 `model <当前模型>` / `env NAME <值的 sha256 或 absent>`（不回显值）                                                                                 |
| `--minimal`（`{ minimal: true }`）                   | 不声明 resume / load / list / close，也不给模式，用来测降级路径                                                                                        |
| `--config-options`（`{ configOptions: true }`）      | 开会话答一个 `model` 配置项（选项按组给出），接 `session/set_config_option`                                                                            |
| `--config-only`（`{ configOnly: true }`）            | 开会话不给 `modes`，改在 `configOptions` 里给 category `mode` 的选择项（id `mode`），经 `session/set_config_option` 切换；可与 `--config-options` 同开 |
| `--auth-required`（`{ authRequired: true }`）        | `initialize` 给一条 terminal 型认证方法（id `login`），`session/new` / `load` / `resume` 一律回 -32000                                                 |
| `[cancel-request]`（`{ cancelRequestMs }` 缺省 2 s） | 发权限请求，挂起到期后 Agent 自己发 `$/cancel_request` 撤回，工具调用 failed，回 `permission withdrawn` 与 `end_turn`                                  |

假 Agent 的线路两侧都开着 `$/cancel_request`。仓库内的 `test/helpers/acp-schema.ts` 用官方 v1 schema（1.24.1，`test/fixtures/acp/schema-v1.24.1.json`）逐条校验线路：`assertAcpWire(wire)`。

黄金记录在 `test/fixtures/acp/`：`driver-{allow,reject,cancel}.jsonl`（ama 驱动假 Agent 的三条路径）与 `mode-prompt.jsonl`（`ama --mode acp` 一轮往返）。`UPDATE_GOLDEN=1` 重写。

## 兼容性

对照官方 ACP v1 schema **1.24.1**（稳定部分，含 `session/list`、`session/resume`、`session/close`、`$/cancel_request`、`usage_update`、`session_info_update`、`config_option_update` 与 terminal 型认证方法）实现；schema 原文随仓库在 `test/fixtures/acp/schema-v1.24.1.json`，测试与黄金记录的每条线路都按它校验。唯一用到的不稳定字段是 `session/prompt` 结果的 `usage`（见「事件映射」）。v2 计划取消 `session/load`，ama 作客户端时已优先 `resume`。
