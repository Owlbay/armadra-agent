/**
 * 轨迹构建器的索引与扫描状态（`build.ts` 用）。[W6-T1]
 *
 * 预建索引：`ama.trace` 按 assistant / toolCall / compaction / usage 条目 id，`ama.task` 按父 toolCallId（同一
 * taskId 取分支上最后一条），`external_turn` 按 taskId，`context_edit{retry|overflow}` 的目标。
 */

import type { Usage } from "../ai/types.js";
import type { SessionEntry } from "../session/types.js";
import {
  TRACE_CUSTOM_TYPE,
  type TraceAuxData,
  type TraceAuxNode,
  type TraceCompactionData,
  type TraceEntryData,
  type TraceExternalTurnData,
  type TraceStepData,
  type TraceSubcallTiming,
  type TraceToolNode,
  type TraceToolTiming,
  type TraceTurnNode,
} from "./types.js";

/** 父会话 `ama.task` 的 customType（与 agents/task-record.ts 相同；这里不 import 运行时模块）。 */
export const TASK_CUSTOM_TYPE = "ama.task";

/** 父会话里一个任务的最后一条快照（`TaskInfo + parentToolCallId`）。 */
export interface TaskData {
  taskId: string;
  agent?: string;
  runner?: string;
  background?: boolean;
  status?: string;
  startedAt?: number;
  endedAt?: number;
  turns?: number;
  usage?: Usage;
  costUsd?: number;
  parentToolCallId?: string;
  sessionRef?: { runner?: string; sessionId?: string; sessionFile?: string };
}

export interface Index {
  stepByAssistant: Map<string, { data: TraceStepData; entryId: string }>;
  toolTiming: Map<string, TraceToolTiming>;
  subcalls: Map<string, { data: TraceSubcallTiming; entryId: string }[]>;
  compactionByEntry: Map<string, { data: TraceCompactionData; entryId: string }>;
  auxByUsage: Map<string, { data: TraceAuxData; entryId: string }>;
  external: Map<string, { data: TraceExternalTurnData; entryId: string }[]>;
  /** 父 toolCallId → taskId → 最后一条快照。 */
  tasks: Map<string, Map<string, { data: TaskData; entryId: string }>>;
  /** 被 context_edit{retry|overflow} 剔除的 assistant。 */
  retried: Set<string>;
}

