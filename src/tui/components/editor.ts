/**
 * 多行编辑器组件（设计 §12.3、§12.4）。[B4]
 *
 * - 渲染：上下规则线之间按列宽折行（不切开字素与折叠标记）；首行前是提示符 `› `（`user` 粗体，
 *   `disableSubmit` 时 dim），续行缩进 2 列对齐；超过 `maxVisibleLines` 时视窗跟随光标，规则线上提示
 *   上 / 下方隐藏的行数（dim）；获焦时在光标处输出 CURSOR_MARKER 并反显光标格。空文本显示占位
 *   （获焦时也显示，光标反显占位首字）。
 * - 键位：`tui.editor.*`（见 keybindings.ts）。Enter 提交（`disableSubmit` 时忽略）；Shift+Enter / Ctrl+J 换行；
 *   Up/Down 在首 / 末视觉行时浏览历史（单行文本或空文本或已在浏览中），否则按视觉行移动。
 * - 括号粘贴（`ESC[200~…ESC[201~`，由 StdinBuffer 合成一次输入）：> 10 行或 > 1 000 字符折叠为
 *   `[粘贴 #N · M 行]`，提交时展开；粘贴期间不触发补全；粘贴后紧随的 `\r` 是普通 Enter（提交）。
 * - 补全：提供者由外部注入（`/` 命令、`@` 文件等由 B7 实现）；同步或异步返回候选与替换起点；
 *   弹层缩进 2 列，尾行 `(i/n) Tab 接受 · Esc 关闭`。
 * - 历史：会话内 + 可选历史文件（JSONL，每行一个 JSON 字符串，保留最近 500 条）。
 */

import { msg } from "../../i18n/index.js";
import { CURSOR_MARKER, type Component, type Focusable, type Theme } from "../component.js";
import { truncateToWidth, visibleWidth } from "../ansi.js";
import { defaultKeybindings, type Keybindings } from "../keybindings.js";
import { isPasteData, isPrintableText, unwrapPaste } from "../keys.js";
import { plainTheme } from "../theme.js";
import { EditorBuffer } from "./editor-buffer.js";
import { appendHistoryFile, loadHistoryFile } from "./editor-history.js";
import { PasteStore } from "./editor-paste.js";
import { SelectList, type SelectItem } from "./select-list.js";

export { loadHistoryFile } from "./editor-history.js";

export interface AutocompleteItem {
  /** 接受后替换进编辑器的文本。 */
  value: string;
  label: string;
  description?: string;
}

export interface AutocompleteResult {
  items: AutocompleteItem[];
  /** 当前行内被替换区间的起点（UTF-16 列）；终点是光标。 */
  from: number;
}

export interface AutocompleteContext {
  /** 当前行全文。 */
  line: string;
  /** 当前行光标前的文本。 */
  textBeforeCursor: string;
  /** 编辑器全文（折叠标记未展开）。 */
  text: string;
  /** Tab 主动请求时为 true；输入触发时为 false。 */
  force: boolean;
}

export interface AutocompleteProvider {
  getSuggestions(
    context: AutocompleteContext,
  ): AutocompleteResult | null | Promise<AutocompleteResult | null>;
}

export interface EditorOptions {
  theme?: Theme;
  keybindings?: Keybindings;
  /** 可见文本行上限，缺省 10。 */
  maxVisibleLines?: number;
  /** 历史条数上限，缺省 500。 */
  historyLimit?: number;
  /** 历史文件路径（JSONL）；缺省只保留会话内历史。 */
  historyFile?: string;
  autocomplete?: AutocompleteProvider;
  /** 异步补全返回后请求重绘。 */
  requestRender?: () => void;
  placeholder?: string;
  onSubmit?(text: string): void;
  onChange?(text: string): void;
}

interface VisualRow {
  line: number;
  start: number;
  end: number;
  /** 本逻辑行的最后一段。 */
  last: boolean;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 提示符 `› ` / 续行缩进的宽度。 */
const PROMPT_WIDTH = 2;

export class Editor implements Component, Focusable {
  focused = false;
  /** 审批对话框期间置 true：Enter 不提交。 */
  disableSubmit = false;
  private readonly buffer: EditorBuffer;
  private readonly pastes = new PasteStore();
  private readonly keys: Keybindings;
  private readonly theme: Theme;
  private history: string[] = [];
  private historyIndex = -1;
  private draft = "";
  private lastWidth = 80;
  private scrollTop = 0;
  private preferredCol: number | null = null;
  private completion: { list: SelectList; from: number } | null = null;
  private completionToken = 0;

