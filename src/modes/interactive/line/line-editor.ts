/**
 * 行式界面的单行编辑器（raw 模式可用时）。[B6]
 *
 * 键位：可见字符插入；←/→、Home/End（Ctrl+A / Ctrl+E）移动；↑/↓ 历史；退格、Delete、
 * Ctrl+U（删到行首）、Ctrl+K（删到行尾）、Ctrl+W（删前一个词）；Enter 提交；Ctrl+C 中断；
 * 空行 Ctrl+D 结束。括号粘贴：单行原样插入，多行折叠成 `[粘贴 #n +k 行]` 标记，提交时展开。
 * `ask()`：审批等单键问答，下一个可见字符（或 Enter = 缺省答案）作答。
 */

import { visibleWidth } from "../../../tui/ansi.js";
import { PasteState } from "./paste-state.js";

export type EditorAction =
  { kind: "submit"; text: string } | { kind: "interrupt" } | { kind: "eof" };

export interface LineEditorOptions {
  prompt: string;
  write(text: string): void;
  history?: string[];
}

const KEYS: Readonly<Record<string, string>> = {
  "\x1b[A": "up",
  "\x1b[B": "down",
  "\x1b[C": "right",
  "\x1b[D": "left",
  "\x1b[H": "home",
  "\x1bOH": "home",
  "\x1b[1~": "home",
  "\x1b[F": "end",
  "\x1bOF": "end",
  "\x1b[4~": "end",
  "\x1b[3~": "delete",
};

export class LineEditor {
  buffer = "";
  cursor = 0;
  private readonly paste = new PasteState();
  private readonly pastes = new Map<string, string>();
  private readonly history: string[];
  private historyAt: number;
  private visible = false;
  private question: { resolve(answer: string): void; fallback: string } | undefined;

  constructor(private readonly options: LineEditorOptions) {
    this.history = options.history ?? [];
    this.historyAt = this.history.length;
  }

  /** 提示符 + 内容，光标放到正确的列。 */
  render(): void {
    this.visible = true;
    const line = this.options.prompt + this.buffer;
    const back = visibleWidth(this.buffer.slice(this.cursor));
    this.options.write(`\r\x1b[2K${line}${back > 0 ? `\x1b[${back}D` : ""}`);
  }

  /** 清掉编辑行（输出前调用）。 */
  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.options.write("\r\x1b[2K");
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** 单键问答：返回小写的回答字符；Enter → fallback；Ctrl+C → fallback。 */
  ask(question: string, fallback: string): Promise<string> {
    this.hide();
    this.options.write(question);
    return new Promise((resolve) => {
      this.question = { resolve, fallback };
    });
  }

  feed(data: string): EditorAction[] {
    const actions: EditorAction[] = [];
    for (const piece of this.paste.feed(data)) {
      if (piece.kind === "paste") this.insertPaste(piece.text);
      else this.keys(piece.text, actions);
    }
    return actions;
  }

  /** 输入暂停后交出留着的 ESC 前缀。 */
  flush(): EditorAction[] {
    const actions: EditorAction[] = [];
    for (const piece of this.paste.flush())
      if (piece.kind === "text") this.keys(piece.text, actions);
    return actions;
  }

  private answer(ch: string): void {
    const q = this.question;
    if (q === undefined) return;
    this.question = undefined;
    const answer = ch === "\r" || ch === "\n" || ch === "\x03" ? q.fallback : ch.toLowerCase();
    this.options.write(`${answer}\n`);
    q.resolve(answer);
  }

  private keys(text: string, actions: EditorAction[]): void {
    let i = 0;
    while (i < text.length) {
      if (this.question !== undefined) {
        const ch = text[i] as string;
        i++;
        if (ch === "\x1b") continue;
        this.answer(ch);
        continue;
      }
      if (text[i] === "\x1b") {
        const seq = /^\x1b(?:\[[0-9;]*[~A-Za-z]|O[A-Za-z])?/.exec(text.slice(i))?.[0] ?? "\x1b";
        i += seq.length;
        this.special(KEYS[seq]);
        continue;
      }
      const cp = text.codePointAt(i) as number;
      const ch = String.fromCodePoint(cp);
      i += ch.length;
      switch (ch) {
        case "\r":
        case "\n":
          actions.push({ kind: "submit", text: this.submit() });
          break;
        case "\x03":
          actions.push({ kind: "interrupt" });
          break;
        case "\x04":
          if (this.buffer === "") actions.push({ kind: "eof" });
          else this.special("delete");
          break;
        case "\x7f":
        case "\b":
          if (this.cursor > 0) {
            const before = Array.from(this.buffer.slice(0, this.cursor));
            before.pop();
            const head = before.join("");
            this.buffer = head + this.buffer.slice(this.cursor);
            this.cursor = head.length;
          }
          break;
        case "\x01":
          this.special("home");
          break;
        case "\x05":
          this.special("end");
          break;
        case "\x15":
          this.buffer = this.buffer.slice(this.cursor);
          this.cursor = 0;
          break;
        case "\x0b":
          this.buffer = this.buffer.slice(0, this.cursor);
          break;
        case "\x17": {
          const head = this.buffer.slice(0, this.cursor).replace(/\S+\s*$/, "");
          this.buffer = head + this.buffer.slice(this.cursor);
          this.cursor = head.length;
          break;
        }
        default:
          if (cp >= 0x20) this.insert(ch);
      }
    }
    if (this.visible) this.render();
  }

  private special(key: string | undefined): void {
    switch (key) {
      case "left":
        if (this.cursor > 0)
          this.cursor -= Array.from(this.buffer.slice(0, this.cursor)).pop()?.length ?? 1;
        break;
      case "right":
        if (this.cursor < this.buffer.length)
          this.cursor += Array.from(this.buffer.slice(this.cursor))[0]?.length ?? 1;
        break;
      case "home":
        this.cursor = 0;
        break;
      case "end":
        this.cursor = this.buffer.length;
        break;
      case "delete":
        if (this.cursor < this.buffer.length) {
          const tail = Array.from(this.buffer.slice(this.cursor)).slice(1).join("");
          this.buffer = this.buffer.slice(0, this.cursor) + tail;
        }
        break;
      case "up":
      case "down": {
        const next = this.historyAt + (key === "up" ? -1 : 1);
        if (next < 0 || next > this.history.length) break;
        this.historyAt = next;
        this.buffer = this.history[next] ?? "";
        this.cursor = this.buffer.length;
        break;
      }
      default:
        break;
    }
  }

  private insert(text: string): void {
    this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
    this.cursor += text.length;
  }

  private insertPaste(text: string): void {
    const lines = text.split("\n").length;
    if (lines <= 1) {
      this.insert(text);
    } else {
      const marker = `[粘贴 #${this.pastes.size + 1} +${lines} 行]`;
      this.pastes.set(marker, text);
      this.insert(marker);
    }
    if (this.visible) this.render();
  }

  /** 展开粘贴标记、记历史、清空。 */
  private submit(): string {
    let text = this.buffer;
    for (const [marker, content] of this.pastes) text = text.split(marker).join(content);
    if (this.buffer.trim() !== "" && this.history.at(-1) !== this.buffer)
      this.history.push(this.buffer);
    this.historyAt = this.history.length;
    this.buffer = "";
    this.cursor = 0;
    this.pastes.clear();
    if (this.visible) this.options.write("\n");
    this.visible = false;
    return text;
  }
}
