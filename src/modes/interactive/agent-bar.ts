/**
 * Agent 栏（docs/wave6-plan.md §1.1–§1.2、D1、D4）。[W6-A]
 *
 * 装配在提示行之下、状态行之上。每个任务一行，最多 3 行，多出的给一行「另 N 个」：
 *
 * ```
 * ⏺ t1 explore · 运行中 1m05s · 3 轮 · grep  找测试缺口
 * ⏺ t2 codex · 等待审批
 * ⏺ t3 explore · 完成 12s · 2 轮
 * 另 1 个
 * ```
 *
 * - 显示条件：有排队 / 运行中 / 等审批的任务，或本会话里看着结束、还没查看过的任务（结束后最多 10 分钟）；
 *   `ui.agentBar: "off"`（嵌入宿主缺省）整个不显示。
 * - 聚焦（`Ctrl+B` / 空输入 `↓` / `/tasks`）：列出本会话全部任务，`›` 标当前项，窗口跟着选择滚动，
 *   末行是按键提示（`↑↓ 选择 · Enter 打开 · b 转后台 · x 停止 · Esc 返回`，放不下时丢 b / x 说明）。
 *   按键处理在 agent-ui.ts。
 * - [W7-C] 等审批的行（含停靠在栏里的后台任务审批）整行警告色。
 * - 状态来自任务注册表（`TaskInfo`、`live().queued`）、子 Agent 折叠视图的跟踪（轮数、最近工具、用时，界面时钟）
 *   与 `permission_request.context.taskId`（等审批）。
 */

import type { SubagentRegistry } from "../../agent/subagent-registry.js";
import type { SubagentStatus } from "../../agent/types.js";
import { msg } from "../../i18n/index.js";
import type { TaskInfo } from "../../tools/types.js";
import {
  formatElapsed,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Theme,
} from "../../tui.js";
import type { SubagentTracker } from "./subagent-view.js";

export const BAR_ROWS = 3;
/** 结束后未查看的任务在栏里保留多久。 */
export const BAR_RETAIN_MS = 10 * 60_000;

export type BarStatus = "queued" | "running" | "approval" | SubagentStatus;

export interface BarRow {
  taskId: string;
  agent: string;
  runner: string;
  description: string;
  status: BarStatus;
  turns: number;
  tool?: string;
  elapsedMs?: number;
}

/** 栏与视图读的任务注册表（当前会话的 `registryOf(sessionId)`；测试给假的）。 */
export type TaskSource = Pick<SubagentRegistry, "list" | "get" | "live" | "message">;

export interface AgentBarDeps {
  theme: Theme;
  registry(): TaskSource | undefined;
  tracker: SubagentTracker;
  now(): number;
  /** 正在等审批的任务。 */
  approvals(): ReadonlySet<string>;
  /** `ui.agentBar` 不是 off。 */
  enabled(): boolean;
}

const ACTIVE: ReadonlySet<BarStatus> = new Set(["queued", "running", "approval"]);

function taskNumber(taskId: string): number {
  const n = /^t(\d+)$/.exec(taskId);
  return n === null ? Number.MAX_SAFE_INTEGER : Number(n[1]);
}

/** 活动的在前，各组内按编号。 */
function compareRows(a: BarRow, b: BarRow): number {
  const group = (row: BarRow): number => (ACTIVE.has(row.status) ? 0 : 1);
  return group(a) - group(b) || taskNumber(a.taskId) - taskNumber(b.taskId);
}

export function statusLabel(status: BarStatus): string {
  return msg().agents.status[status];
}

export function statusColor(status: BarStatus): "accent" | "dim" | "warning" | "success" | "error" {
  switch (status) {
    case "running":
      return "accent";
    case "queued":
      return "dim";
    case "completed":
      return "success";
    case "failed":
      return "error";
    default:
      return "warning";
  }
}

/** 一条任务的栏 / 视图标题数据（状态、轮数、最近工具、用时；用时按界面时钟）。 */
export function taskRow(
  info: TaskInfo,
  ctx: { tracker: SubagentTracker; approvals: ReadonlySet<string>; queued: boolean; now: number },
): BarRow {
  const state = ctx.tracker.get(info.taskId);
  let status: BarStatus;
  if (info.status !== "running") status = info.status;
  else if (ctx.approvals.has(info.taskId)) status = "approval";
  else if (ctx.queued) status = "queued";
  else status = "running";
  const row: BarRow = {
    taskId: info.taskId,
    agent: info.agent,
    runner: info.runner,
    description: info.description,
    status,
    turns: Math.max(state?.turns ?? 0, info.turns ?? 0),
  };
  const tool = state?.tools.at(-1);
  if (tool !== undefined && status !== "queued") row.tool = tool;
  if (status !== "queued") {
    if (state !== undefined) row.elapsedMs = (state.endedAt ?? ctx.now) - state.startedAt;
    else if (info.endedAt !== undefined) row.elapsedMs = info.endedAt - info.startedAt;
  }
  return row;
}

/** `explore` / `gemini(acp:gemini)`。 */
export function agentLabel(row: Pick<BarRow, "agent" | "runner">): string {
  return row.runner !== "ama" && row.runner !== row.agent
    ? `${row.agent}(${row.runner})`
    : row.agent;
}

/** `运行中 1m05s · 3 轮 · grep`（不带颜色）。 */
export function rowFacts(row: BarRow, withTool = true): string {
  const facts = [statusLabel(row.status)];
  if (row.elapsedMs !== undefined) facts[0] += ` ${formatElapsed(row.elapsedMs)}`;
  if (row.turns > 0) facts.push(msg().agents.turns(row.turns));
  if (withTool && row.tool !== undefined && row.status === "running") facts.push(row.tool);
  return facts.join(" · ");
}

