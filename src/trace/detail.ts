/**
 * 轨迹节点的正文预览与详情卡片（docs/history/wave6-plan.md §2.4：Enter 详情——概要 / 用量与缓存 / 参数与结果预览）。
 * [W6-T1]
 *
 * 轨迹树不含正文；这里按节点的 `entryIds` 回会话条目取：回合 → 用户提示，请求 → 助手文字，工具 → 参数
 * （JSON，截到 500 字符）与结果（截到 2000 字符），与 `sessions export --format md` 同一截断口径。
 * 只给本机界面用（TUI 详情、line 模式标签）；HTML / RPC 的预览由 W6-T2 另行脱敏。
 */

import { formatDuration, msg } from "../i18n/index.js";
import { formatPercent, formatTokenCount, formatUsd } from "../modes/session-report.js";
import { toolSummary } from "../modes/interactive/tool-summary.js";
import { contentText } from "../session/reuse.js";
import type { SessionEntry } from "../session/types.js";
import { padToWidth, visibleWidth, wrapTextWithAnsi } from "../tui/ansi.js";
import type { Theme } from "../tui/component.js";
import type { TraceRowNode } from "./flatten.js";
import { durationText } from "./format.js";

/** 参数预览上限（字符）。 */
export const ARGS_PREVIEW_MAX = 500;
/** 结果 / 提示 / 输出预览上限（字符）。 */
export const RESULT_PREVIEW_MAX = 2000;
/** 行内标签里的提示预览上限（字符）。 */
const LABEL_PREVIEW_MAX = 80;

export interface TraceEntryLookup {
  entry(id: string): SessionEntry | undefined;
  /** 工具参数里的路径相对它显示。 */
  cwd?: string;
}

