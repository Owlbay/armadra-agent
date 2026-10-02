/**
 * 通用确认框：底部覆盖层 + `Box`，选项样式与审批对话框一致（终端界面视觉设计 v1 §3.11）。
 *
 * - 编号选项 `› 1. 进入 Bypass   y`，选中行 `›` + `selection` 底色，右侧按键提示 `dim`；
 * - 按键：↑↓ 移动（循环）、Enter 确认、数字直选、选项按键提示里的单个字母直选（如 `y` / `n`）；
 *   Esc / Ctrl+C / `tui.select.cancel` 取消（返回 undefined）；
 * - 宽 < 56 列紧凑：去掉空行、按键提示只留第一个、底部提示缩短。字形取 `theme.glyphs`（ASCII 回退）。
 *
 * 用途：进入 Bypass permissions 前的确认（`confirmBypass`，permissions/bypass.ts）。
 */

import {
  BYPASS_CHOICES,
  BYPASS_CONFIRM_TITLE,
  BYPASS_DEFAULT_CHOICE,
  BYPASS_RISK_LINES,
} from "../../permissions/bypass.js";
import {
  Box,
  defaultKeybindings,
  matchesKey,
  padToWidth,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type Keybindings,
  type OverlayHandle,
  type OverlayOptions,
  type SemanticColor,
  type Theme,
} from "../../tui.js";

export interface ChoiceOption {
  label: string;
  /** 右侧按键提示（空格分隔）；其中的单个字母同时是直选键。 */
  keys: string;
}

export interface ChoiceSpec {
  title: string;
  /** 正文（已着色），选项之上。 */
  body: readonly string[];
  options: readonly ChoiceOption[];
  /** 缺省选中的下标。 */
  selected?: number;
  borderColor?: SemanticColor;
}

export interface ChoiceHost {
  theme: Theme;
  keybindings?: Keybindings;
  showOverlay(component: Component, options: OverlayOptions): OverlayHandle;
}

/** 宽度低于它（Box 外宽）时用紧凑布局。 */
const COMPACT_WIDTH = 56;

export class ChoiceDialog implements Component, Focusable {
  focused = false;
  private selected: number;

  constructor(
    private readonly spec: ChoiceSpec,
    private readonly host: Omit<ChoiceHost, "showOverlay">,
    private readonly done: (index: number | undefined) => void,
  ) {
    this.selected = Math.max(0, Math.min(spec.options.length - 1, spec.selected ?? 0));
  }

  get selectedIndex(): number {
    return this.selected;
  }

  handleInput(data: string): void {
    const keys = this.host.keybindings ?? defaultKeybindings;
    const n = this.spec.options.length;
    const letter = data.length === 1 ? data.toLowerCase() : "";
    const byLetter =
      letter === "" || !/^[a-z]$/.test(letter)
        ? -1
        : this.spec.options.findIndex((o) => o.keys.split(/\s+/).includes(letter));
    if (byLetter !== -1) this.done(byLetter);
    else if (
      matchesKey(data, "escape") ||
      keys.matches(data, "app.clear") ||
      keys.matches(data, "tui.select.cancel")
    ) {
      this.done(undefined);
    } else if (/^[1-9]$/.test(data) && Number(data) <= n) this.done(Number(data) - 1);
    else if (keys.matches(data, "tui.select.up")) this.selected = (this.selected + n - 1) % n;
    else if (keys.matches(data, "tui.select.down")) this.selected = (this.selected + 1) % n;
    else if (matchesKey(data, "enter")) this.done(this.selected);
  }

  render(width: number): string[] {
    const { theme } = this.host;
    const compact = width + 4 < COMPACT_WIDTH;
    const lines: string[] = [];
    for (const line of this.spec.body) lines.push(...wrapTextWithAnsi(line, width));
    if (!compact) lines.push("");
    lines.push(...this.optionLines(width, compact));
    if (!compact) lines.push("");
    const g = theme.glyphs;
    const arrows = g.arrowUp + g.arrowDown;
    const n = this.spec.options.length;
    lines.push(
      theme.fg(
        "dim",
        compact
          ? `${arrows} Enter · 1-${n} · Esc`
          : `${arrows} 选择 · Enter 确认 · 1-${n} 直接选 · Esc 取消`,
      ),
    );
    return lines.map((l) => truncateToWidth(l, width));
  }

  private optionLines(width: number, compact: boolean): string[] {
    const { theme } = this.host;
    const g = theme.glyphs;
    const shown = this.spec.options.map((o) => (compact ? o.keys.split(/\s+/)[0]! : o.keys));
    const keyWidth = Math.max(...shown.map((k) => visibleWidth(k)));
    return this.spec.options.map((option, i) => {
      const selected = i === this.selected;
      const left = `${selected ? g.prompt : " "} ${i + 1}. ${option.label}`;
      const right = padToWidth(shown[i]!, keyWidth);
      const room = Math.max(1, width - keyWidth - 1);
      const label = selected ? theme.fg("accent", theme.bold(left)) : left;
      const line = padToWidth(truncateToWidth(label, room), room) + " " + theme.fg("dim", right);
      return selected ? theme.bg("selection", line) : line;
    });
  }

  invalidate(): void {}
}

/** 打开确认框（底部覆盖层）：返回选中的下标，取消返回 undefined。 */
export function openChoice(host: ChoiceHost, spec: ChoiceSpec): Promise<number | undefined> {
  return new Promise((resolve) => {
    let handle: OverlayHandle | undefined;
    let settled = false;
    const dialog = new ChoiceDialog(spec, host, (index) => {
      if (settled) return;
      settled = true;
      handle?.hide();
      resolve(index);
    });
    handle = host.showOverlay(
      new Box(dialog, {
        title: spec.title,
        theme: host.theme,
        ...(spec.borderColor !== undefined ? { borderColor: spec.borderColor } : {}),
      }),
      { anchor: "bottom" },
    );
  });
}

/** Bypass 确认框的内容（缺省选中「取消」，边框 warning）。 */
export function bypassChoiceSpec(theme: Theme): ChoiceSpec {
  return {
    title: BYPASS_CONFIRM_TITLE,
    body: BYPASS_RISK_LINES.map((line, i) => (i === 0 ? theme.fg("warning", line) : line)),
    options: BYPASS_CHOICES,
    selected: BYPASS_DEFAULT_CHOICE,
    borderColor: "warning",
  };
}

/** 进入 Bypass 前问一次：选「进入 Bypass」返回 true，取消 / 选「取消」返回 false。 */
export async function confirmBypass(host: ChoiceHost): Promise<boolean> {
  return (await openChoice(host, bypassChoiceSpec(host.theme))) === 0;
}
