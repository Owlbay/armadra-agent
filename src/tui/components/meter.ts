/**
 * 单行余量表（第三波 A8）：`ctx ▮▮▮▮▮▮▮▯▯▯ 72%`。[W3-B9a-2]
 *
 * - `value` 是 0–1 的比例（越界夹紧）；undefined 显示 `—`，格子全空；
 * - 阈值着色（需要 theme）：≥ `dangerAt`（缺省 0.9）error，≥ `warnAt`（缺省 0.7）warning，否则 success；
 *   空格子 dim；
 * - 宽度不够时先去掉格子，只剩「标签 百分比」，再不够就截断；格子字形取 `theme.glyphs`（ASCII `# .`）。
 */

import type { Component, SemanticColor, Theme } from "../component.js";
import { truncateToWidth, visibleWidth } from "../ansi.js";
import { levelColor } from "../theme.js";
import { UNICODE_GLYPHS } from "../glyphs.js";

export interface MeterOptions {
  label?: string;
  /** 格子数，缺省 10。 */
  cells?: number;
  warnAt?: number;
  dangerAt?: number;
  theme?: Theme;
  /** 百分比文本（缺省四舍五入到整数，`72%`）；value 为 undefined 时不调用。 */
  percent?: (ratio: number) => string;
}

export const METER_FULL = UNICODE_GLYPHS.meterFull;
export const METER_EMPTY = UNICODE_GLYPHS.meterEmpty;

export class Meter implements Component {
  constructor(
    private value: number | undefined = undefined,
    private readonly options: MeterOptions = {},
  ) {}

  setValue(value: number | undefined): void {
    this.value = value;
  }

  /** 当前阈值档位对应的语义色。 */
  level(): SemanticColor {
    const { warnAt, dangerAt } = this.options;
    return levelColor(this.value ?? 0, {
      ...(warnAt !== undefined ? { warnAt } : {}),
      ...(dangerAt !== undefined ? { dangerAt } : {}),
    });
  }

  render(width: number): string[] {
    const { theme, label, cells = 10 } = this.options;
    const ratio = this.value === undefined ? undefined : Math.min(1, Math.max(0, this.value));
    const percent =
      ratio === undefined ? "—" : (this.options.percent?.(ratio) ?? `${Math.round(ratio * 100)}%`);
    const color = (c: SemanticColor, text: string): string => (theme ? theme.fg(c, text) : text);
    const head = label === undefined || label === "" ? "" : `${label} `;
    const filled = ratio === undefined ? 0 : Math.round(ratio * cells);
    const glyphs = theme?.glyphs ?? UNICODE_GLYPHS;
    const bar =
      color(this.level(), glyphs.meterFull.repeat(filled)) +
      color("dim", glyphs.meterEmpty.repeat(cells - filled));
    const tail = color(ratio === undefined ? "dim" : this.level(), percent);
    const full = `${head}${bar} ${tail}`;
    if (visibleWidth(full) <= width) return [full];
    return [truncateToWidth(`${head}${tail}`, width)];
  }

  invalidate(): void {}
}
