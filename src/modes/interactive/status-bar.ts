/**
 * 状态栏（设计 §12.6；终端界面视觉设计 v1 §3.10；第五波 §1）：编辑器下方，永远是最后一行。[B7][W5-A]
 *
 * 两区：左区「权限模式 + shift+tab 切换」，右区信息，中间用空格撑开；空隙不足 4 列时退回单区。模式永远在最左；
 * 同组项（模型与思考级别、目录与 git）以空格相连。compact 分隔符固定为 ` · `（tmux 宿主按此解析），full 按用户
 * 样例用 ` | `。
 *
 * 两种布局（`ui.statusLine`，§1.1）：
 * - `compact`（嵌入宿主缺省，即原单行状态栏）：
 *   `Manual · shift+tab 切换    sonnet-4-5 · medium · ↑12.3k ↓1.2k · cache 80% ♨ · $0.12 · ctx 34% · proj ⎇ main 5ae9e54 +12 −3 · 2h24m`
 *   右区顺序：模型 · 思考 · `↑ ↓` · cache · 费用 · rebill · ctx · git · 时长 · queue · codemode · 预设 · [宿主]。
 * - `full`（独立终端缺省，用户样例）：用量类项移到上方速率行（status-line.ts），本行为
 *   `Manual | 模型 思考 | Ctx 3.0% | 目录 ⎇ 分支 短提交 (+a,-d) | $费用 | 会话时长`；Ctx 一位小数、不换余量表。
 *
 * - 用量来自 `session.getStats()`，只在 `refresh()` 时读取（事件驱动），渲染只拼字符串；时长按渲染时刻算。
 * - [W3-C2] `cache` 是**最近一次**请求的命中率；端点三态 `cache —` / `cache 未报告`；保温中追加 `♨`；
 *   重计费 `rebill $x`（无价模型显示 token）；codemode 生效时 `codemode on|only`，网络未隔离追加 `net!`
 *   （S2：Node 权限模型与 OS 沙箱都不隔离网络时）。
 * - 费用 = `stats.cost` + 外部 Agent 以美元计的用量（`stats.external`，W5-E；其它单位只在 /session 显示）。
 * - 着色：整行 dim；模式名正文色（Bypass permissions warning、Plan accent）；模型 accent；ctx 按阈值
 *   success / warning / error；rebill、queue warning；`net!` error。宽 ≥ 110 时 ctx 用余量表。
 * - [W5-U] 模型回退中（`model_fallback`）模型项显示 `主模型 → 回退模型`，切回主模型后恢复。
 * - 模型名缩写：宽 < 100 去掉供应商前缀，< 60 再去掉 `@渠道`，< 48 去掉版本后缀（第一个 `-数字` 起）。
 * - ASCII：`⎇` → `git`（字形表 `branch`）、`−` → `-`、`♨` → `~`。
 * - 宽度不够时按优先级丢弃（数字大的先丢，表见 §1.2）；会变的数字按最宽形状占位（`reserve`），
 *   数字变化不会让某项时有时无（40 列不抖动）。
 */

import type { AgentSession, SessionCacheStats, SessionStats } from "../../agent/types.js";
import { permissionModeLabel } from "../../permissions/modes.js";
import { formatModelRef } from "../../ai/providers/channels.js";
import type { StatusLineMode } from "../../config/types.js";
import type { GitInfo } from "../../git/info.js";
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
  /** 布局；缺省 `compact`（单行）。 */
  layout?(): StatusLineMode;
  /** 工作目录名与 git 信息；没有时不显示目录与 git。 */
  git?(): { dir: string; info: GitInfo | undefined } | undefined;
  /** 会话时长的时钟（缺省 Date.now）。 */
  now?(): number;
  /** 会话时长的起点；缺省取 `getStats().telemetry.sessionStartedAt`。 */
  sessionStartedAt?(): number | undefined;
  /** [W5-U] 模型回退中（`model_fallback` 之后、切回主模型之前）：主模型与回退模型的引用。 */
  fallback?(): { from: string; to: string } | undefined;
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

/** 会话时长：`Ns` / `Nm` / `NhMm`。 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
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

/** 状态费用：会话费用 + 外部 Agent 以美元计的用量；会话费用未知为 undefined。 */
export function statusCost(stats: SessionStats): number | undefined {
  if (stats.cost === undefined) return undefined;
  let external = 0;
  for (const usage of Object.values(stats.external?.byAgent ?? {})) {
    if (usage.unit === "usd") external += usage.amount;
  }
  return stats.cost + external;
}

