/**
 * 速率行（第五波 §1.1，D1、D2）：`ui.statusLine: "full"` 时在状态栏上方多一行。[W5-A]
 *
 * ```text
 * tps: 100 tok/s • 546 tok / 5.5s (avg 100 · ttft 1.4s)                ↑12.3k ↓1.2k · cache 83% ♨ · [-]
 * ```
 *
 * - 左区（用户样例）：`tps: <速率>`（流式中是最近 2 s 窗口的瞬时值、前缀 accent；结束后是该请求的平均值；
 *   还没有请求时 `tps: —`）• `<输出 token> tok / <耗时>`（首 token 起算）`(avg <会话均速> · ttft <首 token 延迟>)`；
 *   `•` 走字形表（ASCII `*`）；
 * - 右区：从状态栏迁来的用量类项 `↑ ↓` · cache · rebill · queue · codemode · 预设 · [宿主]，行尾 `[-]`
 *   （折叠提示：Ctrl+G 或 `/statusline compact`）；
 * - 数据：`StatusBar.current()` 的 `telemetry` 与用量（同一次 getStats）；流式中 `telemetry_tick` 时刷新；
 * - 丢弃顺序（§1.2，数字大先丢；`tps` 与 `[-]` 永不丢）：tok/耗时 10 → codemode 9 → queue 8 → token 7 →
 *   cache 6 → rebill 5 → 预设 4 → 宿主 3 → avg 2 → ttft 1；数字按最宽形状占位，不随数值抖动；
 * - `compact` 时不占行（render 返回空）。
 */

import { truncateToWidth, type Component, type Theme } from "../../tui.js";
import {
  formatTokens,
  layoutRow,
  usageItems,
  type Part,
  type RowStyle,
  type StatusBar,
  type StatusBarSource,
} from "./status-bar.js";

/** 速率：< 10 保留一位小数，其余取整。 */
export function formatRate(tps: number): string {
  return tps < 10 ? tps.toFixed(1) : String(Math.round(tps));
}

/** 耗时：< 60 s 一位小数（`5.5s`），其余 `1m05s`。 */
export function formatSeconds(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, "0")}s`;
}

/** 占位宽度（常见的最宽形状）：`tps: 999 tok/s`、`1.2k tok / 59.9s`、`avg 999`、`ttft 9.9s`。 */
const RESERVE = { tps: 14, amount: 16, avg: 7, ttft: 9 } as const;

const PRIORITY = {
  ttft: 1,
  avg: 2,
  host: 3,
  preset: 4,
  rebill: 5,
  cache: 6,
  tokens: 7,
  queue: 8,
  codemode: 9,
  amount: 10,
} as const;

export const COLLAPSE_HINT = "[-]";

/** 用户样例：`tps: 100 tok/s • 546 tok / 5.5s (avg 100 · ttft 1.4s)`；右区用量项仍以 ` · ` 分隔。 */
const RATE_STYLE: RowStyle = { groups: { stats: { glue: " · ", open: "(", close: ")" } } };

export class StatusLine implements Component {
  constructor(
    private readonly bar: StatusBar,
    private readonly source: StatusBarSource,
    private readonly theme: Theme,
  ) {}

  private parts(): Part[] {
    const theme = this.theme;
    const dim = (text: string): string => theme.fg("dim", text);
    const stats = this.bar.current();
    const telemetry = stats.telemetry;
    const live = telemetry?.live;
    const last = telemetry?.last;
    const parts: Part[] = [];
    const left = (
      text: string,
      priority: number | undefined,
      reserve: number,
      extra: Partial<Part> = {},
    ): void => void parts.push({ text, priority, zone: "left", reserve, ...extra });
    const right = (text: string | undefined, priority: number | undefined): void => {
      if (text !== undefined) parts.push({ text, priority, zone: "right" });
    };

    let tps: number | undefined;
    let amount: string | undefined;
    if (live !== undefined) {
      tps = live.tps;
      amount = `${formatTokens(live.outputTokens)} tok / ${formatSeconds(live.elapsedMs)}`;
    } else if (last?.doneAt !== undefined) {
      tps = last.tps;
      if (last.outputTokens !== undefined && last.firstTokenAt !== undefined) {
        amount = `${formatTokens(last.outputTokens)} tok / ${formatSeconds(last.doneAt - last.firstTokenAt)}`;
      }
    }
    const label = live !== undefined ? theme.fg("accent", "tps:") : dim("tps:");
    left(
      `${label} ${dim(tps === undefined ? "—" : `${formatRate(tps)} tok/s`)}`,
      undefined,
      RESERVE.tps,
    );
    if (amount !== undefined) {
      left(dim(amount), PRIORITY.amount, RESERVE.amount, { lead: ` ${theme.glyphs.dot} ` });
    }
    const stat = { group: "stats", lead: " " };
    if (telemetry?.avgTps !== undefined) {
      left(dim(`avg ${formatRate(telemetry.avgTps)}`), PRIORITY.avg, RESERVE.avg, stat);
    }
    if (last?.ttftMs !== undefined) {
      left(dim(`ttft ${formatSeconds(last.ttftMs)}`), PRIORITY.ttft, RESERVE.ttft, stat);
    }

    const usage = usageItems(stats, this.bar.queued(), this.source, theme);
    right(usage.tokens, PRIORITY.tokens);
    right(usage.cache, PRIORITY.cache);
    right(usage.rebill, PRIORITY.rebill);
    right(usage.queue, PRIORITY.queue);
    right(usage.codemode, PRIORITY.codemode);
    right(usage.sandbox, PRIORITY.codemode);
    right(usage.preset, PRIORITY.preset);
    right(usage.host, PRIORITY.host);
    right(dim(COLLAPSE_HINT), undefined);
    return parts;
  }

  render(width: number): string[] {
    if (this.bar.layout() !== "full") return [];
    return [truncateToWidth(layoutRow(this.parts(), width, this.theme, RATE_STYLE), width)];
  }

  invalidate(): void {}
}
