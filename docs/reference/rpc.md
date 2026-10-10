# RPC 协议（stdio JSONL）

`ama --mode rpc` 从 stdin 读命令、向 stdout 写响应与事件，每行一个 JSON。类型定义在 `@armadra/agent/rpc`（`src/rpc.ts`），实现在 `src/modes/rpc/`。`ama -p --output-format stream-json` 输出的事件与这里同形状。设计依据见 [design.md](../design/design.md) §13.2。

## 线路

- 读：只按 `\n` 切行（去掉行尾 `\r`，空行跳过），不按 U+2028 / U+2029 切；多字节 UTF-8 跨块拼接；stdin 结束时最后一段不带换行的行也算一行。
- 写：每行是一个 `JSON.stringify` 结果，U+2028 / U+2029 转义为 `\u2028` / `\u2029`，`Error` 序列化为 `{ name, message }`，bigint 转字符串，图片 base64 不截断。大行按 64 KiB 分片写出并等待背压，行与行不交错。
- stdout 只有协议行；日志、宿主通知的人读副本写 stderr。

## 握手

启动后先发 `hello`，再发当前会话的 `session_start`：

```json
{"type":"hello","protocolVersion":1,"agent":"ama","version":"0.1.0","capabilities":["approvals","images","hooks","plans","compact_events"]}
{"type":"session_start","sessionId":"…","cwd":"/work","reason":"startup"}
```

`protocolVersion` 是 `RPC_PROTOCOL_VERSION`（当前 1）。`capabilities` 列出服务端支持的能力；客户端要接审批时用 `set_client_capabilities` 声明（见「审批」）。

## 命令与响应

命令形状 `{ "id"?: string, "type": <命令名>, ...参数 }`。响应：

```json
{ "id": "1", "type": "response", "command": "prompt", "success": true, "data": { "disposition": "started" } }
{ "id": "2", "type": "response", "command": "set_model", "success": false, "error": "…", "code": "model_not_found" }
```

- 响应带回请求的 `id`（字符串才带）。命令并发处理：`prompt` 不阻塞后续命令，所以响应顺序不一定与请求顺序相同，用 `id` 对应。
- 失败时 `error` 是人读文本，`code` 是 `AmaError.code`（若有）。未知命令 → `code: "invalid_arguments"`。
  **宿主按 `code` 判断，不得解析 `error` / `message`**：人读文本随界面语言（`AMA_LANG`、`--lang`、`ui.language`）变化（第六波起中英双语，见 [i18n.md](../guides/i18n.md)）；`notification` 事件的 `message` 同理。
- 一行不是合法 JSON 或缺 `type` → `{ "type": "response", "command": "parse", "success": false, "error": … }`，没有 `id`。
- 需要会话实现扩展方法的命令（下表标 †）在非 `AgentSessionImpl` 会话上返回 `code: "not_implemented"`；CLI 与 SDK 建出的会话都是 `AgentSessionImpl`。

### 提示

| 命令          | 参数                                                                                                           | `data`                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `prompt`      | `message: string`、`images?: ImageBlock[]`、`streamingBehavior?: "steer" \| "followUp"`、`interrupt?: boolean` | `{ disposition: "started" \| "queued" \| "handled" }`        |
| `steer`       | `message`、`images?`、`interrupt?: boolean`                                                                    | 同上                                                         |
| `follow_up`   | `message`、`images?`                                                                                           | 同上                                                         |
| `abort`       | —                                                                                                              | `{}`（回到空闲后应答；不清队列）                             |
| `clear_queue` | —                                                                                                              | `{ steering: string[], followUp: string[] }`（被清掉的文本） |

提示类命令**不等运行结束**：会话开始运行（`before_agent_start` / `agent_start`）、消息入队或被处理（例如斜杠命令、Hook 阻止）后立刻应答，运行进展走事件。运行中发 `prompt` 且不带 `streamingBehavior` → 失败，`code: "busy"`；带上 `steer` / `followUp` 则入队。应答发出之后的运行失败以 `{"type":"notification","level":"error","message":…}` 报告。

**打断并立即发送**：`prompt` / `steer` 带 `interrupt: true`（优先于 `streamingBehavior`）时，运行中先取走排队的 steer、中止当前回合（模型流断开，正在执行的工具按中断收尾，每个工具调用恰有一个结果 `aborted by user`，被打断的 assistant 消息以 `stopReason: "aborted"` 落盘），再立刻以「排队的 steer… + 本条」（空行拼接）开新回合，应答 `{ disposition: "started" }`；新回合的 user 消息 `origin: "interrupt"`。排在本轮之后的 followUp 留在队列，新回合结束后照常投递；后台子 Agent 不受影响。空闲时等同不带。`interrupt` 不是布尔 → `invalid_arguments`；运行中但本条与排队的 steer 都为空 → `invalid_arguments`（不中断）。事件顺序：`queue_update`（steer 被取走）→ 旧回合 `message_end`（aborted）→ `agent_settled` → `agent_start` → 应答 → 新的 user `message_end` ……（黄金记录 `test/fixtures/rpc/interrupt.out.jsonl`）。新请求以被打断那次请求的全部消息为前缀，缓存照常命中。SDK 对应 `session.prompt(text, { interrupt: true })` / `session.steer(text, { interrupt: true })`。