export interface Part {
  text: string;
  /** 越小越重要（最后丢）；undefined = 永不丢。 */
  priority: number | undefined;
  zone: "left" | "right";
  /** 同组相邻项连成一段（组内用 `RowStyle.groups[组].glue`，缺省空格）。 */
  group?: string;
  /** 这一段前面的连接符（缺省行分隔符）；段首项的值生效。 */
  lead?: string;
  /** 判断放不放得下时按这个宽度算（会变的数字取最宽形状，避免抖动）。 */
  reserve?: number;
}

export interface RowStyle {
  /** 段间分隔符，缺省 ` · `。 */
  sep?: string;
  /** 组的连接方式：组内连接符与包围（如 `(avg 100 · ttft 1.4s)`）。 */
  groups?: Readonly<Record<string, { glue?: string; open?: string; close?: string }>>;
}

/** 两区之间至少留的空格；不足时退回单区。 */
const MIN_GAP = 4;
/** ctx 改用余量表的最小宽度。 */
const METER_WIDTH = 110;

/** 按优先级丢弃后排成一行（两区 / 单区）；连接符都是 dim。 */
export function layoutRow(
  parts: readonly Part[],
  width: number,
  theme: Theme,
  style: RowStyle = {},
): string {
  const sep = style.sep ?? " · ";
  const dim = (text: string): string => (text === "" ? "" : theme.fg("dim", text));
  /** 返回 [文本, 占位宽度]。 */
  const join = (list: readonly Part[]): [string, number] => {
    let out = "";
    let size = 0;
    const add = (text: string, measured = visibleWidth(text)): void => {
      out += text;
      size += measured;
    };
    list.forEach((p, i) => {
      const prev = i === 0 ? undefined : list[i - 1];
      const group = p.group === undefined ? undefined : style.groups?.[p.group];
      const continues = prev !== undefined && p.group !== undefined && p.group === prev.group;
      if (continues) add(dim(group?.glue ?? " "));
      else {
        if (prev !== undefined) {
          const prevGroup = prev.group === undefined ? undefined : style.groups?.[prev.group];
          add(dim(prevGroup?.close ?? ""));
          add(dim(p.lead ?? sep));
        }
        add(dim(group?.open ?? ""));
      }
      add(p.text, Math.max(visibleWidth(p.text), p.reserve ?? 0));
    });
    const last = list[list.length - 1];
    if (last?.group !== undefined) add(dim(style.groups?.[last.group]?.close ?? ""));
    return [out, size];
  };
  let kept = [...parts];
  const zone = (z: Part["zone"]): Part[] => kept.filter((p) => p.zone === z);
  const fits = (): boolean => {
    const l = join(zone("left"))[1];
    const right = zone("right");
    return l + (right.length === 0 ? 0 : sep.length + join(right)[1]) <= width;
  };
  while (!fits()) {
    const droppable = kept.filter((p) => p.priority !== undefined);
    if (droppable.length === 0) break;
    const drop = droppable.reduce((worst, p) => (p.priority! > worst.priority! ? p : worst));
    kept = kept.filter((p) => p !== drop);
  }
  const l = join(zone("left"))[0];
  const r = join(zone("right"))[0];
  const gap = width - visibleWidth(l) - visibleWidth(r);
  const line = r === "" ? l : gap >= MIN_GAP ? l + " ".repeat(gap) + r : l + dim(sep) + r;
  return truncateToWidth(line, width);
}

/** 按终端宽度缩写模型名（§3.10）。 */
export function abbreviateModel(ref: string, width: number): string {
  let out = ref;
  if (width < 100) out = out.slice(out.indexOf("/") + 1);
  if (width < 60) out = out.replace(/@.*$/, "");
  if (width < 48) out = out.replace(/-\d.*$/, "");
  return out;
}

/** 用量类项（compact 在本行、full 在速率行）的优先级表。 */
export interface UsagePriorities {
  tokens: number;
  cache: number;
  cost?: number;
  rebill: number;
  queue: number;
  codemode: number;
  preset: number;
  host: number;
}

export interface UsageItems {
  tokens?: string;
  cache?: string;
  cost?: string;
  rebill?: string;
  queue?: string;
  codemode?: string;
  preset?: string;
  host?: string;
}

