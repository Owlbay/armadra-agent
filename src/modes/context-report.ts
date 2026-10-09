/**
 * `/context`：上下文分类明细的报告（line 模式文本与交互模式面板共用）。
 *
 * - 顶部：已用 / 窗口（百分比）、剩余、来源（「usage 实测 X + 估算 Y」或「全量估算」）、自动压缩阈值
 *   （窗口 − 预留，读会话的压缩设置与 `state.autoCompaction`）与档一裁剪起点；
 * - 按类别：系统提示（按节）、工具声明（按工具）、用户消息、助手文本、推理、工具调用参数、工具结果
 *   （按工具名）、附件图片、摘要（压缩 / 分支）、自定义消息；每类 token 估算、占比与条形；
 * - 底部：最大的 N 个工具结果，只有序号、工具名与大小，**绝不显示正文**。
 *
 * 统计只读：取活动分支的投影（与 `getStats().contextTokens` 同一口径），不改请求体、不写条目。
 */

import { AgentSessionImpl } from "../agent/session.js";
import {
  DEFAULT_COMPACTION_SETTINGS,
  effectiveWindow,
  pendingPrefixMessage,
} from "../agent/session-compaction.js";
import type { AgentSession } from "../agent/types.js";
import {
  breakdownMessages,
  largestToolResults,
  type BreakdownEntry,
  type ContextBreakdown,
} from "../compaction/breakdown.js";
import {
  estimateContextTokens,
  estimateProjectedTokens,
  type ContextEstimate,
} from "../compaction/estimate.js";
import { prunePolicy } from "../compaction/prune-tier.js";
import type { CompactionConfig } from "../config/types.js";
import { msg } from "../i18n/index.js";
import { buildProjection } from "../session/projection.js";
import {
  Card,
  KeyValue,
  Meter,
  Text,
  type Component,
  type KeyValueRow,
  type Theme,
} from "../tui.js";
import { Indent, Stack } from "./interactive/panels.js";
import { formatTokenCount, renderRows } from "./session-report.js";

/** 底部列出的工具结果个数。 */
export const CONTEXT_TOP_RESULTS = 5;
/** 每类最多列出的名字（节、工具…）。 */
const MAX_PARTS = 6;

export interface ContextSnapshot {
  breakdown: ContextBreakdown;
  estimate: ContextEstimate;
  /** 首次请求前：系统提示与工具声明按将要发送的那一份估算（与状态栏的启动基线同一口径）。 */
  prefixPending: boolean;
  window: number | undefined;
  /** 0–100（一位小数，封顶 100）；无窗口时 undefined。 */
  percent: number | undefined;
  autoCompaction: boolean;
  /** 档二自动压缩的触发点（窗口 − 预留）；无窗口时 undefined。 */
  compactAt: number | undefined;
  /** 档一裁剪的触发点；无窗口时 undefined。 */
  pruneAt: number | undefined;
}

/** 读会话的当前上下文（只读）。 */
export function contextSnapshot(session: AgentSession): ContextSnapshot {
  let messages = session.messages;
  let estimate: ContextEstimate;
  let compaction: Partial<CompactionConfig> = {};
  let prefixPending = false;
  if (session instanceof AgentSessionImpl) {
    const branch = session.manager.branch();
    const items = buildProjection(branch).items;
    messages = items.map((item) => item.message);
    estimate = estimateProjectedTokens(items, branch);
    compaction = (session.options.compaction ?? {}) as Partial<CompactionConfig>;
    if (!messages.some((message) => "role" in message && message.role === "system")) {
      prefixPending = true;
      messages = [pendingPrefixMessage(session), ...messages];
    }
  } else estimate = estimateContextTokens(messages);
  const stats = session.getStats();
  // 「已用」与状态栏、getStats 同一口径（含启动基线）
  if (stats.contextTokens !== undefined) estimate = { ...estimate, tokens: stats.contextTokens };
  const window = stats.contextWindow;
  const reserve = compaction.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  const soft = effectiveWindow(window, compaction);
  const budget = soft === undefined ? undefined : Math.max(0, soft - reserve);
  const percent =
    window === undefined || window <= 0
      ? undefined
      : Math.min(100, Math.round((estimate.tokens / window) * 1000) / 10);
  return {
    breakdown: breakdownMessages(messages),
    estimate,
    prefixPending,
    window,
    percent,
    autoCompaction: session.state.autoCompaction,
    compactAt: budget,
    pruneAt: budget === undefined ? undefined : prunePolicy(budget, compaction.prune).triggerTokens,
  };
}

