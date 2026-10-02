/**
 * 轨迹构建器（docs/wave6-plan.md §2.3、D6）。[W6-T1]
 *
 * `buildTrace(input, opts)` 把会话条目重建成 `Trace`（Turn → Step → Tool → Subcall / Subagent）：
 * TUI `/trace`、`ama sessions trace`、RPC `get_trace` 三方共用同一棵树。
 *
 * 性质：
 * - **纯函数**：不读时钟、不做 I/O；子会话经 `opts.loadChild` 回调读取（深度 ≤ 1：子轨迹里不再展开孙任务）。
 * - **确定性**：同样的输入（含 `opts.now` / `opts.live`）得到逐字节相同的 JSON；节点顺序 = 条目顺序。
 * - **不改历史**：老会话没有 `ama.trace` 时按条目时间回退推算并标 `approx`；推算出的时间不写回文件。
 * - **容忍**：未知条目、未知 customType、损坏的 data 一律跳过；子会话缺失或读取抛错标 `childMissing`。
 * - **不含正文**：只有 id、时间、计数与用量；提示 / 参数 / 结果的预览由调用方按 `entryIds` 回条目取。
 *
 * 算法：选分支（leaf = 根 → 叶子；all = 文件顺序）→ 预建索引（`ama.trace` 按 assistant / toolCall /
 * compaction / usage 条目 id，`ama.task` 按父 toolCallId，`external_turn` 按 taskId，`context_edit` 的
 * retry / overflow 目标）→ 顺序扫描建节点 → 叠加 `live` → 汇总。推算规则：`requestAt = assistant.timestamp`、
 * `doneAt = 条目时间`、工具 `startedAt = assistant 条目时间`、`endedAt = toolResult.timestamp`；ttft 分位与
 * 平均吞吐只用精确（非 approx）的 step。
 */

import type { SessionEntry, SessionHeader } from "../session/types.js";
import { indexEntries, pathToRoot } from "../session/tree.js";
import {
  buildIndex,
  entryTime,
  num,
  splitRef,
  traceData,
  zeroUsage,
  type Index,
  type ScanState,
} from "./build-index.js";
import {
  abortedRequest,
  assistantStep,
  compactionAsAux,
  compactionNode,
  externalNodes,
  pushUsage,
  retryNode,
  subagentNode,
} from "./build-nodes.js";
import { accumulate, emptyTotals, finishTotals, maxDefined, mergeTotals } from "./build-util.js";
import {
  type Trace,
  type TraceAuxNode,
  type TraceStepNode,
  type TraceSubagentNode,
  type TraceTurnNode,
} from "./types.js";

/** `buildTrace` 的输入：与 `ExportInput`（session/export.ts）同形，另可带会话文件路径。 */
export interface TraceInput {
  header: SessionHeader;
  entries: readonly SessionEntry[];
  /** 当前叶子；`undefined` = 最后一条条目，`null` = 空分支。`branch: "all"` 时不用。 */
  leaf?: string | null | undefined;
  /** 写进 `Trace.sessionFile`。 */
  sessionFile?: string;
}

/** 进行中的模型请求（还没有 assistant 条目）。 */
export interface LiveRequest {
  requestAt: number;
  firstTokenAt?: number;
  provider?: string;
  model?: string;
  /** 流式期间估算的输出 token。 */
  outputTokens?: number;
}

/** 正在执行的工具；`parentId` = codemode 外层调用（内层调用）。 */
export interface LiveTool {
  id: string;
  name: string;
  startedAt: number;
  parentId?: string;
}

/** 运行中的叠加层（TUI / RPC 进行中时给；CLI 读文件不给）。 */
export interface LiveOverlay {
  /** 会话正在运行：没有结果的工具算 `running`（否则算 `interrupted`），最后一个回合算进行中。 */
  running: boolean;
  request?: LiveRequest;
  tools?: readonly LiveTool[];
}