### 状态

| 命令                      | 参数 | `data`                                               |
| ------------------------- | ---- | ---------------------------------------------------- |
| `get_state`               | —    | `SessionState`（下表）                               |
| `get_messages`            | —    | `{ messages: AgentMessage[] }`（投影后的上下文消息） |
| `get_last_assistant_text` | —    | `{ text: string \| null }`                           |
| `get_session_stats`       | —    | `SessionStats`（见「会话统计」）                     |

`SessionState`：`isStreaming`、`isCompacting`、`isRetrying`、`model`（`{ provider, id, channel? }` 或缺省；`channel` 只在多渠道供应商上出现）、`thinkingLevel`、`permissionMode`、`sessionId`、`sessionFile`、`cwd`、`sessionName`、`messageCount`、`pendingMessageCount`、`steeringMode`、`followUpMode`、`autoCompaction`、`autoRetry`。

### 模型

| 命令                            | 参数                                                      | `data`                                                           |
| ------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| `set_model`                     | `provider: string`、`modelId: string`、`channel?: string` | `{ model: { provider, id, channel? } }`                          |
| `get_available_models`          | —                                                         | `{ models: RpcModelInfo[] }`                                     |
| `set_thinking_level`            | `level: off \| minimal \| low \| medium \| high \| xhigh` | `{ level }`                                                      |
| `get_available_thinking_levels` | —                                                         | `{ levels: string[] }`（当前模型支持的级别；无模型时 `["off"]`） |

`RpcModelInfo`：`provider`、`id`、`name`、`hasKey`、`keySource`（`cli` / `auth-file` / `config` / `env` / `oauth` / `none`；`oauth` 是第六波的 ChatGPT 登录）、`contextWindow?`、`maxTokens`、`reasoning`、`input`（`"text"` / `"image"`）。**密钥不离开进程**：只报有无与来源。

### 队列、压缩、重试

| 命令                    | 参数                             | `data`                                                                                      |
| ----------------------- | -------------------------------- | ------------------------------------------------------------------------------------------- |
| `set_steering_mode` †   | `mode: "one-at-a-time" \| "all"` | `{ mode }`                                                                                  |
| `set_follow_up_mode` †  | `mode`                           | `{ mode }`                                                                                  |
| `compact`               | `customInstructions?: string`    | `CompactionResult`：`summary`、`firstKeptEntryId`、`tokensBefore`、`tokensAfter?`、`usage?` |
| `set_auto_compaction` † | `enabled: boolean`               | `{ enabled }`                                                                               |
| `set_auto_retry` †      | `enabled: boolean`               | `{ enabled }`                                                                               |
| `abort_retry`           | —                                | `{ aborted: boolean }`（正在重试等待时中断本次运行）                                        |

### 会话

| 命令                  | 参数                     | `data`                                                                                      |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------------------- |
| `new_session`         | `parentSession?: string` | `{ sessionId, sessionFile }`                                                                |
| `switch_session`      | `sessionPath: string`    | 同上                                                                                        |
| `fork`                | `entryId: string`        | 同上（从该条目之前复制出新会话文件）                                                        |
| `get_entries` †       | `since?: string`         | `{ entries: SessionEntry[], leafId: string \| null }`；`since` 是 entry id 游标，不含它本身 |
| `get_tree` †          | —                        | `{ tree: SessionTreeNode[] }`（`{ entry, children, label? }`）                              |
| `set_session_name` †  | `name: string`           | `{ name }`                                                                                  |
| `get_fork_messages` † | —                        | `{ messages: { entryId, text }[] }`（活动分支上的用户消息，`fork` 的候选）                  |

### 回滚

详见 [rewind-plan.md](../history/rewind-plan.md) §3。回滚点是活动路径上开启新回合的用户消息（运行中插话、排队消息并入当前回合，不单列）。运行中调用回 `busy`。

