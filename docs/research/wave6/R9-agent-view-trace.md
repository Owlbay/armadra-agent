# R9 Agent 栏 / 子 Agent 视图 / 轨迹（/trace、HTML、get_trace）调研

> 调研员只读产出，2026-10-03。仓库 `armadra-agent` @ `cdc9408`。代码证据写 `文件:行`；外部资料文末列出。

## 0. 结论先行

1. **轨迹的「骨架」已经在会话文件里，「计时」几乎没有。** 条目树 + `assistant.usage`（含 cacheRead/cacheWrite/cost）+ `toolCall`↔`toolResult` 配对 + `context_edit{reason:retry|overflow}` + `model_change` + `compaction` + `ama.task` 已足以重建 Turn → Step → ToolCall → Subagent 的结构；但 **ttft / tps 只在内存**（`session-telemetry.ts` 只 `contributeStats`，从不落盘，且只装 depth 0），**工具开始时刻没有落盘**，`toolResult.timestamp` 是**整批结束**时刻（`tool-runner.ts:315-327` 在批次全部结束后才统一造结果消息），codemode 嵌套调用**不入转录**，压缩耗时、重试等待、审批等待都不落盘。
2. **持久化建议：新增一个 `custom{customType:"ama.trace"}` 条目，不扩展 `usage` 条目。** `usage` 条目会被 `usageTotals` / `/session` 计费再算一次（`export.ts:58-63`），把每请求计时塞进去会重复计费或要改所有读方；`custom` 天然「不进上下文」（`session-format.md` 条目表），不碰缓存前缀，也不改 `toolResult` 消息形状（避免任何协议层把多余字段序列化出去）。
3. **外部 Agent 只能落「无正文骨架」。** wave5 §5.4 明确「原始事件只在内存展示，不进 JSONL（Armadra 审查 P0）」（`docs/wave5-plan.md:388`，`drivers/turn.ts:5-6`）。轨迹只记 kind / status / 起止时间 / 用量 / 计数；工具标题（常含命令行）默认不落，待定项见 §6。全屏视图里的外部 Agent 实时内容用内存环形缓冲，重启后只剩骨架 + 「去原 CLI resume <sessionId>」提示。
4. **Agent 视图的发消息不能直接复用 `task_ctl send`。** 运行中的任务 `continueTask` 直接报错 `still running; use task_ctl wait or stop first`（`subagent-registry.ts:251-254`）。需要注册表新增 `message(taskId, text)`：运行中 → 子会话 `followUp`（ama runner）/ 排队到回合结束（外部）；已结束 → 等价 `task_ctl send`（后台续聊）。
5. **`Ctrl+B` 有两处冲突**：编辑器 `tui.editor.cursorLeft: ["left","ctrl+b"]`（`keybindings.ts:15`），以及 **tmux 缺省前缀就是 Ctrl+B**（tmux 用户按不到）。建议照 PR #63 的 Tab 先例：**输入框为空时** Ctrl+B 进入 Agent 栏，否则仍是光标左移；同时提供 **空输入时 ↓** 进入（工具 A 同款：底栏选择从输入框往下进入），并允许 `keybindings.json` 改键。
6. **「全屏」必须在主屏约束下做**（`docs/tui.md:5`、`tui-design.md:4`：不切备用屏）。实现为 `showOverlay(..., {anchor:"bottom"})` 且高度 = `rows − 1`（与 rewind 面板同一手法，`rewind-flow.ts:55`），退出时撤掉覆盖层，消息区与回滚历史不变。
7. **分批：先做一个很小的 B0（契约 + 落盘 + 事件增强），之后 A 与 B 并行，C 依赖 B 的构建器。** 文件所有权见 §5。

---

## 1. 参考实现

### 1.1 工具 Z

- **官方 Trajectory 视图**（官方 README）：一张「按回合组织的事件账本」，记录种类为 User / Assistant / Tool / 嵌套 Subtool / compaction；粗分隔线标回合边界、行内小标记标 step。点记录打开检查器：token、耗时、输入输出、时间、附件摘要。顶部固定一条**计时总览**：Assistant 段把「已记录的 TTFT」与「解码」分开画，可拖选区间过滤、缩放平移。
  - 长历史：**先从尾部加载 50 个节点，向前按需翻页，只渲染可见行（虚拟滚动 + overscan）**。
  - 流式时**跟随尾部，用户上滚则暂停跟随**；**进行中的记录只画起点标记，不编造已耗时**。
  - 数据来源：运行时独立的 history 源，不读不改聊天快照；工具 Z 的 resume / fork / replay / transcript / trajectory 都由同一条只追加事件流构建（会话日志是 zstd JSONL）。
- **社区插件甲**（轨迹时间线）：横向可回放时间线 + minimap、搜索、按回合导航、跟随、分页、step/子调用的耗时与吞吐、prompt 变化对比、原始请求分析、Markdown 导出。
- **社区插件乙**（轨迹导出）：会话日志 → 自包含 HTML（带 SHA-256 审计戳）——与本次 C 块同构。
- **社区插件丙**（轨迹调试）：瀑布图、确定性回放、断点、编辑重跑、fork 对比、性能分析（超出本波范围，回放 / 重跑不做）。
- **社区插件丁**（两个同名插件）：一个是竖向执行流（turn / user / assistant / tool / 审批 / 重试 / 压缩，SSE 实时追加 + 自动跟随）；另一个是多 Agent 团队层级画布。可借鉴「审批、重试、压缩作为一等节点」。
- **社区插件戊**（OTel 导出）：每回合一棵 OTel GenAI span 树（step、带 TTFT 的 LLM 调用、工具执行、token），走 OTLP 导出——说明「turn → step → llm/tool」的分层能直接映射 OTel。

