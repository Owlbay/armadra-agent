/**
 * 文本组件（设计 §12.1）。[B4]
 *
 * - `Text`：自动换行（保留 ANSI 样式）、可选左右 / 上下内边距；按 (width, text) 缓存。
 * - `TruncatedText`：只取第一行并截断到宽度（状态栏、标题行）。
 */

import type { Component } from "../component.js";
import { truncateToWidth, wrapTextWithAnsi } from "../ansi.js";

export interface TextOptions {
  paddingX?: number;
  paddingY?: number;
}

export class Text implements Component {
  private cache: { width: number; text: string; lines: string[] } | null = null;
  private readonly paddingX: number;
  private readonly paddingY: number;

  constructor(
    private text = "",
    options: TextOptions = {},
  ) {
    this.paddingX = options.paddingX ?? 0;
    this.paddingY = options.paddingY ?? 0;
  }

  getText(): string {
    return this.text;
  }

  setText(text: string): void {
    if (text === this.text) return;
    this.text = text;
    this.cache = null;
  }

  render(width: number): string[] {
    if (this.cache && this.cache.width === width && this.cache.text === this.text) {
      return this.cache.lines;
    }
    const inner = Math.max(1, width - this.paddingX * 2);
    const pad = " ".repeat(this.paddingX);
    const lines: string[] = [];
    for (let i = 0; i < this.paddingY; i++) lines.push("");
    if (this.text !== "") {
      for (const line of wrapTextWithAnsi(this.text, inner)) lines.push(pad + line);
    }
    for (let i = 0; i < this.paddingY; i++) lines.push("");
    this.cache = { width, text: this.text, lines };
    return lines;
  }

  invalidate(): void {
    this.cache = null;
  }
}

export class TruncatedText implements Component {
  constructor(
    private text = "",
    private readonly paddingX = 0,
  ) {}

  setText(text: string): void {
    this.text = text;
  }

  render(width: number): string[] {
    const firstLine = this.text.split("\n", 1)[0] ?? "";
    const pad = " ".repeat(this.paddingX);
    return [pad + truncateToWidth(firstLine, Math.max(0, width - this.paddingX * 2))];
  }

  invalidate(): void {}
}
