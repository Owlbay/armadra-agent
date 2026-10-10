/**
 * 轨迹行的文本格式（docs/history/wave6-plan.md §2.4）。[W6-T1]
 *
 * 一行：`光标 缩进 折叠符 状态 标签   耗时  ▕████▒▒▒░░▏  ↑in ↓out  缓存%`
 * - 条形是所在回合的相对时间轴：`▒` = TTFT、`█` = 解码、`░` = 工具、`│` = 进行中节点的起点（不编造时长）；
 *   ASCII 或无色（`NO_COLOR`）降级为 `[==..--]`（`.` = TTFT、`=` = 解码、`-` = 工具、`|` = 起点）。
 * - 宽 ≥ 60 显示条形与 token 列；宽 < 60 只留「标签 · 耗时」；40 列可用。
 * - 耗时：精确时间 `2.1s`，推算的加 `≈`（ASCII `~`），进行中 `…`。
 * - ↑ = 提示 token（input + cacheRead + cacheWrite），↓ = 输出 token，缓存% = cacheRead / 提示 token。
 *
 * `formatTraceText` 是 line 模式 `/trace` 的整表输出（无条形、不截断）。标签里来自正文的部分（用户提示预览、
 * 工具参数摘要）由调用方经 `describe` 提供——轨迹本身不含正文。
 */

import type { Usage } from "../ai/types.js";
import { formatDuration, msg } from "../i18n/index.js";
import { formatPercent, formatTokenCount } from "../modes/session-report.js";
import { padToWidth, truncateToWidth, visibleWidth } from "../tui/ansi.js";
import type { SemanticColor, Theme } from "../tui/component.js";
import { cacheHitRatio } from "./build-index.js";
import {
  flattenTrace,
  type TraceNode,
  type TraceRow,
  type TraceRowNode,
  type TraceSpan,
} from "./flatten.js";
import type { Trace, TraceNodeStatus } from "./types.js";

export interface TraceFormatContext {
  theme: Theme;
  /** 来自正文的标签部分：回合 → 用户提示预览，工具 → 参数摘要；没有返回 undefined。 */
  describe?(node: TraceRowNode): string | undefined;
}

/** 宽度低于它时去掉条形与 token 列。 */
export const NARROW_WIDTH = 60;
const DURATION_WIDTH = 7;
const TOKENS_WIDTH = 13;
const CACHE_WIDTH = 4;
/** 缩进上限（深层子 Agent 不把标签挤没）。 */
const MAX_INDENT = 10;

export function barWidth(width: number): number {
  return width >= 100 ? 26 : width >= 80 ? 14 : 10;
}

function plainBars(theme: Theme): boolean {
  return theme.glyphs.ascii || theme.caps.colors === 0;
}

/** 节点耗时文字：精确 `2.1s`、推算 `≈2.1s`、进行中 `…`、没有时间为空。 */
export function durationText(node: TraceRowNode, theme: Theme): string {
  if (node.kind === "more" || node.kind === "aux_group") return "";
  if (node.status === "running") return theme.glyphs.ellipsis;
  if (node.startedAt === undefined || node.endedAt === undefined) return "";
  const text = formatDuration(node.endedAt - node.startedAt, "precise");
  return node.approx === true ? `${theme.glyphs.ascii ? "~" : "≈"}${text}` : text;
}

const STATUS_COLOR: Partial<Record<TraceNodeStatus, SemanticColor>> = {
  error: "error",
  denied: "error",
  aborted: "warning",
  interrupted: "warning",
  retried: "warning",
  running: "accent",
};

/** 状态记号（完成时为空）。 */
export function statusMark(node: TraceRowNode, theme: Theme): string {
  if (node.kind === "more" || node.kind === "aux_group") return "";
  const g = theme.glyphs;
  const mark: Partial<Record<TraceNodeStatus, string>> = {
    error: g.fail,
    denied: g.blocked,
    aborted: g.warn,
    interrupted: g.warn,
    retried: g.retry,
    running: g.spinnerStatic,
  };
  const text = mark[node.status];
  const color = STATUS_COLOR[node.status];
  return text === undefined || color === undefined ? "" : theme.fg(color, text);
}