| 命令                | 参数                                                                                                      | `data`                                                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_rewind_points` | —                                                                                                         | `{ points: { entryId, text, timestamp, hasCheckpoint }[] }`，从旧到新；`hasCheckpoint: false`（内存会话、检查点关闭、超出保留数）时只能仅对话                                   |
| `rewind`            | `entryId`、`mode: both \| conversation \| code`、`dryRun?: boolean`、`onConflict?: "skip" \| "overwrite"` | `RewindResult`：`conversation?: { leafId, draft: { text, images? } }`、`code?: CodeRestoreResult`、`gitHint?: { recordedHead, currentHead }`；`dryRun` 只返回预览，不改任何东西 |
| `summarize_from`    | `entryId`、`instructions?: string`                                                                        | `{ leafId, draft, summary? }`：回到该消息之前，为离开的分支写 `branch_summary`，并回填原消息                                                                                    |
| `summarize_up_to`   | `entryId`、`instructions?: string`                                                                        | `CompactionResult`：以该消息为切点压缩之前的上下文（`firstKeptEntryId` = 该消息），停在末尾                                                                                     |

`CodeRestoreResult`：`restored` / `deleted` / `conflicts`（`skip` 时未动，`overwrite` 时已覆盖）/ `skipped: { path, reason }[]`（`symlink` / `hardlink` / `not_regular` / `parent_moved` / `too_large` / `backup_missing`）/ `failed: { path, message }[]` / `insertions` / `deletions`；路径在 cwd 内为相对路径（`/` 分隔）。错误码：没有检查点却要恢复代码 → `no_checkpoint`；全部失败且无一恢复 → `rewind_failed`（对话不动）；条目不是活动路径上的回滚点 → `invalid_arguments`。仅对话或仅代码时，下一次提示前会在上下文末尾追加一条 `custom_message{customType: "ama.rewind-note"}` 告诉模型哪些文件与对话不一致。

换会话后服务端重新订阅事件，并为新会话发 `session_start`（`reason` 为 `new` / `resume` / `fork`）。`new_session` 目前不使用 `parentSession` 参数。条目形状见 [session-format.md](session-format.md)。

### 审批

| 命令                      | 参数                                                                                  | `data`                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `set_client_capabilities` | `capabilities: ("approvals" \| "images" \| "hooks" \| "plans" \| "compact_events")[]` | `{ capabilities }`                                                             |
| `permission_response`     | `requestId: string`、`decision: "allow" \| "deny" \| "allow_session"`                 | `{ accepted: boolean }`（false = 当前没在等这个 id，已暂存，稍后被问到时生效） |

`compact_events`（docs/history/memory-plan.md D9）：声明后，`turn_end.toolResults`、`message_start` 与 `entry_appended` 不再重复携带工具结果与带图用户消息的正文（以 `contentOmitted: true` 标记），正文只在 `message_end` 与 `tool_execution_end` 里发；不声明时事件形状逐字节不变。形状见「[精简事件](#精简事件compact_events)」。`stream-json` 没有这个开关，输出始终是全量形状。

### 工具、权限、发现

| 命令                  | 参数                                                                   | `data`                                                                                                              |
| --------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `get_tools`           | —                                                                      | `{ tools: { name, description, parameters, permission, active }[] }`（注册表全部工具，`active` 表示模型当前能看到） |
| `set_active_tools`    | `names: string[]`                                                      | `{ names }`（生效后的活动工具名）                                                                                   |
| `set_permission_mode` | `mode: plan \| allowlist \| default \| auto-edit \| auto \| full-auto` | `{ mode }`（未知模式 → `invalid_arguments`）                                                                        |
| `get_commands`        | —                                                                      | `{ commands: { name, description?, source: "builtin" \| "template" \| "skill" }[] }`；Skill 名写作 `skill:<名>`     |
| `get_skills`          | —                                                                      | `{ skills: { name, description, location, … }[] }`（已发现的 Skill；`location` 是 SKILL.md 路径）                   |

### 计划与任务（第五波）

| 命令            | 参数                                                                                                                                             | `data`                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `plan_response` | `planId`、`decision: approve \| approve_fresh \| revise \| reject`、`mode?`（批准后的执行模式）、`feedback?`（revise 的意见）、`editedMarkdown?` | `{ planId, decision }`；`planId` 不是待审批的计划 → `plan_not_found`。见「计划审批」                     |
| `get_plan`      | `planId?`                                                                                                                                        | `PlanData \| null`：`{ id, version, status, markdown, steps, sourceEntryId, filePath? }`，缺省取最近一份 |
| `get_todos`     | —                                                                                                                                                | `{ items: { id, text, status: pending \| in_progress \| done, planStep? }[] }`                           |
| `get_tasks`     | —                                                                                                                                                | `{ tasks: TaskInfo[] }`（子 Agent 任务注册表的只读视图；未装配时为空表）                                 |
| `get_agents`    | —                                                                                                                                                | `{ agents: AgentInfo[] }`（可用的子 Agent 类型与外部 Agent；未装配时为空表）                             |

### 轨迹（第六波）

`get_trace` 返回会话轨迹（与 TUI `/trace`、`ama sessions trace` 同一棵树，见 [tui.md](../guides/tui.md)「轨迹」）。不新增事件：客户端收到
`entry_appended` 后用上次的 `cursor.since` 再取一次即可增量刷新。

| 参数         | 说明                                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `branch?`    | `leaf`（缺省，根到当前叶子）\| `all`（文件里全部条目）                                                                     |
| `turnLimit?` | 尾部优先的回合数，缺省 50，范围 1–500                                                                                      |
| `before?`    | 回合 id（= 该回合用户消息的条目 id），返回它之前的 `turnLimit` 个回合（向前翻页）                                          |
| `since?`     | 条目 id（同 `get_entries.since`）：返回从「包含该条目的回合」起到末尾的全部回合（不受 `turnLimit` 限制）；与 `before` 互斥 |
| `taskId?`    | 该任务的子轨迹：ama 子 Agent 返回子会话的轨迹（游标、`leafId` 按子会话）；外部 Agent 返回空回合，骨架在 `task.external`    |
| `content?`   | `none`（缺省，只有结构、时间与 token）\| `preview`（附 `previews`）                                                        |

`data`：`{ trace, hasMoreBefore, cursor: { before?, since }, leafId, task?, previews? }`

- `trace` 是 `Trace`（`@armadra/agent` 导出的类型）：`turns` 是所请求的窗口，`totals` 与 `aux`（保温、权限分类等辅助请求）始终是整条分支的。
- `cursor.before` 是窗口第一个回合的 id（还有更早的回合时才有），传给下一次 `before`；`cursor.since` 是分支上最后一条条目的 id，传给下一次 `since`。
- **增量合并**：从返回的第一个回合 id 起替换本地列表的尾部；本地没有这个 id（rewind 换了分支）就整体替换；返回空表表示分支上没有回合。
  `since` 所在的回合总会重发（它可能还在进行中）；后台任务晚到的结束条目改到更早的回合时，从那个回合起重发。`since` 不在所选分支上时从第一个回合起全量返回。
- `task`：`taskId` 时的子 Agent 节点本身（不含 `child`）。
- `previews`：`<kind>:<节点 id>` → `{ input?, output?, args?, result? }`（回合的提示、请求的回复文字、工具参数 JSON 与结果），
  只含窗口内本会话的节点；先脱敏（同 `sessions export`）再截断——参数 500 字符、其余 2000 字符，截断处以 `…` 结尾。
- 整个 `data` 都经过脱敏；节点里只有 id、时间、计数与用量，正文只在 `previews` 里。运行中没有结果的工具标 `running`。
- 错误：`invalid_arguments`（参数越界、`before` 不是本分支的回合 id、`before` 与 `since` 同用）、`task_not_found`。

### 后台子 Agent（第七波）

| 命令              | 参数      | `data`                                                                                                                                                                     |
| ----------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `background_task` | `taskId?` | `{ backgrounded: string[] }`：实际转了后台的 `taskId`。不给 `taskId` = 全部前台运行中任务；已结束、已在后台或不存在的任务回空表；`taskId` 不是字符串 → `invalid_arguments` |

被转的前台任务不中断，其 `task` 调用立即以 `tool_execution_end` 返回（结果文本以 `[task tN] Moved to the background` 开头，
`details.status: "running"`），随后发 `subagent_background`；任务结束时照常 `subagent_end`，父会话空闲后收到 `origin: "task"`
的通知消息。语义与交互界面的 `Ctrl+B` 相同，见 [agents.md](../guides/agents.md)「前台与后台」。

合计 44 条命令，名字即 `RpcCommandMap` 的键。

## 事件

事件就是进程内 `SessionEvent`（`src/agent/types.ts`），只有 `message_update` 在线上换成纯增量。按出现场景分组：

| 事件                                                 | 字段                                                                                                                                                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session_start`                                      | `sessionId`、`sessionFile?`、`cwd`、`reason: startup \| resume \| new \| fork`                                                                                                                                                                   |
| `session_changed`                                    | `sessionId`、`sessionFile?`                                                                                                                                                                                                                      |
| `session_rewound`                                    | `entryId`、`mode`、`restored`、`deleted`、`conflicts`、`skipped`（回滚完成；`dryRun` 不发，仅对话时文件清单为空）                                                                                                                                |
| `before_agent_start`                                 | `prompt`（经 UserPromptSubmit Hook 与模板展开之后）                                                                                                                                                                                              |
| `agent_start` / `turn_start` / `agent_before_settle` | —                                                                                                                                                                                                                                                |
| `turn_end`                                           | `message`（助手消息）、`toolResults`                                                                                                                                                                                                             |
| `agent_end`                                          | `stopReason`、`willRetry`                                                                                                                                                                                                                        |
| `agent_settled`                                      | `warning?`（运行彻底结束，含重试与 followUp）                                                                                                                                                                                                    |
| `message_start` / `message_end`                      | `message`（`AgentMessage`）                                                                                                                                                                                                                      |
| `message_update`                                     | `assistantMessageEvent`、`usage?`（见下）                                                                                                                                                                                                        |
| `tool_execution_start`                               | `toolCallId`、`toolName`、`args`、`parentToolCallId?`                                                                                                                                                                                            |
| `tool_execution_update`                              | `toolCallId`、`toolName`、`partial`（运行中的输出文本）、`parentToolCallId?`                                                                                                                                                                     |
| `tool_execution_end`                                 | `toolCallId`、`toolName`、`result`、`isError`、`parentToolCallId?`、`autoDecision?`（auto 模式：`{ layer: rule \| static \| classifier, decision, reason, cached? }`）、`denied?`（`true`：被权限 / Hook / 审批拒绝而没有执行，原因见 `result`） |
| `queue_update`                                       | `steering: string[]`、`followUp: string[]`                                                                                                                                                                                                       |
| `compaction_start`                                   | `trigger: threshold \| overflow \| manual`                                                                                                                                                                                                       |
| `compaction_end`                                     | `trigger`、`result?`、`aborted`、`willRetry`、`error?`                                                                                                                                                                                           |
| `auto_retry_start`                                   | `attempt`、`maxAttempts`、`delayMs`、`errorMessage`                                                                                                                                                                                              |
| `auto_retry_end`                                     | `success`、`attempt`、`finalError?`                                                                                                                                                                                                              |
| `permission_request`                                 | `requestId`、`toolName`、`input`、`reason: mode \| dangerous \| hook`、`hookReason?`、`timeoutMs`、`preview?`、`autoDecision?`（auto 模式下为什么询问）、`context?`（来源，见「子 Agent 事件」）                                                 |
| `permission_resolved`                                | `requestId`、`decision`                                                                                                                                                                                                                          |
| `permission_mode_changed`                            | `mode`                                                                                                                                                                                                                                           |
| `model_changed`                                      | `model: { provider, id, channel? }`                                                                                                                                                                                                              |
| `thinking_level_changed`                             | `level`                                                                                                                                                                                                                                          |
| `entry_appended`                                     | `entry`（刚落盘的会话条目）                                                                                                                                                                                                                      |
| `hook_executed`                                      | `event`、`command`、`exitCode`（超时或被信号杀死为 null）、`durationMs`                                                                                                                                                                          |
| `cache_miss`                                         | `missedTokens`、`missedCost?`、`reason`、`detail?`、`idleMs`                                                                                                                                                                                     |
| `cache_warm`                                         | `phase: scheduled \| sent \| stopped`、`nextWarmAt?`、`usage?`、`cost?`、`reason?`                                                                                                                                                               |
| `context_pressure`                                   | `percent`、`threshold: 70 \| 90`、`remainingTokens?`、`estimatedTurnsLeft?`                                                                                                                                                                      |

