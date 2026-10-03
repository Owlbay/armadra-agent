/**
 * 订阅配额行（full 布局第三行，状态栏下方；compact 只在行尾追加一个短项）。[W6]
 *
 * ```text
 * Session: 10.0% | Reset: 2h 18m | Weekly: 31.0% | Weekly Reset: 6d 5h      ≥ 80 列
 * 5h 10% ↻2h18m · wk 31% ↻6d5h                                              < 80 列
 * ```
 *
 * - 数据：会话的 `quota_update`（codex flavor 的 `x-codex-primary/secondary-*` 头、`codex.rate_limits` 事件；
 *   SIWC 只有 429）。primary = 5 小时窗口、secondary = 周窗口；窗口长度不是 5 h / 7 d 时标签换成实际时长。
 * - 只在当前模型走 ChatGPT 订阅（compat `chatgptBackend`）时出现；codex flavor 还没有数据时显示
 *   「配额：首次请求后显示」（第一次请求就会带回配额，先占住行免得行数跳动），SIWC 没有数据时不占行
 *   （只有超限才有配额，占位会一直挂着误导）。
 * - 着色：标签与分隔 dim；百分比按阈值（≥ 70% warning、≥ 90% error，否则 success）；重置时间 `tool`（紫）。
 * - 重置时间是相对时长（`2h 18m`、`6d 5h`），按渲染时刻算；StatusArea 每分钟重画一次。
 */

import { msg } from "../../i18n/index.js";
import type { QuotaUpdateEvent, QuotaWindow } from "../../agent/types-w6.js";
import type { StatusLineMode } from "../../config/types.js";
import {
  levelColor,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Theme,
} from "../../tui.js";
import { layoutRow, type Part } from "./status-bar.js";

/** 配额行的数据：有数据 / 等首次请求 / 不显示（undefined）。 */
export type QuotaView = { quota: QuotaUpdateEvent } | "pending" | undefined;

/** 第三行改用短格式的宽度。 */
export const QUOTA_NARROW_WIDTH = 80;

const FIVE_HOURS = 300;
const WEEK = 10_080;

/** 距重置：`6d 5h` / `2h 18m` / `18m`（已过或不足一分钟 `0m`）；`tight` 去掉空格。 */
export function formatRemaining(ms: number, tight = false): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const sep = tight ? "" : " ";
  if (days > 0) return `${days}d${sep}${hours}h`;
  if (hours > 0) return `${hours}h${sep}${minutes % 60}m`;
  return `${minutes}m`;
}

/** 窗口长度的紧凑写法（标签用）：`5h`、`7d`、`90m`。 */
function windowSpan(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.round(minutes)}m`;
}

function labels(w: QuotaWindow, which: "primary" | "secondary"): { pct: string; reset: string } {
  const m = msg().interactive.statusLine.quota;
  const minutes = w.windowMinutes;
  const standard = minutes === undefined || minutes === (which === "primary" ? FIVE_HOURS : WEEK);
  if (!standard)
    return { pct: m.window(windowSpan(minutes)), reset: m.windowReset(windowSpan(minutes)) };
  return which === "primary"
    ? { pct: m.session, reset: m.reset }
    : { pct: m.weekly, reset: m.weeklyReset };
}

function shortLabel(w: QuotaWindow, which: "primary" | "secondary"): string {
  const m = msg().interactive.statusLine.quota;
  const minutes = w.windowMinutes;
  if (minutes === FIVE_HOURS || (minutes === undefined && which === "primary")) return m.short5h;
  if (minutes === WEEK || (minutes === undefined && which === "secondary")) return m.shortWeek;
  return windowSpan(minutes!);
}

function percent(theme: Theme, used: number, decimal: boolean): string {
  return theme.fg(levelColor(used / 100), decimal ? `${used.toFixed(1)}%` : `${Math.round(used)}%`);
}

function windows(quota: QuotaUpdateEvent): ["primary" | "secondary", QuotaWindow][] {
  const out: ["primary" | "secondary", QuotaWindow][] = [];
  if (quota.primary !== undefined) out.push(["primary", quota.primary]);
  if (quota.secondary !== undefined) out.push(["secondary", quota.secondary]);
  return out;
}

/** compact 行尾的短项 `5h 10% wk 31%`（项内只用空格，不含 ` · `，宿主解析不受影响）。 */
export function compactQuotaItem(quota: QuotaUpdateEvent, theme: Theme): string | undefined {
  const dim = (text: string): string => theme.fg("dim", text);
  const items = windows(quota).map(
    ([which, w]) => `${dim(shortLabel(w, which))} ${percent(theme, w.usedPercent, false)}`,
  );
  return items.length === 0 ? undefined : items.join(" ");
}

/** 配额行各项（宽 / 窄两种格式）；重置时间先丢，主窗口百分比永不丢。 */
export function quotaParts(
  quota: QuotaUpdateEvent,
  width: number,
  now: number,
  theme: Theme,
): Part[] {
  const dim = (text: string): string => theme.fg("dim", text);
  const narrow = width < QUOTA_NARROW_WIDTH;
  const parts: Part[] = [];
  windows(quota).forEach(([which, w], i) => {
    const first = i === 0;
    const group = narrow ? which : undefined;
    const name = narrow ? `${shortLabel(w, which)} ` : labels(w, which).pct;
    parts.push({
      text: dim(name) + percent(theme, w.usedPercent, !narrow),
      priority: first ? undefined : 2,
      zone: "left",
      ...(group !== undefined ? { group } : {}),
    });
    if (w.resetsAt === undefined) return;
    const left = formatRemaining(w.resetsAt - now, narrow);
    parts.push({
      text: narrow
        ? theme.fg("tool", `${theme.glyphs.retry}${left}`)
        : dim(labels(w, which).reset) + theme.fg("tool", left),
      priority: first ? 3 : 1,
      zone: "left",
      // 宽格式按最宽形状占位（`23h 59m`），数值变化不让某项时有时无
      reserve: narrow ? 0 : visibleWidth(labels(w, which).reset) + 7,
      ...(group !== undefined ? { group } : {}),
    });
  });
  return parts;
}

export interface QuotaLineSource {
  layout(): StatusLineMode;
  quota(): QuotaView;
  now(): number;
}

export class QuotaLine implements Component {
  constructor(
    private readonly source: QuotaLineSource,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    if (this.source.layout() !== "full") return [];
    const view = this.source.quota();
    if (view === undefined) return [];
    const theme = this.theme;
    if (view === "pending") {
      return [truncateToWidth(theme.fg("dim", msg().interactive.statusLine.quota.pending), width)];
    }
    const parts = quotaParts(view.quota, width, this.source.now(), theme);
    if (parts.length === 0) return [];
    const sep = width < QUOTA_NARROW_WIDTH ? " · " : " | ";
    return [layoutRow(parts, width, theme, { sep })];
  }

  invalidate(): void {}
}
