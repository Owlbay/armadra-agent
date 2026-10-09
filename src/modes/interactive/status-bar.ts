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
 *   `Manual | 模型 思考 | Ctx 3.0% 8.2k/272k auto | 目录 ⎇ 分支 短提交 (+a,-d) | $费用 | 会话时长`；Ctx 一位小数、
 *   不换余量表，带已用量 / 窗口与自动压缩标记（status-ctx.ts）。
 * - 上下文：估算值带 `≈`；着色阈值与档一裁剪对齐；流式中有 usage 时显示在途请求的值（`noteStreaming`，≤ 2 Hz）。
 *
 * - 用量来自 `session.getStats()`，只在 `refresh()` 时读取（事件驱动），渲染只拼字符串；时长按渲染时刻算。
 * - [W3-C2] `cache` 是**最近一次**请求的命中率；端点三态 `cache —` / `cache 未报告`；保温中追加 `♨`；
 *   重计费 `rebill $x`（无价模型显示 token）；codemode 生效时 `codemode on|only`，网络未隔离追加 `net!`
 *   （S2：Node 权限模型与 OS 沙箱都不隔离网络时）。
 * - 费用 = `stats.cost` + 外部 Agent 以美元计的用量（`stats.external`，W5-E；其它单位只在 /session 显示）。
 * - 着色：整行 dim；模式名正文色（Bypass permissions warning、Plan accent）；模型 accent；ctx 按阈值
 *   success / warning / error；rebill、queue warning；`net!` error。宽 ≥ 110 时 ctx 用余量表。
 *   [W6] full 本行按用户参考配色：思考级别 `user`（浅蓝）、目录与分支 success、短提交 dim、`↑N` 领先 `code`（橙）/
 *   `↓N` 落后 error、`(+a,-d)` 的 +a success / -d error、费用 warning、时长 `tool`（紫）；compact 着色不变。
 * - [W6] git 段在短提交后显示领先 / 落后上游 `↑N ↓N`（只 full；为 0 不显示，没有上游不显示）。
 * - [W6] compact 在行尾（宿主状态之后）追加订阅配额短项 `5h 10% wk 31%`（status-quota.ts），最先丢；
 *   既有记号顺序不变。full 的配额在状态栏下方单独一行。
 * - [W5-U] bash 在操作系统沙箱里跑时（S2）用量类项多一个 `沙箱`（与 codemode 同一丢弃优先级）。
 * - [W5-U] 模型回退中（`model_fallback`）compact 模型项显示 `主模型 → 回退模型`，切回主模型后恢复；[W7] full
 *   本行只显示主模型，`→ 回退模型` 作为开关类项在速率行左区。
 * - [W7] full 左右分区：左 = 状态（权限模式、`shift+tab` 提示），右 = 模型与度量；开关类项在速率行左区，
 *   配额在第三行右区（status-line.ts / status-quota.ts）。
 * - 模型名缩写：宽 < 100 去掉供应商前缀，< 60 再去掉 `@渠道`，< 48 去掉版本后缀（第一个 `-数字` 起）。
 * - ASCII：`⎇` → `git`（字形表 `branch`）、`−` → `-`、`♨` → `~`。
 * - 宽度不够时按优先级丢弃（数字大的先丢，表见 §1.2）；会变的数字按最宽形状占位（`reserve`），
 *   数字变化不会让某项时有时无（40 列不抖动）。
 */

import { msg } from "../../i18n/index.js";
import type { AgentSession, SessionCacheStats, SessionStats } from "../../agent/types.js";
import type { Usage } from "../../ai/types.js";
import { permissionModeLabel } from "../../permissions/modes.js";
import { formatModelRef } from "../../ai/providers/channels.js";
import type { StatusLineMode } from "../../config/types.js";
import type { GitInfo } from "../../git/info.js";
import { compactQuotaItem, type QuotaView } from "./status-quota.js";
import { LiveContext, compactCtxText, fullCtxParts } from "./status-ctx.js";
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
  /** 布局；缺省 `compact`（单行）。 */
  layout?(): StatusLineMode;
  /** 工作目录名与 git 信息；没有时不显示目录与 git。 */
  git?(): { dir: string; info: GitInfo | undefined } | undefined;
  /** 会话时长的时钟（缺省 Date.now）。 */
  now?(): number;
  /** 会话时长的起点；缺省取 `getStats().telemetry.sessionStartedAt`。 */
  sessionStartedAt?(): number | undefined;
  /** [W5-U] bash 命令在操作系统沙箱里跑（S2 第二阶段，`sandbox.bash: auto` 且可用、bash 工具活动）。 */
  bashSandbox?(): boolean;
  /** [W5-U] 模型回退中（`model_fallback` 之后、切回主模型之前）：主模型与回退模型的引用。 */
  fallback?(): { from: string; to: string } | undefined;
  /** [W6] 订阅配额（当前模型走 ChatGPT 订阅时）；compact 行尾短项用。 */
  quota?(): QuotaView;
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
      ? msg().interactive.statusLine.cacheSilent
      : cache.reporting === "reported" && rate !== undefined
        ? `${Math.round(rate * 100)}%`
        : "—";
  return `cache ${value}${cache.warming.state === "scheduled" ? ` ${warm}` : ""}`;
}

