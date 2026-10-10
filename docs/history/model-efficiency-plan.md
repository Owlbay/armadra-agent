# 模型调用与使用效率改进设计（缓存、用量、重试、元数据）

> 状态：**已实施**（C0 #134、A #143、B #141、C #142、D #140，Z 收尾 #135；实测汇总见 [benchmarks/efficiency-2026-10.md](../benchmarks/efficiency-2026-10.md)）。基线 `main` = `0a98418`（0.7.3 + #133）。依据：效率审计报告（C0 整理为 [research/model-efficiency-audit-2026-10.md](../research/model-efficiency-audit-2026-10.md)，去掉外部项目名）、[benchmarks/cache-midconvo-2026-10-09.md](../benchmarks/cache-midconvo-2026-10-09.md)、[benchmarks/cache-2026-10-02.md](../benchmarks/cache-2026-10-02.md)、[design.md](../design/design.md) §3.6 / §9 / §9.1、`src/cli/prompt-budget.test.ts`。批次写法沿用 [acp-plan.md](acp-plan.md)。
> 硬约束不变：零运行时依赖；源码 ≤ 600 行 / 测试 ≤ 1000 行（**`src/agent/session.ts` 已 596 行、`src/agent/subagent-registry.ts` 600 行、`src/ai/providers/registry.ts` 599 行、`src/cli/compose-session.ts` 608 行：本计划不得向这四个文件加行**）；i18n en / zh；**首个请求与相邻回合的 system + tools 逐字节不变**；`prompt-budget` 三档不突破（现值 default ≈ 1446 / 2000、minimal ≈ 740 / 800、codemode-only ≈ 1767 / 1775，`default+memory` ≤ 2350、`default+task` ≤ 2000）；RPC / ACP / TUI 既有语义不变，新增字段一律可选；测试只用 fake 供应商；真实测量只经中转 packy 的 deepseek / kimi，每批 ≤ 10 次请求；代码与文档不出现参考项目名。
> 范围：报告 P1-1…P1-7 全部；P2 中 P2-1、2、4、5、6、7、8、9、11 纳入；P2-3、P2-10、P2-12 与 P1-2(c) 本波不做，理由见 §6。

## §0 决策表

