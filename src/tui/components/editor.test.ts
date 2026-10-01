import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CURSOR_MARKER } from "../component.js";
import { stripAnsi, visibleWidth } from "../ansi.js";
import { MemoryTerminal } from "../terminal.js";
import { TUI } from "../tui.js";
import { Editor, type AutocompleteProvider } from "./editor.js";

const PASTE = (s: string) => `\x1b[200~${s}\x1b[201~`;

function typeInto(editor: Editor, text: string): void {
  for (const ch of text) editor.handleInput(ch);
}

function plain(lines: string[]): string[] {
  return lines.map((l) => stripAnsi(l.split(CURSOR_MARKER).join("")));
}

describe("Editor 基本编辑与提交", () => {
  it("Enter 提交并清空，Shift+Enter / Ctrl+J 换行", () => {
    const submitted: string[] = [];
    const editor = new Editor({ onSubmit: (t) => submitted.push(t) });
    typeInto(editor, "hi");
    editor.handleInput("\x1b[13;2u");
    typeInto(editor, "there");
    editor.handleInput("\n");
    typeInto(editor, "!");
    expect(editor.getText()).toBe("hi\nthere\n!");
    editor.handleInput("\r");
    expect(submitted).toEqual(["hi\nthere\n!"]);
    expect(editor.isEmpty()).toBe(true);
  });

  it("空白文本不提交", () => {
    const submitted: string[] = [];
    const editor = new Editor({ onSubmit: (t) => submitted.push(t) });
    typeInto(editor, "  ");
    editor.handleInput("\r");
    expect(submitted).toEqual([]);
  });

  it("disableSubmit 时 Enter 不提交、不清空", () => {
    const submitted: string[] = [];
    const editor = new Editor({ onSubmit: (t) => submitted.push(t) });
    editor.disableSubmit = true;
    typeInto(editor, "wait");
    editor.handleInput("\r");
    expect(submitted).toEqual([]);
    expect(editor.getText()).toBe("wait");
    editor.disableSubmit = false;
    editor.handleInput("\r");
    expect(submitted).toEqual(["wait"]);
  });

  it("行编辑键：Ctrl+W / Ctrl+U / Ctrl+K / Alt+B / Ctrl+Z", () => {
    const editor = new Editor();
    typeInto(editor, "one two three");
    editor.handleInput("\x17");
    expect(editor.getText()).toBe("one two ");
    editor.handleInput("\x1bb");
    editor.handleInput("\x0b");
    expect(editor.getText()).toBe("one ");
    editor.handleInput("\x1a");
    expect(editor.getText()).toBe("one two ");
    editor.handleInput("\x15");
    expect(editor.getText()).toBe("two ");
  });

  it("takeSubmission 取出内容并记历史（followUp 用）", () => {
    const editor = new Editor();
    typeInto(editor, "later");
    expect(editor.takeSubmission()).toBe("later");
    expect(editor.isEmpty()).toBe(true);
    expect(editor.getHistory()).toEqual(["later"]);
    expect(editor.takeSubmission()).toBeNull();
  });
});

