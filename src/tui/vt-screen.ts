/**
 * 极简终端屏幕模拟（供 MemoryTerminal 还原屏幕、做帧黄金测试）。[B4]
 *
 * 只实现 TUI 实际会写出的子集：可打印字素（按列宽占格，含延迟换行语义）、`\r` `\n` `\b`、
 * CSI A/B/C/D/E/F/G/H/f/J/K/m、`?25` `?2004` `?2026` 模式开关；OSC / APC / DCS 跳过；样式不记录。
 * 滚出屏幕顶部的行进入回滚区（scrollback）。改尺寸不做重排：行截断 / 补齐，高度缩小时顶部行进回滚。
 */

import { escapeLengthAt, graphemeWidth } from "./ansi.js";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 格子：字素；宽字符的第二格为 ""（续格）；空格子为 " "。 */
type Row = string[];

export interface ScreenModes {
  cursorVisible: boolean;
  bracketedPaste: boolean;
  /** 当前未闭合的同步输出层数（?2026h 计 +1，?2026l 归零）。 */
  synchronized: boolean;
}

export class VirtualScreen {
  private grid: Row[] = [];
  private history: string[] = [];
  private x = 0;
  private y = 0;
  private pendingWrap = false;
  readonly modes: ScreenModes = { cursorVisible: true, bracketedPaste: false, synchronized: false };

  constructor(
    private cols: number,
    private rows: number,
  ) {
    for (let i = 0; i < rows; i++) this.grid.push(this.blankRow());
  }

  get columns(): number {
    return this.cols;
  }

  get height(): number {
    return this.rows;
  }

  get cursor(): { row: number; col: number } {
    return { row: this.y, col: this.x };
  }

  /** 可见屏幕各行（右侧空白去掉）。 */
  viewport(): string[] {
    return this.grid.map(rowText);
  }

  /** 已滚出顶部的行（旧 → 新）。 */
  scrollback(): string[] {
    return [...this.history];
  }

  /** 回滚 + 屏幕，去掉屏幕底部的空行。 */
  transcript(): string[] {
    const all = [...this.history, ...this.viewport()];
    while (all.length > 0 && all[all.length - 1] === "") all.pop();
    return all;
  }

  resize(cols: number, rows: number): void {
    for (let i = 0; i < this.grid.length; i++) {
      const row = this.grid[i]!;
      if (cols < row.length) {
        row.length = cols;
        // 被截断的宽字符首格
        if (cols > 0 && graphemeWidth(row[cols - 1]!) === 2) row[cols - 1] = " ";
      } else while (row.length < cols) row.push(" ");
    }
    this.cols = cols;
    if (rows < this.rows) {
      const overflow = Math.max(0, this.y - (rows - 1));
      for (let i = 0; i < overflow; i++) this.history.push(rowText(this.grid.shift()!));
      this.grid.length = rows;
      this.y -= overflow;
    } else {
      while (this.grid.length < rows) this.grid.push(this.blankRow());
    }
    this.rows = rows;
    this.x = Math.min(this.x, cols - 1);
    this.pendingWrap = false;
  }

  write(data: string): void {
    let i = 0;
    while (i < data.length) {
      const c = data.charCodeAt(i);
      if (c === 0x1b) {
        const len = escapeLengthAt(data, i);
        this.escape(data.slice(i, i + len));
        i += len;
        continue;
      }
      if (c < 0x20 || c === 0x7f) {
        this.control(c);
        i++;
        continue;
      }
      let j = i;
      while (j < data.length) {
        const cc = data.charCodeAt(j);
        if (cc === 0x1b || cc < 0x20 || cc === 0x7f) break;
        j++;
      }
      for (const { segment } of segmenter.segment(data.slice(i, j))) this.print(segment);
      i = j;
    }
  }

  private blankRow(): Row {
    return new Array<string>(this.cols).fill(" ");
  }

  private lineFeed(): void {
    if (this.y < this.rows - 1) {
      this.y++;
      return;
    }
    this.history.push(rowText(this.grid.shift()!));
    this.grid.push(this.blankRow());
  }