function usageOf(node: TraceRowNode): Usage | undefined {
  switch (node.kind) {
    case "step":
    case "aux":
    case "subagent":
      return node.usage;
    default:
      return undefined;
  }
}

/** token 列：`↑12k ↓980`（没有用量为空）。 */
export function tokensText(node: TraceRowNode, theme: Theme): string {
  const { arrowUp, arrowDown } = theme.glyphs;
  if (node.kind === "turn") {
    const u = node.usage;
    if (u.requests === 0) return "";
    const prompt = u.input + u.cacheRead + u.cacheWrite;
    return `${arrowUp}${formatTokenCount(prompt)} ${arrowDown}${formatTokenCount(u.output)}`;
  }
  const usage = usageOf(node);
  if (usage === undefined) return "";
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  if (prompt === 0 && usage.output === 0) return "";
  return `${arrowUp}${formatTokenCount(prompt)} ${arrowDown}${formatTokenCount(usage.output)}`;
}

/** 缓存命中列。 */
export function cacheText(node: TraceRowNode): string {
  const ratio = node.kind === "turn" ? node.usage.cacheHitRatio : cacheHitRatio(usageOf(node));
  return ratio === undefined ? "" : formatPercent(ratio);
}

function auxLabel(purpose: string): string {
  const aux = msg().trace.row.aux;
  return purpose === "cache_warm"
    ? aux.cache_warm
    : purpose === "permission_classify"
      ? aux.permission_classify
      : purpose === "compaction"
        ? msg().trace.row.compactionPlain
        : purpose;
}

/** 行标签（不含缩进、折叠符与状态记号）。 */
export function rowLabel(row: TraceRow, ctx: Pick<TraceFormatContext, "describe">): string {
  const m = msg().trace.row;
  const node = row.node;
  const described = ctx.describe?.(node);
  switch (node.kind) {
    case "more":
      return m.more(node.hidden);
    case "aux_group":
      return m.auxGroup(node.nodes.length);
    case "turn": {
      const text = described ?? "";
      const origin = node.origin;
      return origin === undefined || origin === "followUp"
        ? m.turn(row.turn, text).trimEnd()
        : m.turnOrigin(row.turn, origin, text).trimEnd();
    }
    case "step": {
      const base = node.attempt > 1 ? m.stepAttempt(node.model, node.attempt) : m.step(node.model);
      const parts = [base];
      if (node.fallbackFrom !== undefined) parts.push(m.fallback(node.fallbackFrom));
      if (node.ttftMs !== undefined) parts.push(`ttft ${formatDuration(node.ttftMs, "precise")}`);
      if (node.tps !== undefined) parts.push(`${Math.round(node.tps)} tok/s`);
      return parts.join(" · ");
    }
    case "tool":
      return described !== undefined && described !== "" ? `${node.name} ${described}` : node.name;
    case "subcall":
      return described !== undefined && described !== "" ? `${node.name} ${described}` : node.name;
    case "subagent": {
      const base =
        node.runner === "ama" || node.runner === node.agent
          ? m.subagent(node.taskId, node.agent)
          : m.subagentExternal(node.taskId, node.agent, node.runner);
      const parts = [base];
      if (node.background) parts.push(m.background);
      if (node.childMissing === true) parts.push(m.childMissing);
      return parts.join(" · ");
    }
    case "external_turn":
      return m.externalTurn(node.turn, node.toolCount, node.filesTouched);
    case "compaction":
      return node.trigger === undefined ? m.compactionPlain : m.compaction(node.trigger);
    case "retry_wait":
      return m.retryWait(formatDuration(node.delayMs, "precise"), node.attempt);
    case "aux":
      return auxLabel(node.purpose);
  }
}

type Seg = { from: number; to: number; rank: number };
const DECODE = 3;
const TTFT = 2;
const TOOL = 1;
const MARK = 4;

