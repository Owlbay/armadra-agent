/**
 * 边框 / 内边距容器（设计 §12.1）。[B4]
 *
 * 子组件按内宽渲染后加圆角边框（可选标题，嵌在上边框）与内边距；宽度不足 4 列时退化为只加内边距。
 * 边框字形取 `theme.glyphs.box`（ASCII 下为 `+ - |`），颜色缺省 `border`，可用 `borderColor` 改
 * （审批对话框按严重度用 error / warning）。
 * 焦点与键输入透传给子组件，所以可以直接把 `Box(SelectList)` 交给 `showOverlay`。
 */

import { isFocusable, type Component, type SemanticColor, type Theme } from "../component.js";
import { padToWidth, truncateToWidth, visibleWidth } from "../ansi.js";
import { UNICODE_GLYPHS, type BoxGlyphs } from "../glyphs.js";

export interface BoxOptions {
  border?: boolean;
  paddingX?: number;
  paddingY?: number;
  title?: string;
  theme?: Theme;
  /** 边框颜色，缺省 `border`。 */
  borderColor?: SemanticColor;
}

export class Box implements Component {
  constructor(
    readonly child: Component,
    private readonly options: BoxOptions = {},
  ) {}

  /** 焦点与输入透传给子组件（覆盖层里常用 Box 包一层）。 */
  get focused(): boolean {
    return isFocusable(this.child) ? this.child.focused : false;
  }

  set focused(value: boolean) {
    if (isFocusable(this.child)) this.child.focused = value;
  }

  handleInput(data: string): void {
    this.child.handleInput?.(data);
  }

  render(width: number): string[] {
    const border = this.options.border !== false && width >= 4;
    const padX = this.options.paddingX ?? 1;
    const padY = this.options.paddingY ?? 0;
    const frame = border ? 2 : 0;
    const inner = Math.max(1, width - frame - padX * 2);
    const body = this.child.render(inner);
    const borderColor = this.options.borderColor ?? "border";
    const color = (s: string): string =>
      this.options.theme ? this.options.theme.fg(borderColor, s) : s;
    const g = this.glyphs;
    const pad = " ".repeat(padX);
    const contentWidth = Math.max(0, width - frame);
    const rows: string[] = [];
    const emptyRow = " ".repeat(contentWidth);
    for (let i = 0; i < padY; i++) rows.push(emptyRow);
    for (const line of body) {
      rows.push(padToWidth(pad + truncateToWidth(line, inner), contentWidth));
    }
    for (let i = 0; i < padY; i++) rows.push(emptyRow);
    if (!border) return rows;
    const lines = [this.topBorder(width, color)];
    for (const row of rows) lines.push(color(g.vertical) + row + color(g.vertical));
    lines.push(color(g.bottomLeft + g.horizontal.repeat(width - 2) + g.bottomRight));
    return lines;
  }

  private get glyphs(): BoxGlyphs {
    return (this.options.theme?.glyphs ?? UNICODE_GLYPHS).box;
  }

  private topBorder(width: number, color: (s: string) => string): string {
    const g = this.glyphs;
    const title = this.options.title;
    if (title === undefined || title === "") {
      return color(g.topLeft + g.horizontal.repeat(width - 2) + g.topRight);
    }
    const label = truncateToWidth(` ${title} `, width - 4);
    const rest = Math.max(0, width - 3 - visibleWidth(label));
    return color(g.topLeft + g.horizontal) + label + color(g.horizontal.repeat(rest) + g.topRight);
  }

  invalidate(): void {
    this.child.invalidate();
  }
}