export interface ScanState {
  turns: TraceTurnNode[];
  aux: TraceAuxNode[];
  turn: TraceTurnNode | undefined;
  /** 回合开始时的模型（推算回退用）。 */
  turnModel: string | undefined;
  model: string | undefined;
  tools: Map<string, TraceToolNode>;
  /** 有 toolResult 的调用。 */
  resolved: Set<string>;
  /** 回合 id → 压缩 / 分支摘要等不属于 step 的用量。 */
  extraUsage: Map<string, Usage[]>;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** ISO 时间 → epoch ms；不合法返回 undefined。 */
export function entryTime(entry: { timestamp: string }): number | undefined {
  const t = Date.parse(entry.timestamp);
  return Number.isFinite(t) ? t : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 是有限数字时写入 `target[key]`。 */
export function putNum<T extends object>(target: T, key: keyof T, value: unknown): void {
  const v = num(value);
  if (v !== undefined) (target as Record<keyof T, unknown>)[key] = v;
}

/** `ama.trace` 的 data（形状不对返回 undefined）。 */
export function traceData(entry: SessionEntry): TraceEntryData | undefined {
  if (entry.type !== "custom" || entry.customType !== TRACE_CUSTOM_TYPE) return undefined;
  const data = entry.data;
  return isObject(data) && typeof data["kind"] === "string"
    ? (data as unknown as TraceEntryData)
    : undefined;
}

/** [ME-A] fork 式子会话从父复制来的条目（首条 `ama.task{context:"fork"}` 之后到 forkedFrom 为止）。 */
function forkInherited(entries: readonly SessionEntry[]): Set<string> {
  const head = entries[0];
  const data = head?.type === "custom" && head.customType === TASK_CUSTOM_TYPE ? head.data : {};
  if (!isObject(data) || data["context"] !== "fork" || typeof data["forkedFrom"] !== "string")
    return new Set();
  const end = entries.findIndex((entry) => entry.id === data["forkedFrom"]);
  return new Set(entries.slice(1, end + 1).map((entry) => entry.id));
}

export function buildIndex(entries: readonly SessionEntry[]): Index {
  const inherited = forkInherited(entries);
  const index: Index = {
    stepByAssistant: new Map(),
    toolTiming: new Map(),
    subcalls: new Map(),
    compactionByEntry: new Map(),
    auxByUsage: new Map(),
    external: new Map(),
    tasks: new Map(),
    retried: new Set(),
  };
  for (const entry of entries) {
    if (entry.type === "context_edit") {
      if (entry.reason === "retry" || entry.reason === "overflow")
        index.retried.add(entry.targetId);
      continue;
    }
    if (entry.type === "custom" && entry.customType === TASK_CUSTOM_TYPE) {
      const data = entry.data;
      // 子会话自己的首条没有 status，不是父会话的快照；fork 继承来的父快照也不算
      if (!isObject(data) || typeof data["taskId"] !== "string" || data["status"] === undefined)
        continue;
      if (inherited.has(entry.id)) continue;
      const parent = typeof data["parentToolCallId"] === "string" ? data["parentToolCallId"] : "";
      const byTask = index.tasks.get(parent) ?? new Map();
      byTask.set(data["taskId"], { data: data as unknown as TaskData, entryId: entry.id });
      index.tasks.set(parent, byTask);
      continue;
    }
    const data = traceData(entry);
    if (data === undefined) continue;
    switch (data.kind) {
      case "step": {
        if (typeof data.assistantEntryId === "string")
          index.stepByAssistant.set(data.assistantEntryId, { data, entryId: entry.id });
        for (const tool of Array.isArray(data.tools) ? data.tools : []) {
          if (!isObject(tool) || typeof tool.id !== "string") continue;
          const known = index.toolTiming.get(tool.id);
          // 同一调用出现两次（中断兜底 + 正常）时留有结束时间的那条
          if (known === undefined || (known.endedAt === undefined && tool.endedAt !== undefined))
            index.toolTiming.set(tool.id, tool);
        }
        for (const sub of Array.isArray(data.subcalls) ? data.subcalls : []) {
          if (!isObject(sub) || typeof sub.id !== "string" || typeof sub.parentId !== "string")
            continue;
          const list = index.subcalls.get(sub.parentId) ?? [];
          if (!list.some((s) => s.data.id === sub.id)) list.push({ data: sub, entryId: entry.id });
          index.subcalls.set(sub.parentId, list);
        }
        break;
      }
      case "compaction":
        if (typeof data.compactionEntryId === "string")
          index.compactionByEntry.set(data.compactionEntryId, { data, entryId: entry.id });
        break;
      case "aux":
        if (typeof data.usageEntryId === "string")
          index.auxByUsage.set(data.usageEntryId, { data, entryId: entry.id });
        break;
      case "external_turn":
        if (typeof data.taskId === "string") {
          const list = index.external.get(data.taskId) ?? [];
          list.push({ data, entryId: entry.id });
          index.external.set(data.taskId, list);
        }
        break;
      default:
        break;
    }
  }
  return index;
}

export function zeroUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

/** cacheRead / (input + cacheRead + cacheWrite)；分母为 0 时 undefined。 */
export function cacheHitRatio(usage: Usage | undefined): number | undefined {
  if (usage === undefined) return undefined;
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  return prompt > 0 ? usage.cacheRead / prompt : undefined;
}

export function splitRef(ref: string | undefined): { provider: string; model: string } {
  if (ref === undefined) return { provider: "", model: "" };
  const at = ref.indexOf("/");
  return at < 0
    ? { provider: "", model: ref }
    : { provider: ref.slice(0, at), model: ref.slice(at + 1) };
}
