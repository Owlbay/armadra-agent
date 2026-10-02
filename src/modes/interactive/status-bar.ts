/**
 * 状态栏（设计 §12.6；终端界面视觉设计 v1 §3.10）：编辑器下方一行，永远是最后一行。[B7]
 *
 * 两区：左区「权限模式 · shift+tab 切换」，右区用量，中间用空格撑开；空隙不足 4 列时退回单区（` · ` 连接）。
 * `Accept edits · shift+tab 切换        sonnet-4-5 · medium · ↑12.3k ↓1.2k · cache 80% ♨ · $0.12 · ctx 34%`
 *
 * - 右区顺序固定：模型 · 思考级别（只显示值，off 不显示）· `↑` 输入（含缓存读写）`↓` 输出 · cache · 费用 ·
 *   rebill · ctx · queue · codemode · 预设（非 default 才显示）· [宿主状态]；分隔符固定为 ` · `，
 *   模式永远在最左（tmux 宿主可按此解析）。
 * - 用量来自 `session.getStats()`，只在 `refresh()` 时读取（事件驱动），渲染只拼字符串；
 * - [W3-C2] `cache` 是**最近一次**请求的命中率；端点三态 `cache —` / `cache 未报告`；保温中追加 `♨`；
 *   重计费 `rebill $x`（无价模型显示 token）；codemode 生效时 `codemode on|only`，网络未隔离追加 `net!`；
 * - 着色：整行 dim；模式名正文色（Bypass permissions warning、Plan accent）；模型 accent；ctx 按阈值
 *   success / warning / error；rebill、queue warning；`net!` error。宽 ≥ 110 时 ctx 用余量表。
 * - 模型名缩写：宽 < 100 去掉供应商前缀，< 60 再去掉 `@渠道`，< 48 去掉版本后缀（第一个 `-数字` 起）。
 * - 宽度不够时按优先级丢弃（数字大的先丢）：切换提示 12 → 宿主 11 → 预设 10 → rebill 9 → 费用 8 →
 *   cache 7 → token 6 → 思考 5 → 队列 4 → codemode 3 → ctx 1 → 模型 0；模式永不丢。
 */

import type { AgentSession, SessionCacheStats, SessionStats } from "../../agent/types.js";
import { permissionModeLabel } from "../../permissions/modes.js";
import { formatModelRef } from "../../ai/providers/channels.js";
import {
  Meter,
  levelColor,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Theme,
} from "../../tui.js";