function pushSegments(node: TraceNode, out: Seg[], deep: boolean): void {
  const running = node.status === "running" && node.endedAt === undefined;
  switch (node.kind) {
    case "step": {
      const start = node.requestAt ?? node.startedAt;
      if (start !== undefined) {
        if (node.firstTokenAt !== undefined) {
          out.push({ from: start, to: node.firstTokenAt, rank: TTFT });
          if (node.doneAt !== undefined)
            out.push({ from: node.firstTokenAt, to: node.doneAt, rank: DECODE });
        } else if (node.doneAt !== undefined)
          out.push({ from: start, to: node.doneAt, rank: DECODE });
        if (running) out.push({ from: start, to: start, rank: MARK });
      }
      for (const tool of node.tools) pushSegments(tool, out, false);
      return;
    }
    case "turn":
      for (const child of node.steps) pushSegments(child, out, true);
      return;
    case "retry_wait":
      return;
    default: {
      const start = node.startedAt;
      if (start === undefined) return;
      const rank = node.kind === "compaction" || node.kind === "aux" ? DECODE : TOOL;
      if (running) out.push({ from: start, to: start, rank: MARK });
      else if (node.endedAt !== undefined) out.push({ from: start, to: node.endedAt, rank });
      if (deep && node.kind === "tool")
        for (const child of node.children) pushSegments(child, out, false);
    }
  }
}

/** 条形（含两侧括号，共 `width` 列）；没有时间窗时为空白。 */
export function barText(row: TraceRow, width: number, theme: Theme): string {
  const plain = plainBars(theme);
  const cells = Math.max(1, width - 2);
  const ranks = new Array<number>(cells).fill(0);
  const span: TraceSpan | undefined = row.span;
  const node = row.node;
  if (span !== undefined && node.kind !== "more" && node.kind !== "aux_group") {
    const segs: Seg[] = [];
    pushSegments(node, segs, true);
    const total = Math.max(1, span.end - span.start);
    const cellOf = (t: number): number =>
      Math.min(cells - 1, Math.max(0, Math.floor(((t - span.start) / total) * cells)));
    for (const seg of segs) {
      const a = cellOf(seg.from);
      const b = seg.to > seg.from ? cellOf(seg.to - 1e-6) : a;
      for (let i = a; i <= b; i++) ranks[i] = Math.max(ranks[i] as number, seg.rank);
    }
  }
  const chars = plain ? [" ", "-", ".", "=", "|"] : [" ", "░", "▒", "█", "│"];
  const colors: (SemanticColor | undefined)[] = [undefined, "tool", "muted", "accent", "warning"];
  let body = "";
  for (const rank of ranks) {
    const ch = chars[rank] as string;
    const color = colors[rank];
    body += color === undefined || plain ? ch : theme.fg(color, ch);
  }
  const [open, close] = plain ? ["[", "]"] : ["▕", "▏"];
  return theme.fg("border", open) + body + theme.fg("border", close);
}

function labelPart(row: TraceRow, ctx: TraceFormatContext): string {
  const g = ctx.theme.glyphs;
  const indent = " ".repeat(Math.min(row.depth * 2, MAX_INDENT));
  const fold = row.expandable ? (row.expanded ? g.collapse : g.expand) : " ";
  const mark = statusMark(row.node, ctx.theme);
  const label = rowLabel(row, ctx);
  const styled =
    row.node.kind === "turn"
      ? ctx.theme.bold(label)
      : row.node.kind === "more" || row.node.kind === "aux_group"
        ? ctx.theme.dim(label)
        : label;
  return `${indent}${ctx.theme.fg("dim", fold)} ${mark === "" ? "" : `${mark} `}${styled}`;
}

