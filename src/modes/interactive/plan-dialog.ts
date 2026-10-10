/**
 * 计划审批对话框（docs/history/wave5-plan.md §6.1、§6.3）：底部覆盖层，与权限审批框同一手法。[W5-U]
 *
 * ```
 * ╭─ 计划待审批 ──────────────────────────────────────────────╮
 * │ 计划 v1 · 3 步 · ~/.local/share/ama/plans/3f2a9c1e-v1.md  │
 * │ 给 status-bar 加回退模型显示                              │
 * │   S1 读 status-bar.ts 与 status-area.ts                   │
 * │   …                                                       │
 * │                                                           │
 * │ › 1. 批准并执行                                           │
 * │   2. 批准，在新上下文执行                                 │
 * │   3. 继续修改…                                            │
 * │   4. 放弃，退出 Plan 模式                                 │
 * │                                                           │
 * │ ↑↓ 选择 · Enter 确认 · e 编辑计划 · Esc 留在 Plan         │
 * ╰───────────────────────────────────────────────────────────╯
 * ```
 *
 * - 1 / 2 之后选执行模式：回到进入前的模式（缺省）/ Accept edits / Auto；Esc 回到上一步。
 * - 3「继续修改」：行内写意见（Enter 发送，`Ctrl+E` 改用外部编辑器写），意见作为普通用户消息、留在 plan；
 *   Esc 回到上一步。
 * - `e`：在外部编辑器（`$VISUAL` / `$EDITOR`，TUI 挂起）里改计划全文；批准时以改后的版本（version + 1）
 *   交接。
 * - 4「放弃」：计划标 rejected 并退出 Plan 模式（回到进入前的模式）；Esc：计划标 rejected、留在 Plan 模式
 *   （§6.1）。
 * - 宽 < 56 时紧凑：去掉空行、按键提示缩短。ASCII 字形走 theme.glyphs。
 */

import type { PlanData } from "../../agent/types.js";
import { msg } from "../../i18n/index.js";
import { permissionModeLabel } from "../../permissions/modes.js";
import type { PermissionMode } from "../../permissions/types.js";
import {
  Box,
  defaultKeybindings,
  isPasteData,
  isPrintableText,
  matchesKey,
  padToWidth,
  truncateToWidth,
  unwrapPaste,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type Keybindings,
  type OverlayHandle,
  type Theme,
} from "../../tui.js";
import { planTitle } from "./plan-command.js";

/** 对话框里最多列出的步骤数。 */
export const PLAN_DIALOG_STEPS = 6;
const COMPACT_WIDTH = 56;

export type PlanChoice =
  | { decision: "approve" | "approve_fresh"; mode: PermissionMode; editedMarkdown?: string }
  | { decision: "revise"; feedback: string }
  /** `exit`：放弃并退出 Plan 模式（选项 4）；Esc 为 false。 */
  | { decision: "reject"; exit: boolean };

export interface PlanDialogHost {
  theme: Theme;
  keybindings?: Keybindings;
  showOverlay(component: Component): OverlayHandle;
  /** 外部编辑器：返回改后的文本，取消或失败返回 undefined。 */
  editExternal?(text: string, kind: "plan" | "feedback"): Promise<string | undefined>;
  /** 计划文件路径的显示（缩写家目录）。 */
  displayPath?(path: string): string;
  /** 重画（外部编辑器回来之后）。 */
  render?(): void;
  onOpen?(): void;
  onClose?(): void;
}

export interface PlanDialogInput {
  plan: PlanData;
  /** 「回到进入前的模式」对应的执行模式。 */
  preMode: PermissionMode;
}

function mainOptions(ellipsis: string): readonly string[] {
  const m = msg().plan.dialog;
  return [m.optionApprove, m.optionApproveFresh, m.optionRevise(ellipsis), m.optionReject];
}
const MAIN_COUNT = 4;

type Stage = "main" | "mode" | "revise" | "editing";

export class PlanDialog implements Component, Focusable {
  focused = false;
  private stage: Stage = "main";
  private selected = 0;
  private modeSelected = 0;
  /** 选执行模式时记下的是 1 还是 2。 */
  private fresh = false;
  private feedback = "";
  private edited: string | undefined;

  constructor(
    private readonly input: PlanDialogInput,
    private readonly host: PlanDialogHost,
    private readonly done: (choice: PlanChoice) => void,
  ) {}