另有非会话事件 `{"type":"notification","level":"info"|"warn"|"error","message":…}`：宿主 `ui.notify` 与应答之后的运行失败。

`parentToolCallId` 只出现在 codemode 脚本里经 `tools.*` 发起的内层调用上，值是外层 `codemode` 调用的 id；客户端据此折叠显示。内层调用不进转录。

`message_end`、`turn_end`、`done` / `error` 与回放（`get_messages`、`get_entries`）里的助手消息可能带两个可选字段（模型调用效率批次，docs/history/model-efficiency-plan.md §1.10）：失败消息的 `retryAfterMs`（`Retry-After`，毫秒），工具调用块的 `rawArguments`（模型输出的原始参数字符串）。`subagent_*` 事件不变；`get_tasks` 的 `TaskInfo` 可带 `context?: "fork" | "fresh"`（子会话的实际上下文模式）。都是新增的可选字段，`RPC_PROTOCOL_VERSION` 不变，客户端忽略不认识的字段即可。

### 精简事件（`compact_events`）

一次工具调用的结果在全量形状下会随 `message_start`、`message_end`、`tool_execution_end`、`turn_end`、`entry_appended` 各出现一次。客户端用 `set_client_capabilities` 声明 `compact_events` 之后，其中三类事件改为：

| 事件             | 全量（未声明）                        | 声明 `compact_events` 时                                                                                                     |
| ---------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `turn_end`       | `toolResults`：完整的 toolResult 消息 | `toolResults[]` 每项只有 `{ toolCallId, toolName, isError, timestamp, contentOmitted: true }`（不带 `content` 与 `details`） |
| `message_start`  | `message` 原样                        | `message` 是 toolResult 或带图片的 user 消息时 `content: ""`、`contentOmitted: true`，其余字段不变；其它消息原样             |
| `entry_appended` | `entry` 原样                          | `message` 条目同上（toolResult、带图片的 user）；其它条目原样                                                                |