export class AgentBar implements Component {
  /** 聚焦时的选择（undefined = 未聚焦）。 */
  private index: number | undefined;
  private top = 0;
  /** 界面看到任务结束的时刻（界面时钟）。 */
  private readonly endedSeen = new Map<string, number>();
  private readonly viewed = new Set<string>();

  constructor(private readonly deps: AgentBarDeps) {}

  get focused(): boolean {
    return this.index !== undefined;
  }

  /** 本会话全部任务的行（排序后）。 */
  all(): BarRow[] {
    const registry = this.deps.registry();
    if (registry === undefined) return [];
    const approvals = this.deps.approvals();
    const now = this.deps.now();
    const rows = registry.list().map((info) => this.row(info, approvals, now));
    return rows.sort(compareRows);
  }

  /** 未聚焦时显示的行：活动的 + 本会话看着结束、未查看、10 分钟内的。 */
  visibleRows(): BarRow[] {
    if (!this.deps.enabled()) return [];
    const now = this.deps.now();
    return this.all().filter((row) => {
      if (ACTIVE.has(row.status)) return true;
      if (this.deps.tracker.get(row.taskId) === undefined || this.viewed.has(row.taskId))
        return false;
      const seen = this.endedSeen.get(row.taskId);
      return seen !== undefined && now - seen < BAR_RETAIN_MS;
    });
  }

  get visible(): boolean {
    return this.visibleRows().length > 0;
  }

  /** 聚焦；没有任务返回 false。 */
  focus(): boolean {
    if (!this.deps.enabled() || this.all().length === 0) return false;
    this.index = 0;
    this.top = 0;
    return true;
  }

  blur(): void {
    this.index = undefined;
    this.top = 0;
  }

  /** 移动选择；越过第一项返回 false（调用方退出栏）。 */
  move(delta: number): boolean {
    if (this.index === undefined) return false;
    const count = this.all().length;
    const next = this.index + delta;
    if (next < 0) return false;
    this.index = Math.min(next, Math.max(0, count - 1));
    return true;
  }

  selected(): string | undefined {
    if (this.index === undefined) return undefined;
    const rows = this.all();
    return rows[Math.min(this.index, rows.length - 1)]?.taskId;
  }

  /** 聚焦时选中某任务。 */
  select(taskId: string): void {
    if (this.index === undefined) return;
    const at = this.all().findIndex((row) => row.taskId === taskId);
    if (at >= 0) this.index = at;
  }

  /** 查看过（视图里看到了结束后的状态）：不再留在栏里。 */
  markViewed(taskId: string): void {
    this.viewed.add(taskId);
  }

  /** 换会话：清掉本会话的保留状态。 */
  reset(): void {
    this.blur();
    this.endedSeen.clear();
    this.viewed.clear();
  }

  private row(info: TaskInfo, approvals: ReadonlySet<string>, now: number): BarRow {
    const row = taskRow(info, {
      tracker: this.deps.tracker,
      approvals,
      queued: this.deps.registry()?.live(info.taskId)?.queued === true,
      now,
    });
    if (ACTIVE.has(row.status)) {
      // 又跑起来了（续聊）：重新计保留与查看
      this.endedSeen.delete(info.taskId);
      this.viewed.delete(info.taskId);
    } else if (!this.endedSeen.has(info.taskId)) this.endedSeen.set(info.taskId, now);
    return row;
  }

  render(width: number): string[] {
    const focused = this.index !== undefined;
    const rows = focused ? this.all() : this.visibleRows();
    const t = this.deps.theme;
    const m = msg().agents;
    if (rows.length === 0) return focused ? [truncateToWidth(t.fg("dim", m.bar.empty), width)] : [];
    let start = 0;
    if (this.index !== undefined) {
      this.index = Math.min(this.index, rows.length - 1);
      if (this.index < this.top) this.top = this.index;
      if (this.index >= this.top + BAR_ROWS) this.top = this.index - BAR_ROWS + 1;
      this.top = Math.max(0, Math.min(this.top, rows.length - BAR_ROWS));
      start = this.top;
    }
    const shown = rows.slice(start, start + BAR_ROWS);
    const out = shown.map((row, i) => this.line(row, width, focused, start + i === this.index));
    const hidden = rows.length - shown.length;
    const tail: string[] = [];
    if (hidden > 0) tail.push(m.bar.more(hidden));
    if (focused) {
      const [up, down] = [t.glyphs.arrowUp, t.glyphs.arrowDown];
      const full = [...tail, m.bar.keysFull(up, down)].join(" · ");
      tail.push(visibleWidth(full) <= width ? m.bar.keysFull(up, down) : m.bar.keys(up, down));
    }
    if (tail.length > 0)
      out.push(truncateToWidth(t.fg("dim", tail.join(" · ")), width, t.glyphs.ellipsis));
    return out;
  }

  private line(row: BarRow, width: number, focused: boolean, selected: boolean): string {
    const t = this.deps.theme;
    const g = t.glyphs;
    const agent = agentLabel(row);
    const lead = focused ? (selected ? t.fg("accent", g.prompt) : " ") + " " : "";
    const marker = t.fg(statusColor(row.status), g.tool);
    const approval = row.status === "approval";
    const plainId = selected || approval ? t.bold(row.taskId) : row.taskId;
    const id = approval ? t.fg("warning", plainId) : plainId;
    const description = row.description.replace(/\s+/g, " ").trim();
    const text =
      `${lead}${marker} ${id} ${t.fg("tool", agent)}` +
      t.fg("dim", " · ") +
      t.fg(row.status === "approval" ? "warning" : "muted", rowFacts(row)) +
      (description === "" ? "" : `  ${t.fg("dim", description)}`);
    return truncateToWidth(text, width, g.ellipsis);
  }

  invalidate(): void {}
}
