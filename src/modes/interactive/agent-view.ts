/**
 * 子 Agent 视图（docs/wave6-plan.md §1.1–§1.2、D2、D3）。[W6-A]
 *
 * 主屏约束下的「全屏」：底部覆盖层，高度 = 终端行数 − 1（不切备用屏；撤掉覆盖层后消息区与回滚历史不变）。
 *
 * ```
 * t2 explore · 运行中 1m05s · 3 轮 · ↑12k ↓3.4k · Esc 返回 · /tasks stop t2 停止
 * <正文：ama 子会话的消息与工具 / 外部 Agent 的实时输出，跟随尾部>
 * <一行提示：发送结果、已暂停跟随>
 * ────────
 * › 发给 t2
 * ────────
 * ```
 *
 * 按键：Enter 发给子 Agent（`registry.message`，留在视图）；输入为空时 Esc 返回、`←` `→` 切兄弟任务、
 * `↑` / PgUp 上翻（暂停跟随）、`↓` / PgDn 下翻、End（暂停时也可 `f`）回到跟随；输入非空时 Esc 清空。
 * Esc 不中断父会话，停止子任务用 `/tasks stop <id>`（视图里只认这一条命令）。
 * 所查看的任务在等审批时标题显示「等待审批」，审批框照常以覆盖层弹在视图上面。
 * [W7-C] `Ctrl+B`（`app.tasks.background`）转后台正在看的任务（只对前台任务有效，否则落回编辑器）；
 * 视图里另认 `/tasks bg [id]`。
 * [打断并发送] `Ctrl+X`（`app.message.interrupt`）= 打断该子 Agent 当前回合并立即发送（`registry.message` 的
 * interrupt）；外部 Agent 的驱动不能中断回合时退回排队并提示。`ui.enterWhileRunning: "interrupt"` 时与 Enter 互换。
 */

import type { SessionEvent } from "../../agent/types.js";
import { msg } from "../../i18n/index.js";
import {
  Editor,
  isPrintableText,
  parseKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type Keybindings,
  type Theme,
} from "../../tui.js";
import { formatTokenCount } from "../session-report.js";
import { agentLabel, rowFacts, statusColor, taskRow, type TaskSource } from "./agent-bar.js";
import {
  AmaTranscript,
  ExternalTranscript,
  readBranch,
  type ExternalSource,
} from "./agent-transcript.js";
import type { MessageViewOptions } from "./message-view.js";
import type { SubagentTracker } from "./subagent-view.js";
import { backgroundedText } from "./task-background.js";

export interface AgentViewDeps {
  theme: Theme;
  keys: Keybindings;
  registry(): TaskSource | undefined;
  tracker: SubagentTracker;
  approvals(): ReadonlySet<string>;
  now(): number;
  /** 终端行数（视图高度 = 行数 − 1）。 */
  rows(): number;
  render(): void;
  /** 兄弟任务的顺序（←/→）。 */
  siblings(): string[];
  /** 换了查看的任务（栏的选择跟着走）。 */
  onSwitch?(taskId: string): void;
  close(): void;
  stop(taskId: string): Promise<void>;
  /** [W7-C] 人工转后台；返回转了的 taskId。 */
  background?(taskId: string): string[];
  /** 消息区的显示选项（思考块、Markdown、紧凑）。 */
  messages?: Omit<MessageViewOptions, "theme">;
  /** `ui.enterWhileRunning`：`interrupt` 时 Enter 打断并发送、专用键排队。 */
  enterMode?(): "queue" | "interrupt";
}

type Body = (AmaTranscript | ExternalTranscript) & { readonly isEmpty: boolean };

export class AgentView implements Component, Focusable {
  private readonly editor: Editor;
  private body: Body | undefined;
  private off: (() => void) | undefined;
  private follow = true;
  /** 不跟随时正文窗口的首行。 */
  private top = 0;
  private lastBody: { total: number; height: number } = { total: 0, height: 0 };
  private flash: string | undefined;
  private notice: string | undefined;
  private _focused = false;

  constructor(
    private taskId: string,
    private readonly deps: AgentViewDeps,
  ) {
    this.editor = new Editor({
      theme: deps.theme,
      keybindings: deps.keys,
      maxVisibleLines: 4,
      placeholder: msg().agents.view.placeholder(taskId),
      requestRender: () => deps.render(),
      onSubmit: (text) => void this.submit(text, this.enterInterrupts()),
    });
    this.attach();
  }

