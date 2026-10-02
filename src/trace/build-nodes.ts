/**
 * 轨迹构建器的节点构造（`build.ts` 用）：step / tool / subcall / compaction / retry_wait / subagent /
 * external_turn。精确时间来自 `ama.trace`，缺失时按条目时间推算并标 `approx`。[W6-T1]
 */

import type { AssistantMessage, Usage } from "../ai/types.js";
import {
  cacheHitRatio,
  isObject,
  num,
  putNum,
  splitRef,
  zeroUsage,
  type Index,
  type ScanState,
  type TaskData,
} from "./build-index.js";
import { statusOfTask } from "./build-util.js";
import {
  type TraceAuxNode,
  type TraceCompactionData,
  type TraceCompactionNode,
  type TraceExternalTurnData,
  type TraceExternalTurnNode,
  type TraceNodeStatus,
  type TraceRetryWaitData,
  type TraceRetryWaitNode,
  type TraceStepData,
  type TraceStepNode,
  type TraceSubagentNode,
  type TraceSubcallNode,
  type TraceToolNode,
  type TraceTurnNode,
} from "./types.js";

export function stepStatus(
  message: AssistantMessage,
  retried: boolean,
  data: TraceStepData | undefined,
): TraceNodeStatus {
  if (retried) return "retried";
  if (data?.status === "aborted" || message.stopReason === "aborted") return "aborted";
  if (message.stopReason === "error") return "error";
  return "ok";
}

export function pushUsage(state: ScanState, turnId: string, usage: Usage): void {
  const list = state.extraUsage.get(turnId) ?? [];
  list.push(usage);
  state.extraUsage.set(turnId, list);
}

export function assistantStep(
  entryId: string,
  m: AssistantMessage,
  at: number | undefined,
  turn: TraceTurnNode,
  state: ScanState,
  index: Index,
): TraceStepNode {
  const trace = index.stepByAssistant.get(entryId);
  const data = trace?.data;
  const previous = [...turn.steps].reverse().find((s): s is TraceStepNode => s.kind === "step");
  const failedBefore =
    previous !== undefined && (previous.status === "retried" || previous.status === "error");
  const ref = `${m.provider}/${m.model}`;
  const step: TraceStepNode = {
    id: entryId,
    kind: "step",
    status: stepStatus(m, index.retried.has(entryId), data),
    entryIds: trace === undefined ? [entryId] : [entryId, trace.entryId],
    provider: m.provider,
    model: m.model,
    attempt: num(data?.attempt) ?? (failedBefore ? (previous?.attempt ?? 0) + 1 : 1),
    usage: m.usage ?? zeroUsage(),
    stopReason: m.stopReason,
    tools: [],
  };
  const fallbackFrom =
    data !== undefined
      ? data.fallbackFrom
      : failedBefore && state.turnModel !== undefined && state.turnModel !== ref
        ? state.turnModel
        : undefined;
  if (fallbackFrom !== undefined) step.fallbackFrom = fallbackFrom;
  if (m.errorMessage !== undefined) step.errorMessage = m.errorMessage;
  if (m.thinkingLevel !== undefined) step.thinkingLevel = m.thinkingLevel;
  const hit = cacheHitRatio(step.usage);
  if (hit !== undefined) step.cacheHitRatio = hit;

  const requestAt = num(data?.requestAt);
  if (data !== undefined && requestAt !== undefined) {
    step.requestAt = requestAt;
    step.startedAt = requestAt;
    const first = num(data.firstTokenAt);
    const done = num(data.doneAt);
    if (first !== undefined) {
      step.firstTokenAt = first;
      step.ttftMs = Math.max(0, first - requestAt);
    }
    if (done !== undefined) {
      step.doneAt = done;
      step.endedAt = done;
    }
    const tps = num(data.tps);
    if (tps !== undefined) step.tps = tps;
  } else {
    // 回退推算：assistant.timestamp ≈ 请求发出，条目时间 ≈ 请求结束
    const start = num(m.timestamp) ?? at;
    const end = at ?? start;
    if (start !== undefined) {
      step.requestAt = start;
      step.startedAt = start;
    }
    if (end !== undefined) {
      step.doneAt = end;
      step.endedAt = end;
    }
    step.approx = true;
  }

  for (const block of m.content ?? []) {
    if (block.type !== "toolCall") continue;
    const tool = toolNode(block.id, block.name, entryId, step, index);
    step.tools.push(tool);
    state.tools.set(tool.id, tool);
  }
  return step;
}

export function toolNode(
  id: string,
  name: string,
  assistantEntryId: string,
  step: TraceStepNode,
  index: Index,
): TraceToolNode {
  const timing = index.toolTiming.get(id);
  const tool: TraceToolNode = {
    id,
    kind: "tool",
    name,
    status: "running",
    isError: false,
    entryIds: [assistantEntryId],
    children: [],
  };
  if (timing !== undefined && num(timing.startedAt) !== undefined) {
    tool.startedAt = timing.startedAt;
    putNum(tool, "endedAt", timing.endedAt);
    putNum(tool, "approvalMs", timing.approvalMs);
    if (timing.denied === true) {
      tool.denied = true;
      tool.status = "denied";
    }
  } else {
    if (step.doneAt !== undefined) tool.startedAt = step.doneAt;
    tool.approx = true;
  }
  for (const { data, entryId } of index.subcalls.get(id) ?? []) {
    const sub: TraceSubcallNode = {
      id: data.id,
      kind: "subcall",
      name: typeof data.name === "string" ? data.name : "",
      parentToolCallId: id,
      isError: data.isError === true,
      status: data.isError === true ? "error" : "ok",
      entryIds: [entryId],
    };
    putNum(sub, "startedAt", data.startedAt);
    putNum(sub, "endedAt", data.endedAt);
    if (sub.endedAt === undefined && data.isError !== true) sub.status = "running";
    tool.children.push(sub);
  }
  return tool;
}

