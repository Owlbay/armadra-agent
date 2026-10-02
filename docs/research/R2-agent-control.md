# R2：ama 原生操控其他编码 Agent —— 控制面调研与驱动层设计

> 调研日期 2026-10-02。只读调研，未改任何仓库代码。
> 本机核实：`claude` 2.1.287、`codex` 0.160.0、`pi` 1.0.0（源码包 `/tmp/pi-1.0/`）；`gemini / qwen / kimi / opencode / agent(cursor) / goose / copilot / iflow / droid` 本机均未安装，相关结论来自官方文档、仓库与 ACP 注册表。
> 未真跑任何计费调用（没有执行 `claude -p` / `codex exec`），所以 Claude stream-json 控制协议的细节用的是官方文档和第三方实测记录（有标注）。Codex app-server 协议用本机 `codex app-server generate-ts --out /tmp/ama-research/codex-ts` 生成的 TS 绑定核对（639 个 v2 类型文件，不涉及网络与账户）。

---

## 0. 结论先行

1. **以 ACP 作统一控制面，在 ama 里手写一个零依赖的 ACP 客户端，能用 ACP 的就都走它**。截至 2026-10，ACP 官方 Agent 列表里原生支持的有 Gemini CLI、Qwen Code、Kimi Code CLI、OpenCode、GitHub Copilot CLI、Goose、Factory Droid、Cursor、Cline、Augment、Junie、Kiro 等三十多家；Claude Code、Codex、Pi 通过适配器支持（`claude-agent-acp`、`codex-acp`、`pi-acp`）。v1 规范里 `session/list`（2026-03）、`session/resume`（2026-04-22）、`session/close`（2026-04-23）、`session/delete` 与 `usage_update`（2026-06-05）都已稳定。一个 ACP 客户端（约 600–900 行）就能覆盖长尾。
2. **Claude Code 和 Codex 先走各自原生的结构化协议，ACP 适配器装了再用**。理由：本机已经装了这两个 CLI，原生协议零额外安装，而且能力比适配器全。
   - Claude：`claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio`。它是长驻进程，支持多轮输入、`control_request{subtype:"can_use_tool"}` 权限回调、`interrupt`，结果消息里带 `total_cost_usd`。
   - Codex：`codex app-server`（stdio JSON-RPC）。有 `thread/start|resume|fork`、`turn/start|steer|interrupt`，权限经服务端请求 `item/commandExecution/requestApproval` 与 `item/fileChange/requestApproval` 回到客户端，用量经 `thread/tokenUsage/updated` 推送。
   - `codex exec --json` 和 `claude -p --output-format json` 只能当「一次性、不接受审批」的兜底。
3. **ama 目前完全没有驱动外部 CLI Agent 的能力**：
   - 独立使用时只有同进程子 Agent `task`（`src/tools/task.ts`）。
   - 嵌入 Armadra 时，画布工具 `canvas_*` 由 Armadra 侧的适配器经 `HostApi.tools.register` 注册（设计 §5.4，`docs/design.md:507-509`）。
   - 仓库里没有 ACP、没有 MCP（D5 明确「不做 MCP」，`docs/design.md:15`），也没有 spawn 外部 Agent 的代码。
4. **推荐分层**：
   - `drivers/` 下定义统一接口 `AgentDriver`，内部事件用 ACP 的词汇。
   - 适配器的优先级：原生 ACP（`acp`）> 已安装的官方 ACP 适配器（`acp-adapter`）> 原生结构化协议（`claude-stream`、`codex-app-server`、`pi-rpc`）> 一次性打印模式（`oneshot`，不能审批，只在只读或沙箱下用）。
   - **ama 独立模式不做 tmux / PTY 文本驱动**。PTY 只由 Armadra 宿主提供，Armadra 已经为「替人答掉对话框」吃过亏，见 `agent-delivery.md:408`。
5. **暴露给模型的工具控制在三个**：`agent_run`（新开或续聊，可阻塞等结果，也可后台跑）、`agent_status`（查看、轮询、列出挂起的审批）、`agent_stop`（取消本轮或关闭会话）。批量编排经 codemode 的 `tools.agent_run(...)` 加 `Promise.all` 完成。**权限请求不做成模型可调用的工具**：一律经 ama 的 `ApprovalBroker` 交给人（TUI 对话框、RPC 的 `permission_request`、或宿主），无人值守时回 `reject_once` 或 `cancelled`，绝不代答。
6. **嵌入与独立的边界**：嵌入 Armadra 时沿用已设计的 `canvas_*` 工具，宿主 `disable("agent_run")` 等，与现在禁用 `task` 是同一手法。独立时由 ama 自己 spawn。中长期可以给 HostApi 加一个可选的 `agents.provideDriver()`，让宿主用画布节点实现同一个 `AgentDriver`，模型只看到一套动词。
7. **分阶段**：
   - P0：ACP 客户端、驱动接口、假 Agent 测试，同时实现 ama 自己的 `--mode acp`（Armadra 的 D12 已经在等）。
   - P1：Claude（stream-json）、Codex（app-server）、通用 ACP（先验证 OpenCode 和 Gemini）。
   - P2：Pi RPC、Copilot / Qwen / Kimi 的 ACP 实测；ACP 适配器路径（`claude-agent-acp`、`codex-acp`）。
   - P3：HostApi 驱动注入、跨 Agent 交接。