  constructor(private readonly options: EditorOptions = {}) {
    this.buffer = new EditorBuffer({ atomic: (line) => this.pastes.ranges(line) });
    this.keys = options.keybindings ?? defaultKeybindings;
    this.theme = options.theme ?? plainTheme();
    if (options.historyFile) this.history = loadHistoryFile(options.historyFile, this.historyLimit);
  }

  private get historyLimit(): number {
    return this.options.historyLimit ?? 500;
  }

  // ---- 公共 API -------------------------------------------------------------

  /** 编辑器原文（折叠标记未展开）。 */
  getText(): string {
    return this.buffer.getText();
  }

  /** 展开折叠标记后的文本（即提交内容）。 */
  getExpandedText(): string {
    return this.pastes.expand(this.buffer.getText());
  }

  setText(text: string): void {
    this.buffer.setText(text);
    this.afterEdit(false);
  }

  insertText(text: string): void {
    this.buffer.insert(text);
    this.afterEdit(false);
  }

  clear(): void {
    this.buffer.reset();
    this.pastes.clear();
    this.closeCompletion();
    this.historyIndex = -1;
    this.options.onChange?.("");
  }

  isEmpty(): boolean {
    return this.buffer.isEmpty();
  }

  get cursor(): { line: number; col: number } {
    return this.buffer.cursor;
  }

  get isCompletionOpen(): boolean {
    return this.completion !== null;
  }

  /** 正在用 ↑↓ 浏览输入历史（编辑后即退出）。 */
  get isBrowsingHistory(): boolean {
    return this.historyIndex !== -1;
  }

  getHistory(): readonly string[] {
    return this.history;
  }

  setHistory(entries: readonly string[]): void {
    this.history = entries.slice(-this.historyLimit);
    this.historyIndex = -1;
  }

  addToHistory(text: string): void {
    if (text.trim() === "" || this.history[this.history.length - 1] === text) return;
    this.history.push(text);
    if (this.history.length > this.historyLimit) this.history.shift();
    if (this.options.historyFile)
      appendHistoryFile(this.options.historyFile, text, this.historyLimit);
  }

  /** 取出提交内容（展开、记历史、清空），不调用 onSubmit；空文本返回 null。供 followUp 等使用。 */
  takeSubmission(): string | null {
    const text = this.getExpandedText();
    if (text.trim() === "") return null;
    this.addToHistory(text);
    this.clear();
    return text;
  }

  submit(): void {
    if (this.disableSubmit) return;
    const text = this.takeSubmission();
    if (text !== null) this.options.onSubmit?.(text);
  }

  // ---- 输入 -----------------------------------------------------------------

  handleInput(data: string): void {
    if (isPasteData(data)) {
      this.closeCompletion();
      this.buffer.insert(this.pastes.accept(unwrapPaste(data)));
      this.afterEdit(false);
      return;
    }
    if (this.completion && this.handleCompletionKey(data)) return;
    if (this.handleAction(data)) return;
    if (isPrintableText(data)) {
      this.buffer.insert(data);
      this.afterEdit(true);
    }
  }

  private handleCompletionKey(data: string): boolean {
    const k = this.keys;
    const list = this.completion!.list;
    if (k.matches(data, "tui.select.up")) list.moveSelection(-1);
    else if (k.matches(data, "tui.select.down")) list.moveSelection(1);
    else if (k.matches(data, "tui.editor.submit")) {
      // Enter：接受候选；候选与已输入完全相同（没有可补的了）则直接提交
      const before = this.buffer.getText();
      this.acceptCompletion();
      if (this.buffer.getText() === before) this.submit();
    } else if (k.matches(data, "tui.select.confirm")) this.acceptCompletion();
    else if (k.matches(data, "tui.select.cancel")) this.closeCompletion();
    else return false;
    return true;
  }

