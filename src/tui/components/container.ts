/**
 * 纵向容器（设计 §12.1）：子组件的行按顺序拼接；无布局引擎。[B4]
 */

import type { Component } from "../component.js";

export class Container implements Component {
  readonly children: Component[] = [];

  addChild(child: Component): void {
    this.children.push(child);
  }

  /** 插到 before 之前；before 不在容器内则追加到末尾。 */
  insertBefore(child: Component, before: Component): void {
    const index = this.children.indexOf(before);
    if (index === -1) this.children.push(child);
    else this.children.splice(index, 0, child);
  }

  removeChild(child: Component): boolean {
    const index = this.children.indexOf(child);
    if (index === -1) return false;
    this.children.splice(index, 1);
    return true;
  }

  clear(): void {
    this.children.length = 0;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    for (const child of this.children) {
      for (const line of child.render(width)) lines.push(line);
    }
    return lines;
  }

  invalidate(): void {
    for (const child of this.children) child.invalidate();
  }
}
