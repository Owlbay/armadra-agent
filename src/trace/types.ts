/**
 * 轨迹（docs/history/wave6-plan.md §2.1、§2.2、D5、D6）。[W6-C0] 纯类型，经 `@armadra/agent` 导出。
 *
 * 两部分：
 * - **持久化**：`custom{customType:"ama.trace"}` 条目的 `data`（`TraceEntryData`），由
 *   `agent/session-trace-writer.ts` 在事件发生后追加；不进上下文、不改请求字节、不改已落条目。
 *   只记 id、时间与计数——**不含正文**（提示、参数、结果、外部 Agent 的工具标题 / 命令行 / 路径）。
 * - **轨迹树**：`Trace`，由 `trace/build.ts` 的 `buildTrace()`（[W6-T1]，纯函数）从会话条目构建，TUI `/trace`、
 *   `ama sessions trace`、RPC `get_trace` 三方共用；老会话（无 `ama.trace`）回退推算并标 `approx`。
 */

import type { Usage } from "../ai/types.js";

export const TRACE_CUSTOM_TYPE = "ama.trace";

/** `TraceEntryData.reason` 的最大长度（字符）。 */
export const TRACE_REASON_MAX = 200;

// ---------------------------------------------------------------------------
// 持久化：custom{ama.trace}.data
// ---------------------------------------------------------------------------

/** 一次工具调用的计时（顶层调用；`id` = toolCallId）。 */
export interface TraceToolTiming {
  id: string;
  startedAt: number;
  endedAt?: number;
  /** 等审批的时长（`permission_request` → `permission_resolved`）。 */
  approvalMs?: number;
  /** 被拒（权限管线 / Hook / 审批 / 无人值守），没有执行。 */
  denied?: boolean;
}

/** codemode 脚本里的内层调用（`parentId` = 外层 codemode 调用的 toolCallId）。 */
export interface TraceSubcallTiming {
  id: string;
  parentId: string;
  name: string;
  startedAt: number;
  endedAt?: number;
  isError?: boolean;
}

/** 一次模型请求（成功、失败、被重试掉的都写一条）；写在该批 toolResult 之后（无工具时紧跟 assistant）。 */
export interface TraceStepData {
  kind: "step";
  /** 该请求的 assistant 条目。 */
  assistantEntryId?: string;
  requestAt?: number;
  firstTokenAt?: number;
  doneAt?: number;
  outputTokens?: number;
  tps?: number;
  /** 本周期内第几次尝试（1 起；重试 / 回退后递增）。 */
  attempt: number;
  /** 回退前的模型 `provider/model`。 */
  fallbackFrom?: string;
  /** 中断时 `agent_end` 兜底写入。 */
  status?: "aborted";
  tools?: TraceToolTiming[];
  subcalls?: TraceSubcallTiming[];
}

export interface TraceRetryWaitData {
  kind: "retry_wait";
  /** 即将进行的尝试序号（2 起）。 */
  attempt: number;
  delayMs: number;
  startedAt: number;
  /** 失败原因（≤ 200 字符）。 */
  reason?: string;
}

export interface TraceFallbackData {
  kind: "fallback";
  from: string;
  to: string;
  reason?: string;
}

export interface TraceCompactionData {
  kind: "compaction";
  trigger: "threshold" | "overflow" | "manual";
  startedAt: number;
  endedAt: number;
  compactionEntryId?: string;
  aborted?: boolean;
}

export interface TraceAuxData {
  kind: "aux";
  purpose: "cache_warm" | "permission_classify" | (string & {});
  usageEntryId: string;
  startedAt?: number;
  endedAt: number;
}

/** 外部 Agent 工具的骨架：只有种类与状态，**不含标题 / 命令行 / 路径**。 */
export interface TraceExternalTool {
  kind: string;
  status: "completed" | "failed" | "in_progress";
  startedAt?: number;
  endedAt?: number;
}

/** 外部 Agent 的一个回合（写在父会话，`taskId` 关联）。 */
export interface TraceExternalTurnData {
  kind: "external_turn";
  taskId?: string;
  agent: string;
  sessionId: string;
  turn: number;
  startedAt: number;
  endedAt: number;
  stopReason: string;
  tools: TraceExternalTool[];
  toolCount: number;
  filesTouched: number;
}