**可借鉴**：回合/步骤两级分隔；TTFT 与解码分段着色；尾部优先 + 向前分页 + 虚拟列表；跟随/暂停跟随；进行中不编造时长；检查器分 tab（概要 / 输入 / 输出 / 原始 JSON）。

### 1.2 工具 A（`本机材料`，压缩源码检索）

- 状态里有 `viewingAgentTaskId` 与 `viewSelectionMode`，取值只见 `"none"` / `"viewing-agent"`；进入视图写 `viewSelectionMode:"viewing-agent"`，退出时清空并打点 `tengu_transcript_view_exit`。
- 底栏选择 `footerSelection` 取值 `"tasks" | "workflows" | "memories" | "frame"`，配合 `coordinatorTaskIndex` 记当前选中项——即「状态行上方的任务栏 + 选择索引」，提示文案 `"Enter to view"`。
- 任务对象带 `pendingMessages`（`{text, origin, isMeta}`），在视图里输入的消息先进该队列再投递给子 Agent；`retain` / `diskLoaded`：查看时若内存里没转录就**从磁盘加载**；`evictAfter`：离开视图后延时释放。
- 审批：后台子 Agent 的审批照常弹出，带来源标注。
- 结论：工具 A 的模型 = **底栏任务列表（选择态）→ 进入「查看某 Agent」模式（主区换成子 Agent 转录，输入框改投递给它）→ Esc 回主会话**，与已商定的 A 方案一致。

### 1.3 工具 B / 工具 E

- **工具 B**：`/agent` 在当前 TUI 内切换 agent 线程并查看进行中的线程；较新版本另有独立的 agents 任务面板命令（搜索 / 打开 / 重命名 / 停止）；后台线程的审批在主线程弹出且带来源标签；子 agent 有路径式地址（`/root/agent_a`）。
- **工具 E**：子 Agent = 子会话（`parentID`）。`<leader>+Down`（leader 缺省 Ctrl+X）进入第一个子会话，进入后 ←/→ 在兄弟间循环、↑ 回父会话；这些键只在子会话里生效。历史上 ctrl+←/→ 与 macOS 切桌面冲突后改键——**键位冲突是真问题**，佐证本报告对 Ctrl+B 的谨慎。
- 可借鉴：在子 Agent 视图里用 ←/→ 切换兄弟任务、Esc/↑ 回父；切换器与查看器分开。

### 1.4 OpenTelemetry GenAI 语义约定（semantic-conventions-genai 仓库，Development 状态）

| ama 轨迹节点     | OTel span 名                            | 关键属性                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trace / 会话     | `invoke_agent ama`（INTERNAL）          | `gen_ai.operation.name=invoke_agent`、`gen_ai.agent.name`、`gen_ai.conversation.id`=会话 id                                                                                                                                                                                                                                                                                                                                         |
| Step（一次请求） | `chat {gen_ai.request.model}`（CLIENT） | `gen_ai.provider.name`、`gen_ai.request.model`、`gen_ai.response.model`、`gen_ai.response.id`、`gen_ai.response.finish_reasons`、`gen_ai.usage.input_tokens`、`gen_ai.usage.output_tokens`、`gen_ai.usage.cache_read.input_tokens`、`gen_ai.usage.cache_write.input_tokens`、`gen_ai.usage.reasoning.output_tokens`、`gen_ai.response.time_to_first_chunk`（秒）、`gen_ai.request.reasoning.level`、`gen_ai.conversation.compacted` |
| ToolCall         | `execute_tool {gen_ai.tool.name}`       | `gen_ai.tool.name`、`gen_ai.tool.call.id`、`gen_ai.tool.type`；参数/结果 `gen_ai.tool.call.arguments` / `.result` 属 opt-in 内容                                                                                                                                                                                                                                                                                                    |
| Subagent         | 子 `invoke_agent {agent}`               | 以 `gen_ai.tool.call.id` 关联父 task 调用                                                                                                                                                                                                                                                                                                                                                                                           |
| 指标             | —                                       | `gen_ai.client.operation.duration`、`gen_ai.client.operation.time_to_first_chunk`、`gen_ai.client.operation.time_per_output_chunk`                                                                                                                                                                                                                                                                                                  |

**口径坑**：OTel 的 `gen_ai.usage.input_tokens` **应包含**缓存读写（registry 注 [42]），而 ama `usage.input` **不含**缓存部分（`session-format.md` 消息节）。导出时 `input_tokens = input + cacheRead + cacheWrite`。时间单位 OTel 是秒，ama 内部用 ms。

### 1.5 两种 LLM 观测平台的数据模型