export interface BuildTraceOptions {
  /** 缺省 `leaf`。 */
  branch?: "leaf" | "all";
  /** 注入的当前时刻：只在会话头与条目都没有可用时间时作 `startedAt` 兜底；构建器不读时钟。 */
  now?: number;
  /**
   * 读取 ama 子会话（`ama.task.sessionRef.sessionFile`）；返回 undefined 或抛错 → `childMissing`。
   * 不给时子 Agent 只有 `childRef`（懒加载：调用方之后用 `loadSubagentTrace`）。
   */
  loadChild?: (sessionFile: string) => TraceInput | undefined;
  live?: LiveOverlay;
}

/** 所选分支的条目。 */
export function selectTraceEntries(
  input: TraceInput,
  branch: "leaf" | "all" = "leaf",
): SessionEntry[] {
  if (branch === "all") return [...input.entries];
  const leaf = input.leaf === undefined ? (input.entries.at(-1)?.id ?? null) : input.leaf;
  return pathToRoot(indexEntries(input.entries), leaf);
}

/**
 * 从会话条目构建轨迹树。见文件头的性质与算法；选项见 `BuildTraceOptions`。
 */
export function buildTrace(input: TraceInput, opts: BuildTraceOptions = {}): Trace {
  const entries = selectTraceEntries(input, opts.branch ?? "leaf");
  const index = buildIndex(entries);
  const state: ScanState = {
    turns: [],
    aux: [],
    turn: undefined,
    turnModel: undefined,
    model: undefined,
    tools: new Map(),
    resolved: new Set(),
    extraUsage: new Map(),
  };

  const openTurn = (id: string, startedAt: number | undefined, origin?: string): TraceTurnNode => {
    const turn: TraceTurnNode = {
      id,
      kind: "turn",
      status: "ok",
      entryIds: [id],
      steps: [],
      usage: emptyTotals(),
    };
    if (startedAt !== undefined) turn.startedAt = startedAt;
    if (origin !== undefined) turn.origin = origin;
    state.turns.push(turn);
    state.turn = turn;
    state.turnModel = state.model;
    return turn;
  };
  const currentTurn = (entry: SessionEntry, at: number | undefined): TraceTurnNode =>
    state.turn ?? openTurn(entry.id, at);

  for (const entry of entries) {
    const at = entryTime(entry);
    switch (entry.type) {
      case "model_change":
        state.model = `${entry.provider}/${entry.modelId}`;
        break;
      case "message": {
        const m = entry.message;
        if (m.role === "user") {
          if (m.origin === "steer" && state.turn !== undefined) state.turn.entryIds.push(entry.id);
          else openTurn(entry.id, num(m.timestamp) ?? at, m.origin);
        } else if (m.role === "assistant") {
          const turn = currentTurn(entry, num(m.timestamp) ?? at);
          turn.steps.push(assistantStep(entry.id, m, at, turn, state, index));
        } else if (m.role === "toolResult") {
          const tool = state.tools.get(m.toolCallId);
          if (tool === undefined) break;
          state.resolved.add(tool.id);
          tool.entryIds.push(entry.id);
          tool.isError = m.isError === true;
          if (tool.status !== "denied") tool.status = tool.isError ? "error" : "ok";
          if (tool.approx === true) {
            const end = num(m.timestamp) ?? at;
            if (end !== undefined) tool.endedAt = end;
          }
        }
        break;
      }
      case "compaction": {
        const turn = state.turn;
        const node = compactionNode(entry.id, at, index.compactionByEntry.get(entry.id));
        node.tokensBefore = entry.tokensBefore;
        if (turn === undefined) state.aux.push(compactionAsAux(node, entry.usage));
        else {
          turn.steps.push(node);
          if (entry.usage !== undefined) pushUsage(state, turn.id, entry.usage);
        }
        break;
      }
      case "branch_summary":
        if (state.turn !== undefined && entry.usage !== undefined)
          pushUsage(state, state.turn.id, entry.usage);
        break;
      case "usage": {
        const trace = index.auxByUsage.get(entry.id);
        const node: TraceAuxNode = {
          id: entry.id,
          kind: "aux",
          purpose: trace?.data.purpose ?? entry.kind,
          status: "ok",
          entryIds: trace === undefined ? [entry.id] : [entry.id, trace.entryId],
          usage: entry.usage,
        };
        const started = num(trace?.data.startedAt);
        const ended = num(trace?.data.endedAt) ?? at;
        if (started !== undefined) node.startedAt = started;
        if (ended !== undefined) node.endedAt = ended;
        if (started === undefined) node.approx = true;
        state.aux.push(node);
        break;
      }
      case "custom": {
        const data = traceData(entry);
        if (data === undefined || state.turn === undefined) break;
        if (data.kind === "retry_wait") state.turn.steps.push(retryNode(entry.id, data));
        else if (data.kind === "compaction" && typeof data.compactionEntryId !== "string") {
          // 中断的压缩没有 compaction 条目，只有这一条
          state.turn.steps.push(compactionNode(entry.id, at, { data, entryId: entry.id }));
        } else if (data.kind === "step" && typeof data.assistantEntryId !== "string")
          abortedRequest(entry.id, data, state);
        break;
      }
      default:
        break;
    }
  }

  attachTasks(state, index, opts);
  applyLive(state, opts.live);
  return finish(input, state, opts);
}