  private handleAction(data: string): boolean {
    const k = this.keys;
    const b = this.buffer;
    const edit = (fn: () => void): true => {
      fn();
      this.afterEdit(true);
      return true;
    };
    const move = (fn: () => void): true => {
      fn();
      this.preferredCol = null;
      this.closeCompletion();
      return true;
    };
    if (k.matches(data, "tui.editor.submit")) {
      this.submit();
      return true;
    }
    if (k.matches(data, "tui.editor.newLine")) return edit(() => b.newLine());
    if (k.matches(data, "tui.editor.deleteBackward")) return edit(() => b.backspace());
    if (k.matches(data, "tui.editor.deleteForward")) return edit(() => b.deleteForward());
    if (k.matches(data, "tui.editor.deleteWordBackward")) return edit(() => b.deleteWordBackward());
    if (k.matches(data, "tui.editor.deleteWordForward")) return edit(() => b.deleteWordForward());
    if (k.matches(data, "tui.editor.deleteToLineStart")) return edit(() => b.deleteToLineStart());
    if (k.matches(data, "tui.editor.deleteToLineEnd")) return edit(() => b.deleteToLineEnd());
    if (k.matches(data, "tui.editor.undo")) return edit(() => b.undo());
    if (k.matches(data, "tui.editor.cursorLeft")) return move(() => b.moveLeft());
    if (k.matches(data, "tui.editor.cursorRight")) return move(() => b.moveRight());
    if (k.matches(data, "tui.editor.wordLeft")) return move(() => b.moveWordLeft());
    if (k.matches(data, "tui.editor.wordRight")) return move(() => b.moveWordRight());
    if (k.matches(data, "tui.editor.lineStart")) return move(() => b.moveLineStart());
    if (k.matches(data, "tui.editor.lineEnd")) return move(() => b.moveLineEnd());
    if (k.matches(data, "tui.editor.cursorUp")) {
      this.closeCompletion();
      this.verticalMove(-1);
      return true;
    }
    if (k.matches(data, "tui.editor.cursorDown")) {
      this.closeCompletion();
      this.verticalMove(1);
      return true;
    }
    if (k.matches(data, "tui.editor.complete") && this.options.autocomplete) {
      this.requestCompletion(true);
      return true;
    }
    return false;
  }

  private afterEdit(triggerCompletion: boolean): void {
    this.historyIndex = -1;
    this.preferredCol = null;
    this.options.onChange?.(this.buffer.getText());
    if (triggerCompletion) this.requestCompletion(false);
    else this.closeCompletion();
  }

  // ---- 历史与纵向移动 -------------------------------------------------------

  private verticalMove(direction: -1 | 1): void {
    const rows = this.layout(this.contentWidth(this.lastWidth));
    const at = this.cursorRowIndex(rows);
    const singleLine = !this.buffer.getText().includes("\n");
    const browsing = this.historyIndex !== -1;
    if (direction === -1 && at === 0) {
      if (this.history.length > 0 && (this.buffer.isEmpty() || singleLine || browsing)) {
        this.historyStep(-1);
      } else this.buffer.moveLineStart();
      return;
    }
    if (direction === 1 && at === rows.length - 1) {
      if (browsing) this.historyStep(1);
      else this.buffer.moveLineEnd();
      return;
    }
    const row = rows[at]!;
    const line = this.buffer.getLines()[row.line]!;
    const col = this.preferredCol ?? visibleWidth(line.slice(row.start, this.buffer.cursor.col));
    this.preferredCol = col;
    const target = rows[at + direction]!;
    this.buffer.setCursor({ line: target.line, col: this.colAtWidth(target, col) });
  }

  private historyStep(direction: -1 | 1): void {
    if (direction === -1) {
      if (this.historyIndex === -1) {
        this.draft = this.buffer.getText();
        this.historyIndex = this.history.length - 1;
      } else if (this.historyIndex > 0) this.historyIndex--;
      else return;
      this.buffer.setText(this.history[this.historyIndex]!, false);
    } else {
      this.historyIndex++;
      if (this.historyIndex >= this.history.length) {
        this.historyIndex = -1;
        this.buffer.setText(this.draft, false);
      } else this.buffer.setText(this.history[this.historyIndex]!, false);
    }
    this.preferredCol = null;
    this.options.onChange?.(this.buffer.getText());
  }