- **观测平台甲的 Run**：`id`、`trace_id`、`parent_run_id`、`dotted_order`（`<ts>Z<uuid>.<child_ts>Z<child_uuid>…`，按字符串排序即得树序）、`run_type ∈ chain|llm|embedding|prompt|tool|retriever|parser`、`start_time`/`end_time`、**`first_token_time`**、`prompt_tokens`/`completion_tokens`/`total_cost`、`events`、`child_run_ids`。
- **观测平台乙**：Trace（一次请求）→ Observation（共享 `trace_id`，可嵌套），Session 聚合多条 trace。Observation 类型：`event / span / generation / agent / tool / chain / retriever / evaluator / embedding / guardrail`；generation 特有 `model`、`usageDetails`、`costDetails`、**`completionStartTime`**。
- **启示**：业界统一用「绝对起止时间 + 首 token 绝对时间」而非只存 ttft 差值——ama 也应存 `requestAt / firstTokenAt / doneAt` 三个 epoch ms，差值现算。节点用「类型 + parentId」平铺存储，树在读时组装（ama 的构建器同理）。`dotted_order` 的「可排序路径键」适合 RPC 分页游标。

---

## 2. ama 现状：会话文件里有什么、缺什么

### 2.1 已有、可直接用于轨迹

| 数据                  | 位置 / 证据                                                                                                                                        | 精度与语义                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 条目 `timestamp`      | `manager.ts:213-223`，`this.now().toISOString()`                                                                                                   | ms，**落盘时刻**                                                                                                                                   |
| `assistant.timestamp` | `ai/apis/shared.ts:25-35` `createOutput` 里 `Date.now()`                                                                                           | epoch ms，**流开始（≈请求发出）**；与条目时间之差 ≈ 请求总时长（含排队到落盘的几 ms）。失败消息走 `loop.ts:76-91` `failureMessage`，时间是失败时刻 |
| 用量                  | `assistant.usage{input,output,cacheRead,cacheWrite,cacheWrite1h?,reasoning?,cost?,cacheReported?}`                                                 | 每请求一份，缓存读写齐全                                                                                                                           |
| 停止原因 / 错误       | `stopReason`、`rawStopReason`、`errorMessage`、`responseId`、`thinkingLevel`/`providerThinkingLevel`                                               | 可标失败尝试、思考级别                                                                                                                             |
| 重试 / 溢出           | 失败的 assistant 仍在文件里，随后 `context_edit{targetId, replacement:null, reason:"retry"/"overflow"}`（`session-run.ts` `excludeFailedAttempt`） | 能识别「哪次请求被重试掉」；**重试等待时长**只能从时间差推                                                                                         |
| 模型回退              | `model_change`（`setModel` 落盘）+ assistant 的 `provider/model`                                                                                   | 能识别切到回退模型与切回；`model_fallback` 事件本身不落盘，`reason` 丢失                                                                           |
| 工具                  | assistant `toolCall` 块 ↔ `toolResult{toolCallId, toolName, isError, details?}`                                                                    | 结构完整；**时间见下**                                                                                                                             |
| 压缩                  | `compaction{summary, firstKeptEntryId, tokensBefore, usage?}`                                                                                      | 有用量、无起始时刻 / 触发方式                                                                                                                      |
| 辅助请求              | `usage{kind: cache_warm \| permission_classify}`                                                                                                   | 有用量、无耗时                                                                                                                                     |
| 子会话                | 独立 JSONL，头 `parentSession`；首条 `custom{ama.task}{parentToolCallId, description, taskId, agent}`                                              | 可从子回溯父                                                                                                                                       |
| 父 → 子               | 父会话 `custom{ama.task}` = `TaskInfo + parentToolCallId + cwd`，开始 / 续聊 / 结束各一条（`session-format.md`「ama.task」）                       | `startedAt/endedAt/turns/usage/costUsd/sessionRef{sessionFile}` → 构建器据 `sessionRef.sessionFile` 递归读子文件；父为内存会话时子也在内存、无文件 |
| 外部 Agent            | `ama.agent-session{agent, runner, sessionId, taskId?}`、每回合 `ama.agent-usage{unit, amount, tokens?}`                                            | 只有引用与用量                                                                                                                                     |
| 回滚 / 分支           | `leaf` 行、`branch_summary`、`ama.rewind-note`                                                                                                     | 轨迹按「当前分支」构建，`--branch all` 时按文件序                                                                                                  |

### 2.2 缺口（必须补才能做 B/C）

| 缺口                      | 现状证据                                                                                                                                                                             | 影响                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| ttft / firstTokenAt / tps | `session-telemetry.ts` 只在内存，`contributeStats` 出；`telemetryFactory` 对 `core.depth > 0` 返回 undefined（文件末尾）                                                             | 历史请求与子 Agent 请求都没有 ttft   |
| 工具起止                  | `toolResultMessage()` 在 `emitResultMessages` 里**批次结束后**统一调用（`tool-runner.ts:315-327`、`:375-386`），并行批次所有结果时间相同；起始时刻只在 `tool_execution_start` 事件里 | 无法画工具瀑布，并行工具无法区分     |
| 审批等待                  | `permission_request` 不带 `toolCallId`（`ApprovalRequestContext`，`permissions/types.ts:89-101` 只有 `parentToolCallId/taskId`）                                                     | 审批时间混在工具耗时里               |
| codemode 嵌套调用         | 事件带 `parentToolCallId`、「不入转录」（`nested-calls.test.ts:54`）                                                                                                                 | 子调用层级只存在于实时事件           |
| 重试等待 / 回退原因       | `auto_retry_start{delayMs}`、`model_fallback{reason}` 只是事件                                                                                                                       | 轨迹里看不到「等了 8 s 重试」        |
| 压缩耗时与触发            | `compaction_start/end{trigger}` 只是事件                                                                                                                                             | 压缩条只能画成零宽点                 |
| 外部 Agent 回合           | `TurnCollector` 原始事件不落盘（`drivers/turn.ts:5-6`）；`SubagentEvent.tool` 只有 `toolName/status`，无 id 与时间（`tools/types.ts:135-147`）                                       | 外部任务只能画一个整块               |
| 子 Agent 实时全量         | `AmaRunner` 只把 tool start / text_delta / turn / usage 转成 `SubagentEvent`（`session-subagent.ts:252-267`），子会话对象不外露                                                      | 全屏视图拿不到思考块、工具参数与结果 |