| #   | 决定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **fork 式子 Agent 是显式选项**：`task.context: "fork" \| "fresh"`，类型 frontmatter `context:` 同名，缺省 `fresh`（三个内置类型都 `fresh`）。fork 点 = 父会话**上一次真实请求**的转录，即发出本次 `task` 调用的那条 assistant 之前的全部条目；用 `SessionManager.fork(entryId, { head })` 复制，`head` 是 `custom{ama.task, context:"fork", forkedFrom}` 作为**根条目**（复制的条目重挂到它下面），保住「task 子会话首条是 `ama.task`」的既有约定（`store.ts`、`trace/build-index.ts`、`session-tools.ts:56`、`session-cache.ts readHead` 都不用改）。                                                                                                                                                                  |
| D2  | fork 子会话**不写 `role` 节、工具表与父逐字节相同**（含 `task` / `task_ctl`，运行时按深度拒绝）；角色说明 + 任务合成一条 user 消息 `<task>…</task>` 追加在继承历史之后。类型 / 参数给的 `tools` / `disallowed-tools` 不改工具表，改为 `AgentSessionOptions.unavailableTools`（C0 新增）在执行层拒绝，并在 `<task>` 里列出不可用工具。只读类型照旧走 `readOnlyPermission`。                                                                                                                                                                                                                                                                                                                                              |
| D3  | fork 回落为 fresh 的条件（记 `log("info")`，结果 `details.context` 标实际模式）：① 请求或类型指定了与父不同的模型 / 思考级别；② 父会话还没有真实请求（`cache.lastTurn` 为空）；③ 父上一次请求 `promptTokens` > `FORK_MAX_CONTEXT_RATIO`（0.5）×（子模型窗口 − `reserveTokens`）；④ 续聊（`taskId`）与 resume 不受影响（照原文件重开）。`prompt_cache_key` 沿用父链根 id（`cacheKeyOf` 对 `context:"fork"` 不再排除）。                                                                                                                                                                                                                                                                                                  |
| D4  | **不变量：开头的 system 检查点与工具声明在会话内只写一次。** 投影的压缩检查点只重放「首条非 system 条目之前」的 system 消息；此后的补丁合并成**一条合成 system 补丁**放在 compaction 摘要之后，由 `normalizeContext` 渲染为 `<system-reminder>` user 消息；工具表重放改为「保留原位、只换内容」（`replaySystem` 与 `context.ts` 两处统一）。多次压缩递归成立。                                                                                                                                                                                                                                                                                                                                                          |
| D5  | **移除工具不再折回开头**：对话开始后的 `toolsRemoved` 补丁，请求工具表**保留声明**，尾部 reminder 写 `Tool "X" is no longer available in this session; calls to it are rejected.`；重新加回只发 `Tool "X" is available again.`（声明冻结为首次版本，不重发新描述）。`removesToolsMidway` 与折回分支删除；`keepSectionsOnToolAppend` 改为 `keepSectionsAfterStart`：首次请求后 `tools` / `rules` 两节冻结，增删都靠 reminder 与工具表体现。执行层文案统一为 `Tool "X" is not available in this session.`（C0）。                                                                                                                                                                                                         |
| D6  | **摘要续写边界**：`checkThreshold` 先 `planPrune` 干跑；裁完仍 > budget 且续写可用（同模型、前缀成立、**缓存未冷**）→ **跳过裁剪直接续写摘要**；裁完 ≤ budget → 只裁；缓存已冷（目录承诺 TTL 且超时）→ 照旧先裁，摘要走独立请求（`summaryContinuation()` 在 `isCold()` 时返回 undefined）。思考开启且非预算型协议时，续写 `maxTokens = min(model.maxTokens, 4096 + thinkingBudget(model, level))`。                                                                                                                                                                                                                                                                                                                     |
| D7  | **Anthropic 第 4 个断点**打在**倒数第二条 user 消息的末块**（= 上一次请求的写入点）。优先级：① 最后一条 user ② system 末 ③ 倒数第二条 user ④ 最后一个工具（`maxCacheBreakpoints` 缺省 4，全部用上；中转不满 4 时按序裁掉）。推翻 §3.6「不再用倒数第二条」的旧决定，理由是并行工具调用 N ≥ 9 时超出回看窗口会整段重写；官方回看窗口无法实测，断点本身不计费，实现无条件打。                                                                                                                                                                                                                                                                                                                                              |
| D8  | **重试**：`AssistantMessage.retryAfterMs?`（协议层 `finishError` 从 `HttpError.retryAfterMs` 写入，可选字段，落盘与 RPC 兼容）；延迟 = `min(maxDelayMs, max(base·2^(n−1), retryAfterMs)) × U(0.8, 1.2)`；`FailureKind` 加 `rate_limited`（429 / 529 / rate limit 文案），其重试上限 = `maxRetries + 2`；5xx 只匹配文案开头的状态码或 `status`/`HTTP` 后的；overloaded 先**快速重试一次**（1 s 基数 + 抖动，计一次 attempt），仍失败才切回退模型。不做「回退代价阈值」（见 §6）。                                                                                                                                                                                                                                        |
| D9  | **`max_tokens`**：① 主动收紧——`contextWindow` 已知时 `max_tokens = min(请求值, max(MIN_OUTPUT_TOKENS=1024, 窗口 − 估算输入 − 2048))`，估算用请求体字符 / 4（`ai/apis/max-tokens.ts` 自带，不 import `compaction/`）；Anthropic **预算型思考不主动收紧**（预算由 max_tokens 推导，改它会让消息缓存失效）。② 被动修正——识别「max_tokens 范围」400（`Range of max_tokens should be [a, b]`、`max_tokens.*(must be                                                                                                                                                                                                                                                                                                          | should be | less than or equal to | at most) N`、Anthropic `input length and max_tokens exceed context limit: X + Y > Z`），解析上限记入进程级 `maxTokensCaps`，`start`之前以收紧值重发一次（与`postWithCacheFallback`同模式）；上限 < 1024 的「exceed context limit」判为溢出（补进`overflow.ts`）。 |
| D10 | **中转模型继承官方目录**：目录条目加 `aliases`；匹配 = 小写 + 去常见厂商前缀（`deepseek/`、`deepseek-ai/`、`moonshotai/`、`anthropic/`、`openai/`、`google/`、`zai-org/`…）后精确、**唯一命中**。只继承模型固有属性 `thinkingLevelMap`、`reasoning`、`input`、`promptCache.minTokens`、`compat.requiresReasoningContentOnAssistantMessages`；**不继承** `cost`、`promptCache.short/long`、`thinkingFormat`、缓存主机能力。命中时还把 models.dev 的显式匹配改为该目录条目的快照引用（`deepseek/deepseek-flash` 而不是别家的同名条目），`cost` 仍标 `models.dev`、用户要用中转价须自填。来源标 `catalog (via id)`；`models[]` 条目 `catalog: false` 关闭、`catalog: "provider/id"` 显式指定；用户 `modelOverrides` 最高。 |
| D11 | **工具结果截断一次到位**（P2-1）：`ToolContext.maxResultChars`（= 会话 `maxToolResultChars`，缺省 30 000）；read / grep / bash 以 `min(50 KB, maxResultChars)` 自截，截断说明里写实际上限与 `offset` / 全文路径；描述里**删掉具体数字**（字符数只减不增，`prompt-budget` 三档验证）。`glob` 缺省 `limit` 1000 → 200（P2-2），grep 不变。                                                                                                                                                                                                                                                                                                                                                                                |
| D12 | **分类器小模型**（P2-4）：目录文件级 `small: "<id>"`（deepseek→`deepseek-flash`、anthropic→haiku 级、openai→mini 级、google→flash 级、moonshot→最小 k2，以目录现有 id 为准）；选择顺序 `permission.autoModel` > 同供应商 `small`（`findModel` 成功且有 key）> 会话模型。不合并并行调用的分类请求（见 §6）。                                                                                                                                                                                                                                                                                                                                                                                                             |
| D13 | **子会话最后一轮不发 `toolChoice:"none"`**（P2-5）：删除 `finalRoundExtension`，只靠 `FINAL_REPORT_PROMPT`；若仍调用工具，`maxTurns: 1` 让 run 结束，结果文本回落为既有的「(the sub-agent returned no text)」。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D14 | **原始参数回放**（P2-6）：`ToolCallBlock.rawArguments?: string`，`BlockTracker.end` 在拼接的 JSON 能严格 `JSON.parse` 时写入；Completions / Responses 的 `function.arguments` 用 `rawArguments ?? JSON.stringify(arguments)`；Anthropic / Google 传对象不变。旧会话无该字段回落 stringify；会话格式只加可选字段。                                                                                                                                                                                                                                                                                                                                                                                                       |
| D15 | **按节指纹**（P2-7）：`PrefixFingerprint.sections?: Record<节名, hash16>`；`prefix_changed` 的 `detail` 从 `"system"` 变为 `"system:hooks,memory"`（变化的节名，按节顺序）；`/cache fingerprint` 同步显示。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D16 | **软窗口**（P2-8）：`compaction.contextBudget?: number`——档一 / 档二 / `context_pressure` 的窗口取 `min(contextWindow, contextBudget)`；缺省仍取窗口；文档给出按价格选择的建议。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D17 | **保温重放的 `maxTokens`**（P2-9）：`warmReplayMaxTokens(api)`：`openai-responses` 16，其余 1（官方下限无法实测，取文档值；中转同样）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D18 | **空闲超时拆成两段**（P2-11）：等响应头沿用 `request.idleTimeoutMs`（300 s）；流中包间新增 `request.streamIdleTimeoutMs`（缺省 **180 s**，环境变量 `AMA_STREAM_IDLE_TIMEOUT_MS`，0 关闭）。取 180 而不是 90：思考不外露的端点在推理阶段可能 60 s 以上没有字节，误判断流会让整段输出重新计费。                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D19 | **不做、维持现状**（§6 写理由）：继续精简前缀（P2-12）、Responses `previous_response_id`、Gemini 显式缓存、改缺省预设、`supportsMidConvoSystemMessages` for DeepSeek、P1-2(c) codemode 晚到工具、P2-3 未变化短回执、P2-10 OpenAI 缺省 24h 保留、回退代价阈值、合并分类请求。                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| D20 | **测试口径**：所有「前缀不变」断言用 fake 供应商录到的 `h.fake.calls[i].context` 经 `buildAnthropicRequest` / `buildOpenAIRequest` 生成请求体，比较 `JSON.stringify({system, tools})`（去 `cache_control`）与 `messages` 前缀；每批真实测量 ≤ 10 次，结果写进 `docs/benchmarks/efficiency-2026-10.md`（Z 汇总）。                                                                                                                                                                                                                                                                                                                                                                                                       |

## §1 契约（`[ME-C0]` 先落地，之后批次只消费）

C0 的原则：只加可选字段、只做无行为变化的搬迁；`pnpm run ci` 绿、所有黄金与 `prompt-budget` 字节不变。

### §1.1 `src/ai/types.ts`（+约 15 行）

```ts
export interface ToolCallBlock {
  …现有…;
  /** [ME-C] 模型输出的原始 arguments 字符串（严格 JSON 可解析时才有）；同协议回放时原样发回。 */
  rawArguments?: string;
}
export interface AssistantMessage {
  …现有…;
  /** [ME-C] 失败响应的 Retry-After（毫秒）；会话层退避取 max(退避, 它)。不进协议面语义，RPC 透传为可选字段。 */
  retryAfterMs?: number;
}
```

### §1.2 `src/ai/cache/types.ts`（+5 行）

```ts
export interface PrefixFingerprint {
  system: string;
  tools: string;
  model: string;
  /** [ME-B] 节名 → hash16，归因时说出哪一节变了。 */
  sections?: Record<string, string>;
}
```

### §1.3 `src/ai/providers/catalog.ts`（类型 +6 行；实现归 D）

```ts
export type CatalogEntry = Partial<Omit<CatalogModel, "cost">> & {
  …现有…;
  /** [ME-D] 中转 / 自定义模型按 id 匹配到本条目时使用的别名（小写、去厂商前缀后比较）。 */
  aliases?: string[];
};
export interface CatalogSourceFile {
  …现有…;
  /** [ME-D] 本供应商用于 auto 模式分类的小模型 id。 */
  small?: string;
}
```