`message_end` 与 `tool_execution_end` 始终全量：前者是客户端替换整条消息的依据，后者带 `details`。回放命令（`get_messages`、`get_entries`）不受影响。会话切换后仍按当前声明生效；重新声明不含 `compact_events` 的能力列表即恢复全量。`RPC_PROTOCOL_VERSION` 不变。

### 子 Agent 事件（第五波）

`task` / `task_ctl` 起的子 Agent（ama 子会话与外部 Agent 同一组事件，见 [agents.md](../guides/agents.md)「子 Agent」）：

| 事件                  | 字段                                                                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subagent_start`      | `taskId`、`parentToolCallId`、`agent`、`runner`（`ama` / `claude` / `codex` / `acp:<程序>`）、`description`、`background`、`model?`、`sessionFile?`、`cwd`；同一 `taskId` 续聊时再发一次 |
| `subagent_update`     | `taskId`、`kind: tool \| text \| turn`、`toolName?`、`textDelta?`（≥ 250 ms 合并）、`turn`、`usage?`                                                                                     |
| `subagent_background` | `taskId`、`parentToolCallId`、`reason: user \| timeout \| host`（前台任务转后台：交互界面手动、`subagents.autoBackgroundAfterMs` 到时、RPC / SDK 调用；第七波）                          |
| `subagent_end`        | `taskId`、`status: completed \| failed \| aborted \| max_turns \| interrupted`、`usage?`、`cache?`、`outputFile?`、`worktree?: { branch, changed }`                                      |

子会话与外部 Agent 的审批照常以 `permission_request` 发给本连接，`context`（可选）标出来源（第六波起本会话工具调用的审批也带
`context.toolCallId`——触发审批的工具调用 id，轨迹据此算审批等待；外部 Agent 的请求不带）：
`depth`（1 = 来自 task 子 Agent）、`taskId`（来源任务）、`origin`（外部 Agent 发来的权限请求：`agent`、`sessionId`（外部 CLI
自己的会话 id）、`toolCall: { title, kind, locations?, inputSummary? }`、`options`）。对话框据此标 `[task:<agent>]` 或
`[claude · 会话 abc1]`。外部 Agent 的请求 `toolName` 是 `agent:<id>`，回答只影响这一次（「本会话允许」交给外部 Agent 自己记）；
首次在会话里以某个外部 Agent 运行时还有一次 `toolName: "task"`、`input: { agent, mode, note }` 的确认（`context.taskId`）。
`test/fixtures/rpc/external.out.jsonl` 是 `task(agent="acp:ama")` 的三次审批（task 工具、首次运行、子 ama 的 bash）的黄金记录，
由 `src/agents/external-rpc.test.ts` 用 `UPDATE_GOLDEN=1` 更新。后台任务完成后父会话收到一条
`origin: "task"` 的 user 消息（`<task-notification …>…</task-notification>`），随后照常开新回合。任务列表与类型列表由
`get_tasks` / `get_agents` 返回（形状 `TaskInfo` / `AgentInfo`；没有 task 工具时为空表），数据来自当前会话的
`taskRegistryView(sessionId)` / `sessionAgents(sessionId)`（`src/agent/subagent-registry.ts`）。`get_agents` 另含外部 Agent
（`installed` / `version` 来自 PATH 与 `--version` 探测，会话建立时异步缓存、外部任务结束与宿主注入变化时刷新；缓存就绪前
只有类型目录，见 `cachedAgentInfos`，`src/agents/external.ts`）。
`test/fixtures/rpc/subagent.out.jsonl` 是一次前台 `task(agent="explore")` 加 `get_tasks` / `get_agents` 的黄金记录（只保留
响应、`tool_execution_*`、`subagent_*` 与 `agent_settled`），由
`src/agent/subagent-rpc.test.ts` 用 `UPDATE_GOLDEN=1` 更新。`test/fixtures/rpc/background.out.jsonl` 是前台 `task` 运行中
`background_task` 转后台、随后任务结束并投递通知回合的黄金记录，由 `src/modes/rpc/rpc-background.test.ts` 更新。

### 速率遥测（第五波）

主会话装有遥测扩展（`src/agent/session-telemetry.ts`），只统计对话请求（`purpose: "turn"`；压缩摘要、保温、探测、分类器不计）：

- 事件 `{"type":"telemetry_tick"}`：流式中首 token 之后约每 500 ms 一次（≤ 2 Hz，由增量驱动；瞬时完成的短回复不发），
  `ui.animation: false` 时不发；没有载荷，数据从 `get_session_stats` 的 `telemetry` 取。
- `SessionStats.telemetry`：`{ sessionStartedAt, last?, live?, avgTps? }`。`last` 是最近一次请求（`requestAt`、`firstTokenAt?`、
  `ttftMs?`、`doneAt?`、`outputTokens?`、`tps?`；进行中的请求出首 token 后即为 `last`，结束后补齐 `doneAt` 等）；
  `live` 只在流式中（`tps` 为最近 2 s 窗口的估算、`outputTokens` 按增量字符估算、`elapsedMs` 自首 token 起）；
  `avgTps` = Σ输出 / Σ(结束 − 首 token)，生成不足 250 ms 的请求不计（`tps` 也留空）。时间都是毫秒时间戳。

### 预算、回退与后台命令事件（第五波 W5-H2）

| 事件             | 字段                                                                                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `limit_reached`  | `kind: turns \| cost`、`value`（本次运行的回合数 / 美元）、`limit`；`limits.*`（config，`-p` 另有 `--max-turns` / `--max-cost`）到限时每次运行每类一次，随后 `agent_settled{warning:"limit_reached"}` |
| `model_fallback` | `from`、`to`（`{ provider, id, channel? }`）、`reason`（触发的错误文本）；可重试错误在 overloaded 时或重试用尽后切到 `fallbackModel` 重试一次，回复后切回（另有两次 `model_changed`）                 |
| `background_job` | `jobId`、`phase: started \| exited \| stopped`、`command`、`pid?`、`outputPath?`、`exitCode?`；`bash{background:true}` 启动的后台命令                                                                 |

重复调用检测（同 run 同名同参第 5 次）结束 run 时 `agent_settled{warning:"repeated_tool_call"}`。

### `message_update` 与消息重建

线上的 `message_update` 去掉了累计消息与 `partial`，只有增量：

```json
{
  "type": "message_update",
  "assistantMessageEvent": { "type": "text_delta", "contentIndex": 0, "delta": "hello" },
  "usage": { "input": 12, "output": 3, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 15 }
}
```

`assistantMessageEvent.type` 取值：`start`、`text_start` / `text_delta` / `text_end`、`thinking_start` / `thinking_delta` / `thinking_end`、`toolcall_start`（带 `id`、`name`）/ `toolcall_delta`（参数 JSON 片段）/ `toolcall_end`（带完整 `toolCall`）、`done`（`reason: stop | length | toolUse`，带最终 `message`）、`error`（`reason: aborted | error`，带最终 `message`）。客户端重建：

1. `message_start` 给出初始助手消息（`content: []`）；
2. 按 `contentIndex` 维护内容块：`*_start` 建块，`*_delta` 追加文本（工具参数先当字符串拼接），`toolcall_end` 用完整 `toolCall` 替换该块；
3. `usage` 是该时刻的最新用量，直接覆盖；
4. 以 `message_end`（或 `done` / `error` 的 `message`）为准替换整条消息——重建结果只用于流式显示。

### 会话统计

`get_session_stats` 的 `data` 是 `SessionStats`：

| 字段                                                               | 说明                                                                        |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `sessionId` / `sessionFile`                                        | 会话标识                                                                    |
| `userMessages` / `assistantMessages` / `toolCalls` / `toolResults` | 计数                                                                        |
| `tokens`                                                           | `{ input, output, cacheRead, cacheWrite, total }`，含保温请求的用量         |
| `cost`                                                             | 美元；任一条消息缺成本时缺省（界面显示 `$?`）                               |
| `contextTokens` / `contextWindow` / `contextPercent`               | 当前上下文估算、窗口与占用（0–100）；模型没有窗口时缺省                     |
| `context`                                                          | 估算来源与自动压缩阈值（字段与缺省语义见 sessions.md）                      |
| `cacheHitRate`                                                     | 旧口径命中率：cacheRead /（input + cacheRead + cacheWrite），全部请求进分母 |
| `cache`                                                            | `SessionCacheStats`（下例），会话层缓存控制器接线时才有                     |

```json
{
  "type": "response",
  "command": "get_session_stats",
  "success": true,
  "data": {
    "tokens": { "input": 1177, "output": 64, "cacheRead": 2176, "cacheWrite": 0, "total": 3417 },
    "cacheHitRate": 0.65,
    "cache": {
      "reporting": "reported",
      "lastHitRate": 0.84,
      "hitRate": 0.65,
      "reBilledTokens": 0,
      "reBilledUsd": 0,
      "misses": { "count": 0, "byReason": {} },
      "warming": { "mode": "streaming", "state": "stopped", "reason": "no_ttl" },
      "contextRemainingTokens": 127077,
      "estimatedTurnsLeft": 2443
    }
  }
}
```

| `cache` 字段                                    | 说明                                                                                                                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reporting`                                     | 当前端点（供应商、baseUrl 主机、模型）的三态：`unknown` / `reported` / `silent`；只在内存，同一进程内跨会话复用                                                                  |
| `lastHitRate` / `hitRate`                       | 最近一次 / 会话累计命中率（0–1）；`unknown` / `silent` 时没有 `lastHitRate`，不报缓存的请求不进 `hitRate` 分母                                                                   |
| `reBilledTokens` / `reBilledUsd`                | 未命中重计费合计；有无价模型参与时没有 `reBilledUsd`                                                                                                                             |
| `misses`                                        | `count` 与 `byReason`（`prefix_changed` / `model_changed` / `idle` / `subtask` / `evicted`）；统计计入全部未命中，不受界面提示门槛影响                                           |
| `warming`                                       | `mode`（`off` / `streaming` / `idle`）、`state`（`inactive` / `scheduled` / `stopped`）、`phase?`、`nextWarmAt?`、停止原因 `reason?`、`sent?`、`costUsd?`、`expectedSavingsUsd?` |
| `contextRemainingTokens` / `estimatedTurnsLeft` | 上下文余量与按最近 5 回合增量估算的剩余回合                                                                                                                                      |
| `subagents`                                     | task 子会话汇总：`count`、`hitRate?`、`reBilledTokens`                                                                                                                           |
| `granularity`                                   | 可选：当前端点推断的缓存读分块粒度（token，非零 cacheRead 的最大公约数，≥ 2 个样本且在 128–8192 才给）；未命中的噪声下限取它与 1024、`minTokens` 中的最大者                      |