/**
 * 会话累计计费量（不是上下文）：`Σ↑<输入含缓存读写> ↓<输出> R<缓存读> W<缓存写>`，R / W 为 0 不显示；
 * ASCII 下 `Σ` → `sum `。
 */
export function tokensText(
  t: SessionStats["tokens"],
  g: Pick<Theme["glyphs"], "ascii" | "arrowUp" | "arrowDown">,
): string {
  const prompt = t.input + t.cacheRead + t.cacheWrite;
  const parts = [
    `${g.ascii ? "sum " : "Σ"}${g.arrowUp}${formatTokens(prompt)}`,
    `${g.arrowDown}${formatTokens(t.output)}`,
  ];
  if (t.cacheRead > 0) parts.push(`R${formatTokens(t.cacheRead)}`);
  if (t.cacheWrite > 0) parts.push(`W${formatTokens(t.cacheWrite)}`);
  return parts.join(" ");
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
    const left = zone("left");
    const right = zone("right");
    const between = left.length === 0 || right.length === 0 ? 0 : sep.length;
    return join(left)[1] + between + join(right)[1] <= width;
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
  // 左区为空时右区右对齐（[W7] full 的速率行没有开关、配额行）
  const line =
    r === ""
      ? l
      : l === ""
        ? " ".repeat(Math.max(0, gap)) + r
        : gap >= MIN_GAP
          ? l + " ".repeat(gap) + r
          : l + dim(sep) + r;
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
  sandbox?: string;
  preset?: string;
  host?: string;
}

