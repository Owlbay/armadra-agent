/**
 * 轨迹树扁平化（docs/wave6-plan.md §2.4）。[W6-T1]
 *
 * 把 `Trace` 按展开状态摊成行数组（列表模型），TUI 只渲染可见窗口、line 模式整表输出。
 * - 行 key 是从根开始的路径（`t:<turnId>/s:<stepId>/x:<toolCallId>/a:<taskId>/…`），刷新后仍稳定，
 *   展开状态与光标都按 key 记。
 * - 缺省展开：回合与请求展开、工具 / 子 Agent / 子调用折叠（子 Agent 展开即懒加载子轨迹，见 `needsChild`）。
 * - 分页：`fromTurn` 之前的回合折成一行「更早的 N 个回合」（尾部优先）；辅助请求（保温 / 分类器 / 回合外的
 *   压缩）在末尾收成一组，缺省折叠。
 * - 每行带所在回合的时间窗 `span`，格式化时据此画条形（同一回合的行共用一个时间轴）。
 */

import type {
  Trace,
  TraceAuxNode,
  TraceCompactionNode,
  TraceExternalTurnNode,
  TraceRetryWaitNode,
  TraceStepNode,
  TraceSubagentNode,
  TraceSubcallNode,
  TraceToolNode,
  TraceTurnNode,
} from "./types.js";

/** 轨迹树里的任一节点。 */
export type TraceNode =
  | TraceTurnNode
  | TraceStepNode
  | TraceCompactionNode
  | TraceRetryWaitNode
  | TraceToolNode
  | TraceSubcallNode
  | TraceSubagentNode
  | TraceExternalTurnNode
  | TraceAuxNode;

/** 分页行：更早的回合。 */
export interface TraceMoreNode {
  kind: "more";
  id: "more";
  hidden: number;
}

/** 末尾的辅助请求组。 */
export interface TraceAuxGroupNode {
  kind: "aux_group";
  id: "aux";
  nodes: readonly TraceAuxNode[];
}

export type TraceRowNode = TraceNode | TraceMoreNode | TraceAuxGroupNode;

export interface TraceSpan {
  start: number;
  end: number;
}

export interface TraceRow {
  /** 路径 key（稳定）。 */
  key: string;
  depth: number;
  node: TraceRowNode;
  /** 所属回合的序号（1 起，按根轨迹计；子轨迹里的行按子轨迹计）；分页 / 辅助组为 0。 */
  turn: number;
  /** 条形的时间窗（所属回合的起止）；没有可用时间时缺省。 */
  span?: TraceSpan;
  expandable: boolean;
  expanded: boolean;
}

export interface FlattenOptions {
  /** 展开状态覆盖（key → 是否展开）；没有的按缺省。 */
  expanded?: ReadonlyMap<string, boolean>;
  /** 从第几个回合开始显示（0 起）；之前的折成一行。缺省 0。 */
  fromTurn?: number;
}

const KEY_CODE: Readonly<Record<TraceNode["kind"], string>> = {
  turn: "t",
  step: "s",
  compaction: "c",
  retry_wait: "w",
  tool: "x",
  subcall: "n",
  subagent: "a",
  external_turn: "e",
  aux: "u",
};

export function rowKey(prefix: string, node: TraceNode): string {
  return `${prefix}${KEY_CODE[node.kind]}:${node.id}`;
}

/** 子节点（子 Agent：已加载的子轨迹的回合，或外部骨架）。 */
export function childrenOf(node: TraceRowNode): readonly TraceNode[] {
  switch (node.kind) {
    case "turn":
      return node.steps;
    case "step":
      return node.tools;
    case "tool":
      return node.children;
    case "subagent":
      return node.child?.turns ?? node.external ?? [];
    case "aux_group":
      return node.nodes;
    default:
      return [];
  }
}

/** ama 子 Agent 有子会话文件但还没加载（展开时由调用方 `loadSubagentTrace`）。 */
export function needsChild(node: TraceRowNode): node is TraceSubagentNode {
  return (
    node.kind === "subagent" &&
    node.runner === "ama" &&
    node.child === undefined &&
    node.childMissing !== true &&
    node.childRef?.sessionFile !== undefined
  );
}

export function isExpandable(node: TraceRowNode): boolean {
  return childrenOf(node).length > 0 || needsChild(node);
}

/** 缺省展开：回合与请求。 */
export function defaultExpanded(node: TraceRowNode): boolean {
  return node.kind === "turn" || node.kind === "step";
}

