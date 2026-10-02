/**
 * 状态栏（设计 §12.6）：编辑器下方一行。[B7]
 *
 * `provider/model · think:medium · ↑12.3k ↓1.2k · cache 80% ♨ · $0.12 · rebill $0.11 · ctx 34%
 *  · queue 1 · mode:default · codemode:only net! · preset:default · [宿主状态]`
 *
 * - 用量来自 `session.getStats()`（`↑` = 输入含缓存读写，`↓` = 输出），只在 `refresh()` 时读取
 *   （事件驱动），渲染只拼字符串；
 * - [W3-C2] `cache` 是**最近一次**请求的命中率（会话累计在 `/session`）；端点三态：`unknown` →
 *   `cache —`，`silent` → `cache 未报告`；保温计时中追加 `♨`；会话有重计费时显示 `rebill $x`
 *   （无价模型显示重计费 token）；会话层缓存未接线时回落到会话命中率 `cacheHitRate`；
 * - `ctx ?` 表示模型没有上下文窗口；≥ 70% 黄、≥ 90% 红；没有用量时不显示 token / cache / 费用；
 * - [W3-C2 A4] codemode 生效时显示 `codemode:on|only`，运行时 Node 的权限模型不隔离网络
 *   （`detectSandboxCapability().strict` 为 false）时追加红色 `net!`；
 * - 宿主状态读 `HostAdapterHandle.status()`（宿主 `ui.setStatus`），每次渲染现取；
 * - 宽度不够时按优先级丢弃（宿主 → 预设 → rebill → 费用 → cache → token → think → 队列 →
 *   codemode），模型、ctx、权限模式最后丢。
 */

import type { AgentSession, SessionCacheStats, SessionStats } from "../../agent/types.js";
import { truncateToWidth, visibleWidth, type Component, type Theme } from "../../tui.js";

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
export function cacheText(cache: SessionCacheStats): string {
  const rate = cache.lastHitRate ?? cache.hitRate;
  const value =
    cache.reporting === "silent"
      ? "未报告"
      : cache.reporting === "reported" && rate !== undefined
        ? `${Math.round(rate * 100)}%`
        : "—";
  return `cache ${value}${cache.warming.state === "scheduled" ? " ♨" : ""}`;
}

interface Part {
  text: string;
  /** 越小越重要（最后丢）。 */
  priority: number;
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

  private parts(): Part[] {
    const theme = this.theme;
    const session = this.source.session();
    const state = session.state;
    const stats = this.stats ?? session.getStats();
    this.stats = stats;
    const parts: Part[] = [];
    const model = state.model === undefined ? "?" : `${state.model.provider}/${state.model.id}`;
    parts.push({ text: theme.fg("accent", model), priority: 0 });
    parts.push({ text: `think:${state.thinkingLevel}`, priority: 5 });
    const t = stats.tokens;
    const prompt = t.input + t.cacheRead + t.cacheWrite;
    if (prompt + t.output > 0) {
      parts.push({ text: `↑${formatTokens(prompt)} ↓${formatTokens(t.output)}`, priority: 6 });
      const cache = stats.cache;
      if (cache !== undefined) parts.push({ text: cacheText(cache), priority: 7 });
      else if (stats.cacheHitRate !== undefined) {
        parts.push({ text: `cache ${Math.round(stats.cacheHitRate * 100)}%`, priority: 7 });
      }
      if (stats.cost === undefined) parts.push({ text: "$?", priority: 8 });
      else if (stats.cost > 0) parts.push({ text: formatCost(stats.cost), priority: 8 });
      if (cache !== undefined && cache.reBilledTokens > 0) {
        const amount =
          cache.reBilledUsd === undefined
            ? `${formatTokens(cache.reBilledTokens)} tok`
            : formatCost(cache.reBilledUsd);
        parts.push({ text: theme.fg("warning", `rebill ${amount}`), priority: 9 });
      }
    }
    const ctx = stats.contextPercent;
    const ctxText = ctx === undefined ? "ctx ?" : `ctx ${Math.round(ctx)}%`;
    parts.push({
      text:
        ctx !== undefined && ctx >= 90
          ? theme.fg("error", ctxText)
          : ctx !== undefined && ctx >= 70
            ? theme.fg("warning", ctxText)
            : ctxText,
      priority: 1,
    });
    if (this.queue > 0)
      parts.push({ text: theme.fg("warning", `queue ${this.queue}`), priority: 4 });
    const mode = `mode:${state.permissionMode}`;
    parts.push({
      text: state.permissionMode === "full-auto" ? theme.fg("warning", mode) : mode,
      priority: 2,
    });
    const codemode = this.source.codemode?.();
    if (codemode !== undefined) {
      const strict = this.source.sandboxStrict?.() ?? true;
      parts.push({
        text: `codemode:${codemode}${strict ? "" : ` ${theme.fg("error", "net!")}`}`,
        priority: 3,
      });
    }
    parts.push({ text: `preset:${this.source.preset()}`, priority: 10 });
    const host = this.source.hostStatus?.();
    if (host !== undefined && host.size > 0) {
      const values = [...host.values()].filter((v) => v.trim() !== "");
      if (values.length > 0) parts.push({ text: `[${values.join(" · ")}]`, priority: 11 });
    }
    return parts;
  }

  render(width: number): string[] {
    const parts = this.parts();
    const sep = this.theme.fg("dim", " · ");
    const join = (list: readonly Part[]): string => list.map((p) => p.text).join(sep);
    let kept = parts;
    while (kept.length > 1 && visibleWidth(join(kept)) > width) {
      const drop = kept.reduce((worst, p) => (p.priority > worst.priority ? p : worst));
      kept = kept.filter((p) => p !== drop);
    }
    return [truncateToWidth(join(kept), width)];
  }

  invalidate(): void {
    this.stats = undefined;
  }
}