---

## 3. 推荐设计

### 3.1 轨迹数据模型（`src/trace/types.ts`，纯类型，经 `@armadra/agent` 导出）

```ts
interface Trace {
  version: 1;
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  startedAt: number;
  endedAt?: number; // epoch ms
  totals: Totals; // 复用 export.ts UsageTotals + durationMs、requests、toolCalls、ttftP50/P90、avgTps
  turns: TurnNode[];
  aux: AuxNode[]; // cache_warm / permission_classify / 会话级压缩
  partial: boolean; // 有进行中节点
}
interface NodeBase {
  id: string; // 稳定 id：turn = 用户消息 entryId；step = assistant entryId；tool = toolCallId；sub = taskId
  kind: "turn" | "step" | "tool" | "subcall" | "subagent" | "compaction" | "retry_wait" | "aux";
  startedAt?: number;
  endedAt?: number; // 进行中只有 startedAt（不编造时长）
  approx?: boolean; // 时间来自回退推算（老会话 / 缺 ama.trace）
  status: "ok" | "error" | "aborted" | "denied" | "running" | "retried" | "interrupted";
  entryIds: string[]; // 回到会话条目（Enter 详情、/tree 跳转用）
}
interface TurnNode extends NodeBase {
  kind: "turn";
  prompt: string /*≤200 字预览*/;
  origin?: string;
  steps: (StepNode | CompactionNode | RetryWaitNode)[];
  usage: Totals;
}
interface StepNode extends NodeBase {
  kind: "step";
  provider: string;
  model: string;
  attempt: number;
  fallbackFrom?: string;
  requestAt?: number;
  firstTokenAt?: number;
  doneAt?: number;
  ttftMs?: number;
  tps?: number;
  usage: Usage;
  stopReason: string;
  errorMessage?: string;
  thinkingLevel?: string;
  cacheHitRatio?: number; // cacheRead / (input+cacheRead+cacheWrite)
  tools: ToolNode[];
}
interface ToolNode extends NodeBase {
  kind: "tool";
  name: string;
  isError: boolean;
  approvalMs?: number;
  denied?: boolean;
  autoDecision?: { layer; decision };
  children: (SubcallNode | SubagentNode)[];
}
interface SubcallNode extends NodeBase {
  kind: "subcall";
  name: string;
  parentToolCallId: string;
  isError: boolean;
} // codemode
interface SubagentNode extends NodeBase {
  kind: "subagent";
  taskId: string;
  agent: string;
  runner: string;
  background: boolean;
  usage?: Usage;
  costUsd?: number;
  turns?: number;
  child?: Trace; // ama 子会话：懒加载（depth ≤ 1）
  external?: ExternalTurnNode[]; // 外部 Agent：只有骨架
  childRef?: { sessionFile?: string; sessionId: string };
}
```

正文不进模型对象：`prompt`、工具参数 / 结果预览只在「详情」按需从条目取（TUI 直接读内存条目，HTML 导出时按需截断嵌入），保证轨迹本身小。

### 3.2 持久化：`custom{customType:"ama.trace"}`

一种 customType，`data.kind` 区分；**都在事件发生后追加，不改已落条目、不进上下文、不改请求字节**（缓存前缀不受影响——`custom` 投影时跳过，`session-format.md` 投影第 3 步）。

```jsonc
// 每次 turn 请求一条（成功、失败、重试掉的都写），写在该批 toolResult 之后（无工具时紧跟 assistant）
{ "kind":"step", "assistantEntryId":"…", "requestAt":…, "firstTokenAt":…, "doneAt":…,
  "outputTokens":812, "tps":64.2, "attempt":1, "fallbackFrom":"anthropic/…"?,
  "tools":[{ "id":"call_1","startedAt":…,"endedAt":…,"approvalMs":1200?,"denied":false? }],
  "subcalls":[{ "id":"cm1_n1","parentId":"cm1","name":"read","startedAt":…,"endedAt":…,"isError":false }] }
{ "kind":"retry_wait", "attempt":2, "delayMs":4000, "startedAt":…, "reason":"overloaded…(≤200 字)" }
{ "kind":"fallback", "from":"…", "to":"…", "reason":"…(≤200)" }
{ "kind":"compaction", "trigger":"threshold|overflow|manual", "startedAt":…, "endedAt":…, "compactionEntryId":"…"? }
{ "kind":"aux", "purpose":"cache_warm|permission_classify", "usageEntryId":"…", "startedAt":…, "endedAt":… }
// 外部 Agent 每回合一条（写在父会话，taskId 关联）
{ "kind":"external_turn", "taskId":"t2", "agent":"codex", "sessionId":"…", "turn":3, "startedAt":…, "endedAt":…,
  "stopReason":"end_turn", "tools":[{ "kind":"execute","status":"completed","startedAt":…,"endedAt":… }],
  "toolCount":12, "filesTouched":3 }
```

