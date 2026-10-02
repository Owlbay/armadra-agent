/**
 * 回滚确认面板（rewind-plan §4）：底部覆盖层，左竖条样式与 `/session` 面板一致（`Card`）。[RW-C]
 *
 * - 标题「回滚到这条消息之前」+ 相对时间；消息原文最多 3 行（超出计数）。
 * - 选项编号列表：恢复代码和对话 / 恢复对话 / 恢复代码（两个代码项只在 dry-run 有改动时出现）/
 *   从这里摘要 / 摘要到这里 / 取消。每项下一行是预览（「将恢复 N 个文件 +x −y」「代码不变 · 对话将分叉」…）；
 *   宽 < 56 时只给选中项画预览、去空行。
 * - 两个摘要项可以在行内输入说明：选中后直接打字，Enter 提交；数字键直接执行（不带说明）；
 *   有说明时 Esc 先清空说明，再按才关闭。
 * - 冲突：选了代码类且 dry-run 有冲突 → 进入第二步「跳过冲突文件 / 覆盖冲突文件 / 返回」，
 *   覆盖对应 `onConflict: "overwrite"`。
 * - 明细：冲突与无法恢复的文件（各最多 5 个）、git HEAD 变化提示与两条命令（只显示，不执行）。
 */

import type { RewindMode, RewindPoint, RewindResult } from "../../checkpoints/types.js";
import { msg } from "../../i18n/index.js";
import {
  Card,
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
  type Theme,
} from "../../tui.js";
import {
  REWIND_DETAIL_MAX,
  skipReasonText,
  gitHintLines,
  hasCodeChanges,
  restorePreview,
} from "./rewind-text.js";
import { relativeTime } from "./startup-ui.js";

export type RewindAction = RewindMode | "summarize-from" | "summarize-up-to";

export interface RewindChoice {
  action: RewindAction;
  /** 摘要两项的说明。 */
  instructions?: string;
  /** 代码类且有冲突时的选择。 */
  onConflict?: "skip" | "overwrite";
}

export interface RewindPanelModel {
  point: RewindPoint;
  /** 代码 dry-run（`mode: "code"`）；没有检查点或预览失败时 undefined。 */
  preview?: RewindResult;
  /** 预览失败的说明。 */
  previewError?: string;
  now: number;
}

export interface RewindOption {
  action: RewindAction | "cancel";
  label: string;
  preview?: string;
  /** 可在行内输入说明。 */
  input?: boolean;
}

/** 宽度低于它（覆盖层外宽）时紧凑布局。 */
const COMPACT_WIDTH = 56;
const MESSAGE_LINES = 3;

/** 面板的选项（按显示顺序）。 */
export function rewindOptions(model: RewindPanelModel, ascii = false): RewindOption[] {
  const code = model.preview?.code;
  const withCode = hasCodeChanges(code);
  const m = msg().rewind.panel;
  const options: RewindOption[] = [];
  if (withCode) {
    options.push({
      action: "both",
      label: m.optionBoth,
      preview: m.previewBoth(restorePreview(code!, ascii)),
    });
  }
  options.push({
    action: "conversation",
    label: m.optionConversation,
    preview: withCode ? m.previewConversationKeep : m.previewConversation,
  });
  if (withCode) {
    options.push({
      action: "code",
      label: m.optionCode,
      preview: m.previewCode(restorePreview(code!, ascii)),
    });
  }
  options.push(
    {
      action: "summarize-from",
      label: m.optionSummarizeFrom,
      preview: m.previewSummarizeFrom,
      input: true,
    },
    {
      action: "summarize-up-to",
      label: m.optionSummarizeUpTo,
      preview: m.previewSummarizeUpTo,
      input: true,
    },
    { action: "cancel", label: m.optionCancel },
  );
  return options;
}

const CONFLICT_VALUES = ["skip", "overwrite", "back"] as const;

function conflictOptions(): { value: (typeof CONFLICT_VALUES)[number]; label: string }[] {
  const m = msg().rewind.panel;
  const labels = { skip: m.conflictSkip, overwrite: m.conflictOverwrite, back: m.conflictBack };
  return CONFLICT_VALUES.map((value) => ({ value, label: labels[value] }));
}

export interface RewindPanelHost {
  theme: Theme;
  keybindings?: Keybindings;
  /** 终端行数：整面板放不下时改用紧凑排版。 */
  rows?(): number;
}

/** 行数组组件（交给 Card 加竖条）。 */
class Lines implements Component {
  constructor(private readonly build: (width: number) => string[]) {}

  render(width: number): string[] {
    return this.build(width);
  }

  invalidate(): void {}
}

export class RewindPanel implements Component, Focusable {
  focused = false;
  private selected = 0;
  private readonly inputs = new Map<RewindAction, string>();
  private stage: { action: RewindAction; selected: number } | undefined;
  /** 终端放不下时：原文 1 行、文件清单并成一行、git 提示去掉说明。 */
  private tight = false;
  readonly options: readonly RewindOption[];

