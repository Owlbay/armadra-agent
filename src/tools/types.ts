/**
 * 工具契约（设计 §5.1）。[B0] 契约文件，实现归 B3；也从 `./host` 再导出。
 *
 * 补全与偏差：
 * - `ToolContext.readFiles` 是只读集合，但 read 工具要「成功后加入」——增加 `markRead(path)`。
 * - bash 要注入 `AMA_PROVIDER / AMA_MODEL / AMA_THINKING`（§5.2），增加 `model` 与 `thinkingLevel`。
 * - 截断全文落 `<sessionDir>/outputs/<toolCallId>.txt`（§4.4），增加 `outputDir`
 *   （内存会话为 undefined，实现自行落到临时目录）。
 * - todo 工具要写 / 读 `custom` 条目，增加 `session.appendCustom / lastCustom`。
 * - task 工具要开子会话，但 B3 不得 import B2 的实现——增加 `spawnSubagent`，由
 *   AgentSession（B2）在构造 ToolContext 时提供；子 Agent（depth ≥ 1）里为 undefined。
 * - `defineTool()` 是恒等函数，只为推断 `I`；放在契约文件里供 SDK 再导出。
 * - `ToolRegistryApi` 是 Runtime 需要的最小接口，B3 的 `ToolRegistry` 实现它。
 * - （W3-C0）`SubagentResult.cache` 可选：子会话的命中率与重计费 token。
 * - （W5-C0）第五波（docs/wave5-plan.md §7.3–§7.6、§8.2 C4、§8.3 H1）：`annotations.pollable /
 *   keepInContext`；`SubagentRequest` 加 `agent / background / taskId / isolation / budgetUsd`；
 *   `SubagentResult` 加 `taskId / status / outputFile / sessionRef`（契约要求向后兼容，全部可选）；
 *   统一入口 `SubagentRunner / RunnerHandle / SubagentEvent`（ama 子会话、外部 CLI、宿主 runner）；
 *   `ToolContext.tasks` 为任务注册表的只读视图（W5-G 提供）。
 */

import type { ContentBlock, JsonSchema, ModelRef, ModelThinkingLevel, Usage } from "../ai/types.js";
import type { CheckpointHooks } from "../checkpoints/types.js";
import type { PermissionMode } from "../permissions/types.js";
import type { TraceExternalTurnData } from "../trace/types.js";

export type { JsonSchema } from "../ai/types.js";

/** 权限管线的粗分类（§7）。 */
/**
 * [W6-C0] `memory`：记忆工具专用（`permissions/memory-class.ts`）——`view` 按 read、写命令按 execute 判定。
 */
export type ToolPermission = "read" | "write" | "execute" | "memory";
export type ToolExecutionMode = "sequential" | "parallel";

export interface ToolAnnotations {
  readOnly?: boolean;
  destructive?: boolean;
  openWorld?: boolean;
  /** [W5-C0] 轮询类调用（`task_ctl wait`、后台 bash 查询）：重复调用检测豁免（§8.3 H1）。 */
  pollable?: boolean;
  /** [W5-C0] 结果不被档一裁剪（压缩保护集，§8.2 C4）。 */
  keepInContext?: boolean;
}

export interface ToolDefinition<I = unknown> {
  /** `^[a-z][a-z0-9_]{1,63}$`；宿主工具建议前缀（canvas_*）。 */
  readonly name: string;
  /** TUI 标题。 */
  readonly label?: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  readonly permission: ToolPermission;
  /** 缺省：read → parallel；write / execute → sequential。 */
  readonly executionMode?: ToolExecutionMode;
  readonly annotations?: ToolAnnotations;
  /** 系统提示 tools 节一行。 */
  readonly promptSnippet?: string;
  /** 系统提示 rules 节。 */
  readonly promptGuidelines?: readonly string[];
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
  /** TUI 可选自定义渲染。 */
  renderCall?(input: I, width: number): string[];
  renderResult?(result: ToolResult, width: number, expanded: boolean): string[];
}

export interface ToolResult {
  content: string | ContentBlock[];
  isError?: boolean;
  /** 落盘，不进上下文。 */
  details?: unknown;
  structured?: unknown;
  /** 整批工具结果都为 true 才提前结束 run。 */
  terminate?: boolean;
  /** [ACP-C0] 文件改动的改前 / 改后全文（edit / write 填）；只随事件走，不落盘（tool-runner 只拷 details）。 */
  fileChange?: FileChange;
}

/** [ACP-C0] 文件改动：`oldText` 为 null 表示新建；`firstChangedLine` 从 1 起。 */
export interface FileChange {
  path: string;
  oldText: string | null;
  newText: string;
  firstChangedLine?: number;
}