function headerRows(snap: ContextSnapshot): KeyValueRow[] {
  const m = msg().report.contextReport;
  const { estimate, window } = snap;
  const rows: KeyValueRow[] = [
    {
      key: m.keyUsed,
      value: m.used(
        formatTokenCount(estimate.tokens),
        window === undefined ? "?" : formatTokenCount(window),
        snap.percent === undefined ? undefined : `${snap.percent.toFixed(1)}%`,
      ),
    },
  ];
  if (window !== undefined)
    rows.push({
      key: m.keyLeft,
      value: m.left(formatTokenCount(Math.max(0, window - estimate.tokens))),
    });
  rows.push({
    key: m.keySource,
    value: snap.prefixPending
      ? m.sourcePrefix
      : estimate.lastUsageIndex === null
        ? m.sourceEstimate
        : m.sourceUsage(
            formatTokenCount(estimate.usageTokens),
            formatTokenCount(estimate.trailingTokens),
          ),
  });
  let auto: string;
  if (!snap.autoCompaction) auto = m.autoCompactOff;
  else if (snap.compactAt === undefined) auto = m.windowUnknown;
  else if (estimate.tokens >= snap.compactAt)
    auto = m.autoCompactReached(formatTokenCount(snap.compactAt));
  else
    auto = m.autoCompact(
      formatTokenCount(snap.compactAt),
      formatTokenCount(snap.compactAt - estimate.tokens),
    );
  rows.push({ key: m.keyAutoCompact, value: auto });
  if (snap.autoCompaction && snap.pruneAt !== undefined)
    rows.push({ key: m.keyPrune, value: m.prune(formatTokenCount(Math.floor(snap.pruneAt))) });
  return rows;
}

function partName(entry: BreakdownEntry, name: string): string {
  const names = msg().report.contextReport.partNames;
  if (entry.category === "summaries" || entry.category === "images")
    return (names as Record<string, string>)[name] ?? name;
  return name;
}

function partsText(entry: BreakdownEntry): string {
  const m = msg().report.contextReport;
  const shown = entry.parts
    .slice(0, MAX_PARTS)
    .map((part) => `${partName(entry, part.name)} ${formatTokenCount(part.tokens)}`);
  if (entry.parts.length > MAX_PARTS) shown.push(m.more(entry.parts.length - MAX_PARTS));
  if (entry.category === "images" && entry.count > 0) shown.unshift(m.images(entry.count));
  return shown.join(" · ");
}

function categoryRows(breakdown: ContextBreakdown, theme: Theme | undefined): KeyValueRow[] {
  const m = msg().report.contextReport;
  const dim = (text: string): string => (theme === undefined ? text : theme.fg("dim", text));
  return breakdown.entries.map((entry) => {
    const ratio = breakdown.total > 0 ? entry.tokens / breakdown.total : undefined;
    // 占比条只表示份额，不按阈值变色
    const meter = new Meter(ratio, { warnAt: 2, dangerAt: 2, ...(theme ? { theme } : {}) });
    const parts = partsText(entry);
    return {
      key: m.categories[entry.category],
      value:
        `${formatTokenCount(entry.tokens).padStart(6)}  ${meter.render(40)[0] ?? ""}` +
        (parts === "" ? "" : `  ${dim(parts)}`),
    };
  });
}

function largestRows(breakdown: ContextBreakdown): KeyValueRow[] {
  return largestToolResults(breakdown, CONTEXT_TOP_RESULTS).map((result) => ({
    key: `#${result.ordinal}`,
    value: `${formatTokenCount(result.tokens).padStart(6)}  ${result.toolName}`,
  }));
}

/** 纯文本（line 模式、无面板时的通知）。 */
export function describeContext(session: AgentSession): string {
  const m = msg().report.contextReport;
  const snap = contextSnapshot(session);
  const { breakdown } = snap;
  const lines = [m.title, ...renderRows(headerRows(snap), "  "), ""];
  lines.push(m.breakdown(formatTokenCount(breakdown.total)));
  lines.push(
    `  ${snap.prefixPending ? m.prefixEstimated : breakdown.hasSystem ? m.prefixCounted : m.prefixPending}`,
  );
  if (breakdown.total === 0) lines.push(`  ${m.empty}`);
  else lines.push(...renderRows(categoryRows(breakdown, undefined), "  "));
  lines.push("", m.largest(CONTEXT_TOP_RESULTS));
  const largest = largestRows(breakdown);
  if (largest.length === 0) lines.push(`  ${m.noToolResults}`);
  else lines.push(...renderRows(largest, "  "));
  return lines.join("\n");
}

/** 交互模式的消息区面板（左竖条卡片）。 */
export function contextPanel(session: AgentSession, theme: Theme): Component {
  const m = msg().report.contextReport;
  const snap = contextSnapshot(session);
  const { breakdown } = snap;
  const table = (rows: readonly KeyValueRow[], wrap = false): Component =>
    new KeyValue(rows, { theme, maxKeyRatio: 0.3, ...(wrap ? { wrap: true } : {}) });
  const largest = largestRows(breakdown);
  const parts: (Component | string)[] = [
    table(headerRows(snap)),
    "",
    theme.bold(m.breakdown(formatTokenCount(breakdown.total))),
    new Indent(
      new Stack([
        new Text(
          theme.fg(
            "dim",
            snap.prefixPending
              ? m.prefixEstimated
              : breakdown.hasSystem
                ? m.prefixCounted
                : m.prefixPending,
          ),
        ),
        breakdown.total === 0
          ? theme.fg("dim", m.empty)
          : table(categoryRows(breakdown, theme), true),
      ]),
      2,
    ),
    "",
    theme.bold(m.largest(CONTEXT_TOP_RESULTS)),
    largest.length === 0
      ? new Indent(new Stack([theme.fg("dim", m.noToolResults)]), 2)
      : new Indent(table(largest), 2),
  ];
  return new Card(new Stack(parts), { theme, title: m.title });
}