  constructor(
    private readonly model: RewindPanelModel,
    private readonly host: RewindPanelHost,
    private readonly done: (choice: RewindChoice | undefined) => void,
  ) {
    this.options = rewindOptions(model, host.theme.glyphs.ascii);
  }

  /** 当前选中项（测试用）。 */
  get selectedOption(): RewindOption {
    return this.options[this.selected]!;
  }

  /** 选中项的说明（测试用）。 */
  inputOf(action: RewindAction): string {
    return this.inputs.get(action) ?? "";
  }

  private get conflicts(): readonly string[] {
    return this.model.preview?.code?.conflicts ?? [];
  }

  private choose(option: RewindOption, instructions: string | undefined): void {
    if (option.action === "cancel") return this.done(undefined);
    if ((option.action === "both" || option.action === "code") && this.conflicts.length > 0) {
      this.stage = { action: option.action, selected: 0 };
      return;
    }
    const choice: RewindChoice = { action: option.action };
    const text = instructions?.trim() ?? "";
    if (option.input === true && text !== "") choice.instructions = text;
    this.done(choice);
  }

  handleInput(data: string): void {
    const keys = this.host.keybindings ?? defaultKeybindings;
    if (this.stage !== undefined) return this.conflictInput(data, keys);
    const option = this.options[this.selected]!;
    const action = option.action === "cancel" ? undefined : option.action;
    const text = action === undefined ? "" : (this.inputs.get(action) ?? "");
    const typing = option.input === true && text !== "";
    if (keys.matches(data, "tui.select.up")) this.move(-1);
    else if (keys.matches(data, "tui.select.down")) this.move(1);
    else if (matchesKey(data, "enter")) this.choose(option, text);
    else if (matchesKey(data, "escape") || keys.matches(data, "app.clear")) {
      if (typing && action !== undefined) this.inputs.set(action, "");
      else this.done(undefined);
    } else if (/^[1-9]$/.test(data) && !typing) {
      const index = Number(data) - 1;
      if (index < this.options.length) {
        this.selected = index;
        this.choose(this.options[index]!, undefined);
      }
    } else if (option.input === true && action !== undefined) {
      if (matchesKey(data, "backspace")) this.inputs.set(action, [...text].slice(0, -1).join(""));
      else if (isPasteData(data)) {
        this.inputs.set(action, text + unwrapPaste(data).replace(/\s+/g, " "));
      } else if (isPrintableText(data)) this.inputs.set(action, text + data);
    }
  }

  private move(delta: number): void {
    const n = this.options.length;
    this.selected = (this.selected + delta + n) % n;
  }

  private conflictInput(data: string, keys: Keybindings): void {
    const stage = this.stage!;
    const n = CONFLICT_VALUES.length;
    const pick = (index: number): void => {
      const value = CONFLICT_VALUES[index]!;
      if (value === "back") this.stage = undefined;
      else this.done({ action: stage.action, onConflict: value });
    };
    if (keys.matches(data, "tui.select.up")) stage.selected = (stage.selected + n - 1) % n;
    else if (keys.matches(data, "tui.select.down")) stage.selected = (stage.selected + 1) % n;
    else if (matchesKey(data, "enter")) pick(stage.selected);
    else if (/^[1-3]$/.test(data)) pick(Number(data) - 1);
    else if (matchesKey(data, "escape") || keys.matches(data, "app.clear")) this.stage = undefined;
  }

  render(width: number): string[] {
    const { theme } = this.host;
    const time = relativeTime(new Date(this.model.point.timestamp).toISOString(), this.model.now);
    const build = (tight: boolean): string[] => {
      this.tight = tight;
      return new Card(new Lines((w) => this.body(w, tight || width < COMPACT_WIDTH)), {
        theme,
        title: msg().rewind.panel.title,
        ...(time !== "" ? { subtitle: time } : {}),
      }).render(width);
    };
    const lines = build(false);
    const rows = this.host.rows?.();
    return rows !== undefined && lines.length > rows ? build(true) : lines;
  }

  invalidate(): void {}