/** [ACP-C0] `fileChange` 单侧文本上限（字符数），超过就不填。 */
export const FILE_CHANGE_TEXT_LIMIT = 256 * 1024;

export interface SubagentRequest {
  prompt: string;
  description?: string;
  /** 缺省 = 父活动集去掉 task。 */
  tools?: string[];
  /** `provider/model-id`；缺省继承父。 */
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
  /** 缺省 30。 */
  maxTurns?: number;
  /** 父 toolCallId（写入子会话的 custom{ama.task}）。 */
  parentToolCallId: string;
  signal: AbortSignal;
  onUpdate?(partial: string): void;
  /** [W5-C0] 子 Agent 类型或外部 Agent id；缺省 `general`。 */
  agent?: string;
  /** [W5-C0] 后台运行：立即返回 taskId，完成后以 `<task-notification>` 通知。 */
  background?: boolean;
  /** [W5-C0] 续聊：向已有子会话追加消息（忽略 agent / tools / model）。 */
  taskId?: string;
  /** [W5-C0] `worktree`：在 `<repo>/.ama/worktrees/<taskId>` 里运行；缺省 `none`。 */
  isolation?: "none" | "worktree";
  /** [W5-C0] 外部 Agent 的美元预算。 */
  budgetUsd?: number;
}

/** [W5-C0] 子 Agent 任务的终态（`subagent_end.status`）。 */
export type SubagentStatus = "completed" | "failed" | "aborted" | "max_turns" | "interrupted";

/** [W5-C0] 会话引用：ama 子会话文件，或外部 CLI 自己的会话 id（`custom{ama.agent-session}`）。 */
export interface SubagentSessionRef {
  runner: string;
  sessionId: string;
  sessionFile?: string;
}

export interface SubagentResult {
  /** 子会话最后一条助手文本。 */
  text: string;
  sessionFile?: string;
  usage: Usage;
  stopReason: string;
  isError: boolean;
  /**
   * [W3-C0] 子会话自己的缓存统计（第三波 §1.9），供 task 结果 details 与 `/session` 的
   * 「子任务」行；子会话未接缓存控制器时缺省。
   */
  cache?: { hitRate?: number; reBilledTokens: number };
  /** [W5-C0] 注册表里的任务 id（W5-G 起总有）。 */
  taskId?: string;
  /** [W5-C0] 终态；后台启动时为 `running`。 */
  status?: SubagentStatus | "running";
  /** [W5-C0] 结果全文（> 50 KB 截断时、后台任务的输出文件）。 */
  outputFile?: string;
  sessionRef?: SubagentSessionRef;
}

// ---------------------------------------------------------------------------
// [W5-C0] 统一的子 Agent 运行入口（docs/wave5-plan.md §7.6）
// ---------------------------------------------------------------------------

/** runner 上报的进度（由注册表转成 `subagent_update` 事件）。 */
export type SubagentEvent =
  | { type: "text"; delta: string }
  | { type: "thought"; delta: string }
  | {
      type: "tool";
      toolName: string;
      status: "started" | "completed" | "failed";
      /** [W6-C0] runner 内的调用 id（外部 Agent 的 tool_call id；配对 started / 结束）。 */
      id?: string;
      /** [W6-C0] 事件时刻（epoch ms）。 */
      at?: number;
    }
  | { type: "turn"; turn: number }
  /**
   * [W6-C0] 外部 Agent 一个回合结束时的骨架（docs/wave6-plan.md §2.2）：任务注册表写成父会话的
   * `ama.trace{kind:"external_turn"}`。只有种类、状态、时间与计数——不含工具标题、命令行、路径。
   */
  | { type: "turn_trace"; trace: Omit<TraceExternalTurnData, "kind" | "taskId" | "agent"> }
  | {
      type: "usage";
      usage?: Usage;
      /** 无美元单位的外部 Agent 按各自单位记（不换算）。 */
      unit?: "usd" | "tokens" | "requests";
      amount?: number;
      /** 外部 Agent 报告的上下文占用与窗口（回合中途也会单独发一条只带它们的 usage）。 */
      contextTokens?: number;
      contextWindow?: number;
    }
  | { type: "notice"; level: "info" | "warn"; text: string };

export interface SubagentRunRequest {
  prompt: string;
  cwd: string;
  /** 不得比父会话当前模式宽（`isAtLeastAsStrict`）。 */
  mode: PermissionMode;
  model?: string;
  /** 续聊的会话 id（runner 自己的）。 */
  resume?: string;
  budgetUsd?: number;
  /** [W5-EG] 发起的任务 id（审批标注 `context.taskId`、外部会话引用记账用）；可选。 */
  taskId?: string;
  signal: AbortSignal;
  onEvent(event: SubagentEvent): void;
}

