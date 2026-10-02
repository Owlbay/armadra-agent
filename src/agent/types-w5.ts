/**
 * 第五波会话契约（docs/wave5-plan.md §1.3、§5.4、§6.3、§6.5、§7.5、§8.3；[W5-C0]）。
 *
 * 这里放新增事件的载荷与 `SessionStats` 的扩展形状，由 agent/types.ts 并入 `SessionEvent` /
 * `SessionStats` 并再导出（agent/types.ts 已接近 600 行）。全部是新增事件与可选字段：
 * `RpcEvent` 由 `SessionEvent` 派生，新事件自动上线；`RPC_PROTOCOL_VERSION` 不变。
 * 实现归各批次：遥测 W5-A、子 Agent W5-G（外部 runner W5-E）、计划 / todo W5-F、
 * 预算 / 回退 / 后台命令 W5-H2。
 */

import type { ModelRef, Usage } from "../ai/types.js";
import type { PermissionMode } from "../permissions/types.js";

// ---------------------------------------------------------------------------
// 遥测（§1.3，W5-A）
// ---------------------------------------------------------------------------

/** 一次 `purpose: "turn"` 请求的速率数据。 */
export interface RequestTelemetry {
  requestAt: number;
  /** 首个 text_delta / thinking_delta / toolcall_start。 */
  firstTokenAt?: number;
  doneAt?: number;
  /** usage.output（含 reasoning）；流式期间用增量字符估算。 */
  outputTokens?: number;
  /** outputTokens / (doneAt − firstTokenAt)。 */
  tps?: number;
  ttftMs?: number;
}

export interface SessionTelemetry {
  /** 最近一次 turn 请求。 */
  last?: RequestTelemetry;
  /** 流式中（2 s 滑动窗口）。 */
  live?: { tps: number; outputTokens: number; elapsedMs: number };
  /** 会话内全部 turn 请求的 Σoutput / Σ(done − firstToken)。 */
  avgTps?: number;
  /** 本进程打开该会话的时刻（不是会话文件创建时间）。 */
  sessionStartedAt: number;
}

// ---------------------------------------------------------------------------
// 子 Agent（§7.5，W5-G / W5-E）
// ---------------------------------------------------------------------------

export type SubagentStatus = "completed" | "failed" | "aborted" | "max_turns" | "interrupted";

/** 外部 Agent 的用量单位（Codex 订阅 token、Copilot premium request 等不换算美元）。 */
export type ExternalUsageUnit = "usd" | "tokens" | "requests";

export interface SubagentStartEvent {
  type: "subagent_start";
  taskId: string;
  parentToolCallId: string;
  /** 子 Agent 类型（`general` / `explore` / 定义文件名 / 外部 Agent id）。 */
  agent: string;
  /** `ama` | `claude` | `codex` | `acp:<program>` | 宿主 runner id。 */
  runner: string;
  description: string;
  background: boolean;
  model?: string;
  sessionFile?: string;
  cwd: string;
}

export interface SubagentUpdateEvent {
  type: "subagent_update";
  taskId: string;
  kind: "tool" | "text" | "turn";
  toolName?: string;
  /** 文本增量（节流 ≥ 250 ms 合并）。 */
  textDelta?: string;
  turn: number;
  usage?: Usage;
}

export interface SubagentEndEvent {
  type: "subagent_end";
  taskId: string;
  status: SubagentStatus;
  /** 外部 runner 可能拿不到 token 用量。 */
  usage?: Usage;
  cache?: { hitRate?: number; reBilledTokens: number };
  /** 全文结果（> 50 KB 截断时）。 */
  outputFile?: string;
  worktree?: { branch: string; changed: boolean };
}

// ---------------------------------------------------------------------------
// 计划与 todo（§6.3、§6.5，W5-F）
// ---------------------------------------------------------------------------

export interface PlanStep {
  /** `S1`、`S2` …；编号列表时按序号生成。 */
  id: string;
  text: string;
  dependsOn?: string[];
  /** 建议执行者（`[agent: codex]`）。 */
  agent?: string;
}