- **为什么不扩展 `usage` 条目**：`usage` 条目被 `usageTotals`、`/session`、`ama stats` 当一次请求计费（`export.ts:58-63`）；轨迹信息是计时元数据，与计费是两回事。也不往 `toolResult` 加字段：`details` 归工具所有，新增顶层字段虽不进请求但改了消息形状，所有 `convertToLlm` 实现都要复核。
- **写入者**：把 `session-telemetry.ts` 拆成「测量」与「落盘」两部分：新 `session-trace-writer.ts`（SessionExtension）订阅 `tool_execution_start/end`、`permission_request/resolved`、`auto_retry_start`、`model_fallback`、`compaction_start/end`、`turn_end`，用遥测扩展已有的 `RequestTracker` 记录，`turn_end` 时 `appendCustom("ama.trace", …)`。**depth > 0 也装**（只落盘、不发 tick），子会话因此也有 ttft。
- **审批等待**：给 `ApprovalRequestContext` 加可选 `toolCallId`（`gateToolCall` 填），写入者据此算 `approvalMs`。RPC `permission_request.context` 多一个可选字段，向后兼容。
- **体积**：每 step 约 200–400 B；1000 请求的会话 ≈ 0.3 MB，可接受。`ama sessions export --format jsonl` 照常带出（custom 条目原样）。
- **崩溃 / 中断**：中断时 `turn_end` 可能不来——`agent_end` 兜底写一条带 `status:"aborted"` 的 step；仍缺时构建器回退推算（`approx:true`）。
- **格式版本不升**：`custom` 是 v1 已有类型，读方遇到未知 customType 本就忽略。

### 3.3 构建器（`src/trace/build.ts`，纯函数）

```ts
buildTrace(input: { header; entries; leaf }, opts: { branch?: "leaf"|"all"; now?: number;
  loadChild?: (sessionFile: string) => ExportInput | undefined;   // CLI/RPC 只读扫描；TUI 用内存
  live?: LiveOverlay }): Trace
```

算法：

1. `selectEntries(input, branch)`（复用 `export.ts:36-40`）。
2. 顺序扫描：`user` 消息（`origin` 为空 / `host` / `followUp`）开新 Turn；`steer` 作为 Turn 内标记；`compaction` / `branch_summary` 作为 Turn 内节点。
3. 每条 assistant = 一个 Step；被 `context_edit{reason:retry|overflow}` 指到的标 `status:"retried"`，attempt 依序递增；与上一个 `model_change` 比较得 `fallbackFrom`。
4. `toolCall` 块按 `toolCallId` 配 `toolResult`；`task` 调用按 `ama.task.parentToolCallId` 挂 SubagentNode（同 `taskId` 取最后一条快照），ama runner 有 `sessionRef.sessionFile` 时 `loadChild` 递归（深度上限 1，与运行时一致），外部 runner 挂 `external_turn`。
5. 合并 `ama.trace`：按 `assistantEntryId` / `toolCallId` 精确覆盖时间；缺失时回退推算：`requestAt = assistant.message.timestamp`、`doneAt = entry.timestamp`、工具 `startedAt = assistant 条目时间`、`endedAt = toolResult.timestamp`，全标 `approx`。
6. `live`：TUI / RPC 进行中时叠加未落盘的请求（`telemetry.snapshot().last/live`）与正在运行的工具，状态 `running`、只有 `startedAt`。
7. 汇总 totals：复用 `usageTotals`；ttft 分位数只用非 approx 的 step。

性质：确定性（不读时钟，`now` 注入）、无 I/O（子会话经回调）、对未知条目容忍。供 TUI、CLI HTML、RPC 三方共用。

### 3.4 TUI `/trace`（B）

- 入口：`/trace`（当前会话）、`/trace t2`（直接看任务 t2 的子轨迹）；覆盖层 `anchor:"bottom"`、高度 `rows−1`（主屏约束，同 rewind 面板）。
- 行布局（宽 ≥ 80）：`缩进+折叠符  标签                 耗时  ▕████▒▒▒░░▏  ↑in ↓out  缓存%`
  - 条形：一行内的相对时间轴（本 Turn 范围），`▒`=TTFT、`█`=解码、`░`=工具；`NO_COLOR` / ASCII 降级为 `[==..--]`；宽 < 60 时去掉条形与 token 列，只留「标签 · 耗时」；40 列可用（`tui-design.md` 约束）。
  - 标签例：`#3 用户 "修一下 …"`、`step 2 claude-… ttft 1.2s 64 tok/s`、`  read src/a.ts 0.1s`、`  task t2 explore 1m05s`、`压缩 threshold 8.4s`、`重试等待 4s`。