describe("Editor 大粘贴折叠", () => {
  const big = Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n");

  it("> 10 行折叠为标记，提交时展开", () => {
    const submitted: string[] = [];
    const editor = new Editor({ onSubmit: (t) => submitted.push(t) });
    typeInto(editor, "see: ");
    editor.handleInput(PASTE(big));
    expect(editor.getText()).toBe("see: [paste #1 +30 lines]");
    editor.handleInput("\r");
    expect(submitted).toEqual([`see: ${big}`]);
  });

  it("> 1000 字符折叠；小粘贴原样插入（\\r 规范化为 \\n）", () => {
    const editor = new Editor();
    editor.handleInput(PASTE("x".repeat(1001)));
    expect(editor.getText()).toBe("[paste #1 +1 lines]");
    editor.clear();
    editor.handleInput(PASTE("a\r\nb\rc"));
    expect(editor.getText()).toBe("a\nb\nc");
    editor.clear();
    editor.handleInput(PASTE("x".repeat(1000)));
    expect(editor.getText()).toBe("x".repeat(1000));
  });

  it("标记是不可分割段：退格一次删掉整段", () => {
    const editor = new Editor();
    editor.handleInput(PASTE(big));
    editor.handleInput(PASTE(big));
    expect(editor.getText()).toBe("[paste #1 +30 lines][paste #2 +30 lines]");
    editor.handleInput("\x7f");
    expect(editor.getText()).toBe("[paste #1 +30 lines]");
    editor.handleInput("\x1b[D");
    editor.handleInput("\x1b[3~");
    expect(editor.getText()).toBe("");
  });

  it("经 MemoryTerminal：粘贴跨 data 块 → 折叠标记 → 紧随的 \\r 提交展开", () => {
    const terminal = new MemoryTerminal({ columns: 60, rows: 10 });
    const tui = new TUI(terminal);
    const submitted: string[] = [];
    const editor = new Editor({ onSubmit: (t) => submitted.push(t) });
    tui.addChild(editor);
    tui.start();
    tui.setFocus(editor);
    const text = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\r");
    const chunks = [
      "\x1b[2",
      "00~" + text.slice(0, 20),
      text.slice(20, 50),
      text.slice(50) + "\x1b[20",
      "1~\r",
    ];
    for (const chunk of chunks.slice(0, -1)) terminal.sendInput(chunk);
    tui.renderNow();
    expect(submitted).toEqual([]);
    expect(editor.getText()).toBe("");
    terminal.sendInput(chunks.at(-1)!);
    expect(submitted).toEqual([text.replace(/\r/g, "\n")]);
    tui.stop();
  });

  it("粘贴不触发补全", () => {
    let calls = 0;
    const provider: AutocompleteProvider = {
      getSuggestions: () => {
        calls++;
        return { items: [{ value: "/help", label: "/help" }], from: 0 };
      },
    };
    const editor = new Editor({ autocomplete: provider });
    editor.handleInput(PASTE("/he"));
    expect(calls).toBe(0);
    expect(editor.isCompletionOpen).toBe(false);
    editor.handleInput("l");
    expect(calls).toBe(1);
    expect(editor.isCompletionOpen).toBe(true);
  });
});

describe("Editor 历史", () => {
  it("Up / Down 浏览历史并恢复草稿", () => {
    const editor = new Editor();
    editor.setHistory(["first", "second"]);
    typeInto(editor, "draft");
    editor.handleInput("\x1b[A");
    expect(editor.getText()).toBe("second");
    editor.handleInput("\x1b[A");
    expect(editor.getText()).toBe("first");
    editor.handleInput("\x1b[A");
    expect(editor.getText()).toBe("first");
    editor.handleInput("\x1b[B");
    expect(editor.getText()).toBe("second");
    editor.handleInput("\x1b[B");
    expect(editor.getText()).toBe("draft");
  });

  it("多行文本里 Up 先在行间移动", () => {
    const editor = new Editor();
    editor.setHistory(["old"]);
    editor.render(40);
    typeInto(editor, "ab");
    editor.handleInput("\n");
    typeInto(editor, "cd");
    editor.handleInput("\x1b[A");
    expect(editor.cursor).toEqual({ line: 0, col: 2 });
    expect(editor.getText()).toBe("ab\ncd");
  });

  it("提交写历史文件（JSONL），新编辑器能读回", () => {
    const dir = mkdtempSync(join(tmpdir(), "ama-hist-"));
    const file = join(dir, "sub", "history");
    const editor = new Editor({ historyFile: file });
    typeInto(editor, "one");
    editor.handleInput("\r");
    editor.insertText("two\nlines");
    editor.handleInput("\r");
    expect(readFileSync(file, "utf8")).toBe('"one"\n"two\\nlines"\n');
    const again = new Editor({ historyFile: file });
    expect(again.getHistory()).toEqual(["one", "two\nlines"]);
  });
});

