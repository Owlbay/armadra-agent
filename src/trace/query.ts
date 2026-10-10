/**
 * 轨迹查询：RPC `get_trace`、SDK `session.trace()`、`ama sessions trace --json` 共用（docs/history/wave6-plan.md §2.6）。
 * [W6-T2]
 *
 * - **窗口**：在 `Trace.turns` 上切。缺省尾部 `turnLimit`（50，上限 500）个回合；`before`（回合 id）向前翻页；
 *   `since`（条目 id）只返回「受该条目之后的新条目影响」的回合起到末尾——含 `since` 所在回合，以及子树
 *   `entryIds` 引用了新条目的更早回合（后台任务晚到的结束条目会改到旧回合）。`since` 不在所选分支上
 *   （rewind 之后、或未知 id）时从第一个回合起全量返回，与 `get_entries.since` 一致。客户端合并规则：
 *   从返回的第一个回合 id 起替换本地列表的尾部（找不到该 id 就整体替换）。
 * - `totals` 与 `aux` 始终是整条分支的；`turns` 才是窗口。
 * - **脱敏**：结果整棵过 `redactValue`；`content:"preview"` 时附 `previews`（`preview.ts`，先脱敏后截断）。
 * - `taskId`：ama 子会话 → 子轨迹（游标与 `leafId` 都按子会话）；外部 Agent → 空回合的轨迹 + `task.external`
 *   骨架。两种都在 `task` 里回子 Agent 节点本身（不含 `child`，避免重复）。
 * - 错误：`task_not_found`、`invalid_arguments`（英文 message，界面层自己渲染）。
 */

import { AmaError } from "../errors.js";
import { redactValue } from "../session/redact.js";
import type { SessionEntry } from "../session/types.js";
import {
  buildTrace,
  findSubagent,
  loadSubagentTrace,
  selectTraceEntries,
  type LiveOverlay,
  type TraceInput,
} from "./build.js";
import { entryLookup, type TraceEntryLookup } from "./detail.js";
import { childrenOf, type TraceNode } from "./flatten.js";
import { previewKey, previewOf, type TracePreview } from "./preview.js";
import type { Trace, TraceSubagentNode, TraceTurnNode } from "./types.js";

export const TURN_LIMIT_DEFAULT = 50;
export const TURN_LIMIT_MAX = 500;

export interface TraceQuery {
  branch?: "leaf" | "all";
  turnLimit?: number;
  before?: string;
  since?: string;
  taskId?: string;
  content?: "none" | "preview";
}

export interface TraceQueryResult {
  trace: Trace;
  hasMoreBefore: boolean;
  cursor: { before?: string; since: string };
  leafId: string | null;
  /** `taskId` 时：子 Agent 节点本身（不含 `child`）。 */
  task?: TraceSubagentNode;
  /** `content:"preview"` 时：`<kind>:<id>` → 预览（只含窗口内的节点）。 */
  previews?: Record<string, TracePreview>;
}

export interface TraceQueryDeps {
  /** 读子会话（`taskId` 用；缺省时任务的子轨迹标 childMissing）。 */
  loadChild?: (sessionFile: string) => TraceInput | undefined;
  /** 构建时就加载全部 ama 子会话（`sessions trace --json`；RPC 不加载，按 `taskId` 取）。 */
  loadChildren?: boolean;
  /** 不分页：返回全部回合（`sessions trace --json`）。 */
  unlimited?: boolean;
  live?: LiveOverlay;
  now?: number;
}

function invalid(message: string): never {
  throw new AmaError("invalid_arguments", message);
}

/** 校验参数（RPC 的 JSON 可能是任意形状）。 */
export function checkTraceQuery(
  q: TraceQuery,
): Required<Pick<TraceQuery, "branch" | "turnLimit" | "content">> {
  const branch = q.branch ?? "leaf";
  if (branch !== "leaf" && branch !== "all") invalid("branch must be leaf | all");
  const content = q.content ?? "none";
  if (content !== "none" && content !== "preview") invalid("content must be none | preview");
  const turnLimit = q.turnLimit ?? TURN_LIMIT_DEFAULT;
  if (!Number.isInteger(turnLimit) || turnLimit < 1 || turnLimit > TURN_LIMIT_MAX)
    invalid(`turnLimit must be an integer in 1..${TURN_LIMIT_MAX}`);
  for (const key of ["before", "since", "taskId"] as const) {
    const value = q[key];
    if (value !== undefined && (typeof value !== "string" || value === ""))
      invalid(`${key} must be a non-empty string`);
  }
  if (q.before !== undefined && q.since !== undefined) invalid("before and since are exclusive");
  return { branch, turnLimit, content };
}

/** 回合子树引用的条目 id（不进子 Agent 的子轨迹：那是另一个会话的条目）。 */
function subtreeEntryIds(node: TraceNode, out: Set<string>): void {
  for (const id of node.entryIds) out.add(id);
  if (node.kind === "subagent") return;
  for (const child of childrenOf(node)) subtreeEntryIds(child, out);
}

