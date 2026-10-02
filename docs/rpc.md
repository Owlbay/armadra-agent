# RPC 协议（stdio JSONL）

`ama --mode rpc` 从 stdin 读命令、向 stdout 写响应与事件，每行一个 JSON。类型定义在 `@armadra/agent/rpc`（`src/rpc.ts`），实现在 `src/modes/rpc/`。`ama -p --output-format stream-json` 输出的事件与这里同形状。设计依据见 [design.md](design.md) §13.2。

## 线路

- 读：只按 `\n` 切行（去掉行尾 `\r`，空行跳过），不按 U+2028 / U+2029 切；多字节 UTF-8 跨块拼接；stdin 结束时最后一段不带换行的行也算一行。
- 写：每行是一个 `JSON.stringify` 结果，U+2028 / U+2029 转义为 `\u2028` / `\u2029`，`Error` 序列化为 `{ name, message }`，bigint 转字符串，图片 base64 不截断。大行按 64 KiB 分片写出并等待背压，行与行不交错。
- stdout 只有协议行；日志、宿主通知的人读副本写 stderr。

## 握手

启动后先发 `hello`，再发当前会话的 `session_start`：

```json
{"type":"hello","protocolVersion":1,"agent":"ama","version":"0.1.0","capabilities":["approvals","images","hooks"]}
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
- 一行不是合法 JSON 或缺 `type` → `{ "type": "response", "command": "parse", "success": false, "error": … }`，没有 `id`。
- 需要会话实现扩展方法的命令（下表标 †）在非 `AgentSessionImpl` 会话上返回 `code: "not_implemented"`；CLI 与 SDK 建出的会话都是 `AgentSessionImpl`。

### 提示

| 命令          | 参数                                                                                    | `data`                                                       |
| ------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `prompt`      | `message: string`、`images?: ImageBlock[]`、`streamingBehavior?: "steer" \| "followUp"` | `{ disposition: "started" \| "queued" \| "handled" }`        |
| `steer`       | `message`、`images?`                                                                    | 同上                                                         |
| `follow_up`   | `message`、`images?`                                                                    | 同上                                                         |
| `abort`       | —                                                                                       | `{}`（回到空闲后应答；不清队列）                             |
| `clear_queue` | —                                                                                       | `{ steering: string[], followUp: string[] }`（被清掉的文本） |

提示类命令**不等运行结束**：会话开始运行（`before_agent_start` / `agent_start`）、消息入队或被处理（例如斜杠命令、Hook 阻止）后立刻应答，运行进展走事件。运行中发 `prompt` 且不带 `streamingBehavior` → 失败，`code: "busy"`；带上 `steer` / `followUp` 则入队。应答发出之后的运行失败以 `{"type":"notification","level":"error","message":…}` 报告。

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

`RpcModelInfo`：`provider`、`id`、`name`、`hasKey`、`keySource`（`cli` / `auth-file` / `config` / `env` / `none`）、`contextWindow?`、`maxTokens`、`reasoning`、`input`（`"text"` / `"image"`）。**密钥不离开进程**：只报有无与来源。

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

换会话后服务端重新订阅事件，并为新会话发 `session_start`（`reason` 为 `new` / `resume` / `fork`）。`new_session` 目前不使用 `parentSession` 参数。条目形状见 [session-format.md](session-format.md)。

### 审批

| 命令                      | 参数                                                                  | `data`                                                                         |
| ------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `set_client_capabilities` | `capabilities: ("approvals" \| "images" \| "hooks")[]`                | `{ capabilities }`                                                             |
| `permission_response`     | `requestId: string`、`decision: "allow" \| "deny" \| "allow_session"` | `{ accepted: boolean }`（false = 当前没在等这个 id，已暂存，稍后被问到时生效） |

### 工具、权限、发现

| 命令                  | 参数                                              | `data`                                                                                                              |
| --------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `get_tools`           | —                                                 | `{ tools: { name, description, parameters, permission, active }[] }`（注册表全部工具，`active` 表示模型当前能看到） |
| `set_active_tools`    | `names: string[]`                                 | `{ names }`（生效后的活动工具名）                                                                                   |
| `set_permission_mode` | `mode: plan \| default \| auto-edit \| full-auto` | `{ mode }`                                                                                                          |
| `get_commands`        | —                                                 | `{ commands: { name, description?, source: "builtin" \| "template" \| "skill" }[] }`；Skill 名写作 `skill:<名>`     |
| `get_skills`          | —                                                 | `{ skills: { name, description, location, … }[] }`（已发现的 Skill；`location` 是 SKILL.md 路径）                   |

合计 33 条命令，名字即 `RpcCommandMap` 的键。

## 事件

事件就是进程内 `SessionEvent`（`src/agent/types.ts`），只有 `message_update` 在线上换成纯增量。按出现场景分组：

| 事件                                                 | 字段                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `session_start`                                      | `sessionId`、`sessionFile?`、`cwd`、`reason: startup \| resume \| new \| fork`                                |
| `session_changed`                                    | `sessionId`、`sessionFile?`                                                                                   |
| `before_agent_start`                                 | `prompt`（经 UserPromptSubmit Hook 与模板展开之后）                                                           |
| `agent_start` / `turn_start` / `agent_before_settle` | —                                                                                                             |
| `turn_end`                                           | `message`（助手消息）、`toolResults`                                                                          |
| `agent_end`                                          | `stopReason`、`willRetry`                                                                                     |
| `agent_settled`                                      | `warning?`（运行彻底结束，含重试与 followUp）                                                                 |
| `message_start` / `message_end`                      | `message`（`AgentMessage`）                                                                                   |
| `message_update`                                     | `assistantMessageEvent`、`usage?`（见下）                                                                     |
| `tool_execution_start`                               | `toolCallId`、`toolName`、`args`、`parentToolCallId?`                                                         |
| `tool_execution_update`                              | `toolCallId`、`toolName`、`partial`（运行中的输出文本）、`parentToolCallId?`                                  |
| `tool_execution_end`                                 | `toolCallId`、`toolName`、`result`、`isError`、`parentToolCallId?`                                            |
| `queue_update`                                       | `steering: string[]`、`followUp: string[]`                                                                    |
| `compaction_start`                                   | `trigger: threshold \| overflow \| manual`                                                                    |
| `compaction_end`                                     | `trigger`、`result?`、`aborted`、`willRetry`、`error?`                                                        |
| `auto_retry_start`                                   | `attempt`、`maxAttempts`、`delayMs`、`errorMessage`                                                           |
| `auto_retry_end`                                     | `success`、`attempt`、`finalError?`                                                                           |
| `permission_request`                                 | `requestId`、`toolName`、`input`、`reason: mode \| dangerous \| hook`、`hookReason?`、`timeoutMs`、`preview?` |
| `permission_resolved`                                | `requestId`、`decision`                                                                                       |
| `permission_mode_changed`                            | `mode`                                                                                                        |
| `model_changed`                                      | `model: { provider, id, channel? }`                                                                           |
| `thinking_level_changed`                             | `level`                                                                                                       |
| `entry_appended`                                     | `entry`（刚落盘的会话条目）                                                                                   |
| `hook_executed`                                      | `event`、`command`、`exitCode`（超时或被信号杀死为 null）、`durationMs`                                       |
| `cache_miss`                                         | `missedTokens`、`missedCost?`、`reason`、`detail?`、`idleMs`                                                  |
| `cache_warm`                                         | `phase: scheduled \| sent \| stopped`、`nextWarmAt?`、`usage?`、`cost?`、`reason?`                            |
| `context_pressure`                                   | `percent`、`threshold: 70 \| 90`、`remainingTokens?`、`estimatedTurnsLeft?`                                   |

另有非会话事件 `{"type":"notification","level":"info"|"warn"|"error","message":…}`：宿主 `ui.notify` 与应答之后的运行失败。

`parentToolCallId` 只出现在 codemode 脚本里经 `tools.*` 发起的内层调用上，值是外层 `codemode` 调用的 id；客户端据此折叠显示。内层调用不进转录。

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

`cache_miss` 的 `detail` 只在 `prefix_changed` 时给出（`system` / `tools`）。`cache_warm{stopped}` 的 `reason` 取值与含义见 [tui.md](tui.md)「缓存与上下文」。`ama -p --output-format json` 的结果对象另有 `cache` 字段，形状同上。

## 审批

1. 工具调用需要确认时，服务端发 `permission_request`。`preview`（可选）是执行前预览：`{ kind: "bash" | "write" | "edit" | "other", lines: string[], severity: "info" | "warn" | "danger", affected?: { path, exists, bytes?, files? }[] }`，`lines` 已排好、不含颜色，可直接显示；预览只读、有上限，算不出时缺省。
2. 客户端在此之前发过 `set_client_capabilities{capabilities:["approvals"]}` 才会被问到；否则这条 ask 无人作答 → deny。声明里去掉 `approvals` 会撤下客户端并让在等的审批全部按无人作答处理。
3. 客户端回 `permission_response{requestId, decision}`。`allow_session` 在本会话内记住同一工具与归一化输入前缀，不落盘。先于请求到达的回答会暂存，等请求出现时使用。
4. 回答者顺序：宿主 broker（`HostApi.approvals.setBroker`）→ RPC 客户端 → 无人作答 deny。审批串行，同一时刻只有一个在等。
5. 超时：`timeoutMs`（缺省 600 000，即 10 分钟；环境变量 `AMA_APPROVAL_TIMEOUT_MS` 可改）内没有回答 → 服务端按 deny 处理并发 `permission_resolved`。运行被中断时同样 deny，即使客户端已经放行。

## 退出

- stdin 关闭：不再接收命令，撤下审批（之后的 ask 按无人作答 deny），等在途命令与已开始的运行结束、响应写完，退出码 0。所以 `printf '{"type":"prompt","message":"hi"}\n' | ama --mode rpc` 能拿到完整回复；要提前停止，先发 `abort`。
- SIGINT / SIGTERM：中断当前运行后有序退出，退出码 130 / 143。
- 启动阶段的失败按 CLI 退出码（[design.md](design.md) §11.3）：配置错误 3、无模型或 key 4、会话错误 5、宿主 / Hook 启动失败 6、宿主 API 版本不匹配 78。

## 示例

`test/fixtures/rpc/prompt.out.jsonl` 是一次完整往返的黄金文件（fake 供应商；`prompt` → `get_last_assistant_text`，会话 id、时间戳与路径已归一化）：`hello` → `session_start` → `entry_appended`（模型、思考级别、首条 system 消息）→ `before_agent_start` → `agent_start` → `turn_start` → `prompt` 的响应 → 用户消息 → 助手消息的 `message_update` 增量 → `turn_end` → `agent_end` → `agent_before_settle` → `agent_settled` → 第二条命令的响应。改协议后由 `src/modes/rpc/rpc-mode.test.ts` 用 `UPDATE_GOLDEN=1` 更新并审阅差异。

最小会话（stdin 关闭即撤下审批，所以管道方式只适合不需要审批的提示；要回答审批，保持 stdin 打开并先发 `set_client_capabilities`）：

```sh
printf '%s\n' '{"id":"1","type":"prompt","message":"hi"}' | ama --mode rpc --model anthropic/<model-id>
```