  private colAtWidth(row: VisualRow, targetWidth: number): number {
    const line = this.buffer.getLines()[row.line]!;
    let col = row.start;
    let width = 0;
    for (const { segment, index } of segmenter.segment(line.slice(row.start, row.end))) {
      const w = visibleWidth(segment);
      if (width + w > targetWidth) break;
      width += w;
      col = row.start + index + segment.length;
    }
    // 不能停在下一段的起点之后（非末段时 end 属于下一行）
    if (!row.last && col >= row.end) col = this.prevGrapheme(line, row.end);
    return col;
  }

  private prevGrapheme(line: string, col: number): number {
    let prev = 0;
    for (const { index } of segmenter.segment(line)) {
      if (index >= col) break;
      prev = index;
    }
    return prev;
  }

  // ---- 补全 -----------------------------------------------------------------

  private requestCompletion(force: boolean): void {
    const provider = this.options.autocomplete;
    if (!provider) return;
    const token = ++this.completionToken;
    const lines = this.buffer.getLines();
    const context: AutocompleteContext = {
      line: lines[this.buffer.cursor.line]!,
      textBeforeCursor: this.buffer.textBeforeCursor(),
      text: this.buffer.getText(),
      force,
    };
    const result = provider.getSuggestions(context);
    if (result instanceof Promise) {
      result.then(
        (r) => {
          if (token !== this.completionToken) return;
          this.applyCompletion(r, force);
          this.options.requestRender?.();
        },
        () => undefined,
      );
    } else this.applyCompletion(result, force);
  }

  private applyCompletion(result: AutocompleteResult | null, force: boolean): void {
    if (!result || result.items.length === 0) {
      this.closeCompletion();
      return;
    }
    if (force && result.items.length === 1) {
      this.buffer.replaceBeforeCursor(result.from, result.items[0]!.value);
      this.closeCompletion();
      this.options.onChange?.(this.buffer.getText());
      return;
    }
    const items: SelectItem[] = result.items.map((item) =>
      item.description === undefined
        ? { value: item.value, label: item.label }
        : { value: item.value, label: item.label, description: item.description },
    );
    this.completion = {
      list: new SelectList(items, {
        maxVisible: 8,
        theme: this.theme,
        keybindings: this.keys,
        footer: msg().interactive.editor.completionFooter,
        showCount: true,
      }),
      from: result.from,
    };
  }

  private acceptCompletion(): void {
    const c = this.completion;
    if (!c) return;
    const item = c.list.getSelected();
    this.closeCompletion();
    if (!item) return;
    this.buffer.replaceBeforeCursor(c.from, item.value);
    this.historyIndex = -1;
    this.options.onChange?.(this.buffer.getText());
  }

  private closeCompletion(): void {
    this.completion = null;
    this.completionToken++;
  }

  // ---- 渲染 -----------------------------------------------------------------

  /** 文本列宽：去掉提示符与行尾光标格。 */
  private contentWidth(width: number): number {
    return Math.max(1, width - PROMPT_WIDTH - 1);
  }

  private prompt(): string {
    const glyph = this.theme.glyphs.prompt;
    return this.theme.fg(this.disableSubmit ? "dim" : "user", this.theme.bold(glyph)) + " ";
  }

  private placeholderLine(width: number): string {
    const text = this.options.placeholder ?? "";
    if (!this.focused) return truncateToWidth(this.prompt() + this.theme.fg("dim", text), width);
    const first = nextGrapheme(text, 0);
    const rest = text.slice(first.length);
    const cursor = CURSOR_MARKER + `\x1b[7m${this.theme.fg("dim", first)}\x1b[27m`;
    return truncateToWidth(this.prompt() + cursor + this.theme.fg("dim", rest), width);
  }

  /** 逻辑行 → 视觉行（按列宽折行，不切开字素与折叠标记）。 */
  private layout(width: number): VisualRow[] {
    const rows: VisualRow[] = [];
    this.buffer.getLines().forEach((text, line) => {
      const atomic = this.pastes.ranges(text);
      let start = 0;
      let used = 0;
      let pos = 0;
      const graphemes = [...segmenter.segment(text)];
      let gi = 0;
      while (gi < graphemes.length) {
        const g = graphemes[gi]!;
        pos = g.index;
        const range = atomic.find(([s]) => s === pos);
        const unitEnd = range ? range[1] : pos + g.segment.length;
        const unitWidth = visibleWidth(text.slice(pos, unitEnd));
        if (used > 0 && used + unitWidth > width) {
          rows.push({ line, start, end: pos, last: false });
          start = pos;
          used = 0;
        }
        if (range && unitWidth > width) {
          // 标记比整行还宽：按字素拆开显示（逻辑上仍不可分割）
          used += visibleWidth(g.segment);
          gi++;
          continue;
        }
        used += unitWidth;
        while (gi < graphemes.length && graphemes[gi]!.index < unitEnd) gi++;
      }
      rows.push({ line, start, end: text.length, last: true });
    });
    return rows;
  }