export function compactionNode(
  id: string,
  at: number | undefined,
  trace: { data: TraceCompactionData; entryId: string } | undefined,
): TraceCompactionNode {
  const node: TraceCompactionNode = {
    id,
    kind: "compaction",
    status: trace?.data.aborted === true ? "aborted" : "ok",
    entryIds: trace === undefined || trace.entryId === id ? [id] : [id, trace.entryId],
  };
  const started = num(trace?.data.startedAt);
  const ended = num(trace?.data.endedAt);
  if (trace !== undefined && started !== undefined && ended !== undefined) {
    node.startedAt = started;
    node.endedAt = ended;
  } else if (at !== undefined) {
    node.startedAt = at;
    node.endedAt = at;
    node.approx = true;
  }
  const trigger = trace?.data.trigger;
  if (trigger === "threshold" || trigger === "overflow" || trigger === "manual")
    node.trigger = trigger;
  return node;
}

export function compactionAsAux(node: TraceCompactionNode, usage: Usage | undefined): TraceAuxNode {
  const aux: TraceAuxNode = {
    id: node.id,
    kind: "aux",
    purpose: "compaction",
    status: node.status,
    entryIds: node.entryIds,
  };
  if (node.startedAt !== undefined) aux.startedAt = node.startedAt;
  if (node.endedAt !== undefined) aux.endedAt = node.endedAt;
  if (node.approx === true) aux.approx = true;
  if (usage !== undefined) aux.usage = usage;
  return aux;
}

export function retryNode(id: string, data: TraceRetryWaitData): TraceRetryWaitNode {
  const d = data as Partial<Record<keyof TraceRetryWaitData, unknown>>;
  const delayMs = num(d.delayMs) ?? 0;
  const node: TraceRetryWaitNode = {
    id,
    kind: "retry_wait",
    status: "ok",
    entryIds: [id],
    attempt: num(d.attempt) ?? 0,
    delayMs,
  };
  const started = num(d.startedAt);
  if (started !== undefined) {
    node.startedAt = started;
    node.endedAt = started + delayMs;
  }
  if (typeof d.reason === "string") node.reason = d.reason;
  return node;
}

/** 中断兜底的 step（没有 assistant 条目）：请求在途时补一个 aborted 的 step。 */
export function abortedRequest(entryId: string, data: TraceStepData, state: ScanState): void {
  const requestAt = num(data.requestAt);
  if (requestAt === undefined || state.turn === undefined) return;
  const { provider, model } = splitRef(state.model);
  const step: TraceStepNode = {
    id: entryId,
    kind: "step",
    status: "aborted",
    entryIds: [entryId],
    provider,
    model,
    attempt: num(data.attempt) ?? 1,
    usage: zeroUsage(),
    stopReason: "aborted",
    requestAt,
    startedAt: requestAt,
    tools: [],
  };
  const first = num(data.firstTokenAt);
  if (first !== undefined) {
    step.firstTokenAt = first;
    step.ttftMs = Math.max(0, first - requestAt);
  }
  const done = num(data.doneAt);
  if (done !== undefined) {
    step.doneAt = done;
    step.endedAt = done;
  }
  if (data.fallbackFrom !== undefined) step.fallbackFrom = data.fallbackFrom;
  state.turn.steps.push(step);
}

export function externalNodes(
  taskId: string,
  list: readonly { data: TraceExternalTurnData; entryId: string }[],
): TraceExternalTurnNode[] {
  return list.map(({ data, entryId }) => {
    const node: TraceExternalTurnNode = {
      id: `${taskId}#${num(data.turn) ?? 0}`,
      kind: "external_turn",
      status: /error|fail/i.test(String(data.stopReason))
        ? "error"
        : /abort|cancel/i.test(String(data.stopReason))
          ? "aborted"
          : "ok",
      entryIds: [entryId],
      turn: num(data.turn) ?? 0,
      stopReason: String(data.stopReason ?? ""),
      tools: Array.isArray(data.tools) ? data.tools : [],
      toolCount: num(data.toolCount) ?? 0,
      filesTouched: num(data.filesTouched) ?? 0,
    };
    putNum(node, "startedAt", data.startedAt);
    putNum(node, "endedAt", data.endedAt);
    return node;
  });
}

export function subagentNode(data: TaskData, entryId: string, live: boolean): TraceSubagentNode {
  const node: TraceSubagentNode = {
    id: data.taskId,
    kind: "subagent",
    taskId: data.taskId,
    agent: typeof data.agent === "string" ? data.agent : "",
    runner: typeof data.runner === "string" ? data.runner : "ama",
    background: data.background === true,
    status: statusOfTask(data.status, live),
    entryIds: [entryId],
  };
  putNum(node, "startedAt", data.startedAt);
  putNum(node, "endedAt", data.endedAt);
  if (isObject(data.usage)) node.usage = data.usage;
  putNum(node, "costUsd", data.costUsd);
  putNum(node, "turns", data.turns);
  const ref = data.sessionRef;
  if (isObject(ref) && typeof ref.sessionId === "string") {
    node.childRef = { sessionId: ref.sessionId };
    if (typeof ref.sessionFile === "string") node.childRef.sessionFile = ref.sessionFile;
  }
  return node;
}
