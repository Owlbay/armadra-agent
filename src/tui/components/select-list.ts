/**
 * 选择列表（设计 §12.6）：过滤、分页（视窗跟随选中项）、描述列、分组标题。[B4]
 *
 * 键位走 `tui.select.*`：上下移动（循环）、翻页、确认（Enter / Tab）、取消（Esc / Ctrl+C）。
 * `filterable` 时可打印字符追加到过滤词、退格删除；过滤为大小写不敏感的分词子串匹配
 * （每个词都要出现在 label / value / group / description 之一中）。
 *
 * `badge` 靠右显示（如 `Default`、`Recommended`）；`numberKeys` 时右侧标 1–9，按数字直接选中并确认；
 * `stacked` 时说明换到标签下一行（缩进、暗色），适合「名字 + 一行说明」的短列表。
 *
 * 终端界面视觉设计 v1：选中行 `›` + `selection` 底色（< 256 色退化为 accent 粗体，stacked 时两行都上）；
 * `currentValue` 的项标 `✓`；`footer` 是列表下的一行按键提示（dim），`showCount` 时前面带 `(i/n)`
 * （缺省只在超出一屏时带）；过滤框提示符 `›`。字形取 `theme.glyphs`。
 */

import type { Component, Focusable, SemanticColor, Theme } from "../component.js";
import { padToWidth, truncateToWidth, visibleWidth } from "../ansi.js";
import { UNICODE_GLYPHS, type Glyphs } from "../glyphs.js";
import { defaultKeybindings, type Keybindings } from "../keybindings.js";
import { isPrintableText, matchesKey } from "../keys.js";

export interface SelectItem {
  value: string;
  label: string;
  description?: string;
  /** 相邻项 group 不同时插入分组标题行。 */
  group?: string;
  /** 靠右的徽标文字。 */
  badge?: string;
  /** 徽标颜色，缺省 accent。 */
  badgeColor?: SemanticColor;
}

export interface SelectListOptions {
  /** 一屏最多显示的条目数，缺省 10。 */
  maxVisible?: number;
  theme?: Theme;
  keybindings?: Keybindings;
  filterable?: boolean;
  emptyText?: string;
  /** 右侧标序号，按 1–9 直接选中并确认（不与 filterable 同用）。 */
  numberKeys?: boolean;
  /** 说明放在标签下一行。 */
  stacked?: boolean;
  /** 列表下的按键提示行（dim）。 */
  footer?: string;
  /** 提示行前带 `(i/n)`；缺省只在超出一屏时带。 */
  showCount?: boolean;
  /** 当前值：该项标签前标 `✓`（其余项留同宽空白）。 */
  currentValue?: string;
  onSelect?(item: SelectItem): void;
  onCancel?(): void;
  onSelectionChange?(item: SelectItem | undefined): void;
}