`tokens` / `cacheHitRate` 保持旧口径，新客户端用 `cache`。缓存事件示例：

```json
{"type":"cache_miss","missedTokens":142000,"missedCost":0.1278,"reason":"evicted","idleMs":3}
{"type":"cache_warm","phase":"scheduled","nextWarmAt":1790000000000}
{"type":"cache_warm","phase":"sent","usage":{"input":1,"output":1,"cacheRead":12000,"cacheWrite":0,"totalTokens":12002},"cost":0.0012}
{"type":"cache_warm","phase":"stopped","reason":"no_cache_hits"}
{"type":"context_pressure","percent":71,"threshold":70,"remainingTokens":57990,"estimatedTurnsLeft":6}
```

`cache_miss` 的 `detail` 只在 `prefix_changed` 时给出（`tools`、`system`，或带变化节名的 `system:<节名,…>`，如 `system:hooks,memory`）。`cache_warm{stopped}` 的 `reason` 取值与含义见 [tui.md](../guides/tui.md)「缓存与上下文」。`ama -p --output-format json` 的结果对象另有 `cache` 字段，形状同上。

## 审批

1. 工具调用需要确认时，服务端发 `permission_request`。`preview`（可选）是执行前预览：`{ kind: "bash" | "write" | "edit" | "other", lines: string[], severity: "info" | "warn" | "danger", affected?: { path, exists, bytes?, files? }[] }`，`lines` 已排好、不含颜色，可直接显示；预览只读、有上限，算不出时缺省。
2. 客户端在此之前发过 `set_client_capabilities{capabilities:["approvals"]}` 才会被问到；否则这条 ask 无人作答 → deny。声明里去掉 `approvals` 会撤下客户端并让在等的审批全部按无人作答处理。
3. 客户端回 `permission_response{requestId, decision}`。`allow_session` 在本会话内记住同一工具与归一化输入前缀，不落盘。先于请求到达的回答会暂存，等请求出现时使用。
4. 回答者顺序：宿主 broker（`HostApi.approvals.setBroker`）→ RPC 客户端 → 无人作答 deny。审批串行，同一时刻只有一个在等。
5. 超时：`timeoutMs`（缺省 600 000，即 10 分钟；环境变量 `AMA_APPROVAL_TIMEOUT_MS` 可改）内没有回答 → 服务端按 deny 处理并发 `permission_resolved`。运行被中断时同样 deny，即使客户端已经放行。