  private body(width: number, compact: boolean): string[] {
    const { theme } = this.host;
    const m = msg().rewind.panel;
    const arrows = theme.glyphs.arrowUp + theme.glyphs.arrowDown;
    const out: string[] = [...this.messageLines(width)];
    const gap = (): void => {
      if (!compact) out.push("");
    };
    gap();
    if (this.stage !== undefined) {
      const conflicts = this.conflicts;
      out.push(
        ...this.fileLines(theme.fg("warning", m.conflictHead(conflicts.length)), conflicts, width),
      );
      gap();
      out.push(
        ...conflictOptions().map((o, i) =>
          this.optionLine(`${i + 1}. ${o.label}`, i === this.stage!.selected, width),
        ),
      );
      gap();
      out.push(theme.fg("dim", compact ? m.hintConflictCompact(arrows) : m.hintConflict(arrows)));
      return out;
    }
    this.options.forEach((option, i) => {
      const selected = i === this.selected;
      out.push(this.optionLine(this.optionLabel(option, i, selected), selected, width));
      if (option.preview !== undefined && (selected || !compact)) {
        const wrapped = wrapTextWithAnsi(theme.fg("dim", option.preview), Math.max(1, width - 5));
        out.push(...wrapped.map((line) => `     ${line}`));
      }
    });
    const details = this.detailLines(width);
    if (details.length > 0) {
      gap();
      out.push(...details);
    }
    gap();
    const n = this.options.length;
    out.push(theme.fg("dim", compact ? m.hintCompact(arrows, n) : m.hint(arrows, n)));
    return out;
  }

  private messageLines(width: number): string[] {
    const { theme } = this.host;
    const prompt = theme.glyphs.prompt;
    const all = this.model.point.text.replace(/\r\n?/g, "\n").split("\n");
    while (all.length > 1 && all[all.length - 1]!.trim() === "") all.pop();
    const max = this.tight ? 1 : MESSAGE_LINES;
    const shown = all
      .slice(0, max)
      .map((line, i) =>
        truncateToWidth(`${i === 0 ? theme.fg("accent", prompt) : " "} ${line}`, width),
      );
    if (all.length > max && !this.tight) {
      shown.push(
        theme.fg("dim", msg().rewind.panel.moreLines(theme.glyphs.ellipsis, all.length - max)),
      );
    }
    return shown;
  }

  private optionLabel(option: RewindOption, index: number, selected: boolean): string {
    const { theme } = this.host;
    let label = `${index + 1}. ${option.label}`;
    if (option.input === true && option.action !== "cancel") {
      const text = this.inputs.get(option.action) ?? "";
      const cursor = selected ? (theme.glyphs.ascii ? "_" : "▏") : "";
      if (text !== "") label += `${msg().rewind.panel.instructions(text)}${cursor}`;
      else if (selected) label += theme.fg("dim", msg().rewind.panel.instructionsHint);
    }
    return label;
  }

  private optionLine(label: string, selected: boolean, width: number): string {
    const { theme } = this.host;
    const left = `${selected ? theme.glyphs.prompt : " "} ${label}`;
    if (!selected) return truncateToWidth(left, width);
    const line = padToWidth(truncateToWidth(theme.fg("accent", theme.bold(left)), width), width);
    return theme.bg("selection", line);
  }

  /** 文件清单：每个一行（最多 5 个）；紧凑时接在 `head` 后面并成一行。 */
  private fileLines(
    head: string,
    files: readonly string[],
    width: number,
    note?: (f: string) => string,
  ): string[] {
    if (this.tight) return [truncateToWidth(msg().rewind.panel.tightList(head, files), width)];
    const lines = files
      .slice(0, REWIND_DETAIL_MAX)
      .map((f) => truncateToWidth(`  ${f}${note !== undefined ? note(f) : ""}`, width));
    lines.unshift(head);
    if (files.length > REWIND_DETAIL_MAX) {
      lines.push(
        this.host.theme.fg(
          "dim",
          msg().rewind.panel.moreFiles(
            this.host.theme.glyphs.ellipsis,
            files.length - REWIND_DETAIL_MAX,
          ),
        ),
      );
    }
    return lines;
  }

  private detailLines(width: number): string[] {
    const { theme } = this.host;
    const out: string[] = [];
    const m = msg().rewind.panel;
    const { point, preview, previewError } = this.model;
    if (!point.hasCheckpoint) out.push(theme.fg("dim", m.noCheckpoint));
    if (previewError !== undefined) out.push(theme.fg("warning", m.previewFailed(previewError)));
    const code = preview?.code;
    if (code !== undefined && code.conflicts.length > 0) {
      const head = this.tight
        ? m.conflictsTight(code.conflicts.length)
        : m.conflicts(code.conflicts.length);
      out.push(...this.fileLines(theme.fg("warning", head), code.conflicts, width));
    }
    if (code !== undefined && code.skipped.length > 0) {
      const reasons = new Map(code.skipped.map((s) => [s.path, skipReasonText(s.reason)]));
      out.push(
        ...this.fileLines(
          theme.fg("dim", m.unrestorable(code.skipped.length)),
          code.skipped.map((s) => s.path),
          width,
          (f) => theme.fg("dim", m.fileReason(reasons.get(f) ?? "")),
        ),
      );
    }
    if (preview?.gitHint !== undefined) {
      const [head, ...commands] = gitHintLines(preview.gitHint, theme.glyphs.ascii, this.tight);
      out.push(...wrapTextWithAnsi(theme.fg("warning", head!), width));
      for (const command of commands) out.push(truncateToWidth(theme.fg("code", command), width));
    }
    return out;
  }
}
