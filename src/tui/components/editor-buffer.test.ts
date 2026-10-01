import { describe, expect, it } from "vitest";
import { EditorBuffer } from "./editor-buffer.js";
import { PasteStore } from "./editor-paste.js";

describe("EditorBuffer 编辑", () => {
  it("插入、换行、退格合并行", () => {
    const b = new EditorBuffer();
    b.insert("ab");
    b.newLine();
    b.insert("cd");
    expect(b.getText()).toBe("ab\ncd");
    expect(b.cursor).toEqual({ line: 1, col: 2 });
    b.moveLineStart();
    b.backspace();
    expect(b.getText()).toBe("abcd");
    expect(b.cursor).toEqual({ line: 0, col: 2 });
  });

  it("多行插入", () => {
    const b = new EditorBuffer();
    b.insert("xy");
    b.moveLeft();
    b.insert("1\n2\n3");
    expect(b.getLines()).toEqual(["x1", "2", "3y"]);
    expect(b.cursor).toEqual({ line: 2, col: 1 });
  });

  it("按字素簇移动与删除（emoji、组合字符）", () => {
    const b = new EditorBuffer();
    b.insert("a👨‍👩‍👧é");
    b.backspace();
    expect(b.getText()).toBe("a👨‍👩‍👧");
    b.moveLeft();
    expect(b.cursor.col).toBe(1);
    b.deleteForward();
    expect(b.getText()).toBe("a");
  });

  it("Ctrl+U / Ctrl+K / 删除到行首行尾", () => {
    const b = new EditorBuffer();
    b.insert("hello world");
    b.setCursor({ line: 0, col: 5 });
    b.deleteToLineEnd();
    expect(b.getText()).toBe("hello");
    b.deleteToLineStart();
    expect(b.getText()).toBe("");
  });
});

describe("EditorBuffer 单词导航", () => {
  it("按词左右移动", () => {
    const b = new EditorBuffer();
    b.insert("foo bar.baz  qux");
    b.moveWordLeft();
    expect(b.cursor.col).toBe(13);
    b.moveWordLeft();
    expect(b.cursor.col).toBe(8);
    b.moveWordLeft();
    expect(b.cursor.col).toBe(7);
    b.moveWordLeft();
    expect(b.cursor.col).toBe(4);
    b.moveLineStart();
    b.moveWordRight();
    expect(b.cursor.col).toBe(3);
    b.moveWordRight();
    expect(b.cursor.col).toBe(7);
  });

  it("删词", () => {
    const b = new EditorBuffer();
    b.insert("git commit -m");
    b.deleteWordBackward();
    expect(b.getText()).toBe("git commit -");
    b.deleteWordBackward();
    expect(b.getText()).toBe("git commit ");
    b.deleteWordBackward();
    expect(b.getText()).toBe("git ");
    b.moveLineStart();
    b.deleteWordForward();
    expect(b.getText()).toBe(" ");
  });
});

describe("EditorBuffer 撤销", () => {
  it("连续输入合并为一步", () => {
    const b = new EditorBuffer();
    for (const ch of "hello") b.insert(ch);
    b.insert(" ");
    for (const ch of "world") b.insert(ch);
    b.undo();
    expect(b.getText()).toBe("hello ");
    b.undo();
    expect(b.getText()).toBe("hello");
    b.undo();
    expect(b.getText()).toBe("");
    expect(b.undo()).toBe(false);
  });

  it("上限 50 步", () => {
    const b = new EditorBuffer();
    for (let i = 0; i < 60; i++) b.insert(`chunk-${i}\n`);
    expect(b.undoDepth).toBe(50);
    let steps = 0;
    while (b.undo()) steps++;
    expect(steps).toBe(50);
    expect(b.getText().startsWith("chunk-0\n")).toBe(true);
  });
});

describe("EditorBuffer 不可分割段", () => {
  function withMarker() {
    const store = new PasteStore();
    const marker = store.accept(Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n"));
    const b = new EditorBuffer({ atomic: (line) => store.ranges(line) });
    b.insert(`a ${marker} b`);
    return { b, marker };
  }

  it("退格整段删除", () => {
    const { b } = withMarker();
    b.moveLeft();
    b.moveLeft();
    b.backspace();
    expect(b.getText()).toBe("a  b");
  });

  it("光标跳过整段", () => {
    const { b, marker } = withMarker();
    b.moveLineStart();
    b.moveRight();
    b.moveRight();
    expect(b.cursor.col).toBe(2);
    b.moveRight();
    expect(b.cursor.col).toBe(2 + marker.length);
    b.moveLeft();
    expect(b.cursor.col).toBe(2);
    b.setCursor({ line: 0, col: 5 });
    expect(b.cursor.col).toBe(2 + marker.length);
  });

  it("Delete 与删词整段删除", () => {
    const { b } = withMarker();
    b.setCursor({ line: 0, col: 2 });
    b.deleteForward();
    expect(b.getText()).toBe("a  b");
    const again = withMarker().b;
    again.moveLeft();
    again.moveLeft();
    again.deleteWordBackward();
    expect(again.getText()).toBe("a  b");
  });
});
