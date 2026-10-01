import { describe, expect, it } from "vitest";
import {
  isPasteData,
  isPrintableText,
  matchesKey,
  normalizeKeyId,
  parseKey,
  unwrapPaste,
} from "./keys.js";

describe("parseKey 解析表", () => {
  const table: Array<[string, string]> = [
    // 基本键
    ["\r", "enter"],
    ["\n", "ctrl+j"],
    ["\t", "tab"],
    ["\x7f", "backspace"],
    ["\x08", "backspace"],
    ["\x1b", "escape"],
    [" ", "space"],
    ["a", "a"],
    ["A", "shift+a"],
    ["/", "/"],
    ["中", "中"],
    ["😀", "😀"],
    // Ctrl 组合
    ["\x01", "ctrl+a"],
    ["\x03", "ctrl+c"],
    ["\x04", "ctrl+d"],
    ["\x0f", "ctrl+o"],
    ["\x15", "ctrl+u"],
    ["\x17", "ctrl+w"],
    ["\x1a", "ctrl+z"],
    ["\x00", "ctrl+space"],
    ["\x1f", "ctrl+-"],
    // CSI 光标键
    ["\x1b[A", "up"],
    ["\x1b[B", "down"],
    ["\x1b[C", "right"],
    ["\x1b[D", "left"],
    ["\x1b[H", "home"],
    ["\x1b[F", "end"],
    // SS3
    ["\x1bOA", "up"],
    ["\x1bOD", "left"],
    ["\x1bOH", "home"],
    ["\x1bOP", "f1"],
    // 修饰键参数
    ["\x1b[1;2A", "shift+up"],
    ["\x1b[1;3D", "alt+left"],
    ["\x1b[1;5C", "ctrl+right"],
    ["\x1b[1;6B", "ctrl+shift+down"],
    ["\x1b[1;9A", "alt+up"],
    // ~ 序列
    ["\x1b[2~", "insert"],
    ["\x1b[3~", "delete"],
    ["\x1b[3;5~", "ctrl+delete"],
    ["\x1b[5~", "pageup"],
    ["\x1b[6~", "pagedown"],
    ["\x1b[1~", "home"],
    ["\x1b[4~", "end"],
    ["\x1b[15~", "f5"],
    ["\x1b[24~", "f12"],
    ["\x1b[Z", "shift+tab"],
    // Shift+Enter 常见变体
    ["\x1b[13;2u", "shift+enter"],
    ["\x1b[27;2;13~", "shift+enter"],
    ["\x1b[13;5u", "ctrl+enter"],
    ["\x1b[27;5;13~", "ctrl+enter"],
    ["\x1b[97;5u", "ctrl+a"],
    ["\x1b[127;3u", "alt+backspace"],
    // Alt 前缀
    ["\x1b\r", "alt+enter"],
    ["\x1b\x7f", "alt+backspace"],
    ["\x1bb", "alt+b"],
    ["\x1bB", "alt+shift+b"],
    ["\x1bd", "alt+d"],
    ["\x1b\x1b[A", "alt+up"],
    ["\x1b\x1b", "alt+escape"],
  ];
  it.each(table)("%j → %s", (data, id) => {
    expect(parseKey(data)?.id).toBe(id);
  });

  it("可打印字符带 text", () => {
    expect(parseKey("A")?.text).toBe("A");
    expect(parseKey("\x01")?.text).toBeUndefined();
  });

  it("无法识别的序列与多字符文本返回 undefined", () => {
    expect(parseKey("")).toBeUndefined();
    expect(parseKey("abc")).toBeUndefined();
    expect(parseKey("\x1b[999~")).toBeUndefined();
    expect(parseKey("\x1b[200~")).toBeUndefined();
    expect(parseKey("\x1b[<0;1;1M")).toBeUndefined();
  });
});

describe("KeyId 规范化与匹配", () => {
  it("修饰键重排与别名", () => {
    expect(normalizeKeyId("Shift+Ctrl+Up")).toBe("ctrl+shift+up");
    expect(normalizeKeyId("return")).toBe("enter");
    expect(normalizeKeyId("esc")).toBe("escape");
    expect(normalizeKeyId("meta+b")).toBe("alt+b");
  });
  it("matchesKey", () => {
    expect(matchesKey("\x1b[13;2u", "shift+enter")).toBe(true);
    expect(matchesKey("\r", "shift+enter")).toBe(false);
    expect(matchesKey("\x03", "ctrl+c")).toBe(true);
    expect(matchesKey("A", "shift+a")).toBe(true);
  });
});

describe("粘贴与文本判定", () => {
  it("括号粘贴包裹", () => {
    const data = "\x1b[200~hello\nworld\x1b[201~";
    expect(isPasteData(data)).toBe(true);
    expect(unwrapPaste(data)).toBe("hello\nworld");
    expect(isPasteData("hello")).toBe(false);
  });
  it("可打印文本", () => {
    expect(isPrintableText("abc 中文")).toBe(true);
    expect(isPrintableText("\r")).toBe(false);
    expect(isPrintableText("\x1b[A")).toBe(false);
    expect(isPrintableText("")).toBe(false);
  });
});