## 计划审批

plan 模式与计划的格式见 [plan.md](../guides/plan.md)。

1. 回合在 plan 模式下以纯文本结束、回复里有 `<proposed_plan>` 块时，服务端落盘计划并发 `plan_proposed{ planId, version, markdown, steps, filePath? }`（`steps[]`：`{ id, text, dependsOn?, agent? }`），随后照常 `agent_settled`。
2. 客户端声明过 `set_client_capabilities{capabilities:["plans"]}` 才由它回答；没声明时按配置 `plan.unattended`：缺省 `stop`（计划留在 proposed，不切模式、不执行，客户端之后仍可用 `plan_response` 作答），`approve` 时同一次运行里自动批准并执行。
3. `plan_response`：
   - `approve`：计划标 approved，步骤写成 todo（首项 in_progress，发 `todo_updated`），发 `plan_resolved{ planId, decision, mode }`，权限模式切到 `mode`（缺省进入 plan 前的模式；进入前就是 plan 时用 `default`），随后自动开一个新回合：用户消息 `The plan is approved. Go ahead.`（`origin: "plan"`）+ `custom_message{ama.plan_approved}`（计划全文、文件路径、进度记法：有 todo 工具时按 todo 推进，没有时请模型每完成一步写一行 `[DONE:<步骤>]`，ama 据此推进待办并发 `todo_updated`）。
   - `approve_fresh`：同上标 approved、切模式，然后新建会话（发 `session_start{reason:"new"}`），在新会话里写 todo，并以计划全文为首条用户消息开回合。
   - `revise`：留在 plan；`feedback` 非空时作为普通用户消息开回合，模型重写计划后出新版本（旧版标 superseded）。
   - `reject`：计划标 rejected，留在 plan。
   - `editedMarkdown`：客户端改过的全文；与原文不同则先落一份新版本（`plan_proposed` 再发一次）再按 `decision` 处理。