`toModel()` 不带出 `aliases`（Model 上不出现）。

### §1.4 `src/agent/session-core.ts`、`src/agent/session-tools.ts`、新 `src/agent/tool-availability.ts`

```ts
// session-core.ts  AgentSessionOptions
/** [ME-A] 留在请求工具表里、执行时拒绝的工具（fork 子会话的 tools / disallowed-tools）。 */
unavailableTools?: readonly string[];

// tool-availability.ts（固定英文，给模型看）
export const toolUnavailableText = (name: string): string =>
  `Tool "${name}" is not available in this session.`;
export const toolRemovedReminder = (name: string): string =>
  `Tool "${name}" is no longer available in this session; calls to it are rejected.`;
export const toolRestoredReminder = (name: string): string =>
  `Tool "${name}" is available again.`;
```

`gateToolCall`：`tool === undefined || core.options.unavailableTools?.includes(call.name)` → `{ block: true, reason: toolUnavailableText(call.name) }`（替换现有 `Tool X not found`）。测试 `session-tools.test.ts` 加一条。

### §1.5 `src/session/manager.ts`（+约 12 行）

```ts
/** 复制 root → entryId 的分支到新文件；`head` 作为新根条目，复制的首条重挂到它下面（fork 子会话的 ama.task 标记）。 */
fork(entryId: string, options?: { head?: SessionEntryInput }): SessionManager;
```

### §1.6 `src/tools/types.ts`、`src/agents/types.ts`、`src/agents/task-record.ts`

```ts
// tools/types.ts
export interface ToolContext { …; /** [ME-D] 会话层的结果上限（字符）；工具据此一次截到位。 */ readonly maxResultChars?: number }
export interface SubagentRequest { …; /** [ME-A] 继承父会话已完成回合；缺省 fresh。 */ context?: "fork" | "fresh" }
// agents/types.ts
export interface AgentDefinition { …; context?: "fork" | "fresh" }   // frontmatter `context:`
// task-record.ts  TaskInfo
context?: "fork" | "fresh";
```

### §1.7 `src/config/types.ts`、`schema.ts`、`json-schema.ts`、`settings-registry.ts`、`key-docs.ts`、`i18n/messages/config-keys.ts`

| 键                            | 类型 / 缺省                              | 消费者 |
| ----------------------------- | ---------------------------------------- | ------ |
| `compaction.contextBudget`    | number ≥ 32768，缺省无（= 窗口）         | B      |
| `request.streamIdleTimeoutMs` | number ≥ 0，缺省 180000                  | C      |
| `models[].catalog`            | `false \| "provider/id"`，缺省自动按别名 | D      |

i18n：`config-keys` 的三条说明 en / zh；`errors.models.source` 加 `"catalog-alias"` → en `catalog (via id)` / zh `目录（按 id 匹配）`。

### §1.8 `src/agent/session-cache-key.ts`（新，从 `session-cache.ts` 搬出 `readHead` / `cacheKeyOf` 共 ~35 行，行为不变）

A 批之后在这里改 fork 规则，B 批改 `session-cache.ts` 不冲突。

### §1.9 `src/ai/apis/max-tokens.ts`（新，C0 建空壳：导出签名，实现归 C）

```ts
export const MIN_OUTPUT_TOKENS = 1024;
export const OUTPUT_HEADROOM_TOKENS = 2048;
/** 主动收紧后的 max_tokens；`window` 未知或 `fixed`（预算型思考）时返回 requested。 */
export function clampMaxTokens(
  requested: number,
  window: number | undefined,
  estimatedInput: number,
  fixed: boolean,
): number;
/** 400 文案里的上限；`{ cap }` 可重发，`{ overflow: true }` 判溢出，undefined 不是本类错误。 */
export function parseMaxTokensRejection(
  error: unknown,
): { cap: number } | { overflow: true } | undefined;
export const maxTokensCaps: Map<string, number>; // `${provider}/${model}` → 已知上限
export async function postWithMaxTokensFallback(
  model,
  url,
  options,
  field: "max_tokens" | "max_completion_tokens" | "max_output_tokens",
): Promise<Response>;
```

### §1.10 文档与记录（C0）

- `docs/history/model-efficiency-plan.md`（本文）；`docs/research/model-efficiency-audit-2026-10.md`（审计报告整理稿，去掉外部项目名与 `/tmp` 路径）。
- `docs/reference/session-format.md`：`ama.task` 的 `data` 增加 `context?`、`forkedFrom?`；assistant 消息块可带 `rawArguments`、失败消息可带 `retryAfterMs`（都是可选字段，格式版本不变）。
- `docs/reference/rpc.md`：`message_end` / 回放里的 assistant 消息可能出现上述可选字段；`subagent_*` 的 TaskInfo 可带 `context`。
- `CHANGELOG.md` / `CHANGELOG.zh-CN.md` 未发布段建子标题「Model efficiency」/「模型调用效率」，各批次往里加条目。

## §2 行为细节

### §2.1 fork 式子 Agent（A；D1–D3、D13）

**fork 点**：`startAmaChild` 里，`parent.manager.branch()` 中找到 `entry.type === "message" && message.role === "assistant"` 且 `content` 含 `toolCall.id === spec.request.parentToolCallId` 的条目，取**它前一条**的 id 作 `entryId`；`parent.manager.fork(entryId, { head: { type:"custom", customType:"ama.task", data:{ taskId, agent, parentToolCallId, description, parentSession, context:"fork", forkedFrom: entryId } } })`。同一条 assistant 里并行的多个 fork 任务共享同一个 fork 点。

**校验**（新文件 `src/agent/subagent-fork.ts`）：`forkPlan(parent, spec, model, thinking): { manager } | { fallback: reason }`——D3 的四个条件；额外在**测试里**断言 `convertToLlm(child.messages)` 与 `parent.cache.lastTurn.contextRef.messages` 逐条相同。

**子会话选项**：`system: base.system`（无 `role`）；`activeTools: base.activeTools`（= 父活动集）；`unavailableTools` = 父活动集 − `childToolNames()` 的结果（去掉 `PARENT_ONLY_TOOLS` 本来就按深度拒）；`model` / `thinkingLevel` = 父；`sessionManager` = fork 出的 manager。首个 `syncSystemMessage` 重放复制的 system 消息与目标一致 → 不产生补丁。

**任务消息**（固定英文，`forkBrief()`）：

```
<task>
You are a sub-agent forked from the conversation above at this point. The main agent cannot see your work, only your final reply; do not delegate further. Instructions in this block take precedence over earlier plans or reminders above.
[Working directory for this task: <worktree>. Relative paths in the conversation above refer to <parentCwd>.]   ← 仅隔离时
[Tools not available to you: bash, write. Calls to them are rejected.]                                        ← 有限制时
<role>…agentRole(spec.agent)…</role>
<instructions>…request.prompt…</instructions>
Complete the task, then end with a concise report: what you did, key findings, files changed (if any).
</task>
```

`readFiles` 从空开始（编辑前必须先 read，安全性不变）；worktree 的 `cwd` 节不改（前缀），工具按子会话 cwd 执行。