  private modes(): { mode: PermissionMode; label: string }[] {
    const pre = this.input.preMode;
    return [
      { mode: pre, label: msg().plan.dialog.modeBack(permissionModeLabel(pre)) },
      { mode: "auto-edit", label: permissionModeLabel("auto-edit") },
      { mode: "auto", label: permissionModeLabel("auto") },
    ];
  }

  handleInput(data: string): void {
    switch (this.stage) {
      case "main":
        return this.mainInput(data);
      case "mode":
        return this.modeInput(data);
      case "revise":
        return this.reviseInput(data);
      case "editing":
        return;
    }
  }

  private keys(): Keybindings {
    return this.host.keybindings ?? defaultKeybindings;
  }

  private cancelKey(data: string): boolean {
    const keys = this.keys();
    return (
      matchesKey(data, "escape") ||
      keys.matches(data, "app.clear") ||
      keys.matches(data, "tui.select.cancel")
    );
  }

  private mainInput(data: string): void {
    const keys = this.keys();
    if (this.cancelKey(data)) return this.done({ decision: "reject", exit: false });
    if (/^[1-4]$/.test(data)) return this.choose(Number(data) - 1);
    if (keys.matches(data, "tui.select.up"))
      this.selected = (this.selected + MAIN_COUNT - 1) % MAIN_COUNT;
    else if (keys.matches(data, "tui.select.down"))
      this.selected = (this.selected + 1) % MAIN_COUNT;
    else if (matchesKey(data, "enter")) this.choose(this.selected);
    else if (data === "e" || data === "E") void this.editPlan();
  }

  private choose(index: number): void {
    this.selected = index;
    if (index === 0 || index === 1) {
      this.fresh = index === 1;
      this.modeSelected = 0;
      this.stage = "mode";
    } else if (index === 2) {
      this.stage = "revise";
    } else this.done({ decision: "reject", exit: true });
  }

  private modeInput(data: string): void {
    const keys = this.keys();
    const modes = this.modes();
    if (this.cancelKey(data)) {
      this.stage = "main";
      return;
    }
    if (/^[1-3]$/.test(data)) return this.approve(modes[Number(data) - 1]!.mode);
    if (keys.matches(data, "tui.select.up"))
      this.modeSelected = (this.modeSelected + modes.length - 1) % modes.length;
    else if (keys.matches(data, "tui.select.down"))
      this.modeSelected = (this.modeSelected + 1) % modes.length;
    else if (matchesKey(data, "enter")) this.approve(modes[this.modeSelected]!.mode);
  }

  private approve(mode: PermissionMode): void {
    this.done({
      decision: this.fresh ? "approve_fresh" : "approve",
      mode,
      ...(this.edited !== undefined ? { editedMarkdown: this.edited } : {}),
    });
  }

  private reviseInput(data: string): void {
    if (this.cancelKey(data)) {
      this.stage = "main";
      return;
    }
    if (matchesKey(data, "enter")) {
      if (this.feedback.trim() !== "") this.done({ decision: "revise", feedback: this.feedback });
      return;
    }
    if (matchesKey(data, "ctrl+e")) return void this.editFeedback();
    if (matchesKey(data, "backspace")) {
      this.feedback = [...this.feedback].slice(0, -1).join("");
      return;
    }
    if (isPasteData(data)) {
      this.feedback += unwrapPaste(data).replace(/\r\n?/g, "\n");
      return;
    }
    if (isPrintableText(data)) this.feedback += data;
  }

  private async editPlan(): Promise<void> {
    if (this.host.editExternal === undefined) return;
    this.stage = "editing";
    const before = this.edited ?? this.input.plan.markdown;
    const after = await this.host.editExternal(before, "plan").catch(() => undefined);
    if (after !== undefined && after.trim() !== "" && after !== this.input.plan.markdown)
      this.edited = after;
    this.stage = "main";
    this.host.render?.();
  }

  private async editFeedback(): Promise<void> {
    if (this.host.editExternal === undefined) return;
    this.stage = "editing";
    const after = await this.host.editExternal(this.feedback, "feedback").catch(() => undefined);
    this.stage = "revise";
    if (after !== undefined && after.trim() !== "") {
      this.done({ decision: "revise", feedback: after.trim() });
      return;
    }
    this.host.render?.();
  }