/** 用量类项的文本（已着色；普通项 dim）。 */
export function usageItems(
  stats: SessionStats,
  queue: number,
  source: StatusBarSource,
  theme: Theme,
  /** full 速率行：`Σ` 标明会话累计，缓存读写分列 `R / W`；compact 保持 `↑ ↓`（宿主按此解析、窄屏省宽）。 */
  cumulative = false,
): UsageItems {
  const g = theme.glyphs;
  const dim = (text: string): string => theme.fg("dim", text);
  const out: UsageItems = {};
  const t = stats.tokens;
  const prompt = t.input + t.cacheRead + t.cacheWrite;
  const cache = stats.cache;
  if (prompt + t.output > 0) {
    out.tokens = dim(
      cumulative
        ? tokensText(t, g)
        : `${g.arrowUp}${formatTokens(prompt)} ${g.arrowDown}${formatTokens(t.output)}`,
    );
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
  if (source.bashSandbox?.() === true) out.sandbox = dim(msg().interactive.statusLine.sandbox);
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
  quota: 17,
} as const;

/**
 * full 布局本行的优先级（§1.2 下行表）。Ctx 段由百分比、已用量（ctxUsed）、`/窗口`（ctxWindow）与
 * `auto` 标记组成，窄时先丢 auto、`/窗口`，再丢已用量，百分比最后丢。
 */
const FULL = {
  model: 0,
  ctx: 1,
  cost: 2,
  duration: 3,
  ctxUsed: 4,
  branch: 5,
  dir: 6,
  diff: 7,
  ctxWindow: 8,
  thinking: 9,
  ctxAuto: 13,
};
const FULL_HINT = 12;
/** full 状态栏（用户样例）：段间 ` | `；Ctx 段（status-ctx.ts）的成员自带前导空格 / 斜杠，组内不加连接符。 */
const FULL_STYLE: RowStyle = { sep: " | ", groups: { ctx: { glue: "" } } };

export class StatusBar implements Component {
  private stats: SessionStats | undefined;
  private queue = 0;
  /** 在途请求的上下文量（message_update 的 usage，≤ 2 Hz 采样）；该消息结束后清掉。 */
  private readonly live = new LiveContext(() => this.source.now?.() ?? Date.now());

  constructor(
    private readonly source: StatusBarSource,
    private readonly theme: Theme,
  ) {}

  /** 用量、模型等变化后调用（事件驱动；流式期间不必每帧算）。 */
  refresh(): void {
    this.stats = this.source.session().getStats();
  }

  /**
   * 流式中的助手消息带了 usage（有的协议在开头就给输入量）：记下在途请求的上下文量，距上次采样
   * ≥ 500 ms 才更新（≤ 2 Hz）。返回是否更新了。
   */
  noteStreaming(usage: Usage | undefined): boolean {
    return this.live.note(usage);
  }

  /** 助手消息结束：丢掉在途值，回到统计值。 */
  clearStreaming(): void {
    this.live.clear();
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
        text: dim(msg().interactive.statusLine.cycleHint),
        priority: full ? FULL_HINT : COMPACT.hint,
        zone: "left",
      });
    }
    const model =
      state.model === undefined ? "?" : abbreviateModel(formatModelRef(state.model), width);
    const p = full ? FULL : COMPACT;
    // 回退中：compact 显示 `主模型 → 回退模型`（回退模型 warning）；full 本行只留主模型，`→ 回退模型` 在速率行左区
    const fallback = full ? undefined : this.source.fallback?.();
    const modelText =
      fallback === undefined
        ? theme.fg("accent", model)
        : theme.fg("accent", abbreviateModel(fallback.from, width)) +
          dim(g.ascii ? " -> " : " → ") +
          theme.fg("warning", abbreviateModel(fallback.to, width));
    right(modelText, p.model, full ? { group: "model" } : {});
    if (state.thinkingLevel !== "off") {
      const level = full ? theme.fg("user", state.thinkingLevel) : dim(state.thinkingLevel);
      right(level, p.thinking, full ? { group: "model" } : {});
    }
    const usage = full ? {} : usageItems(stats, this.queue, this.source, theme);
    if (usage.tokens !== undefined) right(usage.tokens, COMPACT.tokens);
    if (usage.cache !== undefined) right(usage.cache, COMPACT.cache);
    if (usage.cost !== undefined) right(usage.cost, COMPACT.cost);
    if (usage.rebill !== undefined) right(usage.rebill, COMPACT.rebill);
    const ctx = this.live.view(stats, g.ascii);
    if (full) fullCtxParts(ctx, theme, FULL).forEach((part) => parts.push(part));
    else right(compactCtxText(ctx, width, theme), p.ctx);
    this.gitParts(p, full).forEach((part) => parts.push(part));
    if (full) {
      const cost = statusCost(stats);
      const used = stats.tokens.input + stats.tokens.output + stats.tokens.cacheRead > 0;
      if (cost === undefined && used) right(dim("$?"), FULL.cost);
      else if (cost !== undefined && cost > 0) {
        right(theme.fg("warning", formatCost(cost)), FULL.cost);
      }
    }
    const started = this.source.sessionStartedAt?.() ?? stats.telemetry?.sessionStartedAt;
    if (started !== undefined) {
      const now = this.source.now?.() ?? Date.now();
      const text = formatDuration(now - started);
      right(full ? theme.fg("tool", text) : dim(text), p.duration, { reserve: 6 });
    }
    if (usage.queue !== undefined) right(usage.queue, COMPACT.queue);
    if (usage.codemode !== undefined) right(usage.codemode, COMPACT.codemode);
    if (usage.sandbox !== undefined) right(usage.sandbox, COMPACT.codemode);
    if (usage.preset !== undefined) right(usage.preset, COMPACT.preset);
    if (usage.host !== undefined) right(usage.host, COMPACT.host);
    const quota = full ? undefined : this.source.quota?.();
    const quotaItem = typeof quota === "object" ? compactQuotaItem(quota.quota, theme) : undefined;
    if (quotaItem !== undefined) right(quotaItem, COMPACT.quota);
    return parts;
  }

  /** `目录 ⎇ 分支 短提交 +a −b`：三项同组、各自按优先级丢弃；full 另带 `↑N ↓N` 并按参考配色。 */
  private gitParts(p: { branch: number; dir: number; diff: number }, full: boolean): Part[] {
    const git = this.source.git?.();
    if (git === undefined) return [];
    const theme = this.theme;
    const g = theme.glyphs;
    const dim = (text: string): string => theme.fg("dim", text);
    const ok = (text: string): string => (full ? theme.fg("success", text) : dim(text));
    const out: Part[] = [];
    const add = (text: string, priority: number): void =>
      void out.push({ text, priority, zone: "right", group: "git" });
    if (git.dir !== "") add(ok(git.dir), p.dir);
    const info = git.info;
    if (info === undefined) return out;
    const head: string[] = [];
    if (info.branch !== undefined) head.push(ok(info.branch));
    if (info.shortHead !== undefined) head.push(dim(info.shortHead));
    if (full && info.ahead !== undefined && info.ahead > 0) {
      head.push(theme.fg("code", `${g.arrowUp}${info.ahead}`));
    }
    if (full && info.behind !== undefined && info.behind > 0) {
      head.push(theme.fg("error", `${g.arrowDown}${info.behind}`));
    }
    if (!full) {
      const text = [info.branch, info.shortHead].filter((s) => s !== undefined).join(" ");
      if (text !== "") add(dim(`${g.branch} ${text}`), p.branch);
    } else if (head.length > 0) add(`${dim(g.branch)} ${head.join(" ")}`, p.branch);
    if (info.insertions !== undefined && info.deletions !== undefined) {
      const { insertions: a, deletions: d } = info;
      add(
        full
          ? `${dim("(")}${theme.fg("success", `+${a}`)}${dim(",")}${theme.fg("error", `-${d}`)}${dim(")")}`
          : dim(`+${a} ${g.ascii ? "-" : "−"}${d}`),
        p.diff,
      );
    }
    return out;
  }

  render(width: number): string[] {
    const style = this.layout() === "full" ? FULL_STYLE : {};
    return [layoutRow(this.parts(width), width, this.theme, style)];
  }

  invalidate(): void {
    this.stats = undefined;
  }
}