**`task` 工具**：`parameters.context: { type:"string", enum:["fork","fresh"] }`，两版描述各加一句 `context fork: the sub-agent inherits this conversation (same model; cheaper when it needs what you already read).`（≈ 15 token，只在 task 启用时进前缀，`default+task` 现有余量约 550）。`buildSubagentRequest` 校验枚举。`details.context` 回填实际模式。

**经济性与缺省**：文档写明——DeepSeek 命中价 ≈ 未命中 1/50，16k 缓存前缀每回合约等于 330 个全价 token，依赖父上下文的子任务基本总划算；Kimi / Anthropic 价差 1/4–1/10，只有需要父上下文时划算。`explore` 建议 fresh；`general` 是否缺省 fork 待基准（§5 Q1）。

**P2-5**：删除 `finalRoundExtension` 与 `toolChoice:"none"`；`FINAL_REPORT_PROMPT` 不变。

### §2.2 开头只写一次（B；D4、D5）

`projection.ts buildProjection`：

1. `headEnd` = 首条非 system 的 `message` 条目索引（`custom` / `usage` / `model_change` 不算「对话开始」，与 `normalizeContext` 的 `messages.length === 0` 判定一致——注意 `custom_message` 算非 system）。检查点 = `replaySystem(branch.slice(0, headEnd))`。
2. 有 compaction 时：`items = [headCheckpoint(entry: compaction), compactionMessage, synthesizedPatch?, kept…, after…]`，其中 `synthesizedPatch = diffSystem(headState, replay(全部 compaction 之前的 system 消息).sections, 同 tools)`（复用 `system-prompt.ts diffSystem`，`timestamp` 取 compaction 的）；无差异不插。
3. `replaySystem` 的工具重放改为 `tools.set(name, tool)`（不先 delete）。

`context.ts`：

- `SystemState.apply(message, started)`：`started` 为真时 `toolsRemoved` **不删**声明、`toolsAdded` 对已存在的名字**不覆盖**；为假（对话开始前）照旧。
- `renderSystemUpdate(message, previouslyRemoved: Set<string>)`：节变更照旧；`toolsRemoved` 每个追加 `toolRemovedReminder`；`toolsAdded` 中名字在 `previouslyRemoved` 里的追加 `toolRestoredReminder`。
- 删除 `removesToolsMidway` 与 `fold`；`normalizeContextInline` 同步。
- `systemReminderText` 的收尾句改为 `These updates replace the earlier versions of those system prompt sections; tool availability notes above are current.`（只在有补丁时出现，不在首个请求里）。

`session-sync.ts keepSectionsAfterStart`：`current !== undefined` 时无条件把 `tools` / `rules` 两节换成已发送文本（删掉「有工具被移除时重写」分支）。

`fingerprint.ts`：`sections` 逐节 hash；`miss.ts`：`detail = "system:" + 变化节名.join(",")`。`fingerprintChange` 返回值不变（仍是 `"system" | "tools" | "model"`），新增 `changedSections(prev, cur): string[]`。

**兼容性**：会话文件不变（补丁条目照写）；`fixedPrefixTokens` 统计把合成补丁也算 system（略保守）；rewind / `/tree` 只看条目不看投影，不受影响；`post-compact.ts skillLocations(items)` 从 system items 取 skills 节——合成补丁与检查点都在 items 里，重放结果不变。

### §2.3 摘要续写边界（B；D6）

`session-compaction.ts`：

```ts
prunePlan(policy, need): PrunePlan           // 干跑（现 prune() 的前半）
applyPrune(plan): number                     // 写 context_edit + reloadMessages
checkThreshold():
  tokens = estimate(); cold = isCold()
  if (tokens > trigger || cold) {
    plan = prunePlan(policy, cold ? undefined : tokens - target)
    after = tokens - plan.savedTokens
    continuation = !cold && after > budget ? cache.summaryContinuation() : undefined
    if (continuation === undefined) { if (applyPrune(plan) > 0) tokens = estimate() }
    // else：跳过裁剪，被裁内容进摘要
  }
  if (tokens <= budget) return
  … summarize("threshold")  // summarizer() 里 continuation 复用上面算好的那份，避免重算
```

`session-cache.ts summaryContinuation()`：开头加 `if (this.isCold()) return undefined`；思考开启且 `replayBlocker(...) !== "thinking_budget"` 且 `model.reasoning` 时 `streamOptions.maxTokens = Math.min(model.maxTokens, SUMMARY_MAX_TOKENS + thinkingBudget(model, level))`。`summarize-tier.ts completeByContinuation` 已优先用 `base.maxTokens`，不改。`session-compaction.test.ts` 原「先裁剪」断言改写，PR 写明理由（被裁内容本来就进摘要；续写比全价独立请求便宜 10–50 倍）。

### §2.4 请求层（C；D7–D9、D14、D18）

- `anthropic-request.ts`：`markLastUser(messages, cc, skip = 0)` 泛化为「从后数第 skip+1 条 user」；断点按 D7 顺序消耗 `budget`。`enforceCacheTtlOrder` 不变。
- `shared.ts finishError`：`if (error instanceof HttpError && error.retryAfterMs !== undefined) output.retryAfterMs = error.retryAfterMs`。
- `retry.ts`：`FailureKind` 加 `"rate_limited"`；`RATE_LIMIT_PATTERNS = [/\b429\b/, /\b529\b/, /rate[_ ]?limit/i, /too many requests/i]` 先于 `RETRYABLE_PATTERNS` 判；5xx 规则改为 `/^\s*5\d\d\b/` 或 `/\b(?:status|HTTP)\s*[:=]?\s*5\d\d\b/i`；`retryDelayMs(attempt, settings, retryAfterMs?, random = Math.random)`；`maxRetriesFor(kind, settings) = kind === "rate_limited" ? settings.maxRetries + 2 : settings.maxRetries`。
- `session-run.ts decideAfterRun`：`OVERLOADED && canFallback` 改为 `retryAttempt === 0 ? { kind:"retry", quick:true } : { kind:"fallback" }`；`RunDecision.retry` 带 `quick?: boolean` 与 `retryAfterMs?`；`auto_retry_start.maxAttempts` 取 `maxRetriesFor`。
- `max-tokens.ts` 按 §1.9 实现；三条协议的请求函数：`body[field] = clampMaxTokens(requested, model.contextWindow, estimate(body), fixed)`，Anthropic 的 `fixed = thinking 为预算型且开启`；`postWithCacheFallback` 之外再包 `postWithMaxTokensFallback`（先缓存剥离、再 max_tokens；两者都只在 `start` 之前，流契约不变；已记入 `maxTokensCaps` 的模型直接用上限）。`overflow.ts` 补 `[/input length and max_tokens exceed context limit/i, "Anthropic"]`，但只在 `parseMaxTokensRejection` 判不能重发时才走到它（顺序：先 max-tokens 解析）。
- `rawArguments`：`BlockTracker.end` 里 `try { JSON.parse(entry.json); entry.block.rawArguments = entry.json } catch {}`；`openai-request.ts` / `openai-responses-request.ts` 的 `arguments: call.rawArguments ?? JSON.stringify(call.arguments)`；fake 供应商录制时也写 `rawArguments`（由脚本 arguments stringify，保持测试确定）。
- `http.ts` / `sse.ts`：`PostOptions.idleTimeoutMs` 继续管响应头；`readSseEvents(…, streamIdleTimeoutMs)` 用新值；`StreamOptions.streamIdleTimeoutMs?`；读取处 `compose-session.ts:252` 一行改为调用新文件 `src/cli/compose-request.ts` 的 `requestTimeouts(config, env)`（compose-session.ts 不加行）。