- 键：↑↓ / PgUp PgDn / Home End 移动；→ 展开、← 折叠（子 Agent 节点展开即懒加载子轨迹）；Enter 详情卡片（概要 / 用量与缓存 / 参数与结果预览，内容截断与 md 导出同口径 500/2000 字）；`f` 跟随开关（进行中自动开，手动上移即暂停）；Esc 先关详情再关视图。
- 分页：只渲染可见窗口（列表模型 = 扁平化的可见节点数组 + 窗口偏移），10k 节点也只算可见行；刷新由 `entry_appended` / `telemetry_tick`（≤2 Hz）驱动，增量重建只重算最后一个 Turn。
- 文案进 i18n（若 W8 的 i18n 已落地则同步中英）。

### 3.5 HTML 导出（C）：`ama sessions trace <id> --html [--output f] [--branch leaf|all] [--no-content] [--children]`

- **单文件、零依赖**：`<style>` 与 `<script>` 内联（目标 ≤ 25 KB 未压缩），数据放 `<script type="application/json" id="trace">`；JSON 里 `</` → `<\/`、U+2028 / U+2029 转义，防止脚本截断与注入。不引用任何外部资源（CSP：`default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'`，以 `<meta>` 写入）。
- **脱敏**：先 `redactValue` 整棵轨迹数据（复用 `session/redact.ts`，同 json 导出），正文预览再 `redactSecrets`；`--no-content` 只留结构与数字（便于分享性能问题）。
- **视图**：左侧树（同 TUI 层级）+ 右侧瀑布（绝对定位 div，横轴 = 会话时间，可缩放；TTFT/解码/工具三色，色值满足对比度且与暗色模式兼容）+ 底部详情面板；顶部 totals（时长、请求数、ttft P50/P90、平均 tps、缓存命中率、费用）。
- **体积与长会话**：预览按条截断（参数 500、结果 2000 字），整份预览总预算 4 MB，超出后更早的预览置空并标注；行数 > 2000 时用固定行高虚拟列表（只建可见 ±50 行 DOM）；子会话默认只嵌结构，`--children` 才内嵌子轨迹全文预览。
- 确定性：同输入同输出（`generatedAt` 可经 `--now` / 测试注入），便于 golden 测试。
- 也可顺带 `--format json`（轨迹 JSON，即 RPC 同形），作为 OTel 导出的中间格式；OTel/OTLP 真正导出放后续波次。

### 3.6 RPC `get_trace`（C）

| 参数                          | 说明                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `branch?: "leaf"\|"all"`      | 缺省 leaf                                                                       |
| `turnLimit?: number`          | 缺省 50（尾部优先），上限 500                                                   |
| `before?: string`             | 回合游标（turn id = 用户消息 entryId），向前翻页                                |
| `since?: string`              | 条目游标（同 `get_entries.since`）：只返回从包含该条目的 Turn 起的 Turn（增量） |
| `taskId?: string`             | 返回该任务的子轨迹（ama 子会话或外部骨架）                                      |
| `content?: "none"\|"preview"` | 缺省 none                                                                       |

返回 `{ trace: Trace（turns 为所请求的窗口）, hasMoreBefore: boolean, cursor: { before?: string, since: string /*最后条目 id*/ }, leafId }`。客户端用 `entry_appended` 事件触发 `get_trace{since}`，用返回的 turns 按 id 替换（最后一个 Turn 可能更新）。不新增事件类型。错误 `{code, message}`：`task_not_found`、`invalid_arguments`。写进 `docs/rpc.md`「计划与任务」节后新增「轨迹」节，并补 `contracts-w5.test.ts` 同类契约测试（建议新 `contracts-w6.test.ts`）。

### 3.7 Agent 栏与子 Agent 视图（A）

**数据来源**

- 列表：`taskRegistryView(sessionId).list()`（已有，`TaskInfo`）+ `SubagentTracker` 的实时状态（`subagent-view.ts`，轮数、最近工具、用量）。
- ama 子 Agent 实时全量：给 `TaskHandle` 加可选 `observe(listener): () => void` 与 `entries(): readonly SessionEntry[]`（`session-subagent.ts` 里 `child.subscribe` / `child.manager.branch()` 外露）；句柄已被 LRU 释放或 resume 后 → **只读加载 `sessionRef.sessionFile`**（工具 A 的 `diskLoaded` 同理），运行中再 `observe`。
- 外部 Agent：注册表每任务一个内存环形缓冲（`DriverEvent` 派生的展示事件，上限 2000 条 / 1 MB，不落盘，§5.4）；`SubagentEvent.tool` 增加可选 `id`、`at`，供视图与 `external_turn` 骨架使用。
- 审批：已有 `permission_request` 带 `context.taskId`（`approval-dialog.ts` 已能标 `[task:<agent>]`）；视图里照常弹审批覆盖层；所查看的任务若在等审批，标题栏显示「等待审批」；Agent 栏条目上加「需审批」标记。

**状态机**（放 `agent-ui.ts` 旁的新 `agent-bar.ts` / `agent-view.ts`，保持 `interactive-mode.ts` ≤ 600 行，当前 578）

