/**
 * 订阅配额行（full 布局第三行，状态栏下方；compact 只在行尾追加一个短项）。[W6]
 *
 * ```text
 * Session: 10.0% | Reset: 2h 18m | Weekly: 31.0% | Weekly Reset: 6d 5h      ≥ 80 列
 * 5h 10% ↻2h18m · wk 31% ↻6d5h                                              < 80 列
 * ```
 *
 * - 数据：会话的 `quota_update`（codex flavor 的 `x-codex-primary/secondary-*` 头、`codex.rate_limits` 事件；
 *   SIWC 只有 429）。[W7] 标签按窗口时长认（300 分钟 = 5 小时 / Session、10080 = 本周 / Weekly，其它用实际时长），
 *   缺时长时按槽位推断（primary 5 小时、secondary 本周）；按时长从短到长排；全 0 的窗口不显示。
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

/**
 * [W7] 一个窗口显示成什么：按**窗口时长**认（300 = 5 小时、10080 = 本周），不按 primary / secondary 槽位——
 * 有的套餐 codex 把周窗口放在 primary（0.6.3 因此显示成 `7d:`）。缺时长时按槽位推断（primary 5 小时、
 * secondary 本周），与另一个窗口撞名时取另一种；时长 ≤ 0 视同缺失（0.6.3 把它渲染成 `0d`）。
 */
type WindowKind = "session" | "weekly" | number;

interface Shown {
  kind: WindowKind;
  window: QuotaWindow;
}

function minutesOf(w: QuotaWindow): number | undefined {
  const m = w.windowMinutes;
  return m !== undefined && Number.isFinite(m) && m > 0 ? m : undefined;
}

function kindOf(minutes: number | undefined): WindowKind | undefined {
  if (minutes === FIVE_HOURS) return "session";
  if (minutes === WEEK) return "weekly";
  return minutes;
}

const SPAN: Record<"session" | "weekly", number> = { session: FIVE_HOURS, weekly: WEEK };

function labels(kind: WindowKind): { pct: string; reset: string; short: string } {
  const m = msg().interactive.statusLine.quota;
  if (kind === "session") return { pct: m.session, reset: m.reset, short: m.short5h };
  if (kind === "weekly") return { pct: m.weekly, reset: m.weeklyReset, short: m.shortWeek };
  const span = windowSpan(kind);
  return { pct: m.window(span), reset: m.windowReset(span), short: span };
}

function percent(theme: Theme, used: number, decimal: boolean): string {
  return theme.fg(levelColor(used / 100), decimal ? `${used.toFixed(1)}%` : `${Math.round(used)}%`);
}

/** 没有任何数据的窗口（0%、无时长、无重置时间）不占位——服务端用全 0 表示「没有这个窗口」。 */
function hasData(w: QuotaWindow): boolean {
  return w.usedPercent !== 0 || minutesOf(w) !== undefined || w.resetsAt !== undefined;
}

/** 要显示的窗口，按时长从短到长（5 小时在前、本周在后）。 */
export function shownWindows(quota: QuotaUpdateEvent): Shown[] {
  const slots = (["primary", "secondary"] as const)
    .map((which) => ({ which, w: quota[which] }))
    .filter((x): x is { which: "primary" | "secondary"; w: QuotaWindow } => x.w !== undefined)
    .filter((x) => hasData(x.w));
  const known = slots.map((x) => kindOf(minutesOf(x.w)));
  const out = slots.map((x, i): Shown => {
    const own = known[i];
    if (own !== undefined) return { kind: own, window: x.w };
    const guess = x.which === "primary" ? "session" : "weekly";
    const taken = known.some((k, j) => j !== i && k === guess);
    const kind = taken ? (guess === "session" ? "weekly" : "session") : guess;
    return { kind, window: x.w };
  });
  const span = (k: WindowKind): number => (typeof k === "number" ? k : SPAN[k]);
  return out.sort((a, b) => span(a.kind) - span(b.kind));
}

/** compact 行尾的短项 `5h 10% wk 31%`（项内只用空格，不含 ` · `，宿主解析不受影响）。 */
export function compactQuotaItem(quota: QuotaUpdateEvent, theme: Theme): string | undefined {
  const dim = (text: string): string => theme.fg("dim", text);
  const items = shownWindows(quota).map(
    ({ kind, window: w }) => `${dim(labels(kind).short)} ${percent(theme, w.usedPercent, false)}`,
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
  shownWindows(quota).forEach(({ kind, window: w }, i) => {
    const first = i === 0;
    const group = narrow ? `w${i}` : undefined;
    const label = labels(kind);
    const name = narrow ? `${label.short} ` : label.pct;
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
        : dim(label.reset) + theme.fg("tool", left),
      priority: first ? 3 : 1,
      zone: "left",
      // 宽格式按最宽形状占位（`23h 59m`），数值变化不让某项时有时无
      reserve: narrow ? 0 : visibleWidth(label.reset) + 7,
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
