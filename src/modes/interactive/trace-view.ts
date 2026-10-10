/**
 * `/trace` 覆盖层（docs/history/wave6-plan.md §2.4）。[W6-T1]
 *
 * - `/trace`（当前会话）、`/trace t2`（以任务 t2 为根：ama 子会话的子轨迹，或外部 Agent 骨架）。
 * - 主屏约束下的覆盖层：`anchor: "bottom"`、高度 `rows − 1`（同 rewind 面板）；退出撤掉覆盖层，消息区不变。
 * - 布局：标题汇总一行 + 列表窗口 + 按键提示一行；只格式化可见窗口里的行（10k 节点也只算可见行）。
 * - 键：↑↓ / PgUp PgDn / Home End 移动；→ 展开（子 Agent 展开即懒加载子轨迹）或进第一个子行；← 折叠或回父行；
 *   Enter 详情卡片（再按或 Esc 返回）；「更早的 N 个回合」行上 Enter / ↑ 加载前一页；f 跟随开关（进行中自动开，
 *   手动上移暂停，End 恢复）；Esc 先关详情再关视图。
 * - 刷新：会话事件（`entry_appended` / `telemetry_tick` / 工具起止 / 请求起止）触发，节流 ≤ 2 Hz；每次整棵
 *   重建（构建器是 O(条目) 的纯函数，10k 节点实测见 trace-view.test.ts），展开状态与光标按行 key 保留。
 */

import type { AgentSession } from "../../agent/types.js";
import { msg } from "../../i18n/index.js";
import {
  defaultKeybindings,
  matchesKey,
  padToWidth,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type Keybindings,
  type OverlayHandle,
  type Theme,
} from "../../tui.js";
import { buildTrace, findSubagent, loadSubagentTrace } from "../../trace/build.js";
import {
  describeNode,
  detailLines,
  entryLookup,
  type TraceEntryLookup,
} from "../../trace/detail.js";
import {
  flattenNode,
  flattenTrace,
  needsChild,
  rowIndex,
  tailStart,
  type TraceRow,
} from "../../trace/flatten.js";
import { formatRow, rowLabel, summaryText } from "../../trace/format.js";
import { childLoader, LiveTracker, traceInputOf, type ChildLoader } from "../../trace/session.js";
import type { Trace, TraceSubagentNode } from "../../trace/types.js";
import type { NoticeLevel } from "./message-view.js";

/** 尾部优先：首屏与每次向前翻页的回合数。 */
export const TRACE_PAGE_TURNS = 50;
/** 刷新节流（≤ 2 Hz）。 */
export const TRACE_REFRESH_MS = 500;

export interface TraceViewHost {
  theme: Theme;
  keybindings?: Keybindings;
  showOverlay(component: Component, options: { anchor: "bottom" }): OverlayHandle;
  rows(): number;
  session(): AgentSession;
  now(): number;
  notice(level: NoticeLevel, text: string): void;
  /** 请求重画（异步刷新后）。 */
  render?(): void;
  /** 子会话读取（测试注入）；缺省只读读文件、按 mtime 缓存。 */
  loadChild?: ChildLoader;
  /** 刷新节流（测试用 0）。 */
  refreshMs?: number;
}

export class TraceView implements Component, Focusable {
  focused = false;
  private trace!: Trace;
  private root: TraceSubagentNode | undefined;
  private rows: TraceRow[] = [];
  private lookup!: TraceEntryLookup;
  private readonly expanded = new Map<string, boolean>();
  /** 已展开过的 ama 子 Agent（重建后重新挂子轨迹）。 */
  private readonly loaded = new Set<string>();
  private fromTurn = 0;
  private cursor = 0;
  private top = 0;
  private follow = false;
  private detail: { row: TraceRow; scroll: number } | undefined;
  readonly live: LiveTracker;
  private readonly loadChild: ChildLoader;

  constructor(
    private readonly host: TraceViewHost,
    private readonly taskId: string | undefined,
    private readonly close: () => void,
  ) {
    this.live = new LiveTracker(host.session, host.now);
    this.loadChild = host.loadChild ?? childLoader();
    this.rebuild();
    this.follow = this.trace.partial;
    if (taskId === undefined) this.fromTurn = tailStart(this.trace, TRACE_PAGE_TURNS);
    if (this.root !== undefined) this.expanded.set(this.rowsKeyOfRoot(), true);
    this.reflow();
    this.cursor = Math.max(0, this.rows.length - 1);
  }

  /** 任务存在（`/trace <id>`）或看主会话。 */
  get found(): boolean {
    return this.taskId === undefined || this.root !== undefined;
  }

  private rowsKeyOfRoot(): string {
    return `a:${this.taskId}`;
  }

