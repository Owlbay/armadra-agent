/**
 * 状态栏的上下文项（status-bar.ts 的一部分，单独成文件控制行数）。
 *
 * - full：`Ctx 3.0% 8.2k/272k auto`——百分比一位小数；已用量 / 窗口是绝对量；`auto` = 自动压缩开着
 *   （关闭、熔断或窗口未知时不显示）。成员各自按优先级丢弃：先丢 `auto`、`/窗口`，再丢已用量，百分比最后丢；
 *   会变的数字按最宽形状占位（不抖动）。
 * - compact：`ctx 34%`，≥ 110 列换余量表；0 < 占用 < 1% 时保留一位小数（不显示成 0%）。
 * - 上下文量不是来自 usage（压缩后新 usage 之前、启动前缀基线）时数字前加 `≈`（ASCII `~`）。
 * - 着色：warning 与档一裁剪阈值对齐（`pruneAt / 窗口`，缺省 0.7），≥ 0.9 error。
 * - 流式中：助手消息的 usage 已经给出在途请求的上下文量时，按 ≤ 2 Hz 采样显示它，消息结束后回到统计值。
 */

import type { SessionStats } from "../../agent/types.js";
import type { Usage } from "../../ai/types.js";
import { calculateContextTokens } from "../../compaction/estimate.js";
import { msg } from "../../i18n/index.js";
import { Meter, levelColor, type Theme } from "../../tui.js";
import { contextEstimated } from "../session-report.js";
import { formatTokens, type Part } from "./status-bar.js";

/** 流式 usage 的采样间隔（与 telemetry_tick 同节奏，≤ 2 Hz）。 */
export const LIVE_CTX_INTERVAL_MS = 500;
/** ctx 改用余量表的最小宽度（compact）。 */
const METER_WIDTH = 110;

/** 上下文百分比：full 一位小数；compact 取整，但 0 < p < 1 时保留一位。 */
export function ctxPercentText(percent: number, decimal: boolean): string {
  return decimal || (percent > 0 && percent < 1)
    ? `${percent.toFixed(1)}%`
    : `${Math.round(percent)}%`;
}

/** 上下文着色的 warning 阈值：与档一裁剪阈值对齐（`pruneAt / 窗口`），缺省 0.7。 */
export function ctxWarnAt(stats: Pick<SessionStats, "context" | "contextWindow">): number {
  const at = stats.context?.pruneAt;
  const window = stats.contextWindow;
  return at === undefined || window === undefined || window <= 0 ? 0.7 : Math.min(0.9, at / window);
}

/** 上下文量不是来自 usage（全量估算 / 启动前缀基线）：`≈`（ASCII `~`），否则空串。 */
export function ctxApprox(stats: Pick<SessionStats, "context">, ascii = false): string {
  return contextEstimated(stats) ? (ascii ? "~" : "≈") : "";
}

/** 状态栏上显示的上下文。 */
export interface CtxView {
  tokens: number | undefined;
  window: number | undefined;
  percent: number | undefined;
  approx: string;
  warnAt: number;
  auto: boolean;
}

/** full 本行 Ctx 段各成员的优先级。 */
export interface CtxPriorities {
  ctx: number;
  ctxUsed: number;
  ctxWindow: number;
  ctxAuto: number;
}

/** 在途请求的上下文量（message_update 的 usage）。 */
export class LiveContext {
  private tokens: number | undefined;
  private at = Number.NEGATIVE_INFINITY;

  constructor(private readonly now: () => number) {}

  /** 记下 usage 给出的上下文量；距上次采样 < 500 ms 时不更新。返回是否更新了。 */
  note(usage: Usage | undefined): boolean {
    if (usage === undefined) return false;
    const tokens = calculateContextTokens(usage);
    if (tokens <= 0) return false;
    const now = this.now();
    if (this.tokens !== undefined && now - this.at < LIVE_CTX_INTERVAL_MS) return false;
    this.tokens = tokens;
    this.at = now;
    return true;
  }

  clear(): void {
    this.tokens = undefined;
    this.at = Number.NEGATIVE_INFINITY;
  }

  /** 统计值 → 显示值（有在途值时以它为准，不再是估算）。 */
  view(stats: SessionStats, ascii: boolean): CtxView {
    const view: CtxView = {
      tokens: stats.contextTokens,
      window: stats.contextWindow,
      percent: stats.contextPercent,
      approx: ctxApprox(stats, ascii),
      warnAt: ctxWarnAt(stats),
      auto: stats.context?.autoCompactAt !== undefined,
    };
    const window = stats.contextWindow;
    if (this.tokens !== undefined) {
      view.tokens = this.tokens;
      view.approx = "";
      if (window !== undefined && window > 0)
        view.percent = Math.min(100, Math.round((this.tokens / window) * 1000) / 10);
    }
    return view;
  }
}

/** compact：`ctx 34%`，宽屏换余量表。 */
export function compactCtxText(ctx: CtxView, width: number, theme: Theme): string {
  const { percent } = ctx;
  if (percent === undefined) return theme.fg("dim", "ctx ?");
  if (width >= METER_WIDTH) {
    const meter = new Meter(percent / 100, {
      label: theme.fg("dim", "ctx"),
      theme,
      warnAt: ctx.warnAt,
      percent: (ratio) => ctx.approx + ctxPercentText(ratio * 100, false),
    });
    return meter.render(80)[0] ?? "";
  }
  const color = levelColor(percent / 100, { warnAt: ctx.warnAt });
  return theme.fg("dim", "ctx ") + theme.fg(color, ctx.approx + ctxPercentText(percent, false));
}

/** full：`Ctx 3.0%` + ` 8.2k` + `/272k` + ` auto`（同组 `ctx`，组内不加连接符）。 */
export function fullCtxParts(ctx: CtxView, theme: Theme, p: CtxPriorities): Part[] {
  const dim = (text: string): string => theme.fg("dim", text);
  const out: Part[] = [];
  const add = (text: string, priority: number, reserve?: number): void =>
    void out.push({
      text,
      priority,
      zone: "right",
      group: "ctx",
      ...(reserve === undefined ? {} : { reserve }),
    });
  const { percent } = ctx;
  if (percent === undefined) add(dim("Ctx ?"), p.ctx, 10);
  else {
    const color = levelColor(percent / 100, { warnAt: ctx.warnAt });
    add(dim("Ctx ") + theme.fg(color, ctx.approx + ctxPercentText(percent, true)), p.ctx, 10);
  }
  if (ctx.tokens !== undefined) add(dim(` ${formatTokens(ctx.tokens)}`), p.ctxUsed, 5);
  if (ctx.tokens !== undefined && ctx.window !== undefined)
    add(dim(`/${formatTokens(ctx.window)}`), p.ctxWindow, 5);
  if (ctx.auto) add(dim(` ${msg().interactive.statusLine.autoCompact}`), p.ctxAuto);
  return out;
}