export type TraceEntryData =
  | TraceStepData
  | TraceRetryWaitData
  | TraceFallbackData
  | TraceCompactionData
  | TraceAuxData
  | TraceExternalTurnData;

export type TraceEntryKind = TraceEntryData["kind"];

// ---------------------------------------------------------------------------
// 轨迹树（buildTrace 的产物；[W6-T1] 实现构建器）
// ---------------------------------------------------------------------------

export type TraceNodeKind =
  "turn" | "step" | "tool" | "subcall" | "subagent" | "compaction" | "retry_wait" | "aux";

export type TraceNodeStatus =
  "ok" | "error" | "aborted" | "denied" | "running" | "retried" | "interrupted";

export interface TraceNodeBase {
  /** turn = 用户消息 entryId；step = assistant entryId；tool = toolCallId；subagent = taskId。 */
  id: string;
  kind: TraceNodeKind;
  startedAt?: number;
  /** 进行中只有 startedAt，不编造时长。 */
  endedAt?: number;
  /** 时间来自回退推算（老会话 / 缺 ama.trace）。 */
  approx?: boolean;
  status: TraceNodeStatus;
  /** 回到会话条目（详情、跳转用）。 */
  entryIds: string[];
}

export interface TraceTotals {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: number;
  durationMs?: number;
  toolCalls: number;
  /** 只用非 approx 的 step。 */
  ttftP50?: number;
  ttftP90?: number;
  avgTps?: number;
  cacheHitRatio?: number;
}

export interface TraceTurnNode extends TraceNodeBase {
  kind: "turn";
  /** 用户消息的 origin（`steer` / `followUp` / `host` / `direct` …）。 */
  origin?: string;
  steps: (TraceStepNode | TraceCompactionNode | TraceRetryWaitNode)[];
  usage: TraceTotals;
}

export interface TraceStepNode extends TraceNodeBase {
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
  cacheHitRatio?: number;
  tools: TraceToolNode[];
}

export interface TraceToolNode extends TraceNodeBase {
  kind: "tool";
  name: string;
  isError: boolean;
  approvalMs?: number;
  denied?: boolean;
  children: (TraceSubcallNode | TraceSubagentNode)[];
}

export interface TraceSubcallNode extends TraceNodeBase {
  kind: "subcall";
  name: string;
  parentToolCallId: string;
  isError: boolean;
}

export interface TraceExternalTurnNode extends Omit<TraceNodeBase, "kind"> {
  kind: "external_turn";
  turn: number;
  stopReason: string;
  tools: TraceExternalTool[];
  toolCount: number;
  filesTouched: number;
}

export interface TraceSubagentNode extends TraceNodeBase {
  kind: "subagent";
  taskId: string;
  agent: string;
  runner: string;
  background: boolean;
  usage?: Usage;
  costUsd?: number;
  turns?: number;
  /** ama 子会话（懒加载，深度 ≤ 1）。 */
  child?: Trace;
  /** 外部 Agent 骨架。 */
  external?: TraceExternalTurnNode[];
  childRef?: { sessionFile?: string; sessionId: string };
  /** 子会话文件缺失或损坏。 */
  childMissing?: boolean;
}

export interface TraceCompactionNode extends TraceNodeBase {
  kind: "compaction";
  trigger?: "threshold" | "overflow" | "manual";
  tokensBefore?: number;
  tokensAfter?: number;
}

export interface TraceRetryWaitNode extends TraceNodeBase {
  kind: "retry_wait";
  attempt: number;
  delayMs: number;
  reason?: string;
}

export interface TraceAuxNode extends TraceNodeBase {
  kind: "aux";
  purpose: string;
  usage?: Usage;
}

export interface Trace {
  version: 1;
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  totals: TraceTotals;
  turns: TraceTurnNode[];
  /** cache_warm / permission_classify。 */
  aux: TraceAuxNode[];
  /** 有进行中节点。 */
  partial: boolean;
}

/** `buildTrace` / `session.trace()` / RPC `get_trace` 的选项（[W6-T1] / [W6-T2] 实现）。 */
export interface TraceOptions {
  branch?: "leaf" | "all";
  /** 注入当前时刻（确定性）。 */
  now?: number;
  /** 尾部优先的回合数上限。 */
  turnLimit?: number;
  /** 子任务的子轨迹。 */
  taskId?: string;
}