  render(width: number): string[] {
    const compact = width + 4 < COMPACT_WIDTH;
    const lines: string[] = [];
    const push = (line: string): void => void lines.push(...wrapTextWithAnsi(line, width));
    const blank = (): void => {
      if (!compact) lines.push("");
    };
    // 摘要（版本、标题、步骤）窄屏截断不折行：续行顶格会和步骤编号对不齐
    lines.push(...this.summary());
    blank();
    switch (this.stage) {
      case "main":
        lines.push(
          ...this.optionLines(mainOptions(this.host.theme.glyphs.ellipsis), this.selected, width),
        );
        break;
      case "mode":
        push(
          this.host.theme.bold(
            this.fresh ? msg().plan.dialog.modeHeadingFresh : msg().plan.dialog.modeHeading,
          ),
        );
        lines.push(
          ...this.optionLines(
            this.modes().map((m) => m.label),
            this.modeSelected,
            width,
          ),
        );
        break;
      case "revise":
        lines.push(...this.reviseLines(width, compact));
        break;
      case "editing":
        push(this.host.theme.fg("dim", msg().plan.dialog.editing(this.host.theme.glyphs.ellipsis)));
        break;
    }
    blank();
    lines.push(this.host.theme.fg("dim", this.hint(compact)));
    return lines.map((line) => truncateToWidth(line, width));
  }

  /** 版本、步数、文件、标题与前几步。 */
  private summary(): string[] {
    const { theme } = this.host;
    const plan = this.input.plan;
    const sep = theme.fg("dim", " · ");
    const m = msg().plan.dialog;
    const head = [m.version(plan.version), m.stepCount(plan.steps.length)];
    if (plan.filePath !== undefined)
      head.push(this.host.displayPath?.(plan.filePath) ?? plan.filePath);
    const out = [theme.fg("muted", head.join(sep))];
    out.push(theme.bold(planTitle({ markdown: this.edited ?? plan.markdown })));
    if (this.edited !== undefined) {
      out.push(theme.fg("warning", m.edited));
      return out;
    }
    for (const step of plan.steps.slice(0, PLAN_DIALOG_STEPS))
      out.push(`  ${theme.fg("dim", step.id)} ${step.text}`);
    const hidden = plan.steps.length - PLAN_DIALOG_STEPS;
    if (hidden > 0) out.push(theme.fg("dim", m.moreSteps(theme.glyphs.ellipsis, hidden)));
    return out;
  }

  private optionLines(labels: readonly string[], selected: number, width: number): string[] {
    const { theme } = this.host;
    const g = theme.glyphs;
    return labels.map((label, i) => {
      const on = i === selected;
      const text = `${on ? g.prompt : " "} ${i + 1}. ${label}`;
      const line = padToWidth(
        truncateToWidth(on ? theme.fg("accent", theme.bold(text)) : text, width),
        width,
      );
      return on ? theme.bg("selection", line) : line;
    });
  }

  private reviseLines(width: number, compact: boolean): string[] {
    const { theme } = this.host;
    const g = theme.glyphs;
    const m = msg().plan.dialog;
    const out = [theme.bold(compact ? m.feedbackCompact : m.feedback)];
    const cursor = "\x1b[7m \x1b[27m";
    const text = this.feedback.replace(/\n/g, " ⏎ ");
    const body = `${theme.fg("user", g.prompt)} ${text}${cursor}`;
    out.push(...wrapTextWithAnsi(body, width));
    return out;
  }

  private hint(compact: boolean): string {
    const g = this.host.theme.glyphs;
    const arrows = g.arrowUp + g.arrowDown;
    const edit = this.host.editExternal !== undefined;
    const m = msg().plan.dialog;
    switch (this.stage) {
      case "main":
        return compact ? m.hintMainCompact(arrows, edit) : m.hintMain(arrows, edit);
      case "mode":
        return compact ? m.hintModeCompact(arrows) : m.hintMode(arrows);
      case "revise":
        return compact ? m.hintReviseCompact(edit) : m.hintRevise(edit);
      case "editing":
        return m.hintEditing;
    }
  }

  invalidate(): void {}
}

/** 打开对话框，等用户选择。 */
export function openPlanDialog(host: PlanDialogHost, input: PlanDialogInput): Promise<PlanChoice> {
  return new Promise((resolve) => {
    let handle: OverlayHandle | undefined;
    let settled = false;
    const dialog = new PlanDialog(input, host, (choice) => {
      if (settled) return;
      settled = true;
      handle?.hide();
      host.onClose?.();
      resolve(choice);
    });
    host.onOpen?.();
    handle = host.showOverlay(
      new Box(dialog, { title: msg().plan.dialog.title, theme: host.theme }),
    );
  });
}