function attachTasks(state: ScanState, index: Index, opts: BuildTraceOptions): void {
  for (const tool of state.tools.values()) {
    const tasks = index.tasks.get(tool.id);
    if (tasks === undefined) continue;
    for (const { data, entryId } of tasks.values()) {
      const node = subagentNode(data, entryId, opts.live !== undefined);
      const external = index.external.get(data.taskId);
      if (external !== undefined) node.external = externalNodes(data.taskId, external);
      const file = node.childRef?.sessionFile;
      if (opts.loadChild !== undefined && file !== undefined && node.runner === "ama")
        loadSubagentTrace(node, opts.loadChild, opts.now);
      tool.children.push(node);
    }
  }
}

/**
 * 懒加载 ama 子 Agent 的子轨迹（就地写 `node.child` / `node.childMissing`，返回子轨迹）。深度 ≤ 1：
 * 子轨迹里的任务不再展开。外部 runner 或没有会话文件时返回 undefined 且不标缺失。
 */
export function loadSubagentTrace(
  node: TraceSubagentNode,
  loadChild: (sessionFile: string) => TraceInput | undefined,
  now?: number,
): Trace | undefined {
  if (node.child !== undefined) return node.child;
  const file = node.childRef?.sessionFile;
  if (file === undefined || node.runner !== "ama") return undefined;
  let input: TraceInput | undefined;
  try {
    input = loadChild(file);
  } catch {
    input = undefined;
  }
  if (input === undefined) {
    node.childMissing = true;
    return undefined;
  }
  try {
    const child = buildTrace(
      { ...input, sessionFile: input.sessionFile ?? file },
      now === undefined ? {} : { now },
    );
    node.child = child;
    delete node.childMissing;
    return child;
  } catch {
    node.childMissing = true;
    return undefined;
  }
}

function applyLive(state: ScanState, live: LiveOverlay | undefined): void {
  for (const tool of state.tools.values()) {
    if (state.resolved.has(tool.id) || tool.status === "denied") continue;
    tool.status = live?.running === true ? "running" : "interrupted";
  }
  if (live === undefined) return;
  for (const lt of live.tools ?? []) {
    if (lt.parentId !== undefined) {
      const parent = state.tools.get(lt.parentId);
      if (parent === undefined) continue;
      const existing = parent.children.find((c) => c.kind === "subcall" && c.id === lt.id);
      if (existing !== undefined) {
        existing.status = "running";
        delete existing.endedAt;
        continue;
      }
      parent.children.push({
        id: lt.id,
        kind: "subcall",
        name: lt.name,
        parentToolCallId: lt.parentId,
        isError: false,
        status: "running",
        startedAt: lt.startedAt,
        entryIds: [],
      });
      continue;
    }
    const tool = state.tools.get(lt.id);
    if (tool === undefined || state.resolved.has(tool.id)) continue;
    tool.status = "running";
    tool.startedAt = lt.startedAt;
    delete tool.endedAt;
    delete tool.approx;
  }
  const turn = state.turn;
  const request = live.request;
  if (request !== undefined && turn !== undefined) {
    const ref = splitRef(state.model);
    const step: TraceStepNode = {
      id: `live:${request.requestAt}`,
      kind: "step",
      status: "running",
      entryIds: [],
      provider: request.provider ?? ref.provider,
      model: request.model ?? ref.model,
      attempt: 1,
      usage: { ...zeroUsage(), output: request.outputTokens ?? 0 },
      stopReason: "",
      requestAt: request.requestAt,
      startedAt: request.requestAt,
      tools: [],
    };
    if (request.firstTokenAt !== undefined) {
      step.firstTokenAt = request.firstTokenAt;
      step.ttftMs = Math.max(0, request.firstTokenAt - request.requestAt);
    }
    turn.steps.push(step);
  }
  if (live.running && turn !== undefined) turn.status = "running";
}

