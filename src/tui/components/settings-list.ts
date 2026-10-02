/**
 * Grouped settings list (docs/wave6-plan.md §6.3). [W6-S]
 *
 * Rows `› label  value  tag  note` under muted group headers; the selected row uses the prompt glyph,
 * accent + bold and the `selection` background (same look as ChoiceDialog). A query filters rows by id,
 * label, value and extra search text (case-insensitive); groups left without rows disappear. Only
 * `maxVisible` lines (headers included) are drawn, scrolled so the selected row stays visible.
 * Narrow widths drop the note column (< 60) and then the tag column (< 48).
 *
 * Input handling stays with the owner (the `/config` panel decides what Enter / Space do); this
 * component only moves the selection and renders.
 */

import type { Component, SemanticColor, Theme } from "../component.js";
import { padToWidth, truncateToWidth, visibleWidth } from "../ansi.js";

export interface SettingsRow {
  id: string;
  /** Group header text; consecutive rows with the same group share one header. */
  group: string;
  label: string;
  /** Already formatted value. */
  value: string;
  valueColor?: SemanticColor;
  /** Short right column (apply tier). */
  tag?: string;
  /** Trailing note (source, lock reason). */
  note?: string;
  noteColor?: SemanticColor;
  /** Not editable in the current scope: drawn dim. */
  dim?: boolean;
  /** Extra text the query matches (enum values, description). */
  search?: string;
}

export interface SettingsListOptions {
  theme: Theme;
  /** Lines to draw (headers included); default 16. */
  maxVisible?: number;
  emptyText?: string;
}

type Line = { kind: "group"; text: string } | { kind: "row"; row: SettingsRow; index: number };

const LABEL_MAX = 24;
const VALUE_MAX = 16;

export class SettingsList implements Component {
  private rows: readonly SettingsRow[] = [];
  private shown: SettingsRow[] = [];
  private selected = 0;
  private top = 0;
  private filter = "";

  constructor(private readonly options: SettingsListOptions) {}

  set maxVisible(lines: number) {
    this.options.maxVisible = Math.max(3, lines);
  }

  get query(): string {
    return this.filter;
  }

  /** Replace the rows, keeping the selection on the same id when possible. */
  setRows(rows: readonly SettingsRow[]): void {
    const id = this.selectedRow?.id;
    this.rows = rows;
    this.refilter();
    if (id !== undefined) this.selectId(id);
  }

  setQuery(query: string): void {
    if (query === this.filter) return;
    const id = this.selectedRow?.id;
    this.filter = query;
    this.refilter();
    this.selected = 0;
    if (id !== undefined) this.selectId(id);
  }

  get selectedRow(): SettingsRow | undefined {
    return this.shown[this.selected];
  }

  get visibleRows(): readonly SettingsRow[] {
    return this.shown;
  }

  selectId(id: string): boolean {
    const index = this.shown.findIndex((row) => row.id === id);
    if (index === -1) return false;
    this.selected = index;
    return true;
  }

  /** Move by `delta` rows (wraps around). */
  move(delta: number): void {
    const n = this.shown.length;
    if (n === 0) return;
    this.selected = (((this.selected + delta) % n) + n) % n;
  }

  private refilter(): void {
    const q = this.filter.trim().toLowerCase();
    this.shown =
      q === ""
        ? [...this.rows]
        : this.rows.filter((row) =>
            [row.id, row.label, row.value, row.search ?? ""].some((t) =>
              t.toLowerCase().includes(q),
            ),
          );
    if (this.selected >= this.shown.length) this.selected = Math.max(0, this.shown.length - 1);
  }

  private lines(): Line[] {
    const out: Line[] = [];
    let group: string | undefined;
    this.shown.forEach((row, index) => {
      if (row.group !== group) {
        group = row.group;
        out.push({ kind: "group", text: row.group });
      }
      out.push({ kind: "row", row, index });
    });
    return out;
  }

  render(width: number): string[] {
    const { theme } = this.options;
    if (this.shown.length === 0)
      return [theme.fg("dim", truncateToWidth(this.options.emptyText ?? "", width))];
    const all = this.lines();
    const max = this.options.maxVisible ?? 16;
    const at = all.findIndex((l) => l.kind === "row" && l.index === this.selected);
    // keep the selected row (and its group header when it is the first row of the group) in view
    const anchor = at > 0 && all[at - 1]!.kind === "group" ? at - 1 : at;
    if (anchor < this.top) this.top = anchor;
    if (at >= this.top + max) this.top = at - max + 1;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, all.length - max)));
    const window = all.slice(this.top, this.top + max);
    // column widths from all rows: filtering does not make columns jump
    const rows = this.rows;
    // narrow terminals: label gets at most half the width, value what is left of the first two columns
    const labelCap = Math.min(LABEL_MAX, Math.max(8, Math.floor((width - 4) / 2)));
    const labelW = Math.min(labelCap, Math.max(...rows.map((r) => visibleWidth(r.label))));
    const valueCap = Math.min(VALUE_MAX, Math.max(4, width - 4 - labelW));
    const valueW = Math.min(valueCap, Math.max(...rows.map((r) => visibleWidth(r.value))));
    const tagW = Math.max(0, ...rows.map((r) => visibleWidth(r.tag ?? "")));
    return window.map((line) =>
      line.kind === "group"
        ? truncateToWidth(theme.fg("muted", theme.bold(line.text)), width)
        : this.rowLine(line.row, line.index === this.selected, width, labelW, valueW, tagW),
    );
  }

  private rowLine(
    row: SettingsRow,
    selected: boolean,
    width: number,
    labelW: number,
    valueW: number,
    tagW: number,
  ): string {
    const { theme } = this.options;
    const pointer = selected ? theme.glyphs.prompt : " ";
    const label = padToWidth(truncateToWidth(row.label, labelW), labelW);
    const valueText = padToWidth(truncateToWidth(row.value, valueW), valueW);
    const value = row.valueColor !== undefined ? theme.fg(row.valueColor, valueText) : valueText;
    let line = `${pointer} ${selected ? theme.fg("accent", theme.bold(label)) : label}  ${value}`;
    if (width >= 48 && tagW > 0) line += `  ${theme.fg("dim", padToWidth(row.tag ?? "", tagW))}`;
    if (width >= 60 && row.note !== undefined && row.note !== "")
      line += `  ${theme.fg(row.noteColor ?? "dim", row.note)}`;
    let out = truncateToWidth(line, width);
    if (row.dim === true && !selected) out = theme.dim(out);
    return selected ? theme.bg("selection", padToWidth(out, width)) : out;
  }

  invalidate(): void {}
}