/** 由条目数组建查找表。 */
export function entryLookup(entries: readonly SessionEntry[], cwd?: string): TraceEntryLookup {
  const map = new Map<string, SessionEntry>();
  for (const entry of entries) map.set(entry.id, entry);
  return { entry: (id) => map.get(id), ...(cwd !== undefined ? { cwd } : {}) };
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function truncate(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max)}\n${msg().trace.detail.truncated(text.length)}`
    : text;
}

function messageOf(lookup: TraceEntryLookup, id: string | undefined) {
  const entry = id === undefined ? undefined : lookup.entry(id);
  return entry?.type === "message" ? entry.message : undefined;
}

function toolArgs(lookup: TraceEntryLookup, node: TraceRowNode): unknown {
  if (node.kind !== "tool") return undefined;
  const m = messageOf(lookup, node.entryIds[0]);
  if (m?.role !== "assistant") return undefined;
  for (const block of m.content)
    if (block.type === "toolCall" && block.id === node.id) return block.arguments;
  return undefined;
}

/** 行标签里来自正文的部分：回合 → 提示预览，工具 → 参数摘要。 */
export function describeNode(node: TraceRowNode, lookup: TraceEntryLookup): string | undefined {
  if (node.kind === "turn") {
    const m = messageOf(lookup, node.id);
    return m?.role === "user" ? oneLine(contentText(m.content), LABEL_PREVIEW_MAX) : undefined;
  }
  if (node.kind === "tool") {
    const summary = toolSummary(node.name, toolArgs(lookup, node), lookup.cwd);
    return summary === "" ? undefined : oneLine(summary, LABEL_PREVIEW_MAX);
  }
  return undefined;
}

/** 详情里的两段预览（标题 → 正文）。 */
export function nodePreviews(
  node: TraceRowNode,
  lookup: TraceEntryLookup,
): { title: string; text: string }[] {
  const d = msg().trace.detail;
  const out: { title: string; text: string }[] = [];
  if (node.kind === "turn") {
    const m = messageOf(lookup, node.id);
    if (m?.role === "user")
      out.push({ title: d.input, text: truncate(contentText(m.content), RESULT_PREVIEW_MAX) });
  } else if (node.kind === "step") {
    const m = messageOf(lookup, node.id);
    if (m?.role === "assistant") {
      const text = m.content
        .flatMap((b) => (b.type === "text" && b.text.trim() !== "" ? [b.text] : []))
        .join("\n");
      if (text !== "") out.push({ title: d.output, text: truncate(text, RESULT_PREVIEW_MAX) });
    }
  } else if (node.kind === "tool") {
    const args = toolArgs(lookup, node);
    if (args !== undefined)
      out.push({ title: d.args, text: truncate(JSON.stringify(args, null, 2), ARGS_PREVIEW_MAX) });
    const r = messageOf(lookup, node.entryIds[1]);
    if (r?.role === "toolResult")
      out.push({ title: d.result, text: truncate(contentText(r.content), RESULT_PREVIEW_MAX) });
  }
  return out;
}

type Row = [label: string, value: string];

function usageRows(
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined,
  cost: number | undefined,
): Row[] {
  const d = msg().trace.detail;
  if (usage === undefined) return [];
  const t = formatTokenCount;
  const rows: Row[] = [
    [
      d.usage,
      d.usageValue(t(usage.input), t(usage.output), t(usage.cacheRead), t(usage.cacheWrite)),
    ],
  ];
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  if (prompt > 0) rows.push([d.cacheHit, formatPercent(usage.cacheRead / prompt)]);
  if (cost !== undefined) rows.push([d.cost, formatUsd(cost)]);
  return rows;
}

/** 概要与用量两组键值行。 */
export function summaryRows(node: TraceRowNode, theme: Theme, traceStart: number): Row[] {
  const d = msg().trace.detail;
  if (node.kind === "more" || node.kind === "aux_group") return [];
  const rows: Row[] = [
    [d.kind, node.kind],
    [d.status, msg().trace.status[node.status]],
  ];
  if (node.startedAt !== undefined)
    rows.push([d.start, `+${formatDuration(Math.max(0, node.startedAt - traceStart), "precise")}`]);
  const duration = durationText(node, theme);
  if (duration !== "") rows.push([d.duration, duration]);
  if (node.approx === true) rows.push([d.approx, d.approxValue]);
  switch (node.kind) {
    case "turn":
      if (node.origin !== undefined) rows.push([d.origin, node.origin]);
      rows.push(...usageRows(node.usage, node.usage.cost));
      break;
    case "step":
      rows.push([d.model, `${node.provider}/${node.model}`], [d.attempt, String(node.attempt)]);
      if (node.fallbackFrom !== undefined) rows.push([d.fallbackFrom, node.fallbackFrom]);
      if (node.ttftMs !== undefined) rows.push([d.ttft, formatDuration(node.ttftMs, "precise")]);
      if (node.tps !== undefined) rows.push([d.tps, `${node.tps} tok/s`]);
      if (node.thinkingLevel !== undefined) rows.push([d.thinking, node.thinkingLevel]);
      if (node.stopReason !== "") rows.push([d.stopReason, node.stopReason]);
      if (node.errorMessage !== undefined) rows.push([d.error, node.errorMessage]);
      rows.push(...usageRows(node.usage, node.usage.cost?.total));
      break;
    case "tool":
      if (node.approvalMs !== undefined)
        rows.push([d.approval, formatDuration(node.approvalMs, "precise")]);
      if (node.denied === true) rows.push([d.denied, d.yes]);
      break;
    case "subagent":
      rows.push([d.task, `${node.taskId} ${node.agent}`], [d.runner, node.runner]);
      if (node.background) rows.push([d.background, d.yes]);
      if (node.turns !== undefined) rows.push([d.turns, String(node.turns)]);
      rows.push(...usageRows(node.usage, node.costUsd));
      if (node.childRef?.sessionFile !== undefined)
        rows.push([d.childFile, node.childRef.sessionFile]);
      if (node.childMissing === true) rows.push([d.childFile, d.childMissing]);
      break;
    case "external_turn":
      rows.push([d.stopReason, node.stopReason], [d.files, String(node.filesTouched)]);
      if (node.tools.length > 0)
        rows.push([d.tools, node.tools.map((t) => `${t.kind}:${t.status}`).join(" ")]);
      break;
    case "retry_wait":
      if (node.reason !== undefined) rows.push([d.reason, node.reason]);
      break;
    case "compaction":
      if (node.tokensBefore !== undefined)
        rows.push([d.usage, formatTokenCount(node.tokensBefore)]);
      break;
    case "aux":
      rows.push(...usageRows(node.usage, node.usage?.cost?.total));
      break;
    default:
      break;
  }
  return rows;
}

/** 详情卡片的行（不含标题与边框；宽度内折行）。 */
export function detailLines(
  node: TraceRowNode,
  lookup: TraceEntryLookup,
  width: number,
  theme: Theme,
  traceStart: number,
): string[] {
  const rows = summaryRows(node, theme, traceStart);
  // 键列宽取最长的键（en 的 Waiting for approval 比 16 列宽，封顶会让这一行错位）
  const labelWidth = Math.max(0, ...rows.map(([label]) => visibleWidth(label)));
  const out: string[] = [];
  const valueWidth = Math.max(8, width - labelWidth - 2);
  for (const [label, value] of rows) {
    const wrapped = wrapTextWithAnsi(value, valueWidth);
    wrapped.forEach((line, i) =>
      out.push(
        `${i === 0 ? theme.fg("muted", padToWidth(label, labelWidth)) : " ".repeat(labelWidth)}  ${line}`,
      ),
    );
  }
  for (const preview of nodePreviews(node, lookup)) {
    out.push("", theme.bold(preview.title));
    for (const line of preview.text.split("\n"))
      out.push(...wrapTextWithAnsi(line, Math.max(8, width)));
  }
  return out;
}