```
main ──Ctrl+B(空输入)/↓(空输入且栏可见)──▶ bar(index)
bar ──↑↓──▶ bar(index±1)        bar ──Esc/再按 Ctrl+B/输入可打印字符──▶ main（字符回填输入框）
bar ──Enter──▶ view(taskId, follow=true)
view ──←/→──▶ view(兄弟任务)     view ──↑/PgUp──▶ view(follow=false)  view ──End/f──▶ follow=true
view ──Enter(输入非空)──▶ registry.message(taskId, text) → 留在 view
view ──Esc(输入为空)──▶ main     view ──Esc(输入非空)──▶ 清空输入
view ──任务被移除──▶ main + 提示
```

- **栏的显示规则**：有运行中任务，或有「结束后未查看」的任务（结束 10 分钟内）时显示一行摘要（`⏺ 3 个 Agent · t1 explore 运行中 1m · t2 codex 完成 …`，宽度不够则省略号）；聚焦时展开为 ≤ 5 行列表（多了滚动）。位于提示行之上、`StatusLine` 之下装配（`status-area.ts`）。
- **视图内容**：标题行（`t2 explore · 运行中 1m05s · 3 轮 · ↑12k ↓3.4k · Esc 返回`）+ 复用 `message-view.ts` / `tool-view.ts` 渲染子会话消息（ama）或骨架行（外部）+ 底部输入框（占位「发给 t2」）。
- **发消息语义**（新 `SubagentRegistry.message(taskId, text)`，返回 `"steered"|"queued"|"resumed"`）：
  - ama 运行中 → 子会话 `followUp`（回合结束投递，不打断当前工具）；
  - 外部运行中 → 进 `pendingMessages` 队列，回合结束后以 `send` 续聊；
  - 已结束 → 与 `task_ctl send` 同语义（后台续聊，完成后父会话照常收 `<task-notification>`）；
  - 子会话 user 消息 `origin:"user"`（待定，见 §6），父会话 `ama.task` 快照照常更新——**父模型并不知道用户与子 Agent 直接对话过**，靠结束通知里的结果自然带回。
- **与 `/tasks` 的关系**：`/tasks` 保留（line 模式与无 TTY 仍需要），交互模式下无参数 `/tasks` 改为「打开 Agent 栏并聚焦」，`/tasks <id>` 直接进视图；`taskOutputPanel` 降为视图里的「全文」子页。`/agents` 不变。

**键位冲突检查（`src/tui/keybindings.ts`）**

| 键     | 现有绑定                                        | 处理                                                                                                                                                      |
| ------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ctrl+B | `tui.editor.cursorLeft`（`:15`）；tmux 缺省前缀 | 新动作 `app.agents.focus: ["ctrl+b", "down"]`，`key-dispatch.ts` 里**仅在输入框为空且没有覆盖层时**抢先处理；有字时落回编辑器（与 PR #63 Tab 的先例一致） |
| ↓      | `tui.editor.cursorDown` / 历史下一条            | 只在空输入、未浏览历史、栏可见时进入栏                                                                                                                    |
| ←/→    | 光标                                            | 只在 view 且输入为空时切兄弟任务                                                                                                                          |
| Enter  | 提交                                            | bar 内 = 打开；view 内 = 发给子 Agent                                                                                                                     |
| Esc    | `app.interrupt` / `app.rewind`（双击）          | bar / view 内先消费；**view 内 Esc 不中断父会话运行**（中断子任务用视图里的 `Ctrl+X`？待定）                                                              |
| `f`    | —                                               | /trace 覆盖层内部键，不进全局表                                                                                                                           |

---

## 4. 分批建议

| 批                      | 内容                                                                                                                                                              | 文件所有权（独占）                                                                                                                                                                                                                                                                            | 依赖        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **B0 契约**（小，先合） | `ama.trace` 写入扩展；遥测 depth>0 只落盘；`ApprovalRequestContext.toolCallId`；`SubagentEvent.tool{id?,at?}`；`TaskHandle.observe/entries`；`src/trace/types.ts` | `src/agent/session-telemetry.ts`、新 `src/agent/session-trace-writer.ts`、`src/permissions/types.ts`（一字段）、`src/tools/types.ts`（可选字段）、`src/agent/session-subagent.ts`（observe/entries）、`src/trace/types.ts`、`docs/session-format.md`（登记 `ama.trace`）、`src/index.ts` 导出 | —           |
| **A Agent 栏 + 视图**   | 栏、视图、`registry.message`、外部环形缓冲、键位                                                                                                                  | 新 `src/modes/interactive/{agent-bar,agent-view}.ts`、`agent-ui.ts`、`key-dispatch.ts`、`src/tui/keybindings.ts`、`status-area.ts`、`src/agent/subagent-registry.ts`、`src/agents/{task-record,external}.ts`、`docs/tui.md`（A 节）                                                           | B0          |
| **B 构建器 + /trace**   | 纯函数构建器、TUI 覆盖层                                                                                                                                          | 新 `src/trace/{build,flatten,format}.ts`、新 `src/modes/interactive/trace-view.ts`、`commands.ts`（注册 `/trace`）、`docs/tui.md`（B 节）                                                                                                                                                     | B0          |
| **C HTML + CLI + RPC**  | `sessions trace`、HTML、`get_trace`                                                                                                                               | 新 `src/trace/html.ts`、新 `src/cli/subcommands/sessions-trace.ts`、`sessions.ts`（用法与分派）、`src/rpc.ts`、`docs/rpc.md`、`docs/sessions.md`、契约测试                                                                                                                                    | B（构建器） |