  private print(grapheme: string): void {
    const w = graphemeWidth(grapheme);
    if (w === 0) {
      // 组合字符：附到前一格
      const row = this.grid[this.y]!;
      const at = Math.max(0, this.pendingWrap ? this.x : this.x - 1);
      row[at] = (row[at] === " " ? "" : row[at]) + grapheme;
      return;
    }
    if (this.pendingWrap || this.x + w > this.cols) {
      this.x = 0;
      this.lineFeed();
      this.pendingWrap = false;
    }
    const row = this.grid[this.y]!;
    row[this.x] = grapheme;
    if (w === 2 && this.x + 1 < this.cols) row[this.x + 1] = "";
    this.x += w;
    if (this.x >= this.cols) {
      this.x = this.cols - 1;
      this.pendingWrap = true;
    }
  }

  private control(c: number): void {
    switch (c) {
      case 0x0d:
        this.x = 0;
        this.pendingWrap = false;
        break;
      case 0x0a:
        this.lineFeed();
        this.pendingWrap = false;
        break;
      case 0x08:
        this.x = Math.max(0, this.x - 1);
        this.pendingWrap = false;
        break;
      default:
        break;
    }
  }

  private escape(seq: string): void {
    if (!seq.startsWith("\x1b[")) return;
    const final = seq[seq.length - 1]!;
    const body = seq.slice(2, -1);
    if (body.startsWith("?")) {
      this.privateMode(body.slice(1), final === "h");
      return;
    }
    const params = body.split(";").map((p) => (p === "" ? undefined : Number(p)));
    const n = params[0] ?? 1;
    this.pendingWrap = false;
    switch (final) {
      case "A":
        this.y = Math.max(0, this.y - n);
        break;
      case "B":
        this.y = Math.min(this.rows - 1, this.y + n);
        break;
      case "C":
        this.x = Math.min(this.cols - 1, this.x + n);
        break;
      case "D":
        this.x = Math.max(0, this.x - n);
        break;
      case "E":
        this.y = Math.min(this.rows - 1, this.y + n);
        this.x = 0;
        break;
      case "F":
        this.y = Math.max(0, this.y - n);
        this.x = 0;
        break;
      case "G":
        this.x = clamp(n - 1, 0, this.cols - 1);
        break;
      case "H":
      case "f":
        this.y = clamp((params[0] ?? 1) - 1, 0, this.rows - 1);
        this.x = clamp((params[1] ?? 1) - 1, 0, this.cols - 1);
        break;
      case "J":
        this.eraseDisplay(params[0] ?? 0);
        break;
      case "K":
        this.eraseLine(params[0] ?? 0);
        break;
      default:
        break;
    }
  }

  private privateMode(body: string, on: boolean): void {
    for (const p of body.split(";")) {
      if (p === "25") this.modes.cursorVisible = on;
      else if (p === "2004") this.modes.bracketedPaste = on;
      else if (p === "2026") this.modes.synchronized = on;
    }
  }

  private eraseLine(mode: number): void {
    const row = this.grid[this.y]!;
    const [from, to] =
      mode === 0 ? [this.x, this.cols] : mode === 1 ? [0, this.x + 1] : [0, this.cols];
    for (let i = from; i < to; i++) row[i] = " ";
  }

  private eraseDisplay(mode: number): void {
    if (mode === 3) {
      this.history = [];
      return;
    }
    if (mode === 2) {
      for (let r = 0; r < this.rows; r++) this.grid[r] = this.blankRow();
      return;
    }
    if (mode === 0) {
      this.eraseLine(0);
      for (let r = this.y + 1; r < this.rows; r++) this.grid[r] = this.blankRow();
      return;
    }
    this.eraseLine(1);
    for (let r = 0; r < this.y; r++) this.grid[r] = this.blankRow();
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function rowText(row: Row): string {
  return row.join("").replace(/ +$/, "");
}