/** 一行（可见宽恰为 `width`）。`selected` 时行首画光标。 */
export function formatRow(
  row: TraceRow,
  width: number,
  ctx: TraceFormatContext,
  selected = false,
): string {
  const theme = ctx.theme;
  const cursor = selected ? theme.fg("accent", theme.glyphs.prompt) : " ";
  const inner = Math.max(1, width - 1);
  const duration = durationText(row.node, theme).padStart(DURATION_WIDTH);
  let right: string;
  if (width < NARROW_WIDTH) right = ` ${duration}`;
  else {
    const bar = barText(row, barWidth(width), theme);
    const tokens = padToWidth(tokensText(row.node, theme), TOKENS_WIDTH);
    const cache = cacheText(row.node).padStart(CACHE_WIDTH);
    right = ` ${duration} ${bar} ${tokens} ${cache}`;
  }
  const labelWidth = Math.max(1, inner - visibleWidth(right));
  const label = padToWidth(
    truncateToWidth(labelPart(row, ctx), labelWidth, theme.glyphs.ellipsis),
    labelWidth,
  );
  const line = `${cursor}${label}${theme.fg("muted", right)}`;
  return selected && theme.caps.colors >= 256 ? theme.bg("selection", line) : line;
}

/** 顶部汇总：回合 · 请求 · 工具 · 总耗时 · ↑↓ · 缓存 · ttft 分位 · 平均吞吐。 */
export function summaryText(trace: Trace, theme: Theme): string {
  const m = msg().trace;
  const t = trace.totals;
  const parts = [m.summary(trace.turns.length, t.requests, t.toolCalls)];
  if (t.durationMs !== undefined) parts.push(formatDuration(t.durationMs, "precise"));
  if (t.requests > 0) {
    const prompt = t.input + t.cacheRead + t.cacheWrite;
    const { arrowUp, arrowDown } = theme.glyphs;
    parts.push(`${arrowUp}${formatTokenCount(prompt)} ${arrowDown}${formatTokenCount(t.output)}`);
  }
  if (t.cacheHitRatio !== undefined) parts.push(m.cache(formatPercent(t.cacheHitRatio)));
  if (t.ttftP50 !== undefined) {
    const p50 = formatDuration(t.ttftP50, "precise");
    const p90 = t.ttftP90 !== undefined ? ` / p90 ${formatDuration(t.ttftP90, "precise")}` : "";
    parts.push(`ttft p50 ${p50}${p90}`);
  }
  if (t.avgTps !== undefined) parts.push(`${Math.round(t.avgTps)} tok/s`);
  return parts.join(" · ");
}

/** 整表展开（line 模式与测试）：全部节点展开，子调用与子 Agent 也展开。 */
export function expandAll(rows: (expanded: Map<string, boolean>) => TraceRow[]): TraceRow[] {
  const expanded = new Map<string, boolean>();
  for (let guard = 0; guard < 8; guard++) {
    let changed = false;
    for (const row of rows(expanded))
      if (row.expandable && !row.expanded && row.node.kind !== "more") {
        expanded.set(row.key, true);
        changed = true;
      }
    if (!changed) break;
  }
  return rows(expanded);
}

/**
 * line 模式 `/trace` 的文本：标题 + 汇总 + 全部节点（缩进树），每行「标签  耗时  ↑in ↓out  缓存%」，
 * 不画条形、不截断。
 */
export function formatTraceText(
  trace: Trace,
  ctx: TraceFormatContext,
  rows: TraceRow[] = expandAll((expanded) => flattenTrace(trace, { expanded })),
  title = `${msg().trace.title} · ${summaryText(trace, ctx.theme)}`,
): string {
  const theme = ctx.theme;
  const lines = [title];
  if (rows.length === 0) lines.push(msg().trace.empty);
  for (const row of rows) {
    const indent = "  ".repeat(row.depth);
    const mark = statusMark(row.node, theme);
    const cols = [durationText(row.node, theme), tokensText(row.node, theme), cacheText(row.node)]
      .filter((c) => c !== "")
      .join("  ");
    const label = `${indent}${mark === "" ? "" : `${mark} `}${rowLabel(row, ctx)}`;
    lines.push(cols === "" ? label : `${label}  ${cols}`);
  }
  return `${lines.join("\n")}\n`;
}