export interface RunnerHandle {
  /** 子会话 / 外部会话 id。 */
  readonly id: string;
  /** 续聊。 */
  send(text: string): Promise<void>;
  wait(): Promise<SubagentResult>;
  stop(): Promise<void>;
  /**
   * 打断当前回合并立即以 `text` 开下一回合（子 Agent 视图的「打断并发送」）；`wait()` 跟到这一回合结束。
   * 驱动能中断回合（ACP `session/cancel`、Claude stream-json interrupt、Codex `turn/interrupt`）且正在
   * 运行时返回 true；否则 false（调用方退回排队）。
   */
  interrupt?(text: string): Promise<boolean>;
}

/** `ama`（AmaRunner）| `claude` | `codex` | `acp:<program>`（ProcessRunner，W5-E）| 宿主 id。 */
export interface SubagentRunner {
  readonly id: string;
  start(request: SubagentRunRequest): Promise<RunnerHandle>;
}

/** [W5-C0] 任务注册表里一条任务的快照（`task_ctl list`、RPC `get_tasks`、`/tasks`）。 */
export interface TaskInfo {
  taskId: string;
  agent: string;
  runner: string;
  description: string;
  background: boolean;
  status: SubagentStatus | "running";
  startedAt: number;
  endedAt?: number;
  turns?: number;
  usage?: Usage;
  costUsd?: number;
  /** 外部 Agent 最近报告的上下文占用与窗口（token，只记数字）；驱动不报时缺省。 */
  contextTokens?: number;
  contextWindow?: number;
  outputFile?: string;
  sessionRef?: SubagentSessionRef;
}

/** [W5-C0] 任务注册表的只读视图（W5-G 的 `SubagentRegistry` 提供）。 */
export interface TaskRegistryView {
  list(): readonly TaskInfo[];
  get(taskId: string): TaskInfo | undefined;
}

export interface ToolContext {
  readonly toolCallId: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly signal: AbortSignal;
  /** task 深度：主会话 0，子 Agent 1。 */
  readonly depth: number;
  readonly model?: ModelRef;
  readonly thinkingLevel?: ModelThinkingLevel;
  /** 截断全文的落盘目录（`<sessionDir>/outputs`）；内存会话为 undefined。 */
  readonly outputDir?: string;
  onUpdate(partial: string): void;
  /** 本会话已 read 的绝对路径（write / edit 先读后写检查）。 */
  readonly readFiles: ReadonlySet<string>;
  markRead(absolutePath: string): void;
  /**
   * [S-A] 本次调用时模型可直接调用的工具名（会话活动集，只读快照）；工具据此给出可执行的提示
   * （如 read 收到目录时说用 ls 还是 glob）。宿主 / SDK 自建上下文可不给。
   */
  readonly activeTools?: ReadonlySet<string>;
  /**
   * 嵌套调用其它工具（codemode 脚本、task），受同一管线；按全部未禁用工具查找（不限于活动集），
   * 发带 `parentToolCallId` 的 tool_execution_* 事件。`signal`：与 ctx.signal 合并，用于提前取消
   * 这一次嵌套调用（codemode 脚本结束时取消仍在跑的调用）。
   */
  readonly tools: {
    executeTool(
      name: string,
      input: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<ToolResult>;
  };
  readonly session: {
    /** 追加 custom 条目（不进上下文）。 */
    appendCustom(customType: string, data: unknown): void;
    /** 活动分支上最近一条该类型 custom 条目的 data。 */
    lastCustom(customType: string): unknown;
  };
  /** 检查点（docs/rewind-plan.md §2）：edit / write 写文件前后调用；未启用时为 undefined。 */
  readonly checkpoint?: CheckpointHooks;
  /** 仅 depth 0 且 task 可用时存在。 */
  readonly spawnSubagent?: (request: SubagentRequest) => Promise<SubagentResult>;
  /** [W5-C0] 任务注册表只读视图（`task_ctl`）；注册表未装配时 undefined。 */
  readonly tasks?: TaskRegistryView;
  log(level: "debug" | "info" | "warn", message: string): void;
}

export type ToolSource = "builtin" | "host" | "sdk";

export interface ToolRegistryApi {
  /** 同名已存在则抛 AmaError{code:"tool_exists"}。 */
  register(tool: ToolDefinition, source: ToolSource): void;
  disable(name: string): void;
  get(name: string): ToolDefinition | undefined;
  /** 已注册且未禁用的名字，按名排序。 */
  list(): readonly string[];
  /** 当前活动集（发给模型的工具），按名排序。 */
  active(): readonly ToolDefinition[];
  setActive(names: readonly string[]): void;
}

/** 恒等函数，帮助推断输入类型。 */
export function defineTool<I>(tool: ToolDefinition<I>): ToolDefinition<I> {
  return tool;
}