  get task(): string {
    return this.taskId;
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value;
  }

  /** 接上任务的数据（打开、切兄弟任务、任务重新开跑）；任务不存在返回 false。 */
  attach(): boolean {
    this.off?.();
    this.off = undefined;
    this.notice = undefined;
    const registry = this.deps.registry();
    const live = registry?.live(this.taskId);
    if (registry === undefined || live === undefined) {
      this.body = undefined;
      return false;
    }
    const info = live.info;
    if (info.runner !== "ama") {
      const taskId = this.taskId;
      const source: ExternalSource = {
        events: () => registry.live(taskId)?.recent ?? [],
        running: () => registry.get(taskId)?.status === "running",
        runner: info.runner,
        ...(info.sessionRef?.sessionId !== undefined
          ? { sessionId: info.sessionRef.sessionId }
          : {}),
      };
      this.body = new ExternalTranscript(this.deps.theme, source);
      return true;
    }
    const body = new AmaTranscript({
      theme: this.deps.theme,
      ...this.deps.messages,
      now: this.deps.now,
    });
    this.body = body;
    if (live.entries !== undefined) {
      body.load(live.entries());
      this.off = live.observe?.((event: SessionEvent) => {
        if (body.onEvent(event)) this.deps.render();
      });
      return true;
    }
    const file = info.sessionRef?.sessionFile;
    if (file === undefined) {
      this.notice = msg().agents.view.noTranscript;
      return true;
    }
    try {
      body.load(readBranch(file));
    } catch (error) {
      this.notice = msg().agents.view.loadFailed(
        error instanceof Error ? error.message : String(error),
      );
    }
    return true;
  }

  dispose(): void {
    this.off?.();
    this.off = undefined;
  }

  /** 每秒：运行中的工具重画耗时。 */
  tick(): void {
    if (this.body instanceof AmaTranscript) this.body.tick();
  }

  private switchTo(delta: number): void {
    const list = this.deps.siblings();
    const at = list.indexOf(this.taskId);
    if (list.length < 2 || at < 0) return;
    const next = list[(at + delta + list.length) % list.length] as string;
    this.dispose();
    this.taskId = next;
    this.follow = true;
    this.top = 0;
    this.flash = undefined;
    this.editor.clear();
    this.attach();
    this.deps.onSwitch?.(next);
  }

  private enterInterrupts(): boolean {
    return this.deps.enterMode?.() === "interrupt";
  }

  private async submit(text: string, interrupt = false): Promise<void> {
    const m = msg().agents.view;
    const trimmed = text.trim();
    if (trimmed === "") return;
    const taskId = this.taskId;
    if (trimmed.startsWith("/")) {
      const stop = /^\/tasks\s+stop(?:\s+(\S+))?\s*$/.exec(trimmed);
      const bg = /^\/tasks\s+bg(?:\s+(\S+))?\s*$/.exec(trimmed);
      if (bg !== null && this.deps.background !== undefined)
        this.flash = backgroundedText(this.deps.background(bg[1] ?? taskId));
      else if (stop === null) this.flash = m.commandsHere;
      else {
        const target = stop[1] ?? taskId;
        try {
          await this.deps.stop(target);
          this.flash = m.stopped(target);
        } catch (error) {
          this.flash = error instanceof Error ? error.message : String(error);
        }
      }
      this.deps.render();
      return;
    }
    const registry = this.deps.registry();
    try {
      if (registry === undefined) throw new Error(m.unknown(taskId));
      const reply = await registry.message(taskId, text, interrupt);
      this.flash = m[reply](taskId);
    } catch (error) {
      this.flash = m.sendFailed(error instanceof Error ? error.message : String(error));
    }
    this.follow = true;
    this.deps.render();
  }