/** `custom{customType:"ama.plan"}` 的 data，也是 RPC `get_plan` 的返回。 */
export interface PlanData {
  id: string;
  version: number;
  status: "proposed" | "approved" | "rejected" | "superseded";
  markdown: string;
  steps: PlanStep[];
  sourceEntryId: string;
  filePath?: string;
}

/** `custom{customType:"ama.plan_state"}` 的 data（resume 回到 plan 模式）。 */
export interface PlanStateData {
  active: boolean;
  prePlanMode: PermissionMode;
  planId?: string;
}

/** 审批四选项 + 拒绝（Esc）。 */
export type PlanDecisionKind = "approve" | "approve_fresh" | "revise" | "reject";

export interface PlanProposedEvent {
  type: "plan_proposed";
  planId: string;
  version: number;
  markdown: string;
  steps: PlanStep[];
  filePath?: string;
}

export interface PlanResolvedEvent {
  type: "plan_resolved";
  planId: string;
  decision: PlanDecisionKind;
  /** `approve` 时指定的执行模式（缺省回到进入 plan 前的模式）。 */
  mode?: PermissionMode;
}

/** todo 条目的线上形状（与 `tools/todo.ts` 的 `TodoItem` 结构兼容；`planStep` 由 W5-F 加）。 */
export interface TodoItemView {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "done";
  planStep?: string;
}

export interface TodoUpdatedEvent {
  type: "todo_updated";
  items: TodoItemView[];
}

// ---------------------------------------------------------------------------
// 预算、回退、后台命令（§8.3，W5-H2）
// ---------------------------------------------------------------------------

export type LimitKind = "turns" | "cost";

/** `--max-turns` / `--max-cost` / `limits.*` 到限；`-p` 下以退出码 7 结束。 */
export interface LimitReachedEvent {
  type: "limit_reached";
  kind: LimitKind;
  /** 到限时的值（回合数或美元）。 */
  value: number;
  limit: number;
}

export interface ModelFallbackEvent {
  type: "model_fallback";
  from: ModelRef;
  to: ModelRef;
  /** 触发原因（`overloaded` / 重试用尽的错误文本）。 */
  reason: string;
}

export interface BackgroundJobEvent {
  type: "background_job";
  jobId: string;
  phase: "started" | "exited" | "stopped";
  command: string;
  pid?: number;
  outputPath?: string;
  exitCode?: number | null;
}

export type SessionEventW5 =
  /** 流式中 ≤ 2 Hz（`ui.animation: false` 时不发）；数据从 `getStats().telemetry` 取。 */
  | { type: "telemetry_tick" }
  | SubagentStartEvent
  | SubagentUpdateEvent
  | SubagentEndEvent
  | PlanProposedEvent
  | PlanResolvedEvent
  | TodoUpdatedEvent
  | LimitReachedEvent
  | ModelFallbackEvent
  | BackgroundJobEvent;

// ---------------------------------------------------------------------------
// SessionStats 扩展
// ---------------------------------------------------------------------------

/** 外部 Agent 记账（`custom{ama.agent-usage}` 汇总，§5.4）。 */
export interface ExternalAgentStats {
  byAgent: Record<
    string,
    { runs: number; unit: ExternalUsageUnit; amount: number; tokens?: number }
  >;
}

/** 子 Agent 任务注册表的汇总（`/session` 与 `get_session_stats`）。 */
export interface SessionTaskStats {
  total: number;
  running: number;
  byStatus: Partial<Record<SubagentStatus, number>>;
}

export interface SessionStatsW5 {
  /** [W5-A] 速率与会话时长；遥测扩展未装配时缺省。 */
  telemetry?: SessionTelemetry;
  /** [W5-E] 外部 Agent 用量；没有外部运行时缺省。 */
  external?: ExternalAgentStats;
  /** [W5-G] 子 Agent 任务；没有任务时缺省。 */
  tasks?: SessionTaskStats;
}

/** `limits` 选项（`--max-turns` / `--max-cost` / config `limits.*`），W5-H2 实现。 */
export interface SessionLimits {
  maxTurns?: number;
  maxCostUsd?: number;
}