  /** 重建轨迹（会话条目 + live 叠加 + 已展开的子轨迹）。 */
  rebuild(): void {
    const session = this.host.session();
    const input = traceInputOf(session);
    this.trace = buildTrace(input, { live: this.live.overlay() });
    for (const taskId of this.loaded) {
      const node = findSubagent(this.trace, taskId);
      if (node !== undefined) loadSubagentTrace(node, this.loadChild);
    }
    if (this.taskId !== undefined) {
      this.root = findSubagent(this.trace, this.taskId);
      if (this.root !== undefined) loadSubagentTrace(this.root, this.loadChild);
    }
    const children = this.loadChild.inputs().flatMap((i) => i.entries);
    this.lookup = entryLookup([...input.entries, ...children], session.state.cwd);
  }

  /** 重新摊平，光标按 key 保持；跟随时贴底。 */
  private reflow(): void {
    const key = this.rows[this.cursor]?.key;
    const opts = { expanded: this.expanded, fromTurn: this.fromTurn };
    this.rows =
      this.root !== undefined ? flattenNode(this.root, opts) : flattenTrace(this.trace, opts);
    const at = key === undefined ? -1 : rowIndex(this.rows, key);
    this.cursor = this.follow
      ? Math.max(0, this.rows.length - 1)
      : at >= 0
        ? at
        : Math.min(this.cursor, Math.max(0, this.rows.length - 1));
    if (this.detail !== undefined) {
      const fresh = this.rows[rowIndex(this.rows, this.detail.row.key)];
      if (fresh !== undefined) this.detail.row = fresh;
    }
  }

  /** 会话有变化：重建并重排。 */
  refresh(): void {
    this.rebuild();
    this.reflow();
  }

  /** 当前行数（测试用）。 */
  get rowCount(): number {
    return this.rows.length;
  }

  get cursorIndex(): number {
    return this.cursor;
  }

  get selected(): TraceRow | undefined {
    return this.rows[this.cursor];
  }

  get following(): boolean {
    return this.follow;
  }

  get detailOpen(): boolean {
    return this.detail !== undefined;
  }

  private bodyHeight(): number {
    return Math.max(1, this.host.rows() - 1 - 2);
  }

  private move(delta: number): void {
    if (this.rows.length === 0) return;
    if (delta < 0) this.follow = false;
    // 第一行是「更早的回合」时继续上移 = 加载前一页
    if (delta < 0 && this.cursor === 0 && this.rows[0]?.node.kind === "more")
      return this.loadEarlier();
    this.cursor = Math.max(0, Math.min(this.rows.length - 1, this.cursor + delta));
    if (delta > 0 && this.cursor === this.rows.length - 1 && this.trace.partial) this.follow = true;
  }

  private loadEarlier(): void {
    const key = this.rows[1]?.key;
    this.fromTurn = Math.max(0, this.fromTurn - TRACE_PAGE_TURNS);
    this.reflow();
    const at = key === undefined ? -1 : rowIndex(this.rows, key);
    this.cursor = Math.max(0, at - 1);
  }

  private expand(): void {
    const row = this.selected;
    if (row === undefined) return;
    if (!row.expandable) return;
    if (!row.expanded) {
      if (needsChild(row.node)) {
        this.loaded.add(row.node.taskId);
        loadSubagentTrace(row.node, this.loadChild);
        this.rebuild();
      }
      this.expanded.set(row.key, true);
      this.reflow();
      return;
    }
    if (this.rows[this.cursor + 1]?.depth === row.depth + 1) this.cursor++;
  }

  private collapse(): void {
    const row = this.selected;
    if (row === undefined) return;
    this.follow = false;
    if (row.expanded) {
      this.expanded.set(row.key, false);
      this.reflow();
      return;
    }
    const slash = row.key.lastIndexOf("/");
    if (slash < 0) return;
    const parent = rowIndex(this.rows, row.key.slice(0, slash));
    if (parent >= 0) this.cursor = parent;
  }

  handleInput(data: string): void {
    const keys = this.host.keybindings ?? defaultKeybindings;
    if (this.detail !== undefined) return this.detailInput(data, keys);
    const page = this.bodyHeight();
    if (keys.matches(data, "tui.select.up")) this.move(-1);
    else if (keys.matches(data, "tui.select.down")) this.move(1);
    else if (keys.matches(data, "tui.select.pageUp")) this.move(-page);
    else if (keys.matches(data, "tui.select.pageDown")) this.move(page);
    else if (matchesKey(data, "home")) {
      this.follow = false;
      this.cursor = 0;
    } else if (matchesKey(data, "end")) {
      this.cursor = Math.max(0, this.rows.length - 1);
      this.follow = this.trace.partial;
    } else if (matchesKey(data, "right")) this.expand();
    else if (matchesKey(data, "left")) this.collapse();
    else if (matchesKey(data, "enter")) {
      const row = this.selected;
      if (row?.node.kind === "more") this.loadEarlier();
      else if (row !== undefined && row.node.kind !== "aux_group") this.detail = { row, scroll: 0 };
    } else if (data === "f") {
      this.follow = !this.follow;
      if (this.follow) this.cursor = Math.max(0, this.rows.length - 1);
    } else if (matchesKey(data, "escape") || keys.matches(data, "tui.select.cancel")) this.close();
  }