export function filterItems(items: readonly SelectItem[], filter: string): SelectItem[] {
  const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...items];
  return items.filter((item) => {
    const hay = [item.label, item.value, item.group ?? "", item.description ?? ""]
      .join("\n")
      .toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
}

export class SelectList implements Component, Focusable {
  focused = false;
  private items: SelectItem[];
  private filtered: SelectItem[];
  private filter = "";
  private selected = 0;
  private scrollTop = 0;
  private readonly keys: Keybindings;

  constructor(
    items: readonly SelectItem[],
    private readonly options: SelectListOptions = {},
  ) {
    this.items = [...items];
    this.filtered = [...items];
    this.keys = options.keybindings ?? defaultKeybindings;
  }

  private get maxVisible(): number {
    return Math.max(1, this.options.maxVisible ?? 10);
  }

  setItems(items: readonly SelectItem[]): void {
    this.items = [...items];
    this.applyFilter();
  }

  getItems(): readonly SelectItem[] {
    return this.filtered;
  }

  /** 换列表下的按键提示（选择器切视图时）。 */
  setFooter(footer: string | undefined): void {
    if (footer === undefined) delete this.options.footer;
    else this.options.footer = footer;
  }

  getFilter(): string {
    return this.filter;
  }

  setFilter(filter: string): void {
    this.filter = filter;
    this.applyFilter();
  }

  getSelected(): SelectItem | undefined {
    return this.filtered[this.selected];
  }

  getSelectedIndex(): number {
    return this.selected;
  }

  setSelectedIndex(index: number): void {
    if (this.filtered.length === 0) return;
    this.selected = Math.max(0, Math.min(this.filtered.length - 1, index));
    this.ensureVisible();
    this.options.onSelectionChange?.(this.getSelected());
  }

  /** 按 value 选中。 */
  selectValue(value: string): boolean {
    const index = this.filtered.findIndex((item) => item.value === value);
    if (index === -1) return false;
    this.setSelectedIndex(index);
    return true;
  }

  moveSelection(delta: number, wrap = true): void {
    const n = this.filtered.length;
    if (n === 0) return;
    let next = this.selected + delta;
    if (wrap && Math.abs(delta) === 1) next = (next + n) % n;
    this.setSelectedIndex(next);
  }

  handleInput(data: string): void {
    const k = this.keys;
    if (this.options.numberKeys === true && /^[1-9]$/.test(data)) {
      const index = Number(data) - 1;
      if (index < this.filtered.length) {
        this.setSelectedIndex(index);
        this.options.onSelect?.(this.filtered[index]!);
      }
      return;
    }
    if (k.matches(data, "tui.select.up")) this.moveSelection(-1);
    else if (k.matches(data, "tui.select.down")) this.moveSelection(1);
    else if (k.matches(data, "tui.select.pageUp")) this.moveSelection(-this.maxVisible, false);
    else if (k.matches(data, "tui.select.pageDown")) this.moveSelection(this.maxVisible, false);
    else if (k.matches(data, "tui.select.confirm")) {
      const item = this.getSelected();
      if (item) this.options.onSelect?.(item);
    } else if (k.matches(data, "tui.select.cancel")) this.options.onCancel?.();
    else if (this.options.filterable) {
      if (matchesKey(data, "backspace")) {
        if (this.filter.length > 0) this.setFilter([...this.filter].slice(0, -1).join(""));
      } else if (isPrintableText(data)) {
        this.setFilter(this.filter + data);
      }
    }
  }

  private get glyphs(): Glyphs {
    return this.options.theme?.glyphs ?? UNICODE_GLYPHS;
  }

  render(width: number): string[] {
    const theme = this.options.theme;
    const dim = (s: string): string => (theme ? theme.fg("dim", s) : s);
    const lines: string[] = [];
    if (this.options.filterable) {
      const mark = `${this.glyphs.prompt} `;
      const prompt = theme ? theme.fg("accent", mark) : mark;
      lines.push(truncateToWidth(prompt + this.filter + (this.focused ? "▏" : ""), width));
    }
    if (this.filtered.length === 0) {
      lines.push(truncateToWidth(dim(`  ${this.options.emptyText ?? "(no matches)"}`), width));
      if (this.options.footer !== undefined) {
        lines.push(truncateToWidth(dim(this.options.footer), width));
      }
      return lines;
    }
    const end = Math.min(this.filtered.length, this.scrollTop + this.maxVisible);
    const labelWidth = this.labelColumnWidth(end);
    let lastGroup: string | undefined;
    for (let i = this.scrollTop; i < end; i++) {
      const item = this.filtered[i]!;
      if (item.group !== undefined && item.group !== lastGroup) {
        lines.push(truncateToWidth(dim(item.group), width));
      }
      lastGroup = item.group;
      lines.push(...this.renderItem(item, i, labelWidth, width));
    }
    const overflow = this.filtered.length > this.maxVisible;
    const count = `(${this.selected + 1}/${this.filtered.length})`;
    const footer = this.options.footer;
    if (footer !== undefined) {
      const withCount = this.options.showCount ?? overflow;
      lines.push(truncateToWidth(dim(`${withCount ? `${count} ` : ""}${footer}`), width));
    } else if (overflow) {
      lines.push(truncateToWidth(dim(`  ${count}`), width));
    }
    return lines;
  }

  invalidate(): void {}

  private renderItem(item: SelectItem, index: number, labelWidth: number, width: number): string[] {
    const theme = this.options.theme;
    const selected = index === this.selected;
    const dim = (s: string): string => (theme ? theme.fg("dim", s) : s);
    const rightParts: string[] = [];
    if (item.badge !== undefined && item.badge !== "") {
      rightParts.push(theme ? theme.fg(item.badgeColor ?? "accent", item.badge) : item.badge);
    }
    if (this.options.numberKeys === true && index < 9) rightParts.push(dim(String(index + 1)));
    let right = rightParts.join("  ");
    if (visibleWidth(right) > Math.max(0, width - 8)) right = "";
    const rightWidth = right === "" ? 0 : visibleWidth(right) + 1;
    const g = this.glyphs;
    const current = this.options.currentValue;
    const check =
      current === undefined
        ? ""
        : item.value === current
          ? (theme ? theme.fg(selected ? "accent" : "success", g.check) : g.check) + " "
          : "  ";
    const prefix = (selected ? `${g.prompt} ` : "  ") + check;
    const prefixWidth = visibleWidth(prefix);
    const labelRoom = Math.max(1, width - prefixWidth - rightWidth);
    const label = truncateToWidth(item.label, labelRoom);
    let line = padToWidth(label, Math.min(labelWidth, labelRoom));
    if (selected && theme) line = theme.fg("accent", theme.bold(line));
    line = (selected && theme ? theme.fg("accent", theme.bold(prefix)) : prefix) + line;
    const stacked = this.options.stacked === true;
    if (!stacked) {
      const room = width - visibleWidth(line) - 2 - rightWidth;
      if (item.description && room > 4) {
        line += "  " + dim(truncateToWidth(item.description, room));
      }
    }
    if (right !== "") {
      line =
        padToWidth(truncateToWidth(line, width - rightWidth), width - rightWidth) + " " + right;
    }
    const out = [truncateToWidth(line, width)];
    if (stacked && item.description) {
      const indent = " ".repeat(prefixWidth + 2);
      out.push(
        truncateToWidth(
          `${indent}${dim(truncateToWidth(item.description, Math.max(1, width - indent.length)))}`,
          width,
        ),
      );
    }
    return selected && theme ? out.map((l) => theme.bg("selection", l)) : out;
  }

  private labelColumnWidth(end: number): number {
    let max = 0;
    for (let i = this.scrollTop; i < end; i++) {
      max = Math.max(max, visibleWidth(this.filtered[i]!.label));
    }
    return max;
  }

  private applyFilter(): void {
    const previous = this.getSelected()?.value;
    this.filtered = filterItems(this.items, this.filter);
    const keep = previous === undefined ? -1 : this.filtered.findIndex((i) => i.value === previous);
    this.selected = keep === -1 ? 0 : keep;
    this.scrollTop = 0;
    this.ensureVisible();
    this.options.onSelectionChange?.(this.getSelected());
  }

  private ensureVisible(): void {
    if (this.selected < this.scrollTop) this.scrollTop = this.selected;
    else if (this.selected >= this.scrollTop + this.maxVisible) {
      this.scrollTop = this.selected - this.maxVisible + 1;
    }
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, this.filtered.length - this.maxVisible));
    this.scrollTop = Math.max(0, this.scrollTop);
  }
}