export interface StatusBarSource {
  session(): AgentSession;
  /** 工具预设名（`config.tools.preset`）。 */
  preset(): string;
  /** 宿主 `ui.setStatus` 的当前值；无宿主为 undefined。 */
  hostStatus?(): ReadonlyMap<string, string> | undefined;
  /** 生效的 codemode 方式（codemode 工具活动时）；off / 未注册为 undefined。 */
  codemode?(): "on" | "only" | undefined;
  /** 沙箱是否隔离网络（缺省 true，不标 `net!`）。 */
  sandboxStrict?(): boolean;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatCost(cost: number): string {
  if (cost >= 0.01) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(3)}`;
}

/** `cache 83%` / `cache —` / `cache 未报告`，保温计时中追加 ` ♨`。 */
export function cacheText(cache: SessionCacheStats, warm = "♨"): string {
  const rate = cache.lastHitRate ?? cache.hitRate;
  const value =
    cache.reporting === "silent"
      ? "未报告"
      : cache.reporting === "reported" && rate !== undefined
        ? `${Math.round(rate * 100)}%`
        : "—";
  return `cache ${value}${cache.warming.state === "scheduled" ? ` ${warm}` : ""}`;
}

interface Part {
  text: string;
  /** 越小越重要（最后丢）；undefined = 永不丢。 */
  priority: number | undefined;
  zone: "left" | "right";
}

/** 两区之间至少留的空格；不足时退回单区。 */
const MIN_GAP = 4;
/** ctx 改用余量表的最小宽度。 */
const METER_WIDTH = 110;

/** 按终端宽度缩写模型名（§3.10）。 */
export function abbreviateModel(ref: string, width: number): string {
  let out = ref;
  if (width < 100) out = out.slice(out.indexOf("/") + 1);
  if (width < 60) out = out.replace(/@.*$/, "");
  if (width < 48) out = out.replace(/-\d.*$/, "");
  return out;
}

export class StatusBar implements Component {
  private stats: SessionStats | undefined;
  private queue = 0;

  constructor(
    private readonly source: StatusBarSource,
    private readonly theme: Theme,
  ) {}

  /** 用量、模型等变化后调用（事件驱动；流式期间不必每帧算）。 */
  refresh(): void {
    this.stats = this.source.session().getStats();
  }

  setQueue(steering: number, followUp: number): void {
    this.queue = steering + followUp;
  }

  private parts(width: number): Part[] {
    const theme = this.theme;
    const g = theme.glyphs;
    const session = this.source.session();
    const state = session.state;
    const stats = this.stats ?? session.getStats();
    this.stats = stats;
    const parts: Part[] = [];
    /** 普通项整项 dim；`colored` 的项已自带颜色。 */
    const tone = (text: string, colored: boolean): string =>
      colored ? text : theme.fg("dim", text);
    const left = (text: string, priority: number | undefined, colored = false): void =>
      void parts.push({ text: tone(text, colored), priority, zone: "left" });
    const right = (text: string, priority: number, colored = false): void =>
      void parts.push({ text: tone(text, colored), priority, zone: "right" });
    const mode = permissionModeLabel(state.permissionMode);
    left(
      state.permissionMode === "full-auto"
        ? theme.fg("warning", mode)
        : state.permissionMode === "plan"
          ? theme.fg("accent", mode)
          : theme.fg("text", mode),
      undefined,
      true,
    );
    if (width >= 40) left("shift+tab 切换", 12);
    const model =
      state.model === undefined ? "?" : abbreviateModel(formatModelRef(state.model), width);
    right(theme.fg("accent", model), 0, true);
    if (state.thinkingLevel !== "off") right(state.thinkingLevel, 5);
    const t = stats.tokens;
    const prompt = t.input + t.cacheRead + t.cacheWrite;
    const cache = stats.cache;
    if (prompt + t.output > 0) {
      right(`${g.arrowUp}${formatTokens(prompt)} ${g.arrowDown}${formatTokens(t.output)}`, 6);
      if (cache !== undefined) right(cacheText(cache, g.warm), 7);
      else if (stats.cacheHitRate !== undefined) {
        right(`cache ${Math.round(stats.cacheHitRate * 100)}%`, 7);
      }
      if (stats.cost === undefined) right("$?", 8);
      else if (stats.cost > 0) right(formatCost(stats.cost), 8);
      if (cache !== undefined && cache.reBilledTokens > 0) {
        const amount =
          cache.reBilledUsd === undefined
            ? `${formatTokens(cache.reBilledTokens)} tok`
            : formatCost(cache.reBilledUsd);
        right(theme.fg("warning", `rebill ${amount}`), 9, true);
      }
    }
    right(this.ctxText(stats.contextPercent, width), 1, true);
    if (this.queue > 0) right(theme.fg("warning", `queue ${this.queue}`), 4, true);
    const codemode = this.source.codemode?.();
    if (codemode !== undefined) {
      const strict = this.source.sandboxStrict?.() ?? true;
      const label = theme.fg("dim", `codemode ${codemode}`);
      right(strict ? label : `${label} ${theme.fg("error", "net!")}`, 3, true);
    }
    const preset = this.source.preset();
    if (preset !== "default") right(`preset ${preset}`, 10);
    const host = this.source.hostStatus?.();
    if (host !== undefined && host.size > 0) {
      const values = [...host.values()].filter((v) => v.trim() !== "");
      if (values.length > 0) right(`[${values.join(" · ")}]`, 11);
    }
    return parts;
  }

  private ctxText(percent: number | undefined, width: number): string {
    const theme = this.theme;
    if (percent === undefined) return theme.fg("dim", "ctx ?");
    const color = levelColor(percent / 100);
    if (width >= METER_WIDTH) {
      const meter = new Meter(percent / 100, { label: theme.fg("dim", "ctx"), theme });
      return meter.render(80)[0] ?? "";
    }
    return theme.fg("dim", "ctx ") + theme.fg(color, `${Math.round(percent)}%`);
  }

  render(width: number): string[] {
    const theme = this.theme;
    const sep = theme.fg("dim", " · ");
    const join = (list: readonly Part[]): string => list.map((p) => p.text).join(sep);
    let kept = this.parts(width);
    const zones = (): [string, string] => [
      join(kept.filter((p) => p.zone === "left")),
      join(kept.filter((p) => p.zone === "right")),
    ];
    const fits = (): boolean => {
      const [l, r] = zones();
      return visibleWidth(l) + (r === "" ? 0 : 3 + visibleWidth(r)) <= width;
    };
    while (!fits()) {
      const droppable = kept.filter((p) => p.priority !== undefined);
      if (droppable.length === 0) break;
      const drop = droppable.reduce((worst, p) => (p.priority! > worst.priority! ? p : worst));
      kept = kept.filter((p) => p !== drop);
    }
    const [l, r] = zones();
    const gap = width - visibleWidth(l) - visibleWidth(r);
    const line = r === "" ? l : gap >= MIN_GAP ? l + " ".repeat(gap) + r : l + sep + r;
    return [truncateToWidth(line, width)];
  }

  invalidate(): void {
    this.stats = undefined;
  }
}
