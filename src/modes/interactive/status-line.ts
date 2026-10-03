/**
 * 速率行（第五波 §1.1，D1、D2）：`ui.statusLine: "full"` 时在状态栏上方多一行。[W5-A]
 *
 * ```text
 * codemode on · preset x            tps: 100 tok/s • 546 tok / 5.5s (avg 100 · ttft 1.4s) · ↑12.3k ↓1.2k · cache 83% ♨ · [-]
 * ```
 *
 * - [W7] 左右分区：左 = 状态 / 开关（`codemode on|only`〔网络未隔离追加 `net!`〕· `沙箱` · `preset 名` ·
 *   `→ 回退模型` · `queue N` · [宿主]），没有开关时左区为空、右区右对齐；右 = 度量：
 *   `tps: <速率>`（流式中是最近 2 s 窗口的瞬时值、前缀 accent；结束后是该请求的平均值；还没有请求时 `tps: —`）
 *   • `<输出 token> tok / <耗时>`（首 token 起算）`(avg <会话均速> · ttft <首 token 延迟>)` · `↑ ↓` · cache ·
 *   rebill，行尾 `[-]`（折叠提示：Ctrl+G 或 `/statusline compact`）；`•` 走字形表（ASCII `*`）；
 * - 数据：`StatusBar.current()` 的 `telemetry` 与用量（同一次 getStats）；流式中 `telemetry_tick` 时刷新；
 * - 丢弃顺序（数字大先丢；`tps` 与 `[-]` 永不丢）：右区度量先丢——tok/耗时 12 → token 11 → cache 10 →
 *   rebill 9 → avg 8 → ttft 7，左区开关最后丢——宿主 6 → queue 5 → 预设 4 → 回退 3 → 沙箱 2 → codemode 1；
 *   数字按最宽形状占位，不随数值抖动；
 * - `compact` 时不占行（render 返回空）。
 * - [W6] 配色（用户参考）：标签、单位、`•`、括号 dim；速率数字 `tool`（紫）；输出量与耗时、avg 数字 accent（蓝）；
 *   ttft 数字 `tool`；用量项 dim；回退模型 warning。
 */

import { truncateToWidth, type Component, type Theme } from "../../tui.js";
import {
  abbreviateModel,
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
  codemode: 1,
  sandbox: 2,
  fallback: 3,
  preset: 4,
  queue: 5,
  host: 6,
  ttft: 7,
  avg: 8,
  rebill: 9,
  cache: 10,
  tokens: 11,
  amount: 12,
} as const;

export const COLLAPSE_HINT = "[-]";

/** 用户样例：`tps: 100 tok/s • 546 tok / 5.5s (avg 100 · ttft 1.4s)`；其后的用量项与左区开关以 ` · ` 分隔。 */
const RATE_STYLE: RowStyle = { groups: { stats: { glue: " · ", open: "(", close: ")" } } };

export class StatusLine implements Component {
  constructor(
    private readonly bar: StatusBar,
    private readonly source: StatusBarSource,
    private readonly theme: Theme,
  ) {}

  private parts(width: number): Part[] {
    const theme = this.theme;
    const dim = (text: string): string => theme.fg("dim", text);
    const stats = this.bar.current();
    const telemetry = stats.telemetry;
    const live = telemetry?.live;
    const last = telemetry?.last;
    const parts: Part[] = [];
    const metric = (
      text: string,
      priority: number | undefined,
      reserve: number,
      extra: Partial<Part> = {},
    ): void => void parts.push({ text, priority, zone: "right", reserve, ...extra });
    const add = (
      zone: Part["zone"],
      text: string | undefined,
      priority: number | undefined,
    ): void => {
      if (text !== undefined) parts.push({ text, priority, zone });
    };

    const blue = (text: string): string => theme.fg("accent", text);
    const purple = (text: string): string => theme.fg("tool", text);
    const amountText = (tokens: number, ms: number): string =>
      `${blue(formatTokens(tokens))}${dim(" tok / ")}${blue(formatSeconds(ms))}`;
    let tps: number | undefined;
    let amount: string | undefined;
    if (live !== undefined) {
      tps = live.tps;
      amount = amountText(live.outputTokens, live.elapsedMs);
    } else if (last?.doneAt !== undefined) {
      tps = last.tps;
      if (last.outputTokens !== undefined && last.firstTokenAt !== undefined) {
        amount = amountText(last.outputTokens, last.doneAt - last.firstTokenAt);
      }
    }
    const label = live !== undefined ? theme.fg("accent", "tps:") : dim("tps:");
    metric(
      `${label} ${tps === undefined ? dim("—") : `${purple(formatRate(tps))}${dim(" tok/s")}`}`,
      undefined,
      RESERVE.tps,
    );
    if (amount !== undefined) {
      metric(amount, PRIORITY.amount, RESERVE.amount, { lead: ` ${theme.glyphs.dot} ` });
    }
    const stat = { group: "stats", lead: " " };
    if (telemetry?.avgTps !== undefined) {
      metric(
        `${dim("avg ")}${blue(formatRate(telemetry.avgTps))}`,
        PRIORITY.avg,
        RESERVE.avg,
        stat,
      );
    }
    if (last?.ttftMs !== undefined) {
      metric(
        `${dim("ttft ")}${purple(formatSeconds(last.ttftMs))}`,
        PRIORITY.ttft,
        RESERVE.ttft,
        stat,
      );
    }

    const usage = usageItems(stats, this.bar.queued(), this.source, theme);
    add("right", usage.tokens, PRIORITY.tokens);
    add("right", usage.cache, PRIORITY.cache);
    add("right", usage.rebill, PRIORITY.rebill);
    add("right", dim(COLLAPSE_HINT), undefined);
    add("left", usage.codemode, PRIORITY.codemode);
    add("left", usage.sandbox, PRIORITY.sandbox);
    add("left", usage.preset, PRIORITY.preset);
    const fallback = this.source.fallback?.();
    if (fallback !== undefined) {
      const arrow = theme.glyphs.ascii ? "-> " : "→ ";
      add(
        "left",
        dim(arrow) + theme.fg("warning", abbreviateModel(fallback.to, width)),
        PRIORITY.fallback,
      );
    }
    add("left", usage.queue, PRIORITY.queue);
    add("left", usage.host, PRIORITY.host);
    return parts;
  }

  render(width: number): string[] {
    if (this.bar.layout() !== "full") return [];
    return [truncateToWidth(layoutRow(this.parts(width), width, this.theme, RATE_STYLE), width)];
  }

  invalidate(): void {}
}