### §2.5 目录与工具（D；D10–D12）

- `catalog.ts`：解析 `aliases` / `small`；`loadBuiltinCatalog` 另建 `aliasIndex: Map<normalized, { provider, id, snapshotRef }>`，重复 normalized 标记为 ambiguous（不命中）；`export function catalogByAlias(id): CatalogAliasHit | undefined`；`normalizeModelId(id)`：小写、去 `^[a-z0-9_.-]+/`（厂商前缀）、去 `:latest`。
- `enrich.ts enrichEntry`：`entry.catalog !== false` 时先 `catalogByAlias(entry.id)`（或 `catalog` 显式引用）；命中 → 复制 `INTRINSIC_FIELDS = ["thinkingLevelMap","reasoning","input"]`、`promptCache: { minTokens }`、`compat: { requiresReasoningContentOnAssistantMessages }`（用户已写的不覆盖），来源 `catalog-alias`；并把 models.dev 显式匹配设为 `hit.snapshotRef`（用户没写 `modelsDev` 时）。`registry.ts` 不加行（`enrichEntry` 签名不变，`synthesize()` 自动受益）。
- `catalog/deepseek.json`：`deepseek-flash.aliases: ["deepseek-v4-flash"]`、`deepseek-v4-pro` 若官方 id 不同同样补；其它目录按已知中转 id 补（kimi：`kimi-k2.5` 等按 packy 实测列表）；`small` 每家一条。
- `models list` 的来源列显示 `catalog (via id)`；`ama models discover --probe` 文档写明 `thinkingFormat` 仍需实测后写 `modelOverrides`。
- `tool-runner.ts`：`ToolContext.maxResultChars = options.maxToolResultChars ?? DEFAULT`（+2 行）；`read.ts` / `grep.ts` / `bash.ts`：`maxBytes = min(DEFAULT_MAX_BYTES, ctx.maxResultChars ?? ∞)`（按 UTF-8 字节保守 1:1），截断提示写实际数字；描述改写：read `…head-truncated; the result says how to continue with offset`、bash `…keeps the tail (full output saved to a file)`、grep 同理——**每条描述字符数 ≤ 现值**。`glob.ts DEFAULT_GLOB_LIMIT = 200`，描述 `Default 1000` → `Default 200`。
- `session-classifier.ts classifierModel`：`autoModel` 失败或未配时查 `providers.get(model.provider)?.small`，`findModel` 成功且 `resolveApiKey` 不抛再用，否则会话模型；选择结果 `log("debug")` 一次。
- `session-compaction.ts` 的 `budget()` / `breaker.configure` / `checkPressure` 窗口改用 `effectiveWindow = min(contextWindow, settings.contextBudget)`（**归 B**，D 只加配置键）。
- `session-cache.ts replay()`：`maxTokens: warmReplayMaxTokens(model.api)`（**归 B**；常量放 `ai/cache/warmer.ts`）。

## §3 实施批次与文件所有权

C0 先合；A、B、C、D 之后**并行**，文件互不重叠；Z 收尾。

### `[ME-C0]` 契约与无行为搬迁（§1 全部）

| 文件（唯一属主 C0）                                                                                                                                                   | 内容                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `src/ai/types.ts`、`src/ai/cache/types.ts`、`src/tools/types.ts`、`src/agents/types.ts`、`src/agents/task-record.ts`（TaskInfo 一行）、`src/agent/session-core.ts`    | §1.1、§1.2、§1.6、§1.4 字段                           |
| `src/agent/tool-availability.ts`（新）、`src/agent/session-tools.ts`（gate 两行）、`session-tools.test.ts`                                                            | §1.4；测试：`unavailableTools` 里的工具被拒且文案固定 |
| `src/session/manager.ts`、`manager.test.ts`                                                                                                                           | §1.5；测试：`head` 成为根、复制条目重挂、投影消息不变 |
| `src/agent/session-cache-key.ts`（新）、`src/agent/session-cache.ts`（只删搬走的 35 行并 import）、`session-cache.test.ts`（import 路径）                             | §1.8                                                  |
| `src/ai/apis/max-tokens.ts`（新，空壳：签名 + `clampMaxTokens` 直接返回 requested、`parse` 返回 undefined）                                                           | §1.9                                                  |
| `src/ai/providers/catalog.ts`（类型 + 校验 `aliases` 为字符串数组、`small` 为字符串；不建索引）、`catalog.test.ts`                                                    | §1.3                                                  |
| `src/config/types.ts`、`schema.ts`、`json-schema.ts`、`settings-registry.ts`、`key-docs.ts`、`src/i18n/messages/config-keys.ts`、`errors.ts`                          | §1.7                                                  |
| `docs/history/model-efficiency-plan.md`、`docs/research/model-efficiency-audit-2026-10.md`、`docs/reference/session-format.md`、`docs/reference/rpc.md`、CHANGELOG ×2 | §1.10                                                 |

完成标准：`pnpm run ci` 绿；`prompt-budget` 三档数值不变；`cache-stability.test.ts`、rpc / acp 黄金字节不变。

### `[ME-A]` fork 式子 Agent（P1-1、P2-5；D1–D3、D13）