/** 用量类项的文本（已着色；普通项 dim）。 */
export function usageItems(
  stats: SessionStats,
  queue: number,
  source: StatusBarSource,
  theme: Theme,
): UsageItems {
  const g = theme.glyphs;
  const dim = (text: string): string => theme.fg("dim", text);
  const out: UsageItems = {};
  const t = stats.tokens;
  const prompt = t.input + t.cacheRead + t.cacheWrite;
  const cache = stats.cache;
  if (prompt + t.output > 0) {
    out.tokens = dim(`${g.arrowUp}${formatTokens(prompt)} ${g.arrowDown}${formatTokens(t.output)}`);
    if (cache !== undefined) out.cache = dim(cacheText(cache, g.warm));
    else if (stats.cacheHitRate !== undefined) {
      out.cache = dim(`cache ${Math.round(stats.cacheHitRate * 100)}%`);
    }
    const cost = statusCost(stats);
    if (cost === undefined) out.cost = dim("$?");
    else if (cost > 0) out.cost = dim(formatCost(cost));
    if (cache !== undefined && cache.reBilledTokens > 0) {
      const amount =
        cache.reBilledUsd === undefined
          ? `${formatTokens(cache.reBilledTokens)} tok`
          : formatCost(cache.reBilledUsd);
      out.rebill = theme.fg("warning", `rebill ${amount}`);
    }
  }
  if (queue > 0) out.queue = theme.fg("warning", `queue ${queue}`);
  const codemode = source.codemode?.();
  if (codemode !== undefined) {
    const strict = source.sandboxStrict?.() ?? true;
    const label = dim(`codemode ${codemode}`);
    out.codemode = strict ? label : `${label} ${theme.fg("error", "net!")}`;
  }
  const preset = source.preset();
  if (preset !== "default") out.preset = dim(`preset ${preset}`);
  const host = source.hostStatus?.();
  if (host !== undefined && host.size > 0) {
    const values = [...host.values()].filter((v) => v.trim() !== "");
    if (values.length > 0) out.host = dim(`[${values.join(" · ")}]`);
  }
  return out;
}

/** compact 布局的优先级（§1.2：现状顺序，git 三项与时长插在 ctx 之后）。 */
const COMPACT = {
  model: 0,
  ctx: 1,
  duration: 3,
  branch: 4,
  dir: 5,
  diff: 6,
  codemode: 7,
  queue: 8,
  thinking: 9,
  tokens: 10,
  cache: 11,
  cost: 12,
  rebill: 13,
  preset: 14,
  host: 15,
  hint: 16,
} as const;

