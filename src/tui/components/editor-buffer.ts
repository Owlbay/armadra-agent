/**
 * 编辑器文本缓冲（设计 §12.4）：行 / 光标 / 撤销栈（50 步）/ 单词导航 / 不可分割段。[B4]
 *
 * - 光标列是该行内的 UTF-16 下标，移动与删除按字素簇进行（emoji、组合字符不会被切开）。
 * - 不可分割段（大粘贴折叠标记）由 `atomic` 回调按行给出区间：光标不会停在段内，
 *   退格 / 删除 / 删词把整段一起删掉，单词导航把整段当作一个词。
 * - 撤销：每次编辑前存快照；连续输入同类字符合并为一步；上限 50 步。
 * - 不做选区（无鼠标、无 kill ring，§12.9）。
 */

export interface Position {
  line: number;
  col: number;
}

export type AtomicRanges = (line: string) => ReadonlyArray<readonly [number, number]>;

export interface EditorBufferOptions {
  undoLimit?: number;
  atomic?: AtomicRanges;
}

interface Snapshot {
  lines: string[];
  cursor: Position;
}

type EditKind = "type-word" | "type-space" | "other";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemeStarts(line: string): number[] {
  const starts: number[] = [];
  for (const { index } of segmenter.segment(line)) starts.push(index);
  starts.push(line.length);
  return starts;
}

type CharClass = "space" | "word" | "punct";

function classify(ch: string): CharClass {
  if (/\s/.test(ch)) return "space";
  if (/[\p{L}\p{N}_]/u.test(ch)) return "word";
  return "punct";
}

export class EditorBuffer {
  private lines: string[] = [""];
  private cur: Position = { line: 0, col: 0 };
  private undoStack: Snapshot[] = [];
  private lastKind: EditKind | null = null;
  private readonly undoLimit: number;
  private readonly atomic: AtomicRanges;

  constructor(options: EditorBufferOptions = {}) {
    this.undoLimit = options.undoLimit ?? 50;
    this.atomic = options.atomic ?? (() => []);
  }

  get cursor(): Position {
    return { ...this.cur };
  }

  getLines(): readonly string[] {
    return this.lines;
  }

  getText(): string {
    return this.lines.join("\n");
  }