describe("Editor 补全", () => {
  const provider: AutocompleteProvider = {
    getSuggestions: ({ textBeforeCursor }) => {
      const m = /(?:^|\s)(\/\w*)$/.exec(textBeforeCursor);
      if (!m) return null;
      const all = ["/help", "/model", "/tree"].filter((c) => c.startsWith(m[1]!));
      return {
        items: all.map((c) => ({ value: c, label: c, description: `run ${c}` })),
        from: textBeforeCursor.length - m[1]!.length,
      };
    },
  };

  it("输入触发列表，上下选择，Tab 接受", () => {
    const editor = new Editor({ autocomplete: provider });
    editor.handleInput("/");
    expect(editor.isCompletionOpen).toBe(true);
    const lines = plain(editor.render(40));
    expect(lines.some((l) => l.includes("› /help"))).toBe(true);
    editor.handleInput("\x1b[B");
    editor.handleInput("\t");
    expect(editor.getText()).toBe("/model");
    expect(editor.isCompletionOpen).toBe(false);
  });

  it("Enter 在列表打开时接受而不是提交；Esc 关闭", () => {
    const submitted: string[] = [];
    const editor = new Editor({ autocomplete: provider, onSubmit: (t) => submitted.push(t) });
    typeInto(editor, "/t");
    editor.handleInput("\r");
    expect(editor.getText()).toBe("/tree");
    expect(submitted).toEqual([]);
    typeInto(editor, " /");
    editor.handleInput("\x1b");
    expect(editor.isCompletionOpen).toBe(false);
  });

  it("候选与输入完全相同时 Enter 直接提交", () => {
    const submitted: string[] = [];
    const editor = new Editor({ autocomplete: provider, onSubmit: (t) => submitted.push(t) });
    typeInto(editor, "/help");
    expect(editor.isCompletionOpen).toBe(true);
    editor.handleInput("\r");
    expect(submitted).toEqual(["/help"]);
  });

  it("Tab 主动请求：唯一候选直接补全", () => {
    const editor = new Editor({ autocomplete: provider });
    editor.insertText("/mo");
    editor.handleInput("\t");
    expect(editor.getText()).toBe("/model");
  });

  it("异步提供者：结果回来后请求重绘，过期结果丢弃", async () => {
    let renders = 0;
    const editor = new Editor({
      autocomplete: {
        getSuggestions: async ({ textBeforeCursor }) => ({
          items: [{ value: `@${textBeforeCursor.slice(1)}.ts`, label: "file" }],
          from: 0,
        }),
      },
      requestRender: () => renders++,
    });
    editor.handleInput("@");
    editor.handleInput("a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(renders).toBe(1);
    editor.handleInput("\t");
    expect(editor.getText()).toBe("@a.ts");
  });
});

describe("Editor 渲染", () => {
  it("获焦时输出光标标记，宽度不超限，中文按列宽折行", () => {
    const editor = new Editor();
    editor.focused = true;
    editor.insertText("中文".repeat(12));
    const lines = editor.render(20);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
    expect(lines.join("").split(CURSOR_MARKER)).toHaveLength(2);
    expect(plain(lines).slice(1, 4)).toEqual([
      "中文中文中文中文中",
      "文中文中文中文中文",
      "中文中文中文 ",
    ]);
  });

  it("超过 maxVisibleLines 时视窗跟随光标并提示隐藏行数", () => {
    const editor = new Editor({ maxVisibleLines: 3 });
    editor.insertText("1\n2\n3\n4\n5");
    const lines = plain(editor.render(30));
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("↑ 2");
    expect(lines.slice(1, 4)).toEqual(["3", "4", "5"]);
  });

  it("占位文本只在未获焦且为空时显示", () => {
    const editor = new Editor({ placeholder: "Ask anything" });
    expect(plain(editor.render(30))[1]).toBe("Ask anything");
    editor.focused = true;
    expect(plain(editor.render(30))[1]).toBe(" ");
  });
});