- A 与 B 只在 `docs/tui.md` 与 `interactive-mode.ts` 装配处可能相碰：约定两者都通过 `agent-ui.ts` / 各自新文件装配，`interactive-mode.ts` 各加 ≤ 3 行，由后合者解决。
- 若 C 的人手先到，可在 B 构建器 API 定稿（类型 + 函数签名）后用桩数据并行做 HTML 模板。

### 测试要点

- **B0**：fake stream 驱动一次带两个并行工具的请求 → 恰好一条 `ama.trace{kind:"step"}`，两工具起止不同；重试路径写 `retry_wait` 且失败尝试也有 step；`fallback` 条；子会话（depth 1）也写；**缓存稳定性**：加写入扩展前后请求字节一致（复用 `cli/cache-stability.test.ts` 手法）；投影结果不变（custom 不进上下文）。
- **构建器**：golden 会话夹具（普通 / 并行工具 / codemode 嵌套 / 重试 + 回退 / 溢出压缩 / 子 Agent ama / 外部骨架 / 回滚分支 / 无 `ama.trace` 的老会话 → approx）；确定性；损坏 / 缺子文件时 SubagentNode 标 `childMissing` 不抛。
- **/trace**：`MemoryTerminal` 帧 golden（120 / 60 / 40 列，`NO_COLOR`）；10k 节点只渲染可见行的性能测试；跟随与暂停。
- **HTML**：输出确定性 golden；`</script>` 与 U+2028 注入用例；脱敏用例（API key 样式串不出现在文件里）；`--no-content` 不含任何消息正文；体积上限。
- **RPC**：`get_trace` 分页（before）与增量（since）一致性：多次增量拼接 = 一次全量；契约形状测试。
- **A**：键位：空输入 Ctrl+B 进栏、有字时 Ctrl+B 仍左移；tmux 场景用 ↓ 进入；状态机全路径；运行中发消息走 followUp、结束后走续聊、外部排队；审批在视图中弹出并带来源；LRU 释放后从文件加载；视图退出后主区帧不变（主屏约束，滚回历史不重复）。

## 5. 风险

1. **主屏「全屏」**：覆盖层高度若超过可视区，差分渲染会把旧帧顶进回滚造成重复行——严格 `rows−1` 并在 resize 时重算；参考 rewind 面板已有测试。
2. **写入时机**：`ama.trace` 写在 toolResult 之后，若某处逻辑假设「assistant 后紧跟 toolResult 条目」（如 `excludeFailedAttempt` 扫 `branch.slice(at+1)` 只认 toolResult，影响不大，但需全仓 grep 「下一条条目」类假设）；rewind 选点、`get_fork_messages` 只认 user 消息，不受影响。
3. **隐私**：外部工具标题常含命令行与路径；即便 ama 自己的 step 也不应把参数写进 `ama.trace`（只存 id 与时间）——Armadra 审查对「终端原始输出、文件正文」进持久化是 P0。
4. **子会话体积**：HTML `--children` 可能把十几个子会话全嵌入，需总预算兜底。
5. **事件顺序**：并行工具的 `tool_execution_end` 在 `emitEnd` 里逐个发，审批等待在 prepare 阶段——`approvalMs` 依赖新加的 `toolCallId`，否则只能留空。
6. **外部 Agent 无法重建细节**：重启后视图只剩骨架，需要明确 UI 文案，避免用户以为数据丢失。

## 6. 待定项（需用户拍板）

1. 外部工具标题是否落盘：A 不落（最安全，只有 kind）；B 脱敏 + 截 80 字落盘（轨迹可读性好）。建议 A，配置项 `trace.externalTitles` 后续再议。
2. 视图里发给子 Agent 的消息 `origin`：沿用普通用户（缺省）还是新值 `"direct"`（便于父会话 / 审计区分）。建议 `"direct"`，需在 `session-format.md` 登记。
3. 视图内中断子任务的键：复用 Esc（与父会话中断语义冲突）还是 `Ctrl+X` / `/tasks stop`。建议不新增键，视图标题提示 `task_ctl stop` 等价操作 `/tasks stop t2`。
4. Agent 栏「结束后保留多久」：10 分钟或「直到查看过」。
5. `get_trace` 是否同时提供 OTel JSON（`format:"otel"`）——建议本波只做轨迹 JSON，OTLP 导出另立。
6. 是否给老会话做一次性「推算」标注之外的修复——不建议，构建器回退推算即可，**不改历史文件**。

## 资料

- 工具 Z：官方 Trajectory README 与 npm 包；社区插件与生态列表（插件站点）
- OTel GenAI semconv：https://github.com/open-telemetry/semantic-conventions-genai （`docs/gen-ai/gen-ai-spans.md`、`gen-ai-agent-spans.md`、`gen-ai-metrics.md`、`docs/registry/attributes/gen-ai.md`）
- 两种 LLM 观测平台的数据模型文档
- 工具 E 键位文档与相关 issue
- 工具 B 子 Agent：官方文档与社区实践
- 工具 A：本机 `本机材料`（`viewingAgentTaskId`、`viewSelectionMode`、`footerSelection`、`pendingMessages`、`diskLoaded`、`"Enter to view"`）