/** full 布局本行的优先级（§1.2 下行表）。 */
const FULL = { model: 0, ctx: 1, cost: 2, duration: 3, branch: 4, dir: 5, diff: 6, thinking: 7 };
const FULL_HINT = 12;
/** full 状态栏（用户样例）：段间 ` | `。 */
const FULL_STYLE: RowStyle = { sep: " | " };

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

  /** 当前统计（速率行共用，避免重复 getStats）。 */
  current(): SessionStats {
    this.stats ??= this.source.session().getStats();
    return this.stats;
  }

  queued(): number {
    return this.queue;
  }

  layout(): StatusLineMode {
    return this.source.layout?.() ?? "compact";
  }

  private parts(width: number): Part[] {
    const theme = this.theme;
    const g = theme.glyphs;
    const state = this.source.session().state;
    const stats = this.current();
    const full = this.layout() === "full";
    const parts: Part[] = [];
    const dim = (text: string): string => theme.fg("dim", text);
    const right = (text: string, priority: number, extra: Partial<Part> = {}): void =>
      void parts.push({ text, priority, zone: "right", ...extra });
    const mode = permissionModeLabel(state.permissionMode);
    parts.push({
      text:
        state.permissionMode === "full-auto"
          ? theme.fg("warning", mode)
          : state.permissionMode === "plan"
            ? theme.fg("accent", mode)
            : theme.fg("text", mode),
      priority: undefined,
      zone: "left",
    });
    if (width >= 40) {
      parts.push({
        text: dim("shift+tab 切换"),
        priority: full ? FULL_HINT : COMPACT.hint,
        zone: "left",
      });
    }
    const model =
      state.model === undefined ? "?" : abbreviateModel(formatModelRef(state.model), width);
    const p = full ? FULL : COMPACT;
    const fallback = this.source.fallback?.();
    // 回退中：`主模型 → 回退模型`（回退模型 warning），切回主模型后恢复原样
    const modelText =
      fallback === undefined
        ? theme.fg("accent", model)
        : theme.fg("accent", abbreviateModel(fallback.from, width)) +
          dim(g.ascii ? " -> " : " → ") +
          theme.fg("warning", abbreviateModel(fallback.to, width));
    right(modelText, p.model, full ? { group: "model" } : {});
    if (state.thinkingLevel !== "off") {
      right(dim(state.thinkingLevel), p.thinking, full ? { group: "model" } : {});
    }
    const usage = full ? {} : usageItems(stats, this.queue, this.source, theme);
    if (usage.tokens !== undefined) right(usage.tokens, COMPACT.tokens);
    if (usage.cache !== undefined) right(usage.cache, COMPACT.cache);
    if (usage.cost !== undefined) right(usage.cost, COMPACT.cost);
    if (usage.rebill !== undefined) right(usage.rebill, COMPACT.rebill);
    right(this.ctxText(stats.contextPercent, width, full), p.ctx, full ? { reserve: 10 } : {});
    this.gitParts(p, full).forEach((part) => parts.push(part));
    if (full) {
      const cost = statusCost(stats);
      const used = stats.tokens.input + stats.tokens.output + stats.tokens.cacheRead > 0;
      if (cost === undefined && used) right(dim("$?"), FULL.cost);
      else if (cost !== undefined && cost > 0) right(dim(formatCost(cost)), FULL.cost);
    }
    const started = this.source.sessionStartedAt?.() ?? stats.telemetry?.sessionStartedAt;
    if (started !== undefined) {
      const now = this.source.now?.() ?? Date.now();
      right(dim(formatDuration(now - started)), p.duration, { reserve: 6 });
    }
    if (usage.queue !== undefined) right(usage.queue, COMPACT.queue);
    if (usage.codemode !== undefined) right(usage.codemode, COMPACT.codemode);
    if (usage.preset !== undefined) right(usage.preset, COMPACT.preset);
    if (usage.host !== undefined) right(usage.host, COMPACT.host);
    return parts;
  }

  /** `目录 ⎇ 分支 短提交 +a −b`：三项同组、各自按优先级丢弃。 */
  private gitParts(p: { branch: number; dir: number; diff: number }, full: boolean): Part[] {
    const git = this.source.git?.();
    if (git === undefined) return [];
    const theme = this.theme;
    const g = theme.glyphs;
    const dim = (text: string): string => theme.fg("dim", text);
    const out: Part[] = [];
    const add = (text: string, priority: number): void =>
      void out.push({ text: dim(text), priority, zone: "right", group: "git" });
    if (git.dir !== "") add(git.dir, p.dir);
    const info = git.info;
    if (info === undefined) return out;
    const head = [info.branch, info.shortHead].filter((s) => s !== undefined).join(" ");
    if (head !== "") add(`${g.branch} ${head}`, p.branch);
    if (info.insertions !== undefined && info.deletions !== undefined) {
      const { insertions: a, deletions: d } = info;
      add(full ? `(+${a},-${d})` : `+${a} ${g.ascii ? "-" : "−"}${d}`, p.diff);
    }
    return out;
  }

  private ctxText(percent: number | undefined, width: number, decimal: boolean): string {
    const theme = this.theme;
    if (percent === undefined) return theme.fg("dim", decimal ? "Ctx ?" : "ctx ?");
    const color = levelColor(percent / 100);
    // full 按用户样例总是 `Ctx 3.0%`；compact 宽屏换余量表（现状）
    if (!decimal && width >= METER_WIDTH) {
      const meter = new Meter(percent / 100, { label: theme.fg("dim", "ctx"), theme });
      return meter.render(80)[0] ?? "";
    }
    if (decimal) return theme.fg("dim", "Ctx ") + theme.fg(color, `${percent.toFixed(1)}%`);
    return theme.fg("dim", "ctx ") + theme.fg(color, `${Math.round(percent)}%`);
  }

  render(width: number): string[] {
    const style = this.layout() === "full" ? FULL_STYLE : {};
    return [layoutRow(this.parts(width), width, this.theme, style)];
  }

  invalidate(): void {
    this.stats = undefined;
  }
}
