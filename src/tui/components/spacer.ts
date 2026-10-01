/**
 * 占位空行（设计 §12.1）。[B4]
 */

import type { Component } from "../component.js";

export class Spacer implements Component {
  constructor(private lines = 1) {}

  setLines(lines: number): void {
    this.lines = Math.max(0, lines);
  }

  render(_width: number): string[] {
    return new Array<string>(this.lines).fill("");
  }

  invalidate(): void {}
}