/** `since` 的起始回合下标。 */
function sinceStart(
  turns: readonly TraceTurnNode[],
  entries: readonly SessionEntry[],
  since: string,
): number {
  const at = entries.findIndex((e) => e.id === since);
  if (at < 0) return 0;
  const position = new Map(entries.map((e, i) => [e.id, i]));
  const fresh = new Set(entries.slice(at + 1).map((e) => e.id));
  let start = turns.length;
  turns.forEach((turn, i) => {
    if ((position.get(turn.id) ?? Infinity) <= at) start = i;
  });
  if (start === turns.length) start = 0;
  if (fresh.size === 0) return start;
  for (let i = 0; i < start; i++) {
    const ids = new Set<string>();
    subtreeEntryIds(turns[i] as TraceTurnNode, ids);
    if ([...ids].some((id) => fresh.has(id))) return i;
  }
  return start;
}

interface Window {
  start: number;
  end: number;
}

function windowOf(
  trace: Trace,
  entries: readonly SessionEntry[],
  q: TraceQuery,
  turnLimit: number,
): Window {
  const n = trace.turns.length;
  if (q.since !== undefined) return { start: sinceStart(trace.turns, entries, q.since), end: n };
  let end = n;
  if (q.before !== undefined) {
    end = trace.turns.findIndex((t) => t.id === q.before);
    if (end < 0) invalid(`before ${q.before} is not a turn id on this branch`);
  }
  return { start: Math.max(0, end - turnLimit), end };
}

function emptyTrace(parent: Trace, node: TraceSubagentNode): Trace {
  const trace: Trace = {
    version: 1,
    sessionId: node.childRef?.sessionId ?? node.taskId,
    cwd: parent.cwd,
    startedAt: node.startedAt ?? parent.startedAt,
    totals: {
      requests: 0,
      input: node.usage?.input ?? 0,
      output: node.usage?.output ?? 0,
      cacheRead: node.usage?.cacheRead ?? 0,
      cacheWrite: node.usage?.cacheWrite ?? 0,
      toolCalls: (node.external ?? []).reduce((n, t) => n + t.toolCount, 0),
      ...(node.costUsd !== undefined ? { cost: node.costUsd } : {}),
    },
    turns: [],
    aux: [],
    partial: node.status === "running",
  };
  if (node.endedAt !== undefined) trace.endedAt = node.endedAt;
  return trace;
}

function collectPreviews(
  nodes: readonly TraceNode[],
  lookup: TraceEntryLookup,
): Record<string, TracePreview> {
  const out: Record<string, TracePreview> = {};
  const visit = (node: TraceNode): void => {
    const p = previewOf(node, lookup);
    if (p !== undefined) out[previewKey(node)] = p;
    if (node.kind === "subagent") return;
    for (const child of childrenOf(node)) visit(child);
  };
  for (const node of nodes) visit(node);
  return out;
}

/** 构建 + 切窗口 + 脱敏。 */
export function queryTrace(
  input: TraceInput,
  q: TraceQuery = {},
  deps: TraceQueryDeps = {},
): TraceQueryResult {
  const { branch, turnLimit, content } = checkTraceQuery(q);
  const base = {
    ...(deps.live !== undefined ? { live: deps.live } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  };
  const eager = deps.loadChildren === true && deps.loadChild !== undefined;
  let trace = buildTrace(input, {
    branch,
    ...base,
    ...(eager ? { loadChild: deps.loadChild } : {}),
  });
  let source: TraceInput = input;
  let sourceBranch = branch;
  let task: TraceSubagentNode | undefined;
  if (q.taskId !== undefined) {
    const node = findSubagent(trace, q.taskId);
    if (node === undefined)
      throw new AmaError("task_not_found", `no task ${q.taskId} in this session`);
    const loadChild = deps.loadChild ?? (() => undefined);
    const child = loadSubagentTrace(node, loadChild, deps.now);
    const file = node.childRef?.sessionFile;
    const childInput = child !== undefined && file !== undefined ? loadChild(file) : undefined;
    const { child: _omit, ...rest } = node;
    task = rest;
    if (child !== undefined && childInput !== undefined) {
      trace = child;
      source = childInput;
      sourceBranch = "leaf";
    } else {
      trace = emptyTrace(trace, node);
      source = { ...input, entries: [] };
    }
  }
  const entries = selectTraceEntries(source, sourceBranch);
  const { start, end } = windowOf(
    trace,
    entries,
    q,
    deps.unlimited === true ? Infinity : turnLimit,
  );
  const turns = trace.turns.slice(start, end);
  const leafId =
    source.entries.length === 0
      ? null
      : source.leaf === undefined
        ? (source.entries.at(-1)?.id ?? null)
        : source.leaf;
  const result: TraceQueryResult = {
    trace: { ...trace, turns },
    hasMoreBefore: start > 0,
    cursor: {
      ...(start > 0 && turns[0] !== undefined ? { before: turns[0].id } : {}),
      since: entries.at(-1)?.id ?? "",
    },
    leafId,
  };
  if (task !== undefined) result.task = task;
  if (content === "preview")
    result.previews = collectPreviews(turns, entryLookup(source.entries, source.header.cwd));
  return redactValue(result);
}