/** 回合的时间窗：起点 = 回合开始，终点 = 回合结束或已知的最晚时刻（进行中）。 */
export function turnSpan(turn: TraceTurnNode): TraceSpan | undefined {
  const start = turn.startedAt;
  if (start === undefined) return undefined;
  let end = turn.endedAt ?? start;
  const see = (t: number | undefined): void => {
    if (t !== undefined && t > end) end = t;
  };
  for (const node of turn.steps) {
    see(node.startedAt);
    see(node.endedAt);
    if (node.kind !== "step") continue;
    see(node.firstTokenAt);
    for (const tool of node.tools) {
      see(tool.startedAt);
      see(tool.endedAt);
    }
  }
  return { start, end };
}

/** 节点自身的时间窗（子 Agent / 外部回合的子行用）。 */
function nodeSpan(node: TraceNode): TraceSpan | undefined {
  if (node.startedAt === undefined) return undefined;
  return { start: node.startedAt, end: node.endedAt ?? node.startedAt };
}

/** 尾部优先分页的起始回合：最后 `page` 个回合。 */
export function tailStart(trace: Trace, page: number): number {
  return Math.max(0, trace.turns.length - page);
}

interface Walk {
  rows: TraceRow[];
  expanded: ReadonlyMap<string, boolean>;
}

function walk(
  w: Walk,
  node: TraceNode,
  prefix: string,
  depth: number,
  turn: number,
  span: TraceSpan | undefined,
): void {
  const key = rowKey(prefix, node);
  const expandable = isExpandable(node);
  const expanded = expandable && (w.expanded.get(key) ?? defaultExpanded(node));
  const row: TraceRow = { key, depth, node, turn, expandable, expanded };
  if (span !== undefined) row.span = span;
  w.rows.push(row);
  if (!expanded) return;
  const childPrefix = `${key}/`;
  if (node.kind === "subagent") {
    // 子轨迹的回合各用自己的时间窗；外部骨架用子 Agent 的时间窗
    if (node.child !== undefined) {
      node.child.turns.forEach((child, i) =>
        walk(w, child, childPrefix, depth + 1, i + 1, turnSpan(child)),
      );
      return;
    }
    const own = nodeSpan(node) ?? span;
    for (const child of node.external ?? []) walk(w, child, childPrefix, depth + 1, turn, own);
    return;
  }
  for (const child of childrenOf(node)) walk(w, child, childPrefix, depth + 1, turn, span);
}

/** 摊平整棵轨迹（分页 + 展开状态）。 */
export function flattenTrace(trace: Trace, opts: FlattenOptions = {}): TraceRow[] {
  const w: Walk = { rows: [], expanded: opts.expanded ?? new Map() };
  const from = Math.max(0, Math.min(opts.fromTurn ?? 0, trace.turns.length));
  if (from > 0)
    w.rows.push({
      key: "more",
      depth: 0,
      node: { kind: "more", id: "more", hidden: from },
      turn: 0,
      expandable: false,
      expanded: false,
    });
  for (let i = from; i < trace.turns.length; i++) {
    const turn = trace.turns[i] as TraceTurnNode;
    walk(w, turn, "", 0, i + 1, turnSpan(turn));
  }
  if (trace.aux.length > 0) {
    const group: TraceAuxGroupNode = { kind: "aux_group", id: "aux", nodes: trace.aux };
    const expanded = w.expanded.get("aux") ?? false;
    w.rows.push({ key: "aux", depth: 0, node: group, turn: 0, expandable: true, expanded });
    if (expanded) for (const aux of trace.aux) walk(w, aux, "aux/", 1, 0, nodeSpan(aux));
  }
  return w.rows;
}

/** 摊平单个节点的子树（`/trace <任务 id>` 以子 Agent 为根）。 */
export function flattenNode(node: TraceNode, opts: FlattenOptions = {}): TraceRow[] {
  const w: Walk = { rows: [], expanded: opts.expanded ?? new Map() };
  walk(w, node, "", 0, 0, nodeSpan(node));
  return w.rows;
}

/** 按 key 找行下标（没有返回 -1）。 */
export function rowIndex(rows: readonly TraceRow[], key: string): number {
  return rows.findIndex((row) => row.key === key);
}

/** 节点计数（性能测试与 `--format json` 的规模提示用）。 */
export function countNodes(trace: Trace): number {
  let n = trace.aux.length;
  const visit = (node: TraceNode): void => {
    n++;
    if (node.kind === "subagent") {
      if (node.child !== undefined) for (const t of node.child.turns) visit(t);
      else for (const e of node.external ?? []) visit(e);
      return;
    }
    for (const child of childrenOf(node)) visit(child);
  };
  for (const turn of trace.turns) visit(turn);
  return n;
}