  private cursorRowIndex(rows: readonly VisualRow[]): number {
    const { line, col } = this.buffer.cursor;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (r.line === line && col >= r.start && (col < r.end || r.last)) return i;
    }
    return rows.length - 1;
  }

  private renderRow(row: VisualRow, withCursor: boolean): string {
    const text = this.buffer.getLines()[row.line]!;
    const atomic = this.pastes.ranges(text);
    const cursorCol = withCursor ? this.buffer.cursor.col : -1;
    let out = "";
    let pos = row.start;
    while (pos < row.end || pos === cursorCol) {
      if (pos === cursorCol) {
        const g = pos < row.end ? nextGrapheme(text, pos) : " ";
        out += CURSOR_MARKER + `\x1b[7m${g}\x1b[27m`;
        if (pos >= row.end) break;
        pos += g.length;
        continue;
      }
      const range = atomic.find(([s, e]) => pos >= s && pos < e);
      if (range) {
        const end = Math.min(range[1], row.end, cursorCol > pos ? cursorCol : Infinity);
        out += this.theme.fg("accent", text.slice(pos, end));
        pos = end;
        continue;
      }
      let end = row.end;
      if (cursorCol > pos && cursorCol < end) end = cursorCol;
      const nextAtomic = atomic.find(([s]) => s > pos && s < end);
      if (nextAtomic) end = nextAtomic[0];
      out += text.slice(pos, end);
      pos = end;
    }
    return out;
  }

  render(width: number): string[] {
    this.lastWidth = width;
    const theme = this.theme;
    const contentWidth = this.contentWidth(width);
    const rows = this.layout(contentWidth);
    const cursorRow = this.cursorRowIndex(rows);
    const maxVisible = Math.max(1, this.options.maxVisibleLines ?? 10);
    if (cursorRow < this.scrollTop) this.scrollTop = cursorRow;
    if (cursorRow >= this.scrollTop + maxVisible) this.scrollTop = cursorRow - maxVisible + 1;
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, rows.length - maxVisible));
    const end = Math.min(rows.length, this.scrollTop + maxVisible);
    const g = theme.glyphs;
    const lines = [this.border(width, this.scrollTop > 0 ? `${g.arrowUp} ${this.scrollTop}` : "")];
    if (this.buffer.isEmpty() && this.options.placeholder) {
      lines.push(this.placeholderLine(width));
    } else {
      const indent = " ".repeat(PROMPT_WIDTH);
      for (let i = this.scrollTop; i < end; i++) {
        const prefix = i === 0 ? this.prompt() : indent;
        lines.push(prefix + this.renderRow(rows[i]!, this.focused && i === cursorRow));
      }
    }
    const below = rows.length - end;
    lines.push(this.border(width, below > 0 ? `${g.arrowDown} ${below}` : ""));
    if (this.completion) {
      for (const line of this.completion.list.render(Math.max(1, width - 2))) {
        lines.push("  " + line);
      }
    }
    return lines;
  }

  private border(width: number, label: string): string {
    const rule = this.theme.glyphs.rule;
    const labelWidth = visibleWidth(label);
    if (label === "" || width < labelWidth + 6) return this.theme.fg("border", rule.repeat(width));
    const tail = rule.repeat(width - labelWidth - 5);
    return (
      this.theme.fg("border", rule.repeat(3) + " ") +
      this.theme.fg("dim", label) +
      this.theme.fg("border", " " + tail)
    );
  }

  invalidate(): void {
    this.completion?.list.invalidate();
  }
}

function nextGrapheme(text: string, pos: number): string {
  const first = segmenter
    .segment(text.slice(pos, pos + 32))
    [Symbol.iterator]()
    .next();
  return first.done ? " " : first.value.segment;
}