| 文件所有权                                                                                                                                                                    | 改动                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/agent/subagent-fork.ts`（新，≈150 行：`forkPoint`、`forkPlan`、`forkBrief`、`FORK_MAX_CONTEXT_RATIO`）、`subagent-fork.test.ts`（新）                                    | §2.1                                                                        |
| `src/agent/session-subagent.ts`（`childManager` 分支、`startAmaChild` 选项、删 `finalRoundExtension`；`SubagentParent.cache` 类型加 `lastTurn?`）、`session-subagent.test.ts` | §2.1、P2-5                                                                  |
| `src/agent/session-cache-key.ts`                                                                                                                                              | `cacheKeyOf`：`ama.task` 的 `data.context === "fork"` 不排除，沿用父链根 id |
| `src/tools/task.ts`、`task.test.ts`                                                                                                                                           | `context` 参数、描述、`details.context`                                     |
| `src/agents/parse.ts`、`parse.test.ts`、`src/agents/catalog.ts`（`describe()` 不列 context，保住 400 token 清单预算）                                                         | frontmatter `context:`                                                      |
| `docs/guides/agents.md`（「限制」改写、新「fork 模式」节含经济性表）、`docs/design/design.md` §5.2 `task` 行（经 Z 合入）                                                     | 文档                                                                        |
| CHANGELOG ×2                                                                                                                                                                  | 一条                                                                        |

测试（fake）：

1. 父会话 3 回合（含 read 工具）后 `task(context:"fork")`：子会话首个请求的 `buildAnthropicRequest` / `buildOpenAIRequest` **system + tools 与父上一次请求逐字节相同**；`messages.slice(0, n)` 与父 `h.fake.calls[parentLast].context.messages` 逐条相同；第 n 条是含 `<task>` 的 user；子会话 `entries[0]` 是 `ama.task{context:"fork"}`、`header.parentSession` 指父文件。
2. 类型 `tools: [read, grep]` + fork：工具表仍是父的全集；子会话调用 `bash` → toolResult `isError`、文案 `Tool "bash" is not available in this session.`；`<task>` 列出不可用工具。
3. 回落：指定 `model: fake/other` → `details.context === "fresh"` 且子会话有 `role` 节；父 `promptTokens` 超 50% 窗口（fake usage 伪造）→ fresh。
4. `cacheKeyOf(child) === cacheKeyOf(parent)`；fresh 子会话仍为自己的 id。
5. `rebuildRecords(child.branch)` 不把父的任务记录当作自己的（子会话不建注册表；断言 `task_ctl` 在子会话被深度拒绝）。
6. P2-5：轮数耗尽的最后一轮 `h.fake.calls.at(-1).options` 没有 `toolChoice`。
7. `prompt-budget`：`default+task` 两版描述仍 ≤ 2000。

真实测量（≤ 4 次）：packy deepseek-v4-flash 与 kimi-k2.5 各「父回合 1 次 + fork 子会话首请求 1 次」，用 SDK 脚本（`scripts/` 不新增；临时脚本放仓库外）记录 `cacheRead / promptTokens`，预期 ≥ 95%；写进 `docs/benchmarks/efficiency-2026-10.md` 的「F」表。

### `[ME-B]` 前缀不变量、压缩与可观测（P1-2、P1-3、P2-7、P2-8、P2-9；D4–D6、D15–D17）

| 文件所有权                                                                                                                                                                                                                                                                                                                                                   | 改动                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `src/session/projection.ts`、`projection.test.ts`                                                                                                                                                                                                                                                                                                            | §2.2 检查点与合成补丁、`set` 不删                                             |
| `src/ai/context.ts`、`context.test.ts`                                                                                                                                                                                                                                                                                                                       | §2.2 `apply(started)`、reminder 文案、删折回                                  |
| `src/agent/session-sync.ts`、`session-sync.test.ts`（新或现有）                                                                                                                                                                                                                                                                                              | `keepSectionsAfterStart`                                                      |
| `src/agent/session-compaction.ts`、`session-compaction.test.ts`                                                                                                                                                                                                                                                                                              | §2.3 干跑与顺序；`contextBudget` 软窗口                                       |
| `src/agent/session-cache.ts`、`session-cache.test.ts`                                                                                                                                                                                                                                                                                                        | `summaryContinuation` 冷判、思考 maxTokens；`replay` 用 `warmReplayMaxTokens` |
| `src/ai/cache/warmer.ts`（`warmReplayMaxTokens`）、`fingerprint.ts`、`miss.ts`、三者测试                                                                                                                                                                                                                                                                     | D15、D17                                                                      |
| `src/compaction/continuation.test.ts`                                                                                                                                                                                                                                                                                                                        | 思考开启时续写 `maxTokens`                                                    |
| `src/cli/cache-stability.test.ts`（271 → ≈ 520）                                                                                                                                                                                                                                                                                                             | 见下                                                                          |
| `docs/design/design.md` §9 表「缓存」行、§9.1 表（「只有移除工具的补丁折回开头」→「开头永不改写；移除工具保留声明 + 尾部提醒」、新增「压缩后首个请求的 system + tools 与压缩前逐字节相同」、「档一 / 档二顺序」）、`docs/guides/providers.md`「缓存」节、`docs/guides/sessions.md` 压缩段、`docs/en/guides/providers.md` / `docs/en/guides/sessions.md` 同节 | 文档                                                                          |
| CHANGELOG ×2                                                                                                                                                                                                                                                                                                                                                 | 三条（不变量、续写、软窗口 / 指纹）                                           |

测试（fake，`cache-stability.test.ts` 新增）：

1. **压缩前有补丁**：`--memory` 或 resume 时改 AGENTS.md 产生补丁 → `/compact` → 压缩后首个请求的 `{system, tools}` 与压缩前**逐字节相同**；`messages[1]`（摘要之后）是含 `<system-reminder>` 与新节内容的 user；再压缩一次仍相同。
2. **移除工具**：`setActiveTools(去掉 bash)` → 之后请求 `{system, tools}` 不变、上一次请求的消息逐条是前缀、尾部 reminder 含 `Tool "bash" is no longer available`；脚本让模型仍调 bash → toolResult `isError` 文案固定；再加回 → reminder `available again`，表仍不变；`fingerprintContext` 三次相同。
3. **先裁剪后摘要**：fake usage 推高估算到裁剪不足 → 断言压缩条目之前**没有** `context_edit{reason:"prune"}`，摘要请求 `purpose:"summary"` 且 `messages.slice(0,n)` 等于上一次 turn 请求；裁剪足够的脚本 → 只有 prune、无 compaction。
4. **冷缓存**：目录 TTL 300 s 的 fake 模型 + `now` 前进 600 s → 续写不用，独立请求 `cacheRetention:"none"`。
5. **按节指纹**：`cache_miss.detail === "system:hooks"`。
6. **软窗口**：`compaction.contextBudget: 64k` 的 1M 窗口模型在 ~45k 触发裁剪。
7. `prompt-budget` 三档不变（B 不碰系统提示文本；reminder 不在首个请求里）。

真实测量（≤ 2 次，可选）：packy deepseek 上「压缩前有补丁 → 压缩后首请求」的 cacheRead ≥ 2048（证明 system 段命中），用 `cache-probe` 同款固定前缀。

### `[ME-C]` 请求层：断点、重试、max_tokens、原始参数、超时（P1-4、P1-5、P1-6、P2-6、P2-11；D7–D9、D14、D18）

| 文件所有权                                                                                                                                                                | 改动                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `src/ai/apis/anthropic-request.ts`、`anthropic-messages.test.ts`、`cache-request.test.ts`                                                                                 | 第 4 断点、clamp                                               |
| `src/ai/apis/shared.ts`、`stream-contract.test.ts`                                                                                                                        | `retryAfterMs`、`rawArguments`                                 |
| `src/ai/apis/openai-request.ts`、`openai-responses-request.ts`、`openai-completions.ts`、`openai-responses.ts`、`google-generative-ai.ts`（clamp 一行）、各测试           | `rawArguments`、clamp、`postWithMaxTokensFallback`             |
| `src/ai/apis/max-tokens.ts`、`max-tokens.test.ts`（新）                                                                                                                   | §1.9 实现                                                      |
| `src/ai/overflow.ts`、`overflow.test.ts`                                                                                                                                  | Anthropic 文案                                                 |
| `src/ai/http.ts`、`sse.ts`、`http.test.ts`、`sse.test.ts`                                                                                                                 | 两段超时                                                       |
| `src/agent/retry.ts`、`retry.test.ts`（新）、`session-run.ts`、`fallback.test.ts`                                                                                         | D8                                                             |
| `src/ai/fake/fake-provider.ts`                                                                                                                                            | 录 `rawArguments`；脚本可给 `retryAfterMs` / `status` 模拟 429 |
| `src/cli/compose-request.ts`（新）、`compose-session.ts`（**替换 1 行、不加行**）                                                                                         | `request.streamIdleTimeoutMs`                                  |
| `docs/design/design.md` §3.6 重试 / 缓存两行（经 Z）、`docs/guides/providers.md`「缓存」请求字段表 Anthropic 行与新「max_tokens」小节、`docs/en/guides/providers.md` 同节 | 文档                                                           |
| CHANGELOG ×2                                                                                                                                                              | 四条                                                           |

测试：

1. 3 回合请求体：`cache_control` 恰 4 处，位置 = 最后 user 末块、倒数第二 user 末块、system 末块、最后工具；去掉 `cache_control` 后相邻回合 `{system, tools}` 逐字节相同；`maxCacheBreakpoints: 3` 时倒数第二 user 不打、工具仍打？——不，按 D7 顺序：3 时打 ① ② ③，工具不打；测试断言这一点。
2. `retry.test.ts`：`retryDelayMs(1, settings, 30000, () => 0.5) === 30000`；`"500 tokens"` 不判可重试、`"HTTP 503"` 判；429 → `rate_limited`，`maxRetriesFor === 5`。`fallback.test.ts`：overloaded 第一次 → `auto_retry_start{attempt:1, delayMs ≤ 1300}`，第二次 → `model_fallback`；模型序列 `["echo","echo","backup","echo"]`。
3. `max-tokens.test.ts`：三种文案解析；`clampMaxTokens(262144, 262144, 20000, false) === 262144 − 20000 − 2048`；`fixed` 时原值；`postWithMaxTokensFallback` 在 fake `fetch` 下 400 → 重发一次且 `maxTokensCaps` 记录、第二次请求直接用上限；Anthropic `X + Y > Z` 且 `Z − X < 1024` → 走溢出。
4. `rawArguments`：fake 流里 `{"a": 1}`（带空格）→ 回放请求体 `function.arguments === '{"a": 1}'`；无 `rawArguments` 的旧消息 → `'{"a":1}'`。
5. `sse.test.ts`：响应头 1 s 内到、随后 190 s 无字节 → `IdleTimeoutError(phase:"stream")`，文案含 `idle timeout`。

真实测量（≤ 2 次）：packy kimi-k2.5 以 `maxTokens: 262144` 发一次最小请求 → 观察 400 被识别、自动以 98304 重发成功（共 2 次 HTTP）；记录到 benchmarks「M」表。

### `[ME-D]` 目录、工具与分类器（P1-7、P2-1、P2-2、P2-4；D10–D12）

| 文件所有权                                                                                                                                                                                                                              | 改动                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `src/ai/providers/catalog.ts`（别名索引，≈ +40 行）、`catalog.test.ts`、`catalog-data.ts`（`UPDATE_CATALOG=1` 重生成）                                                                                                                  | D10                          |
| `src/ai/providers/catalog/*.json`                                                                                                                                                                                                       | `aliases`、`small`           |
| `src/ai/providers/enrich.ts`、`enrich.test.ts`（新）、`models-dev.test.ts`                                                                                                                                                              | D10 继承；`registry.ts` 不改 |
| `src/cli/subcommands/models.ts`、`models.test.ts`、`src/i18n/messages/subcommands-models.ts`                                                                                                                                            | 来源列                       |
| `src/tools/read.ts`、`grep.ts`、`bash.ts`、`glob.ts`、各测试、`src/agent/tool-runner.ts`（+2 行）、`tool-runner.test.ts`                                                                                                                | D11                          |
| `src/agent/session-classifier.ts`、`session-classifier.test.ts`                                                                                                                                                                         | D12                          |
| `docs/guides/providers.md`「模型元数据」「接中转」节与新「从官方目录继承」小节、`docs/guides/permissions.md` auto 一节、`docs/design/design.md` §5.2 四行（经 Z）、`docs/en/guides/providers.md` / `docs/en/guides/permissions.md` 同节 | 文档                         |
| CHANGELOG ×2                                                                                                                                                                                                                            | 三条                         |

测试：

1. 自定义供应商 `packy` + `models: [{ id: "deepseek-v4-flash" }]` → `thinkingLevelMap` / `promptCache.minTokens === 2048` / `compat.requiresReasoningContentOnAssistantMessages === true` 来源 `catalog-alias`，`cost` 来源 `models.dev` 且匹配 `deepseek/deepseek-flash`；`promptCache.short` 为 undefined；`catalog: false` 时都不继承；两个目录条目别名相同 → 不命中（ambiguous）。
2. 工具：31 000 字符的 read 结果经 `maxResultChars: 30000` → 只截一次、`Showing lines 1–N` 与实际行一致、无 `[… chars omitted` 二次标记；glob 默认 200。
3. `prompt-budget` 三档：D 批 PR 必附 `AMA_PROMPT_BUDGET_REPORT=1` 输出，三档数值 **≤ 基线**（1446 / 740 / 1767）。
4. 分类器：`autoModel` 未配、供应商有 `small` → classify 请求的 `model.id === small`；主会话请求前缀不变（现有用例延伸）。

真实测量：0 次（`ama models list --provider packy` 不发请求；**不要**用 `ama models check`，它会发请求）。

### `[ME-Z]` 收尾（A–D 合入后）

- `docs/design/design.md`：§3.6（重试、缓存两行）、§5.2（task / read / grep / glob / bash 行）、§9 / §9.1 定稿；§17 风险表若引用缓存现状则更新。
- `docs/benchmarks/efficiency-2026-10.md`：汇总 A / B / C 的实测表（合计 ≤ 8 次），写明中转、粒度与局限。
- `docs/en/` 七篇与中文版通读对齐；CHANGELOG 两份把「Model efficiency」条目归并到发版号。
- 全量 `pnpm run ci`、`AMA_E2E=1 pnpm test:e2e`。

### 共享文件规则

| 文件                                                                       | 规则                                                                                                              |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/i18n/messages/*.ts`                                                   | C0 加键；各批只在自己的键下改文案，后合者 rebase                                                                  |
| `docs/guides/providers.md`、`docs/en/guides/providers.md`                  | B 只改「缓存」节；C 在「缓存」节下只加「max_tokens」小节与 Anthropic 行；D 只改「模型元数据」「接中转」节；Z 统稿 |
| `docs/design/design.md`                                                    | 各批把要改的行写在 PR 描述里，Z 一次合入；C0 不动                                                                 |
| `CHANGELOG.md` / `CHANGELOG.zh-CN.md`                                      | C0 建子标题，各批只追加自己的条目                                                                                 |
| `src/agent/session-compaction.ts`、`session-cache.ts`                      | 唯一属主 B（D 的 `contextBudget`、P2-9 都由 B 实现）                                                              |
| `src/agent/session-tools.ts`                                               | 唯一属主 C0（gate + 文案）；B 不碰                                                                                |
| `src/cli/compose-session.ts`                                               | 只允许 C 替换 1 行（不加行）                                                                                      |
| `src/agent/session.ts`、`subagent-registry.ts`、`ai/providers/registry.ts` | 本计划不改                                                                                                        |

## §4 验收

每批：`pnpm run ci` 绿；`prompt-budget` 三档 ≤ 基线（A 的 `default+task` ≤ 2000；D 必附明细）；`cache-stability.test.ts` 的既有用例不改断言；rpc / acp 黄金字节不变（新增可选字段不出现在黄金场景里——黄金用 fake 成功响应，无 `retryAfterMs`；fake 录制 `rawArguments` 会不会改黄金？会：`external.out.jsonl` 等若含 assistant 消息则多一个字段——C 批 `UPDATE_GOLDEN=1` 重录并在 PR 说明仅多了 `rawArguments`）。

整体（Z）：

1. **前缀不变量**：组装后的会话跑「20 回合 + 中途加工具 + 中途删工具 + resume 改 AGENTS.md + `/compact` + 再 10 回合」，全程 `{system, tools}` 逐字节相同，system 条目只有 1 条全量 + 补丁。
2. **fork**：父 5 回合后 fork 子会话，首请求前缀 = 父上一次请求；子会话独立文件首条 `ama.task{context:"fork"}`；`ama sessions` 列表不显示它（既有过滤仍有效）。
3. **重试**：fake 429 带 `retryAfterMs: 20000` → `auto_retry_start.delayMs ∈ [16000, 24000]`，5 次用尽才回退。
4. **max_tokens**：fake 400 `Range of max_tokens should be [1, 98304]` → 第二次请求 `max_tokens === 98304`，会话无错误。
5. **目录**：`ama models list --provider packy --json` 的 `deepseek-v4-flash` 条目来源字段正确。
6. 真实：A 4 次 + C 2 次 + B 2 次（可选）≤ 8 次，全部经 packy，结果入 benchmarks。

## §5 风险与未决问题

| #   | 风险 / 问题                                                                                                                                                                                             | 处置                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| R1  | fork 子会话的分支里带着父的 `ama.task` 记录（有 `status`）、`ama.plan`、`ama.reminder`：子会话不建注册表（深度拒绝）所以不会误重建；但 trace 索引（`trace/build-index.ts`）会把父的任务列进子会话索引。 | A 在 `build-index` 用 `data.context === "fork"` 的标记之后才计（1 行）；文档写明子会话看得到父的计划与提醒、`<task>` 声明优先级。 |
| R2  | fork 点取「assistant 之前一条」假定 tool 执行时 assistant 已落盘（`message_end → persistMessage → tool-runner`）；若将来改为先执行再落盘会取错。                                                        | `forkPoint` 找不到含 `parentToolCallId` 的 assistant 时回落 fresh 并 warn；测试守住。                                             |
| R3  | D4 改变压缩后投影：`estimateProjectedTokens`、`/context` 统计、`prefix-estimate` 把合成补丁算进 system；rewind / `/tree` 不受影响。                                                                     | B 的 `session-context-stats.test.ts` 补一条「压缩后统计不比压缩前大」。                                                           |
| R4  | D5 保留被移除工具的声明：模型偶尔仍调用（实测两种模型都遵守提醒），多一个回合；codemode 脚本里 `describeTool()` 仍能看到它。                                                                            | 执行层拒绝文案明确；codemode 侧 `callTool` 走同一 gate。                                                                          |
| R5  | D6 跳过裁剪直接续写：若续写失败回落独立请求，这次独立请求比「先裁」时更大（工具结果截 2000 字符后差距有限）。                                                                                           | 回落已有 warning；可接受。                                                                                                        |
| R6  | D7 第 4 断点对中转：缺省也发 `cache_control`，多一个标记无副作用；Anthropic 回看窗口 20 块无法用 packy 核实。                                                                                           | 文档标「按官方文档，未实测」。                                                                                                    |
| R7  | D9 主动收紧用字符 / 4 估算，CJK 重的上下文会低估输入，仍可能 400。                                                                                                                                      | 被动修正兜底；估算低估只影响接近窗口的请求，那时压缩本来要触发。                                                                  |
| R8  | `retryAfterMs` 很大（如 120 s）时等待变长；TUI 已显示 `delayMs`。                                                                                                                                       | 上限 `maxDelayMs`（60 s）截住；文档写明。                                                                                         |
| R9  | D10 别名误配（中转把同名 id 指向别的上游）。                                                                                                                                                            | 只唯一命中、`models list` 显示来源、`catalog: false` 关闭；不继承价格与 TTL 限制了误配代价。                                      |
| R10 | D11 工具描述改写影响三档预算；codemode-only 只剩约 8 token。                                                                                                                                            | 规则「字符数只减不增」+ D 批附明细；超出即改回。                                                                                  |
| R11 | D18 流中 180 s：极端慢的推理端点可能误判。                                                                                                                                                              | 可配 / 环境变量；0 关闭；CHANGELOG 写明。                                                                                         |
| R12 | `rawArguments` 让 fake 黄金多一个字段（R 见 §4）。                                                                                                                                                      | C 重录并说明。                                                                                                                    |
| Q1  | `general` 是否缺省 `fork`（DeepSeek 上几乎总划算，Kimi / Anthropic 不一定）。推荐：本波缺省 fresh；跑一次 presets 式基准（≤ 10 次）后另开 PR 决定，或按供应商价差自动选择。                             |                                                                                                                                   |
| Q2  | 是否把 `FORK_MAX_CONTEXT_RATIO` 暴露为 `subagents.forkMaxContextRatio`。推荐：先常量。                                                                                                                  |                                                                                                                                   |
| Q3  | `requiresReasoningContentOnAssistantMessages` 经中转是否成立取决于中转是否透传 `reasoning_content`；推荐：继承，并在 providers.md 写明用 `modelOverrides.compat` 关闭的方法。                           |                                                                                                                                   |
| Q4  | Anthropic「`input length and max_tokens exceed context limit`」真实文案需官方 key 取样。推荐：按文档文案实现正则 + 单测，标「待核实」。                                                                 |                                                                                                                                   |

## §6 有意不做（写进文档）

| 项                                        | 理由                                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P2-12 继续精简前缀                        | default ≈ 1.45k token 几乎全在缓存里；DeepSeek 前几个回合前缀不足 2048 粒度读数本来是 0；minimal / codemode-only 余量极小，任何改写得先腾空间，收益 < 风险。 |
| Responses `previous_response_id`          | 需要 `store: true`，输入计费不变。                                                                                                                           |
| Gemini 显式缓存                           | 有存储费、起步门槛高于 ama 前缀。                                                                                                                            |
| 改缺省预设                                | presets-2026-10-02 基准支撑现状。                                                                                                                            |
| DeepSeek `supportsMidConvoSystemMessages` | 实测模型不按中途 system 作答（cache-midconvo-2026-10-09）。                                                                                                  |
| P1-2(c) codemode 晚到工具「仅脚本可调用」 | 需要 codemode 声明生成与权限路径设计，另立计划。                                                                                                             |
| P2-3 文件未变化短回执                     | 收益取决于任务，先用 trace 统计重复读占比；误判时模型拿不到内容。                                                                                            |
| P2-10 OpenAI 缺省 24h 保留                | 24h 保留是否不额外收费需按官方定价页核实；核实后只是把 `api.openai.com` 的缺省 retention 改为 long 的一行改动。                                              |
| 回退代价阈值（P1-5）                      | 需要回退模型价格与 `promptTokens` 估算，收益不明；先做「快速重试一次」。                                                                                     |
| 合并并行调用的分类请求（P2-4）            | 分类质量需回归基准；延迟收益可由小模型获得大半。                                                                                                             |