4. `todo_updated{ items }`：todo 清单每次变化（`todo` 工具的 set / update、批准时生成）都发，形状同 `get_todos`。

`test/fixtures/rpc/plan.out.jsonl` 是一次完整审批往返的黄金文件（不含 `entry_appended` 与 `message_update`）：声明 `plans` → `set_permission_mode plan` → 提示 → `ama.plan_mode` 说明 → 带计划块的回复 → `plan_proposed` → `agent_settled` → `get_plan` → `plan_response approve` → `todo_updated`、`plan_resolved`、`permission_mode_changed` → 执行回合（`ama.plan_approved`）→ `get_todos`。由 `src/modes/rpc/rpc-plan.test.ts` 用 `UPDATE_GOLDEN=1` 更新。

## 退出

- stdin 关闭：不再接收命令，撤下审批（之后的 ask 按无人作答 deny），等在途命令与已开始的运行结束、响应写完，退出码 0。所以 `printf '{"type":"prompt","message":"hi"}\n' | ama --mode rpc` 能拿到完整回复；要提前停止，先发 `abort`。
- SIGINT / SIGTERM：中断当前运行后有序退出，退出码 130 / 143。
- 启动阶段的失败按 CLI 退出码（[design.md](../design/design.md) §11.3）：配置错误 3、无模型或 key 4、会话错误 5、宿主 / Hook 启动失败 6、宿主 API 版本不匹配 78。

## 示例

`test/fixtures/rpc/prompt.out.jsonl` 是一次完整往返的黄金文件（fake 供应商；`prompt` → `get_last_assistant_text`，会话 id、时间戳与路径已归一化）：`hello` → `session_start` → `entry_appended`（模型、思考级别、首条 system 消息）→ `before_agent_start` → `agent_start` → `turn_start` → `prompt` 的响应 → 用户消息 → 助手消息的 `message_update` 增量 → `turn_end` → `agent_end` → `agent_before_settle` → `agent_settled` → 第二条命令的响应。改协议后由 `src/modes/rpc/rpc-mode.test.ts` 用 `UPDATE_GOLDEN=1` 更新并审阅差异。`test/fixtures/rpc/rewind.out.jsonl` 记回滚的往返（不含 `entry_appended`；第二回合用 write 新建了 `c.txt`）：`get_rewind_points` → `rewind{mode:"both", dryRun:true}` 只回预览 → `rewind{mode:"both"}` 先发 `session_rewound` 再回 `RewindResult`（`c.txt` 被删除、对话回到第二条消息之前）→ 非回滚点的 `summarize_up_to` 回 `invalid_arguments` → 回滚后的 `get_rewind_points`。

最小会话（stdin 关闭即撤下审批，所以管道方式只适合不需要审批的提示；要回答审批，保持 stdin 打开并先发 `set_client_capabilities`）：

```sh
printf '%s\n' '{"id":"1","type":"prompt","message":"hi"}' | ama --mode rpc --model anthropic/<model-id>
```
