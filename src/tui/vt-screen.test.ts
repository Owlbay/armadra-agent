import { describe, expect, it } from "vitest";
import { VirtualScreen } from "./vt-screen.js";

describe("VirtualScreen", () => {
  it("延迟换行：写满一行后 \\r\\n 不产生空行", () => {
    const s = new VirtualScreen(4, 3);
    s.write("abcd\r\nefgh");
    expect(s.viewport()).toEqual(["abcd", "efgh", ""]);
  });
  it("超宽自动折行、宽字符占两格", () => {
    const s = new VirtualScreen(5, 3);
    s.write("中文中x");
    expect(s.viewport()).toEqual(["中文", "中x", ""]);
  });
  it("滚出顶部的行进回滚", () => {
    const s = new VirtualScreen(10, 2);
    s.write("1\r\n2\r\n3\r\n4");
    expect(s.scrollback()).toEqual(["1", "2"]);
    expect(s.viewport()).toEqual(["3", "4"]);
    expect(s.transcript()).toEqual(["1", "2", "3", "4"]);
  });
  it("光标移动与擦除", () => {
    const s = new VirtualScreen(10, 3);
    s.write("aaaa\r\nbbbb\r\ncccc");
    s.write("\x1b[1A\r\x1b[2Kxx\x1b[5G!");
    expect(s.viewport()).toEqual(["aaaa", "xx  !", "cccc"]);
    s.write("\x1b[H\x1b[J");
    expect(s.viewport()).toEqual(["", "", ""]);
  });
  it("模式开关", () => {
    const s = new VirtualScreen(10, 3);
    s.write("\x1b[?2004h\x1b[?25l\x1b[?2026h");
    expect(s.modes).toEqual({ cursorVisible: false, bracketedPaste: true, synchronized: true });
  });
  it("样式与 OSC 不占格", () => {
    const s = new VirtualScreen(10, 1);
    s.write("\x1b[31mr\x1b[0m\x1b]8;;u\x07l\x1b]8;;\x07");
    expect(s.viewport()).toEqual(["rl"]);
  });
});