  handleInput(data: string): void {
    const keys = this.deps.keys;
    const empty = this.editor.isEmpty();
    const id = parseKey(data)?.id;
    this.flash = undefined;
    if (keys.matches(data, "app.tasks.background") && this.deps.background !== undefined) {
      const moved = this.deps.background(this.taskId);
      if (moved.length > 0) {
        this.flash = backgroundedText(moved);
        return;
      }
    }
    if (keys.matches(data, "app.message.interrupt") && !this.editor.isCompletionOpen) {
      const text = this.editor.takeSubmission();
      if (text !== null) void this.submit(text, !this.enterInterrupts());
      return;
    }
    if (keys.matches(data, "tui.select.cancel") && !this.editor.isCompletionOpen) {
      if (!empty) this.editor.clear();
      else this.deps.close();
      return;
    }
    if (empty) {
      if (id === "left" || id === "right") return this.switchTo(id === "left" ? -1 : 1);
      const page = Math.max(1, this.lastBody.height - 1);
      if (id === "up" || id === "pageup") return this.scroll(id === "up" ? -1 : -page);
      if (id === "down" || id === "pagedown") return this.scroll(id === "down" ? 1 : page);
      if (id === "end" || (id === "f" && !this.follow && isPrintableText(data))) {
        this.follow = true;
        return;
      }
    }
    this.editor.handleInput(data);
  }

  private scroll(delta: number): void {
    const { total, height } = this.lastBody;
    const bottom = Math.max(0, total - height);
    const from = this.follow ? bottom : this.top;
    const next = Math.max(0, Math.min(bottom, from + delta));
    if (delta > 0 && next >= bottom) {
      this.follow = true;
      return;
    }
    this.follow = false;
    this.top = next;
  }

  private title(width: number): string {
    const t = this.deps.theme;
    const m = msg().agents.view;
    const registry = this.deps.registry();
    const info = registry?.get(this.taskId);
    if (info === undefined) return truncateToWidth(t.bold(this.taskId), width);
    const row = taskRow(info, {
      tracker: this.deps.tracker,
      approvals: this.deps.approvals(),
      queued: registry?.live(this.taskId)?.queued === true,
      now: this.deps.now(),
    });
    const g = t.glyphs;
    const usage = this.deps.tracker.get(this.taskId)?.usage ?? info.usage;
    const tokens =
      usage !== undefined && usage.input + usage.output + usage.cacheRead > 0
        ? `${g.arrowUp}${formatTokenCount(usage.input + usage.cacheRead + usage.cacheWrite)} ${g.arrowDown}${formatTokenCount(usage.output)}`
        : undefined;
    const stop = info.status === "running" ? m.stopHint(this.taskId) : undefined;
    const compose = (withTokens: boolean, withStop: boolean): string => {
      const facts = [rowFacts(row, false), ...(withTokens && tokens ? [tokens] : [])];
      const hints = [m.back, ...(withStop && stop ? [stop] : [])];
      return (
        t.bold(`${this.taskId} ${agentLabel(row)}`) +
        t.fg("dim", " · ") +
        t.fg(statusColor(row.status), facts.join(" · ")) +
        t.fg("dim", ` · ${hints.join(" · ")}`)
      );
    };
    // 窄屏先丢用量、再丢停止提示，「Esc 返回」尽量留着
    for (const [withTokens, withStop] of [
      [true, true],
      [false, true],
      [false, false],
    ] as const) {
      const text = compose(withTokens, withStop);
      if (visibleWidth(text) <= width) return text;
    }
    return truncateToWidth(compose(false, false), width, g.ellipsis);
  }

  render(width: number): string[] {
    const t = this.deps.theme;
    const height = Math.max(5, this.deps.rows() - 1);
    const title = this.title(width);
    const input = this.editor.render(width);
    const footer = this.flash ?? (this.follow ? undefined : msg().agents.view.paused);
    const bodyHeight = Math.max(1, height - 1 - input.length - (footer === undefined ? 0 : 1));
    let lines = this.body?.render(width) ?? [];
    if (this.notice !== undefined) lines = [t.fg("warning", this.notice), "", ...lines];
    const total = lines.length;
    this.lastBody = { total, height: bodyHeight };
    const bottom = Math.max(0, total - bodyHeight);
    if (this.follow) this.top = bottom;
    else this.top = Math.min(this.top, bottom);
    const shown = lines.slice(this.top, this.top + bodyHeight);
    while (shown.length < bodyHeight) shown.push("");
    const out = [title, ...shown];
    if (footer !== undefined)
      out.push(truncateToWidth(t.fg("dim", footer), width, t.glyphs.ellipsis));
    out.push(...input);
    return out.slice(0, height);
  }

  invalidate(): void {
    this.body?.invalidate();
    this.editor.invalidate();
  }
}