function finish(input: TraceInput, state: ScanState, opts: BuildTraceOptions): Trace {
  const all = emptyTotals();
  let partial = false;
  let endedAt: number | undefined;
  let duration = 0;
  let timed = false;
  for (const turn of state.turns) {
    const totals = emptyTotals();
    let end: number | undefined;
    let running = turn.status === "running";
    let interrupted = false;
    for (const node of turn.steps) {
      if (node.approx === true) turn.approx = true;
      end = maxDefined(end, node.endedAt);
      if (node.status === "running") running = true;
      if (node.kind !== "step") continue;
      accumulate(totals, node);
      for (const tool of node.tools) {
        totals.toolCalls++;
        if (tool.approx === true) turn.approx = true;
        if (tool.status === "running") running = true;
        if (tool.status === "interrupted") interrupted = true;
        end = maxDefined(end, tool.endedAt);
        for (const child of tool.children) {
          if (child.status === "running") running = running || child.kind === "subcall";
          // 后台任务可能在回合结束后很久才结束，不拉长回合
          if (child.kind === "subcall" || !child.background) end = maxDefined(end, child.endedAt);
        }
      }
    }
    for (const usage of state.extraUsage.get(turn.id) ?? []) accumulate(totals, { usage });
    const last = [...turn.steps].reverse().find((s): s is TraceStepNode => s.kind === "step");
    if (running) {
      turn.status = "running";
      partial = true;
    } else if (interrupted) turn.status = "interrupted";
    else if (last?.status === "aborted") turn.status = "aborted";
    else if (last?.status === "error") turn.status = "error";
    if (!running && end !== undefined) turn.endedAt = Math.max(end, turn.startedAt ?? end);
    if (turn.startedAt !== undefined && turn.endedAt !== undefined) {
      totals.durationMs = turn.endedAt - turn.startedAt;
      duration += totals.durationMs;
      timed = true;
    }
    turn.usage = finishTotals(totals);
    mergeTotals(all, totals);
    endedAt = maxDefined(endedAt, turn.endedAt);
  }
  for (const aux of state.aux) {
    if (aux.usage !== undefined) accumulate(all, { usage: aux.usage });
    endedAt = maxDefined(endedAt, aux.endedAt);
  }
  if (timed) all.durationMs = duration;
  const startedAt =
    entryTime(input.header) ??
    (input.entries[0] !== undefined ? entryTime(input.entries[0]) : undefined) ??
    opts.now ??
    0;
  const trace: Trace = {
    version: 1,
    sessionId: input.header.id,
    cwd: input.header.cwd,
    startedAt,
    totals: finishTotals(all),
    turns: state.turns,
    aux: state.aux,
    partial,
  };
  if (input.sessionFile !== undefined) trace.sessionFile = input.sessionFile;
  if (!partial && endedAt !== undefined) trace.endedAt = endedAt;
  return trace;
}

/** 在轨迹里找任务（子 Agent 节点）；深度优先，先找到的为准。 */
export function findSubagent(trace: Trace, taskId: string): TraceSubagentNode | undefined {
  for (const turn of trace.turns)
    for (const step of turn.steps) {
      if (step.kind !== "step") continue;
      for (const tool of step.tools)
        for (const child of tool.children)
          if (child.kind === "subagent" && child.taskId === taskId) return child;
    }
  return undefined;
}