8. **主要风险**：
   - Claude 的 stream-json 控制协议不是公开的 CLI 接口，近几个版本都有中断与权限相关的 bug。
   - Codex app-server 标注为 `[experimental]`，0.160 已不再列出 `mcp-server` 和 `proto` 子命令。
   - Qwen 的 `--acp` 在 0.23.x 有「不发 `request_permission` 就直接执行」的 issue。
   - 子进程环境里如果漏进 ama 自己的 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`，会把子 CLI 的计费从订阅切到 API Key。必须清理环境变量。

---

## 1. 各 Agent 的可编程控制面

### 1.1 总对照表

图例：★ 官方且稳定；☆ 官方但标为实验，或不承诺稳定；◇ 社区或第三方；「测」表示需要实测确认。

| Agent                              | 启动命令（程序化）                                                                                                                                                    | 协议 / 帧格式                                               | 输入                                                                                                                                                                      | 输出与结构化事件                                                                                                                                                                                                                                                                                        | 权限回调                                                                                                                                                                                                                                                                                           | 中断                                                                                 | 恢复会话                                                                                                                  | 用量 / 成本                                                                                                                                                                                  | 稳定性                                                                                                    | 证据                                                                                                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude Code** 2.1.287            | `claude -p --input-format stream-json --output-format stream-json --verbose [--include-partial-messages] --permission-prompt-tool stdio --permission-mode <m>`        | stdio NDJSON；控制面为 `control_request / control_response` | `{"type":"user","message":{role,content}}` 行；多轮复用同一进程                                                                                                           | `system/init`（session_id、tools、mcp_servers、capabilities）、`assistant`、`user`（tool_result）、`stream_event`（部分增量）、`system/api_retry`、`permission_denied`、`result`                                                                                                                        | `control_request{subtype:"can_use_tool", tool_name, input, tool_use_id, permission_suggestions}` → 回 `{behavior:"allow", updatedInput}` 或 `{behavior:"deny", message}`；挂起时被取消会收到 `control_cancel_request`。备选：`--permission-prompt-tool <mcp工具>` 把审批交给一个 MCP 工具          | `control_request{subtype:"interrupt"}`；SIGINT 对 stream-json 模式无效（第三方实测） | `--resume <id                                                                                                             | jsonl路径>`、`--continue`、`--fork-session`、`--session-id <uuid>`                                                                                                                           | `result.total_cost_usd`、按模型分列的成本、`usage`；`--max-budget-usd` 设硬上限；续聊时报整段会话的累计值 | CLI 旗标★；stream-json 控制协议☆（文档称其「不是公开的 CLI 接口」，Agent SDK 用的就是它）                                                                                              | 本机 `claude --help`；[headless 文档](https://code.claude.com/docs/en/headless)；[#98713](https://github.com/anthropics/claude-code/issues/98713)、[#94741](https://github.com/anthropics/claude-code/issues/94741)、[#34046](https://github.com/anthropics/claude-code/issues/34046) |
| Claude Agent SDK（TS / Py）        | `query({prompt: AsyncIterable<SDKUserMessage>, options:{resume, canUseTool, permissionMode, mcpServers, cwd, env}})`                                                  | 进程内 API，底层 spawn `claude` 并讲上一行的 stream-json    | 同上                                                                                                                                                                      | `SDKMessage` 系列                                                                                                                                                                                                                                                                                       | `canUseTool(toolName, input, {signal, suggestions})`                                                                                                                                                                                                                                               | `Query.interrupt()`                                                                  | `options.resume`、`forkSession`                                                                                           | 同上                                                                                                                                                                                         | ★（V2 session API 已在 0.3.142 移除，只剩 `query()`）                                                     | [V2 移除说明](https://code.claude.com/docs/en/agent-sdk/typescript-v2-preview)                                                                                                         |
| Claude via ACP                     | `claude-agent-acp`（npm `@agentclientprotocol/claude-agent-acp`）                                                                                                     | ACP                                                         | ACP                                                                                                                                                                       | ACP                                                                                                                                                                                                                                                                                                     | `session/request_permission`                                                                                                                                                                                                                                                                       | `session/cancel`                                                                     | `loadSession` 与 `sessionCapabilities.resume` 都有                                                                        | `usage_update`（测）                                                                                                                                                                         | ◇→★（Zed / ACP 组织维护）                                                                                 | Armadra `acp-session-view.md:65`                                                                                                                                                       |
| **Codex** 0.160.0                  | `codex app-server`（缺省 `--listen stdio://`，也支持 `unix://`、`ws://IP:PORT`）                                                                                      | JSON-RPC 2.0 over NDJSON                                    | `initialize{clientInfo, capabilities}` → `thread/start{cwd, approvalPolicy, sandbox, model…}` → `turn/start{threadId, input[], outputSchema?}`；`turn/steer` 在运行中追加 | 通知：`thread/started`、`turn/started`、`turn/completed`、`item/started`、`item/completed`、`item/agentMessage/delta`、`item/reasoning/*`、`item/commandExecution/outputDelta`、`item/fileChange/patchUpdated`、`turn/diff/updated`、`thread/tokenUsage/updated`、`account/rateLimits/updated`、`error` | 服务端请求：`item/commandExecution/requestApproval` → `{decision: "accept"\|"acceptForSession"\|"decline"\|"cancel"\|{acceptWithExecpolicyAmendment}…}`；另有 `item/fileChange/requestApproval`、`item/permissions/requestApproval`、`item/tool/requestUserInput`、`mcpServer/elicitation/request` | `turn/interrupt{threadId, turnId}`                                                   | `thread/resume`、`thread/fork`、`thread/list`、`thread/read`、`thread/revert`；会话即 `$CODEX_HOME/sessions` 下的 rollout | `ThreadTokenUsage{total,last:{inputTokens,cachedInputTokens,cacheWriteInputTokens,outputTokens,reasoningOutputTokens}, modelContextWindow}`；`account/rateLimits/read`、`account/usage/read` | ☆（help 标 `[experimental]`；可用 `generate-ts` / `generate-json-schema` 锁定版本）                       | 本机 `codex app-server --help` 与 `/tmp/ama-research/codex-ts/{ClientRequest,ServerRequest,ServerNotification}.ts`、`v2/CommandExecutionApprovalDecision.ts`、`v2/ThreadTokenUsage.ts` |
| Codex 一次性                       | `codex exec --json [-s read-only\|workspace-write] [-C dir] [--output-schema f] [-o last.txt]`；续聊用 `codex exec resume <id>`                                       | stdout JSONL                                                | argv 或 stdin                                                                                                                                                             | `thread.started{thread_id}`、`turn.started`、`item.started/updated/completed`（`agent_message`、`reasoning`、`command_execution`、`file_change`、`mcp_tool_call`、`web_search`、`todo_list`）、`turn.completed{usage}`、`turn.failed`、`error`                                                          | **无交互审批**：靠 `-s` 沙箱或 `--approve-for-me`（自动审查）                                                                                                                                                                                                                                      | 杀进程                                                                               | `exec resume <id>` / `--last`、`exec fork`                                                                                | `turn.completed.usage`                                                                                                                                                                       | ★                                                                                                         | 本机 `codex exec --help`；[exec JSON 速查](https://takopi.dev/reference/runners/codex/exec-json-cheatsheet/)                                                                           |
| Codex via ACP                      | `codex-acp`（npm `@agentclientprotocol/codex-acp`，内部起 app-server）                                                                                                | ACP                                                         | ACP                                                                                                                                                                       | ACP                                                                                                                                                                                                                                                                                                     | ACP                                                                                                                                                                                                                                                                                                | ACP                                                                                  | `session/load` → `thread/resume`                                                                                          | 测                                                                                                                                                                                           | ◇→★（openai/codex #9085「原生 ACP」已关为 not planned）                                                   | Armadra `acp-session-view.md:66`                                                                                                                                                       |
| `codex mcp-server` / `codex proto` | 0.160 的 help **不再列出**这两个子命令                                                                                                                                | —                                                           | —                                                                                                                                                                         | —                                                                                                                                                                                                                                                                                                       | —                                                                                                                                                                                                                                                                                                  | —                                                                                    | —                                                                                                                         | —                                                                                                                                                                                            | 已淘汰，不要依赖                                                                                          | 本机 `codex --help`                                                                                                                                                                    |
| **Gemini CLI**                     | `gemini --acp`（旧名 `--experimental-acp`）；一次性：`gemini -p … --output-format stream-json`                                                                        | ACP；stream-json 为 JSONL                                   | ACP / argv                                                                                                                                                                | stream-json：`init`、`message`、`tool_use`、`tool_result`、`error`、`result`（含按模型的 token 统计）                                                                                                                                                                                                   | ACP：`request_permission`；headless 下靠 `--approval-mode` / `--yolo`                                                                                                                                                                                                                              | ACP `session/cancel`                                                                 | ACP 能力协商（测）                                                                                                        | `result` 里的统计；ACP `usage_update`（测）                                                                                                                                                  | ★                                                                                                         | [ACP mode](https://geminicli.com/docs/cli/acp-mode.md)、[headless](https://geminicli.com/docs/cli/headless/)                                                                           |
| **Qwen Code**                      | `qwen --acp`（`--experimental-acp` 已弃用）                                                                                                                           | ACP                                                         | ACP                                                                                                                                                                       | ACP                                                                                                                                                                                                                                                                                                     | **有 issue**：0.23.2 / 0.23.4 在受限模式下不发 `request_permission` 就直接执行                                                                                                                                                                                                                     | ACP                                                                                  | 测                                                                                                                        | 测                                                                                                                                                                                           | ★但有缺陷                                                                                                 | [#11887](https://github.com/QwenLM/qwen-code/issues/11887)、[Zed 页](https://zed.dev/acp/agent/qwen-code)                                                                              |
| **Kimi Code CLI**                  | `kimi acp`（子命令；旧的 Python 版 kimi-cli 已归档）                                                                                                                  | ACP                                                         | ACP                                                                                                                                                                       | ACP                                                                                                                                                                                                                                                                                                     | ACP                                                                                                                                                                                                                                                                                                | ACP                                                                                  | 测                                                                                                                        | 测                                                                                                                                                                                           | ★                                                                                                         | [kimi acp](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html)                                                                                                    |
| **OpenCode**                       | `opencode acp`；或 `opencode serve`（HTTP + SSE，OpenAPI 3.1）/ `@opencode-ai/sdk` 的 `createOpencode()`                                                              | ACP；HTTP / SSE                                             | ACP；`POST /session/{id}/prompt`（同步）或 `prompt_async`                                                                                                                 | SSE `/event`：`session.status`、`message.part.updated`、`message.part.delta`、`permission.asked`                                                                                                                                                                                                        | ACP；HTTP 下 `POST /session/{id}/permissions/{pid}`                                                                                                                                                                                                                                                | ACP；HTTP `session.abort`                                                            | ACP 有 list / load / resume / fork / close；HTTP 有 `GET /session`                                                        | 消息里的 tokens / cost                                                                                                                                                                       | ★（ACP 已知 #42442：`session/load` 响应不带 `sessionId`）                                                 | [server](https://opencode.ai/docs/server/)、[sdk](https://opencode.ai/docs/sdk/)、[acp](https://opencode.ai/docs/acp/)                                                                 |
| **GitHub Copilot CLI**             | `copilot --acp --stdio`；一次性：`copilot -p … --output-format json -s --no-ask-user`                                                                                 | ACP；JSONL                                                  | ACP / argv                                                                                                                                                                | ACP；JSONL                                                                                                                                                                                                                                                                                              | ACP；一次性模式用 `--allow-tool`、`--deny-tool`、`--allow-all-tools`                                                                                                                                                                                                                               | ACP                                                                                  | ACP 只在**同一进程内**可 load（#1767）；CLI 有 `--resume`、`--continue`                                                   | 按 premium request 计，不是美元                                                                                                                                                              | ★（ACP 2026-01 起公测）                                                                                   | [ACP server](https://docs.github.com/en/copilot/reference/acp-server)、[programmatic](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference)   |
| **Cursor CLI**                     | `agent -p --output-format stream-json [--stream-partial-output] --force`；ACP：有资料写 `agent acp`，但也有 2026-09 的 PR 说本体不支持、需要第三方 `cursor-agent-acp` | JSONL                                                       | argv；`--resume=<id>`                                                                                                                                                     | `system`、`assistant`、`tool_call`、`result`                                                                                                                                                                                                                                                            | 一次性：`--force` / `--yolo`，否则不写文件                                                                                                                                                                                                                                                         | 杀进程                                                                               | `--resume=<session_id>`                                                                                                   | 测                                                                                                                                                                                           | ★（stream-json）/ 测（ACP）                                                                               | [output-format](https://cursor.com/docs/cli/reference/output-format)、[beeline #1400](https://github.com/Beeline-Work/beeline/pull/1400)                                               |
| **Goose**                          | `goose acp [--with-builtin developer]`；2.0 起 ACP 是缺省接口，计划出 `goose serve`（HTTP / WS）                                                                      | ACP                                                         | ACP                                                                                                                                                                       | ACP                                                                                                                                                                                                                                                                                                     | ACP                                                                                                                                                                                                                                                                                                | ACP                                                                                  | 测                                                                                                                        | 测                                                                                                                                                                                           | ★                                                                                                         | [goose 2.0](https://goose-docs.ai/blog/2026/04/08/goose-acp-and-new-tui/)                                                                                                              |
| **Factory Droid**                  | `droid exec --output-format acp`；原生多轮协议：`droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc`（`stream-json` 已弃用）                     | ACP / JSON-RPC                                              | 同左                                                                                                                                                                      | 原生协议比 ACP 多 spec 模式、rewind、子会话进度                                                                                                                                                                                                                                                         | ACP / 原生                                                                                                                                                                                                                                                                                         | 同左                                                                                 | 同左                                                                                                                      | 测                                                                                                                                                                                           | ★                                                                                                         | [CLI reference](https://docs.factory.ai/reference/cli-reference)、[t3code #7993](https://github.com/pingdotgg/t3code/pull/7993)                                                        |
| **iFlow CLI**                      | `iflow --experimental-acp [--port N]`（stdio，或 `ws://…/acp`）                                                                                                       | ACP                                                         | ACP                                                                                                                                                                       | ACP                                                                                                                                                                                                                                                                                                     | ACP                                                                                                                                                                                                                                                                                                | ACP                                                                                  | 测                                                                                                                        | 测                                                                                                                                                                                           | ☆（仍是 experimental 旗标）                                                                               | [iFlow IDE](https://platform.iflow.cn/en/cli/features/ide)                                                                                                                             |
| **Pi** 1.0.0                       | `pi --mode rpc [--session <id>\|--no-session]`；一次性：`pi -p --mode json`                                                                                           | stdio JSONL（严格按 LF 分帧）                               | `prompt`、`steer`、`follow_up`、`abort`、`new_session`、`switch_session`、`fork`、`set_model`…                                                                            | `agent_start/end`、`agent_settled`、`message_update`、`tool_execution_*`、`compaction`、`retry`；`extension_ui_request`                                                                                                                                                                                 | **Pi 本身没有工具审批**（`docs/security.md:3`：不对每次工具调用征求同意）；只有扩展发的 `extension_ui_request{confirm/select/input}`，经 `extension_ui_response` 回答                                                                                                                              | `abort`                                                                              | `--session <path\|id>`、`--continue`、`--fork`；RPC 里 `switch_session`                                                   | `get_session_stats`：`tokens{input,output,cacheRead,cacheWrite}`、`cost`、`contextUsage`                                                                                                     | ★                                                                                                         | `/tmp/pi-1.0/pi-coding-agent/docs/rpc.md:1-80`、`rpc-commands.md:526-566`、`pi --help`                                                                                                 |
| Pi via ACP                         | `pi-acp`（社区，内部起 `pi --mode rpc`）                                                                                                                              | ACP                                                         | ACP                                                                                                                                                                       | ACP                                                                                                                                                                                                                                                                                                     | 无（Pi 没有审批）                                                                                                                                                                                                                                                                                  | ACP                                                                                  | 经 `~/.pi/pi-acp/session-map.json` 映射                                                                                   | 测                                                                                                                                                                                           | ◇                                                                                                         | Armadra `acp-session-view.md:68`                                                                                                                                                       |
| **ama**（自己）                    | `ama --mode rpc`；规划中的 `--mode acp`（Armadra D12）                                                                                                                | stdio JSONL                                                 | `prompt`、`steer`、`follow_up`、`abort`… 共 33 条命令（`src/rpc.ts:38-83`）                                                                                               | 进程内的 `SessionEvent`                                                                                                                                                                                                                                                                                 | `set_client_capabilities{approvals}` 后由客户端回 `permission_response{requestId, decision}`（`src/modes/rpc/commands.ts:33-60`）                                                                                                                                                                  | `abort`                                                                              | `switch_session`、`fork`                                                                                                  | `get_session_stats`                                                                                                                                                                          | ★（自有）                                                                                                 | 源码                                                                                                                                                                                   |

### 1.2 Claude Code 细节与坑

- **两条审批通道**：
  - `--permission-prompt-tool stdio`：在 stream-json 里走 `control_request`，Agent SDK 用的就是这条。
  - `--permission-prompt-tool mcp__server__tool`：把审批交给一个 MCP 工具。ama 不做 MCP，所以选 stdio。
  - 2.1.287 的 `--help` 已不显示 `--permission-prompt-tool`，但新增的 `--permission-prompts host|none` 的说明里明确提到它。无人值守时可以用 `--permission-prompts none`：所有会弹提示的调用直接拒绝，并在 `result.permission_denials` 里列出。
- **允许必须带 `updatedInput`**（CLI 用 Zod 校验）。`AskUserQuestion`、`ExitPlanMode` 也走 `can_use_tool`，要在 `updatedInput` 里填用户的选择。**ama 不能让模型替人填这些**，只能转给人，没有人时拒绝。
- **已知 bug**：
  - #98713：`interrupt` 紧跟在 user 消息后发出时，返回了成功但被忽略，这一轮照样跑完并计费。
  - #94741：中断后 `result` 事件缺 `result` 字段。
  - #34046：旧版本在 stdio 模式下不发 `can_use_tool`。
  - 对策：中断后设看门狗，N 秒内没收到 `result` 就升级为关闭 stdin 再 SIGTERM。注意 SIGTERM 会让 CLI 以 143 退出，并且「不记录这一轮」。
- **`--bare`**：跳过用户的 hooks、插件、CLAUDE.md、OAuth 和钥匙串，**只认 `ANTHROPIC_API_KEY`**。这等于把计费换到 API。作为协调者**不应缺省加 `--bare`**，否则违反「保留各 CLI 自己的账户」。
- **`-p` 跳过目录信任对话框**（help 原文提示只在信任的目录用），而且非 bare 时会跑项目 `.claude/settings.json` 里的 hooks 和 `.mcp.json`。ama 起 Claude 之前应当用 ama 自己的信任判断（`config/trust.ts`）把关。
- `system/init.capabilities` 提供协议能力位，比如 `interrupt_receipt_v1`。驱动应该按能力位做特性检测，不要比版本号。
- 成本：`total_cost_usd` 是客户端估算；订阅用户的 `cost` 不代表实际账单，界面上应标「估算」。

### 1.3 Codex 细节

- 0.160 的 app-server 方法面很大（`ClientRequest` 一百多个方法）。驱动只用约 12 个：`initialize`、`thread/start|resume|fork|read|list`、`turn/start|steer|interrupt`、`model/list`、`account/rateLimits/read`，以及审批类服务端请求的应答。
- **审批决定的映射**：ACP `allow_once` → `accept`，`allow_always` → `acceptForSession`，`reject_once` → `decline`，回合取消 → `cancel`。`acceptWithExecpolicyAmendment` 会写入执行策略，属于持久配置变更，**不对模型开放，也不缺省**。
- `approvalPolicy`：`"untrusted" | "on-request" | {granular…} | "never"`，`sandbox`：`read-only | workspace-write | danger-full-access`。驱动只透传用户在 ama 里为这个子 Agent 选的模式，不擅自放宽。
- 本机 `generate-json-schema` 可以生成 schema，ama 的 CI 可以把这些 schema 当黄金文件，锁住所依赖的 12 个方法的形状。
- 还有一种做法是连 `codex app-server daemon` 的共享守护进程（`codex agents` 浏览的就是它）。第一版**不连**，每个会话一个子进程，隔离更清楚。

### 1.4 Pi 细节

- RPC 的分帧规则和 ama 一致（不能用 `readline`，`rpc.md` 的 Framing 节）。ama 的 `src/modes/rpc/jsonl.ts` 可以直接复用为客户端。
- `prompt` 的响应只表示「已接受」，要等 `agent_settled` 才算这一轮结束（`rpc.md` 的 Run lifecycle 节）。
- Pi 没有审批，所以「Pi 子 Agent 会做什么」完全由 Pi 自己的工具集决定。ama 应该在启动 Pi 前按用户为它选的模式限制工具（`--tools`，或扩展），并在界面上明确说「Pi 不审批」。

### 1.5 ACP 规范要点（与 ama 相关的部分）

出处：agentclientprotocol.com 的协议页；Armadra `acp-session-view.md:41-55` 已有详表，这里只补增量。

| 能力       | 规范                                                                                                                                                                                                                               | ama 驱动用法                                                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 传输       | JSON-RPC 2.0，客户端 spawn Agent，stdio NDJSON；路径为绝对路径                                                                                                                                                                     | 与 ama RPC 的分帧（`jsonl.ts`）相同，可共用                                                                                                    |
| 初始化     | `initialize{protocolVersion:1, clientCapabilities{fs, terminal}}` → `agentCapabilities{loadSession, sessionCapabilities{list, resume, close…}, promptCapabilities{image, audio, embeddedContext}, mcpCapabilities}`、`authMethods` | 协商结果存进 `DriverCapabilities`                                                                                                              |
| 会话       | `session/new{cwd, mcpServers[]}`、`session/load`（回放历史）、**`session/resume`（不回放，2026-04 已稳定）**、`session/list`（2026-03 稳定）、`session/close`（2026-04 稳定）、`session/delete`（2026-06 稳定）                    | 续聊优先用 `resume`；ama 重启后用 `list` 找回会话                                                                                              |
| 回合       | `session/prompt{prompt: ContentBlock[]}` → `stopReason`；期间收到 `session/update`（`agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`、`plan`、`usage_update`、`current_mode_update`…）                | 这就是驱动事件的超集，直接拿来当内部词汇                                                                                                       |
| 权限       | `session/request_permission{toolCall, options[{optionId, kind: allow_once/allow_always/reject_once/reject_always}]}` → `{outcome:{outcome:"selected", optionId}}` 或 `cancelled`；回合取消时**必须**回 `cancelled`                 | 映射到 ama 的 `ApprovalRequest` 和 `ApprovalDecision`（见 §3.4）                                                                               |
| 用量       | `usage_update`：当前上下文 token 数、窗口大小、可选的会话累计成本（2026-06-05 稳定）                                                                                                                                               | 写进 ama 的用量条目                                                                                                                            |
| 文件与终端 | 客户端可以声明 `fs/read_text_file`、`fs/write_text_file`、`terminal/*`，Agent 才会委托                                                                                                                                             | **第一版不声明**，与 Armadra Q5 一致：子 Agent 自己读写、自己跑命令，用它自己的权限策略。以后要声明的话，委托过来的读写必须经过 ama 的权限管线 |
| 模式与配置 | `session/set_mode`、`session/set_config_option`（2026-02 稳定）                                                                                                                                                                    | 把权限模式和模型映射到这里                                                                                                                     |
| 扩展       | `_meta` 不得假设其内容                                                                                                                                                                                                             | 忽略                                                                                                                                           |

**对 Armadra 文档的勘误建议**：`acp-session-view.md:43` 写的是「v2 草案里的 `session/close`、`session/delete` 等本文不依赖」。按 ACP 官方公告，这两个方法已在 2026-04 和 2026-06 稳定进 v1，建议改写；Copilot 的跨进程 resume 等结论需要重新核对。另外该文 §3.2 写的「本机只装 Codex 0.159.3，`claude` / `pi` 不在 PATH」已经过时，本机现在是 claude 2.1.287、codex 0.160.0、pi 1.0.0。

### 1.6 Armadra 已有 ACP 设计，ama 如何复用

Armadra `acp-session-view.md` 的 `core/acp/` 设计（client、adapters 表、normalize、审批路由、镜像）和 ama 要做的东西高度同构，可以复用以下四点：

1. **协议子集与分帧**：两边都手写、零依赖、不引 ACP SDK（Armadra §5.1 第 169 行，ama D2）。建议 **ama 提供 `@armadra/agent/acp` 子路径**，导出 `AcpClient`、协议类型和一个假 Agent 测试夹具，Armadra 的 `core/acp/client.ts` 可以直接 import。Armadra 已经把 `@armadra/agent` 作为精确版本的 devDependency（`coordinator-agent.md` D6）。代价是 ACP 客户端的版本与 ama 绑定。备选是两边各写一份、共用一套黄金记录。推荐前者：协议栈只维护一份。
2. **适配器表的数据形状**：Armadra 的 `AcpAdapter{program, args, sessionId: same|mapFile|opaque, resume: load|resume|none, modes, expectedProcess}`（`acp-session-view.md:175-205`）可以直接作为 ama `drivers/catalog` 的条目形状，再加上 `kind: acp | acp-adapter | claude-stream | codex-app-server | pi-rpc | oneshot`。两边的表可以用同一份 JSON 数据，ama 发布，Armadra 校验。
3. **审批语义**：Armadra D4 规定「`allow_always` 由适配器自己记，core 不缓存决定，每次都问人」，D13 规定「从不自动回答 `elicitation/create`」。ama 照抄这两条。
4. **ama 的 `--mode acp`**（Armadra D12 / Q4）：在 RPC 引擎外面套一层 ACP 外壳。这件事和「ama 当 ACP 客户端」共用同一套类型和分帧，应该在 P0 一起做。ama 因此能被 Zed、JetBrains 和 Armadra 的 ACP 节点驱动，**也能驱动另一个 ama**（多个 ama 协作时的测试替身）。

---

## 2. ama 现状：调用其他 Agent 的能力与缺口

### 2.1 现有能力（源码核对）

| 能力                  | 位置                                                                                                                                                                       | 说明                                                                                                                                                                                                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 同进程子 Agent `task` | `src/tools/task.ts:1-117`                                                                                                                                                  | 深度不超过 1；并发由 `SubagentPool`（`src/agent/session-subagent.ts:27`，`session.ts:170` 缺省并发）控制；结果是最后一条助手文本加 `details{sessionFile, usage, stopReason}`；子 Agent 的审批串到父会话，标 `[task]`（`permissions/types.ts` 的 `ApprovalRequestContext.depth`）。**模型由 ama 自己调，不是外部 CLI** |
| 宿主注册工具          | `src/host/types.ts:96-142`（`HostApi.tools.register/disable`）                                                                                                             | Armadra 适配器经它注册 `canvas_team`、`canvas_send`、`canvas_inbox`、`context_*` 等，并 `disable("task")`（设计 §5.4，`docs/design.md:507-509`；Armadra `coordinator-agent.md:113-136`）                                                                                                                              |
| codemode 编排         | `src/codemode/*`，设计 §5.5                                                                                                                                                | 脚本里 `tools.<name>()` 走同一条权限管线，并发上限 8，可以 `Promise.allSettled`。**这是多 Agent 并行编排现成的载体**                                                                                                                                                                                                  |
| 审批 broker 链        | `permissions/types.ts:114-120`（`ApprovalBroker.ask` 返回 undefined 时交给下一个回答者：宿主 → UI → 无人值守拒绝）；RPC 侧 `RpcApprovals`（`modes/rpc/commands.ts:33-60`） | 驱动层收到子 Agent 的权限请求后，可以直接投进这条链                                                                                                                                                                                                                                                                   |
| RPC 服务端            | `src/rpc.ts`、`src/modes/rpc/*`                                                                                                                                            | ama **作为被控方**的协议，33 条命令、`hello{protocolVersion:1}`；分帧 `jsonl.ts` 可以给客户端复用                                                                                                                                                                                                                     |
| 一次性输出            | `src/cli/args.ts:33,114`（`--output-format text\|json\|stream-json`）                                                                                                      | ama 被别人以打印模式调用时用                                                                                                                                                                                                                                                                                          |

### 2.2 缺口

1. **独立模式下完全不能调用外部 CLI Agent**。只有 `task`（同进程、同一模型栈）和 `bash`。用 `bash` 去跑 `claude -p` 有三个问题：每次都要审批；拿不到流式事件；子 Agent 的权限请求会被 `-p` 静默拒绝，或者被 `--dangerously-*` 绕过，两种结果都不可接受。
2. **没有 ACP 客户端，也没有 ACP 服务端**（`grep -ri acp src` 只命中模型目录里的无关字样）。
3. **没有「外部会话引用」的持久化**。会话树（`session/`）里没有记录「这个 ama 会话驱动过 Claude 会话 X、Codex 线程 Y」的条目，ama 重启后无法续聊。
4. **审批请求缺少「来源是外部 Agent」的上下文**。`ApprovalRequestContext` 只有 `depth` 和 `parentToolCallId`，需要加 `origin: {agent, sessionId, toolCall, options[]}`，供 TUI 显示和 RPC 透传。
5. **没有跨 Agent 的成本汇总**。`usage` 条目只计 ama 自己的模型调用；外部 CLI 的成本单位也不同（美元、token、Copilot 的 premium request）。
6. **HostApi 没有驱动注入点**。嵌入时只能靠宿主注册另一套工具（`canvas_*`），模型在两种形态下看到的是两套动词。

---

## 3. 推荐架构

### 3.1 分层

```text
src/drivers/                      （新；零依赖；ama 自己的 Node 子进程 + JSONL）
  types.ts          AgentDriver / DriverSession / DriverEvent / DriverCapabilities（内部词汇 = ACP 子集）
  catalog.ts        内置驱动表（数据）：agentId → 候选驱动链 [{kind, program, args, env, modes, resume, sessionIdRule}]
  probe.ts          PATH 探测 + `--version` + 能力缓存（每次启动最多探一次，结果写数据目录）
  env.ts            子进程环境清理：去掉 ama 自己的 provider key / AMA_* / 代理凭据；白名单透传
  pool.ts           并发池、预算、看门狗、进程树回收（复用 tools/process-tree.ts）
  store.ts          会话引用持久化：custom{customType:"ama.agent-session"} 条目（agent、driver、sessionId、cwd、mode）
  acp/
    client.ts       JSON-RPC over NDJSON（复用 modes/rpc/jsonl.ts 的分帧）
    types.ts        v1 协议子集（手写）
    driver.ts       AcpDriver：initialize → session/new|resume|load → prompt/cancel/set_mode/close
    server.ts       （P0 同批）ama --mode acp：把 AgentSession 暴露为 ACP Agent
    testing/fake-agent.mjs
  native/
    claude-stream.ts      stream-json + control_request（can_use_tool / interrupt / initialize）
    codex-app-server.ts   thread/turn API + 审批类 ServerRequest
    pi-rpc.ts             Pi / ama 的 JSONL RPC（同形，ama-rpc 只是参数不同）
    oneshot.ts            claude -p --output-format json / codex exec --json / gemini -p stream-json / copilot -p json / agent -p stream-json
  normalize/        各原生协议事件 → DriverEvent（ACP 词汇）的映射表
src/tools/agent.ts                agent_run / agent_status / agent_stop（模型可见；详见 §3.3）
```

依赖方向：`tools/agent.ts → drivers/ → (agent/types, permissions/types)`。`drivers/` 不依赖 TUI，也不依赖 `host/`。

### 3.2 `AgentDriver` 接口（草案）

```ts
export interface DriverCapabilities {
  resume: "resume" | "load" | "none"; // 跨进程续聊
  list: boolean; // 能否列出历史会话
  permissions: "interactive" | "none" | "unreliable"; // Pi=none；qwen 0.23.x=unreliable
  steer: boolean; // 运行中追加（codex turn/steer、claude 多轮输入、pi steer）
  modes: readonly PermissionMode[]; // 有映射的权限模式
  usage: "tokens" | "usd" | "requests" | "none";
  images: boolean;
}

export interface AgentDriver {
  readonly agentId: string; // "claude" | "codex" | "gemini" | ...
  readonly kind:
    "acp" | "acp-adapter" | "claude-stream" | "codex-app-server" | "pi-rpc" | "oneshot" | "host";
  probe(): Promise<{ installed: boolean; version?: string; capabilities: DriverCapabilities }>;
  open(opts: {
    cwd: string;
    mode: PermissionMode;
    model?: string;
    resume?: string; // CLI 自己的会话 id
    signal: AbortSignal;
  }): Promise<DriverSession>;
}

export interface DriverSession {
  readonly sessionId: string; // 一律存 CLI 自己的 id（与 Armadra §4.3 同规矩）
  prompt(
    content: ContentBlock[],
    hooks: {
      onEvent(e: DriverEvent): void;
      onPermission(
        req: DriverPermissionRequest,
        signal: AbortSignal,
      ): Promise<DriverPermissionOutcome>;
    },
  ): Promise<TurnResult>; // stopReason + 最后文本 + usage + 触及文件
  steer?(content: ContentBlock[]): Promise<void>;
  cancel(): Promise<void>; // 发协议级中断；看门狗超时再升级
  close(): Promise<void>; // 回收进程树；挂起审批统一回 cancelled
}

export type DriverEvent =
  | { type: "message_delta"; text: string }
  | { type: "thought_delta"; text: string }
  | {
      type: "tool_call";
      id: string;
      title: string;
      kind: AcpToolKind;
      status: "pending" | "in_progress" | "completed" | "failed";
      locations?: string[];
    }
  | { type: "plan"; entries: { content: string; status: string }[] }
  | {
      type: "usage";
      input?: number;
      output?: number;
      cacheRead?: number;
      costUsd?: number;
      contextTokens?: number;
      contextWindow?: number;
    }
  | { type: "notice"; level: "info" | "warn"; text: string };
```

各原生协议到这个词汇的映射：

| DriverEvent   | Claude stream-json                                                                                | Codex app-server                                                                                                                   | Pi RPC                                  |
| ------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| message_delta | `stream_event` 的 `text_delta`，或整条 `assistant` 的 text 块                                     | `item/agentMessage/delta`                                                                                                          | `message_update` 的增量                 |
| tool_call     | `assistant` 的 `tool_use` 块 → pending；对应的 `user` 消息里的 `tool_result` → completed / failed | `item/started` / `item/completed`（`commandExecution` → execute，`fileChange` → edit，`mcpToolCall` → other，`webSearch` → fetch） | `tool_execution_start/end`              |
| usage         | `result.usage` + `total_cost_usd`                                                                 | `thread/tokenUsage/updated`                                                                                                        | `get_session_stats`（回合结束时拉一次） |
| 回合结束      | `result`（subtype `success`、`error_during_execution` 等）                                        | `turn/completed` / `turn/failed`                                                                                                   | `agent_settled`                         |
| 权限          | `control_request{can_use_tool}`                                                                   | `item/*/requestApproval`                                                                                                           | 无（扩展的 `confirm` 也一律转给人）     |

### 3.3 暴露给模型的工具（少工具）

| 工具           | 参数                                                                                                                         | 返回                                                                                                                                           | 权限类                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `agent_run`    | `{agent: "claude"\|"codex"\|…, prompt, session?: "new"\|<handle>, cwd?, mode?, model?, wait?: true, timeoutMs?, budgetUsd?}` | `wait=true`：`{handle, status, finalText, toolSummary[≤20 行], filesTouched[], usage, stopReason}`；`wait=false`：`{handle, status:"running"}` | `execute`（与 `task` 同级；首次调用某个 Agent 时进审批，说明「将以你在 X 的账户运行，模式 Y」） |
| `agent_status` | `{handle?}`（缺省列出全部）                                                                                                  | 每个句柄：`{agent, sessionId, state: idle\|running\|awaiting_approval\|exited, lastText 尾部, usage 累计, pendingApprovals: [{title, kind}]}`  | `read`                                                                                          |
| `agent_stop`   | `{handle, close?: boolean}`                                                                                                  | `{stopped, stopReason}`                                                                                                                        | `execute`                                                                                       |

- 「发任务」和「续聊」合并进 `agent_run`：给出 `session=<handle>` 就是续聊。`agent_send` 不单列，以免模型拆出多余的往返。运行中追加用 `agent_run{session, prompt}`：Agent 正忙且驱动支持 `steer` 时自动作为 steer，否则排队。
- 结果**只回摘要**：最终文本加不超过 20 行的工具摘要。完整的流式事件进 TUI 折叠视图（与 codemode 内层调用同样处理，带 `parentToolCallId`），**不进模型上下文**，否则成本会翻倍。
- **codemode 里的并行编排**：

  ```js
  const [a, b] = await Promise.allSettled([
    tools.agent_run({ agent: "claude", prompt: "审查 src/x …", mode: "plan" }),
    tools.agent_run({ agent: "codex", prompt: "审查 src/y …", mode: "plan" }),
  ]);
  return summarize(a, b);
  ```

  每次 `tools.agent_run` 都单独过权限管线，并发上限另受驱动池约束（§3.6）。

- **工具预设**：`agent_*` 在 `default` 预设里缺省关闭（与 `task` 一样用 `+agent` 打开）；在 `coordinator` 预设里开启。在 Armadra 里由适配器 `disable`（§3.7）。

### 3.4 权限请求回到 ama 的权限系统与用户（不代答）

流程：子 Agent 发出权限请求 → 驱动构造 `ApprovalRequest`，`context.origin = {agent, sessionId, toolCall{title, kind, locations, rawInput 摘要}, options[]}` → 走 `ApprovalBroker` 链：宿主 → UI（TUI 对话框或 RPC `permission_request`）→ 无人值守。

规则：

1. **模型没有回答审批的工具**，ama 的 auto 分类器也**不参与**子 Agent 的审批。子 Agent 用的是它自己的权限策略（Claude 的 `permissions.allow`、Codex 的 execpolicy），只有它自己决定「要问人」的那些请求才会到 ama 这里，到了以后**只交给人**。这是 Armadra 一直坚持的「不代答权限提示」，ama 独立时也守住。
2. 选项映射：人选「允许」→ 第一个 `allow_once`；「本会话允许」→ `allow_always` 或 Codex 的 `acceptForSession`（由子 Agent 自己记，ama 不缓存）；「拒绝」→ `reject_once`。`reject_always` 和 Codex 的 execpolicy 修订只有在对话框里点「更多」时才出现，因为它们会改子 CLI 的持久配置。
3. **无人值守**（`-p` 或 RPC 没声明 approvals 能力）：回 `reject_once`；Claude 直接用 `--permission-prompts none` 启动，让它在自己内部拒绝并记进 `permission_denials`。
4. 父 abort、`agent_stop`、超时：所有挂起的请求回 `cancelled`（ACP 规范要求）。
5. `elicitation/create`、Claude 的 `AskUserQuestion` / `ExitPlanMode`、Codex 的 `item/tool/requestUserInput`：作为「Agent 在问人」显示，**只接受人的输入**。
6. 权限模式映射：ama 给子 Agent 选的模式**不得比 ama 当前模式更宽**。例如 ama 在 `default` 时不能以 `bypassPermissions` 或 `danger-full-access` 起子 Agent；要宽于此必须用户显式配置 `agents.<id>.maxMode`。
7. 对话框标注来源，如 `[claude · 会话 abc]`，与现在 `task` 标 `[task]` 同一手法（`docs/design.md` R10）。

### 3.5 会话与上下文在 Agent 之间传递

- **会话引用持久化**：每个 `DriverSession` 写一条 `custom{customType:"ama.agent-session", agent, driver, sessionId, cwd, mode, createdAt}`，跟着 ama 的会话分支走，与 codemode store 同一机制。ama 恢复会话后，`agent_status` 能列出旧句柄，`agent_run{session}` 时按驱动能力 `resume` / `load` 重新打开，不能续的就明确说「已新开」（Armadra D2 同一规矩）。
- **上下文传递默认用显式文本**：协调者把需要的上下文写进 prompt。ACP 支持 `embeddedContext` 时可以传 `resource_link`（文件路径与行号），**不内联文件正文**，让子 Agent 自己读，以省 token 并避开 ama 的预算。
- **结果回传**：只回 `finalText` 和摘要。需要细节时，协调者用 `agent_run` 追问同一会话，而不是去读对方的转录。ama 独立时不实现转录读取，那是 Armadra `core/history/` 的职责。
- **交接**：A 的结论交给 B 时，由 ama 组装「任务 + A 的结论 + 文件列表」作为 B 的 prompt，A 和 B 之间不建直连。这与 Armadra 的「同级消息当资料处理」一致。
- **工作目录与 worktree**：`cwd` 缺省为 ama 的 cwd。多个写入型子 Agent 并行时，建议每个用一个 git worktree（Claude 有 `-w`，Codex 有 `--worktree`），由驱动的 `open({worktree})` 透传。ama 自己不建 worktree，避免与 Armadra 的 worktree 管理冲突。

### 3.6 成本与并发控制

- **并发池**：`agents.maxConcurrent` 缺省 3，每种 Agent 另有上限，比如 `claude: 2`（订阅有速率限制）。超出的排队，排队中可以被父 abort。codemode 的并发上限 8 是上层上限，驱动池是下层上限。
- **预算**：
  - 每次 `agent_run` 可以带 `budgetUsd`。Claude 直接透传 `--max-budget-usd`；其它 Agent 由驱动累计 `usage` 事件，超了就 `cancel()`。
  - 会话级 `agents.sessionBudgetUsd`。
  - 只有 token、没有美元的 Agent（Codex 订阅、Copilot 的 premium request）按各自单位计，**不换算成美元**（Armadra 第一部分已把成本 `unit` 单列，见 `cli-collaboration.md` H3）。
- **记账**：每次回合结束写 `custom{customType:"ama.agent-usage", agent, sessionId, unit, amount, tokens}`。`/session` 和 `get_session_stats` 新增 `external` 分组，与 ama 自身模型的 `usage` 分开显示。
- **看门狗**：`timeoutMs` 缺省 30 分钟；中断后 15 秒内没有回合结束，就升级为关闭 stdin，再 SIGTERM 进程树（`tools/process-tree.ts`）。这是针对 Claude #98713 / #94741 的对策。
- **空闲回收**：驱动进程空闲 10 分钟后关闭；能 resume 的下次再起，`resume: "none"` 的（Copilot ACP）保持常驻并在状态栏标注。

### 3.7 嵌入 Armadra 与独立使用的边界

| 场景                        | 谁 spawn 子 Agent                                                                                              | 模型看到的工具                                                                                                                                                | 审批                                                               | 状态与转录                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------ |
| **独立 ama**                | ama 的 `drivers/`                                                                                              | `agent_run`、`agent_status`、`agent_stop`                                                                                                                     | ama broker → TUI / RPC 客户端                                      | ama 会话里的引用条目           |
| **嵌入 Armadra（现设计）**  | Armadra core（终端节点 PTY 或 `core/acp/`）                                                                    | `canvas_team`、`canvas_send`、`canvas_inbox`、`context_*`（适配器注册），适配器 `disable("task")` **以及 `disable("agent_run"/"agent_status"/"agent_stop")`** | Armadra 的 `agent_approvals` 与节点头部；ama 不参与子 Agent 的审批 | Armadra `core/history/` 与镜像 |
| **嵌入 Armadra（P3 可选）** | Armadra 经 `HostApi.agents.provideDriver(driver)` 注入一个 `kind:"host"` 的驱动，`open()` 就是建画布节点并连线 | 仍是 `agent_*` 一套动词，在画布上表现为节点                                                                                                                   | 同上                                                               | 同上                           |

- 嵌入时**必须禁用 ama 自己的 spawn**：否则 ama 会绕过画布自己起 Claude，节点、状态、连线授权和审批全部失效。这在 Armadra 的审查准则里属于 P1 级问题（「协作上下文绕过连线授权」）。
- P3 的 `provideDriver` 是 HostApi 的**可选面**（与 `cache?` 同一种做法，`HOST_API_VERSION` 不变），宿主不提供就保持现状。好处是 ama 的提示词和技能在两种形态下用同一套动词，协调逻辑可以在独立模式下测试。

### 3.8 分阶段实施建议

| 阶段                                  | 内容                                                                                                                                                              | 先做哪些 Agent                                                                                                                 | 验收                                                                                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0 底座**（约 1 周）                | `drivers/types.ts`、`acp/client.ts`、`acp/server.ts`（`ama --mode acp`）、`env.ts`、`pool.ts`、`store.ts`、`fake-agent.mjs`；`ApprovalRequestContext.origin` 字段 | ama 驱动 ama（经 ACP）作为第一个端到端用例：零费用（脚本化模型服务，与 Armadra 场景 11 同一手法）                              | 假 ACP Agent 黄金记录；审批的允许、拒绝、取消三条路径；父 abort 后挂起请求回 `cancelled`                                                                                         |
| **P1 两家主力 + 通用 ACP**（约 2 周） | `native/claude-stream.ts`、`native/codex-app-server.ts`、`tools/agent.ts` 三个工具、TUI 折叠视图                                                                  | **Claude Code**（本机已装，使用最多）、**Codex**（本机已装，app-server 能力最全）、**通用 ACP** 用 OpenCode 或 Gemini 实测一家 | 每家两轮「回复 OK」加一次触发审批的写文件（在临时目录）；Claude 用真实配置目录时前后做字节指纹比对（Armadra D13 的做法）；Codex 的 schema 用 `generate-json-schema` 黄金文件锁定 |
| **P2 覆盖面**                         | `native/pi-rpc.ts`、`oneshot.ts`；ACP 适配器路径（`claude-agent-acp`、`codex-acp` 已安装时可选用）；Copilot、Qwen、Kimi、Goose 的 ACP 实测并写进 catalog          | Pi、Copilot、Qwen（核对 #11887 是否修复，未修复就标 `permissions:"unreliable"`，并强制 `plan` 模式或拒绝写入型任务）           | catalog 的每一行带「已验证版本区间」                                                                                                                                             |
| **P3 嵌入统一**                       | `HostApi.agents.provideDriver`（可选面）；Armadra 侧的 `kind:"host"` 驱动                                                                                         | —                                                                                                                              | Armadra 场景 11 改用 `agent_run` 跑通                                                                                                                                            |

先做 Claude 和 Codex 的理由：本机已装，用户主力就是这两家；它们的原生协议能力比 ACP 适配器全（Claude 有 `--max-budget-usd` 与 `total_cost_usd`，Codex 有 `turn/steer` 与 `thread/fork`）；而且不用让用户额外 `npm i -g` 适配器（Armadra D11 也认为适配器打包和锁版本代价大）。通用 ACP 一次做完，长尾 Agent 就自动可用。

---

## 4. 风险

| #   | 风险                                                                                                                                                                                                                                                | 影响                                                                                                                                               | 处置                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K1  | **Claude stream-json 控制协议不是公开接口**；近期接连有中断被忽略（#98713）、`result` 缺字段（#94741）、stdio 模式不发 `can_use_tool`（#34046）、`.claude/skills` 写入被静默拒（#54850）等问题                                                      | 中断失效会继续计费；审批被跳过                                                                                                                     | 按 `system/init.capabilities` 做特性检测；中断看门狗；catalog 写已验证版本区间，越界时降级到 ACP 适配器（如果装了）或 oneshot 只读；黄金记录在 CI 里每周用新版本跑一次（需要真实账户，手动触发）               |
| K2  | **Codex app-server 标为 experimental**，方法面大且变动快；0.160 已不再列出 `mcp-server` 和 `proto`                                                                                                                                                  | 升级后方法改名或字段变化                                                                                                                           | 只依赖约 12 个方法；用 `generate-json-schema` 生成黄金文件，CI 比对；`initialize` 失败时降级为 `codex exec --json`（只读或沙箱，无交互审批）                                                                   |
| K3  | **ACP 各家实现参差**：Qwen 0.23.x 不发权限请求（#11887）；OpenCode `session/load` 不带 sessionId（#42442）；Copilot 不能跨进程 resume（#1767）；Cursor 是否原生支持 ACP 说法矛盾；pi-acp 收下 MCP 参数但不接通                                      | 以为有审批，实际没有；续聊失败                                                                                                                     | `permissions:"unreliable"` 标记，并强制只读模式；`resume:"none"` 时明确说「已新开」；catalog 每一行都要实测后才标为已验证                                                                                      |
| K4  | **账户与计费归属**：ama 进程里有自己的 provider key（`ai/providers/auth.ts`），子进程如果继承 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `CODEX_API_KEY`，Claude 和 Codex 会改用 API Key 计费，而不是用户的订阅登录；`claude --bare` 同样只认 API Key | 用户被意外按 API 计费                                                                                                                              | `drivers/env.ts`：**缺省从子进程环境里删掉 ama 自己注入的 provider key**（只删 ama 注入的，保留用户 shell 原本就有的，需要区分来源）；`--bare` 不缺省；首次调用某家时在审批说明里写「将使用你在 X 的现有登录」 |
| K5  | **不代答**：协调者模型可能想「帮忙」通过权限请求，或往 `AskUserQuestion` 里填答案                                                                                                                                                                   | 越权执行；改写用户配置（Armadra 场景 10 的真实事故：一次投递答掉 Claude 启动对话框，改写了 `~/.claude/settings.json`，见 `agent-delivery.md:408`） | 不提供审批工具；auto 分类器不处理外部请求；elicitation 只接受人的输入；独立模式不做 PTY 文本驱动，从根上避免「回车答掉对话框」                                                                                 |
| K6  | **安全：信任边界**                                                                                                                                                                                                                                  | `claude -p` 跳过目录信任对话框，并执行项目 `.claude/settings.json` 的 hooks 和 `.mcp.json`；`codex` 读项目 `.codex` 配置和 execpolicy              | 在未信任目录里起子 Agent 等于执行仓库里的任意代码                                                                                                                                                              | 只在 ama 已信任的目录（`config/trust.ts`）里起子 Agent；未信任时 `agent_run` 直接报错，并提示 `ama trust`                                       |
| K7  | **安全：输出注入**                                                                                                                                                                                                                                  | 子 Agent 的输出（可能包含被仓库内容注入的指令）回到协调者的上下文                                                                                  | 提示注入沿 Agent 链扩散                                                                                                                                                                                        | 结果作为工具结果、按资料处理，与 Armadra 的「同级消息作为资料处理」信任规则一致；摘要限长                                                       |
| K8  | **敏感数据**                                                                                                                                                                                                                                        | 子 Agent 的原始事件里可能有终端输出和文件正文                                                                                                      | 落盘进 ama 会话后外泄                                                                                                                                                                                          | ama 会话只存摘要、用量和引用；完整事件只在内存中展示，不进 JSONL。Armadra 审查准则把「终端原始输出、文件正文进入持久化」列为 P0                 |
| K9  | **进程泄漏与孤儿进程**                                                                                                                                                                                                                              | 子 CLI 自己还会起子进程（Claude 的 Bash、Codex 的沙箱）                                                                                            | ama 崩溃后留下孤儿                                                                                                                                                                                             | 进程组与 `process-tree.ts` 回收；数据目录登记 pid 文件，启动时清理                                                                              |
| K10 | **零依赖约束**                                                                                                                                                                                                                                      | 不能用 Claude Agent SDK、ACP SDK、OpenCode SDK                                                                                                     | 自己维护协议子集                                                                                                                                                                                               | 子集都很小（ACP 约 15 个类型，Claude 控制协议约 6 种消息，Codex 约 12 个方法），用黄金记录守住；与 Armadra 共用 `@armadra/agent/acp` 只维护一份 |
| K11 | **ACP 协议版本**                                                                                                                                                                                                                                    | v2 RFD 计划取消 `session/load`，把历史回放并入 `resume`                                                                                            | 将来要迁移                                                                                                                                                                                                     | 驱动优先用 `session/resume`，`load` 只作回退                                                                                                    |

---

## 附：关键证据索引

- ama：
  - `armadra-agent/docs/design.md:15`（D5 不做 MCP）、`:507-509`（§5.4）、`:511-551`（§5.5 codemode）、`:553-577`（§5.6 预设）、`:1085-1105`（§17）
  - `src/tools/task.ts:1-117`
  - `src/host/types.ts:96-142`
  - `src/permissions/types.ts:80-120`
  - `src/rpc.ts:22-83`
  - `src/modes/rpc/commands.ts:1-60`
  - `src/cli/args.ts:33,61,114`
  - `src/agent/session-subagent.ts:27`
- Armadra：
  - `docs/design/acp-session-view.md:12-25`（D1–D14）、`:41-55`（§2 规范）、`:61-86`（§3 对照与 ama 建议）、`:175-205`（适配器表）、`:237-245`（审批）、`:446-465`（风险与 Q1–Q6）
  - `coordinator-agent.md:7-19, 113-150`
  - `agent-delivery.md:279-281, 408-425`
- 本机：
  - `claude --help`（2.1.287）
  - `codex --help`、`codex exec --help`、`codex app-server --help`（0.160.0）
  - `/tmp/ama-research/codex-ts/`（生成的协议绑定）
  - `pi --help`（1.0.0）
  - `/tmp/pi-1.0/pi-coding-agent/docs/{rpc.md,rpc-commands.md,security.md}`
- 外部：
  - [ACP agents 列表](https://agentclientprotocol.com/overview/agents)
  - [session/list 稳定](https://agentclientprotocol.com/announcements/session-list-stabilized)
  - [session/resume 稳定](https://agentclientprotocol.com/announcements/session-resume-stabilized)
  - [usage 稳定](https://agentclientprotocol.com/announcements/session-usage-stabilized)
  - [Claude headless](https://code.claude.com/docs/en/headless)
  - [Gemini ACP](https://geminicli.com/docs/cli/acp-mode.md)
  - [OpenCode server](https://opencode.ai/docs/server/)
  - [Copilot programmatic](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference)
  - [Cursor output-format](https://cursor.com/docs/cli/reference/output-format)
  - [Factory CLI](https://docs.factory.ai/reference/cli-reference)
  - [Kimi acp](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html)
  - [Qwen #11887](https://github.com/QwenLM/qwen-code/issues/11887)
  - [Goose 2.0](https://goose-docs.ai/blog/2026/04/08/goose-acp-and-new-tui/)
  - [iFlow IDE](https://platform.iflow.cn/en/cli/features/ide)
