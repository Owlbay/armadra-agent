/**
 * 两列键值表（第三波 A8，供 `/session` 等面板）。[W3-B9a-2]
 *
 * - 键列宽 = 最长键的可见宽度，但不超过总宽的 `maxKeyRatio`（缺省 0.4，至少 4 列），超出的键截断；
 * - 值在剩余宽度内截断（不换行，保留 ANSI 样式）；值里的换行折成 ` ⏎ `；
 * - 宽度连键列都放不下时退化为只显示截断后的键；空行（`key` 为空串）原样输出空行，可作分组间隔。
 */

import type { Component, SemanticColor, Theme } from "../component.js";
import { padToWidth, truncateToWidth, visibleWidth } from "../ansi.js";

/** 键列至少保留的宽度（键更短时取键宽）；再窄就只显示键。 */
const MIN_KEY_WIDTH = 4;

export interface KeyValueRow {
  key: string;
  value: string;
}

export interface KeyValueOptions {
  theme?: Theme;
  /** 键的颜色（需要 theme），缺省 dim。 */
  keyColor?: SemanticColor;
  /** 两列之间的空白，缺省 2。 */
  gap?: number;
  maxKeyRatio?: number;
}

export class KeyValue implements Component {
  private cache: { width: number; lines: string[] } | null = null;

  constructor(
    private rows: readonly KeyValueRow[] = [],
    private readonly options: KeyValueOptions = {},
  ) {}

  setRows(rows: readonly KeyValueRow[]): void {
    this.rows = rows;
    this.cache = null;
  }

  render(width: number): string[] {
    if (this.cache?.width === width) return this.cache.lines;
    const gap = this.options.gap ?? 2;
    const longest = Math.max(0, ...this.rows.map((r) => visibleWidth(r.key)));
    const share = Math.floor(width * (this.options.maxKeyRatio ?? 0.4));
    const keyWidth = Math.min(longest, Math.max(share, MIN_KEY_WIDTH));
    const valueWidth = width - keyWidth - gap;
    const { theme, keyColor = "dim" } = this.options;
    const lines = this.rows.map(({ key, value }) => {
      if (key === "" && value === "") return "";
      const shownKey = truncateToWidth(key, Math.max(keyWidth, 1));
      const styledKey = theme ? theme.fg(keyColor, shownKey) : shownKey;
      if (valueWidth < 1) return truncateToWidth(styledKey, width);
      const flat = value.replace(/\r?\n/g, " ⏎ ");
      return padToWidth(styledKey, keyWidth) + " ".repeat(gap) + truncateToWidth(flat, valueWidth);
    });
    this.cache = { width, lines };
    return lines;
  }

  invalidate(): void {
    this.cache = null;
  }
}