  private detailInput(data: string, keys: Keybindings): void {
    const detail = this.detail!;
    const page = this.bodyHeight();
    if (keys.matches(data, "tui.select.up")) detail.scroll = Math.max(0, detail.scroll - 1);
    else if (keys.matches(data, "tui.select.down")) detail.scroll++;
    else if (keys.matches(data, "tui.select.pageUp"))
      detail.scroll = Math.max(0, detail.scroll - page);
    else if (keys.matches(data, "tui.select.pageDown")) detail.scroll += page;
    else if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "left"))
      this.detail = undefined;
  }

  private ctx() {
    return {
      theme: this.host.theme,
      describe: (n: TraceRow["node"]) => describeNode(n, this.lookup),
    };
  }

  private headerLine(width: number): string {
    const theme = this.host.theme;
    const m = msg().trace;
    const root = this.root;
    const title = root !== undefined ? m.taskTitle(root.taskId, root.agent) : m.title;
    const source = root !== undefined ? root.child : this.trace;
    const summary = source !== undefined ? ` · ${summaryText(source, theme)}` : "";
    const state = this.trace.partial ? (this.follow ? m.follow.on : m.follow.off) : "";
    const right = state === "" ? "" : ` ${theme.fg(this.follow ? "accent" : "muted", state)}`;
    const left = truncateToWidth(
      `${theme.bold(title)}${theme.fg("muted", summary)}`,
      Math.max(1, width - visibleWidth(right)),
      theme.glyphs.ellipsis,
    );
    return padToWidth(`${left}${right}`, width);
  }

  render(width: number): string[] {
    const theme = this.host.theme;
    const height = this.bodyHeight();
    const lines = [this.headerLine(width)];
    if (this.detail !== undefined) {
      const { row } = this.detail;
      const body = [
        theme.bold(rowLabel(row, this.ctx())),
        ...detailLines(row.node, this.lookup, Math.max(8, width - 2), theme, this.trace.startedAt),
      ].map((l) => ` ${l}`);
      const max = Math.max(0, body.length - height);
      this.detail.scroll = Math.min(this.detail.scroll, max);
      for (const line of body.slice(this.detail.scroll, this.detail.scroll + height))
        lines.push(padToWidth(truncateToWidth(line, width, theme.glyphs.ellipsis), width));
    } else if (this.rows.length === 0)
      lines.push(padToWidth(theme.dim(` ${msg().trace.empty}`), width));
    else {
      // 窗口：光标始终可见；跟随时贴底
      if (this.cursor < this.top) this.top = this.cursor;
      if (this.cursor >= this.top + height) this.top = this.cursor - height + 1;
      this.top = Math.max(0, Math.min(this.top, Math.max(0, this.rows.length - height)));
      const ctx = this.ctx();
      for (let i = this.top; i < Math.min(this.rows.length, this.top + height); i++)
        lines.push(formatRow(this.rows[i] as TraceRow, width, ctx, i === this.cursor));
    }
    while (lines.length < height + 1) lines.push(" ".repeat(width));
    const hints = msg().trace.hints;
    const hint =
      this.detail !== undefined ? hints.detail : width < 60 ? hints.listNarrow : hints.list;
    lines.push(padToWidth(truncateToWidth(theme.dim(hint), width, theme.glyphs.ellipsis), width));
    return lines;
  }

  invalidate(): void {}
}

/**
 * 打开 `/trace` 覆盖层；关闭时 resolve。任务不存在时提示一行、不打开。
 */
export function openTraceView(host: TraceViewHost, taskId?: string): Promise<void> {
  return new Promise((resolve) => {
    let handle: OverlayHandle | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    let last = 0;
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe?.();
      handle?.hide();
      host.render?.();
      resolve();
    };
    const view = new TraceView(host, taskId, finish);
    if (!view.found) {
      host.notice("warn", msg().trace.taskNotFound(taskId as string));
      resolve();
      return;
    }
    const throttle = host.refreshMs ?? TRACE_REFRESH_MS;
    const flush = (): void => {
      timer = undefined;
      last = host.now();
      view.refresh();
      host.render?.();
    };
    unsubscribe = host.session().subscribe((event) => {
      if (!view.live.onEvent(event) || timer !== undefined) return;
      const wait = Math.max(0, throttle - (host.now() - last));
      if (wait === 0) flush();
      else {
        timer = setTimeout(flush, wait);
        timer.unref?.();
      }
    });
    handle = host.showOverlay(view, { anchor: "bottom" });
  });
}
