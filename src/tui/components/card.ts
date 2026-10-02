/**
 * 左竖条卡片（终端界面视觉设计 v1 §3.6、§3.13）：压缩摘要、`/session` 等面板。
 *
 * 每行前加 `theme.glyphs.card`（`▎`，ASCII `|`）与一个空格，竖条用 `border` 色；可选标题行（正文色粗体）
 * 与跟在标题后的副标题（`muted`，两个空格隔开）。不加上下边框——Box 只留给代码块、启动头与覆盖层。
 * 子组件按 `width - 2` 渲染；空行只画竖条。
 */

import type { Component, SemanticColor, Theme } from "../component.js";
import { truncateToWidth } from "../ansi.js";
import { UNICODE_GLYPHS } from "../glyphs.js";

export interface CardOptions {
  theme?: Theme;
  title?: string;
  /** 标题后的次要说明（muted）。 */
  subtitle?: string;
  /** 竖条颜色，缺省 `border`。 */
  barColor?: SemanticColor;
}

export class Card implements Component {
  constructor(
    readonly child: Component | undefined,
    private readonly options: CardOptions = {},
  ) {}

  render(width: number): string[] {
    const { theme, title, subtitle } = this.options;
    const glyph = (theme?.glyphs ?? UNICODE_GLYPHS).card;
    const bar = theme ? theme.fg(this.options.barColor ?? "border", glyph) : glyph;
    const inner = Math.max(1, width - 2);
    const lines: string[] = [];
    if (title !== undefined && title !== "") {
      let head = theme ? theme.bold(title) : title;
      if (subtitle !== undefined && subtitle !== "") {
        head += "  " + (theme ? theme.fg("muted", subtitle) : subtitle);
      }
      lines.push(head);
    }
    if (this.child) lines.push(...this.child.render(inner));
    return lines.map((line) =>
      line === "" ? bar : truncateToWidth(`${bar} ${truncateToWidth(line, inner)}`, width),
    );
  }

  invalidate(): void {
    this.child?.invalidate();
  }
}