  isEmpty(): boolean {
    return this.lines.length === 1 && this.lines[0] === "";
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  /** 替换全部文本，光标到末尾。recordUndo=false 时不进撤销栈（历史浏览、提交清空）。 */
  setText(text: string, recordUndo = true): void {
    if (recordUndo) this.snapshot("other");
    this.lines = text.split("\n");
    const last = this.lines.length - 1;
    this.cur = { line: last, col: this.lines[last]!.length };
    if (!recordUndo) this.lastKind = null;
  }

  /** 清空并丢弃撤销历史。 */
  reset(): void {
    this.lines = [""];
    this.cur = { line: 0, col: 0 };
    this.undoStack = [];
    this.lastKind = null;
  }

  setCursor(pos: Position): void {
    const line = Math.max(0, Math.min(this.lines.length - 1, pos.line));
    const col = Math.max(0, Math.min(this.lines[line]!.length, pos.col));
    this.cur = { line, col: this.snapOutOfAtomic(line, col) };
    this.lastKind = null;
  }

  /** 插入文本（可含换行）。 */
  insert(text: string): void {
    if (text === "") return;
    const kind: EditKind =
      text.length <= 2 && !text.includes("\n")
        ? /\s/.test(text)
          ? "type-space"
          : "type-word"
        : "other";
    this.snapshot(kind);
    const line = this.lines[this.cur.line]!;
    const before = line.slice(0, this.cur.col);
    const after = line.slice(this.cur.col);
    const parts = text.split("\n");
    if (parts.length === 1) {
      this.lines[this.cur.line] = before + text + after;
      this.cur = { line: this.cur.line, col: this.cur.col + text.length };
      return;
    }
    const newLines = [before + parts[0]!, ...parts.slice(1, -1), parts[parts.length - 1]! + after];
    this.lines.splice(this.cur.line, 1, ...newLines);
    this.cur = { line: this.cur.line + parts.length - 1, col: parts[parts.length - 1]!.length };
  }

  newLine(): void {
    this.insert("\n");
  }

  backspace(): void {
    const { line, col } = this.cur;
    if (col === 0) {
      if (line === 0) return;
      this.snapshot("other");
      const prevLen = this.lines[line - 1]!.length;
      this.lines[line - 1] += this.lines[line]!;
      this.lines.splice(line, 1);
      this.cur = { line: line - 1, col: prevLen };
      return;
    }
    const start = this.prevStop(line, col);
    this.snapshot("other");
    this.deleteRange(line, start, col);
  }

  deleteForward(): void {
    const { line, col } = this.cur;
    const text = this.lines[line]!;
    if (col >= text.length) {
      if (line >= this.lines.length - 1) return;
      this.snapshot("other");
      this.lines[line] = text + this.lines[line + 1]!;
      this.lines.splice(line + 1, 1);
      return;
    }
    this.snapshot("other");
    this.deleteRange(line, col, this.nextStop(line, col));
  }

  moveLeft(): void {
    const { line, col } = this.cur;
    if (col > 0) this.cur = { line, col: this.prevStop(line, col) };
    else if (line > 0) this.cur = { line: line - 1, col: this.lines[line - 1]!.length };
    this.lastKind = null;
  }

  moveRight(): void {
    const { line, col } = this.cur;
    if (col < this.lines[line]!.length) this.cur = { line, col: this.nextStop(line, col) };
    else if (line < this.lines.length - 1) this.cur = { line: line + 1, col: 0 };
    this.lastKind = null;
  }

  moveLineStart(): void {
    this.cur = { line: this.cur.line, col: 0 };
    this.lastKind = null;
  }

  moveLineEnd(): void {
    this.cur = { line: this.cur.line, col: this.lines[this.cur.line]!.length };
    this.lastKind = null;
  }

  moveWordLeft(): void {
    const { line, col } = this.cur;
    if (col === 0) return this.moveLeft();
    this.cur = { line, col: this.wordStartBefore(line, col) };
    this.lastKind = null;
  }

  moveWordRight(): void {
    const { line, col } = this.cur;
    if (col >= this.lines[line]!.length) return this.moveRight();
    this.cur = { line, col: this.wordEndAfter(line, col) };
    this.lastKind = null;
  }

  deleteWordBackward(): void {
    const { line, col } = this.cur;
    if (col === 0) return this.backspace();
    this.snapshot("other");
    this.deleteRange(line, this.wordStartBefore(line, col), col);
  }

  deleteWordForward(): void {
    const { line, col } = this.cur;
    if (col >= this.lines[line]!.length) return this.deleteForward();
    this.snapshot("other");
    this.deleteRange(line, col, this.wordEndAfter(line, col));
  }

  deleteToLineStart(): void {
    const { line, col } = this.cur;
    if (col === 0) return this.backspace();
    this.snapshot("other");
    this.deleteRange(line, 0, col);
  }

  deleteToLineEnd(): void {
    const { line, col } = this.cur;
    if (col >= this.lines[line]!.length) return this.deleteForward();
    this.snapshot("other");
    this.deleteRange(line, col, this.lines[line]!.length);
  }

  undo(): boolean {
    const snap = this.undoStack.pop();
    if (!snap) return false;
    this.lines = snap.lines;
    this.cur = snap.cursor;
    this.lastKind = null;
    return true;
  }

  /** 光标所在行内、光标前的文本（补全提供者用）。 */
  textBeforeCursor(): string {
    return this.lines[this.cur.line]!.slice(0, this.cur.col);
  }

  /** 把当前行 [from, cursor) 替换为 text（补全接受）。 */
  replaceBeforeCursor(from: number, text: string): void {
    this.snapshot("other");
    const { line, col } = this.cur;
    const current = this.lines[line]!;
    const start = Math.max(0, Math.min(from, col));
    this.lines[line] = current.slice(0, start) + text + current.slice(col);
    this.cur = { line, col: start + text.length };
  }

  private deleteRange(line: number, from: number, to: number): void {
    const text = this.lines[line]!;
    this.lines[line] = text.slice(0, from) + text.slice(to);
    this.cur = { line, col: from };
  }

  private snapshot(kind: EditKind): void {
    const coalesce = kind !== "other" && kind === this.lastKind;
    this.lastKind = kind === "other" ? null : kind;
    if (coalesce) return;
    this.undoStack.push({ lines: [...this.lines], cursor: { ...this.cur } });
    if (this.undoStack.length > this.undoLimit) this.undoStack.shift();
  }

  private atomicAt(
    line: number,
    col: number,
    inclusiveEnd: boolean,
  ): readonly [number, number] | undefined {
    return this.atomic(this.lines[line]!).find(([s, e]) =>
      inclusiveEnd ? col > s && col <= e : col >= s && col < e,
    );
  }

  private snapOutOfAtomic(line: number, col: number): number {
    const range = this.atomic(this.lines[line]!).find(([s, e]) => col > s && col < e);
    return range ? range[1] : col;
  }

  /** 光标左侧的停靠点（字素簇或整段不可分割段）。 */
  private prevStop(line: number, col: number): number {
    const range = this.atomicAt(line, col, true);
    if (range) return range[0];
    const starts = graphemeStarts(this.lines[line]!);
    let prev = 0;
    for (const s of starts) {
      if (s >= col) break;
      prev = s;
    }
    return prev;
  }

  private nextStop(line: number, col: number): number {
    const range = this.atomicAt(line, col, false);
    if (range) return range[1];
    const starts = graphemeStarts(this.lines[line]!);
    return starts.find((s) => s > col) ?? this.lines[line]!.length;
  }

  private classAt(line: number, col: number): CharClass {
    if (this.atomicAt(line, col, false)) return "word";
    return classify(this.lines[line]![col] ?? " ");
  }

  private wordStartBefore(line: number, col: number): number {
    let pos = col;
    while (pos > 0 && this.classAt(line, this.prevStop(line, pos)) === "space") {
      pos = this.prevStop(line, pos);
    }
    if (pos === 0) return 0;
    const first = this.prevStop(line, pos);
    if (this.atomicAt(line, pos, true)) return first;
    const cls = this.classAt(line, first);
    pos = first;
    while (pos > 0) {
      const p = this.prevStop(line, pos);
      if (this.atomicAt(line, pos, true) || this.classAt(line, p) !== cls) break;
      pos = p;
    }
    return pos;
  }

  private wordEndAfter(line: number, col: number): number {
    const len = this.lines[line]!.length;
    let pos = col;
    while (pos < len && this.classAt(line, pos) === "space") pos = this.nextStop(line, pos);
    if (pos >= len) return len;
    if (this.atomicAt(line, pos, false)) return this.nextStop(line, pos);
    const cls = this.classAt(line, pos);
    while (pos < len && !this.atomicAt(line, pos, false) && this.classAt(line, pos) === cls) {
      pos = this.nextStop(line, pos);
    }
    return pos;
  }
}
