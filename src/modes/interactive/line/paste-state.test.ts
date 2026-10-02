import { describe, expect, it } from "vitest";
import { PASTE_END, PASTE_START, PasteState } from "./paste-state.js";

describe("括号粘贴状态机", () => {
  it("一次到达：前后普通输入 + 完整粘贴，\\r\\n 归一", () => {
    const state = new PasteState();
    expect(state.feed(`ab${PASTE_START}x\r\ny\rz${PASTE_END}\r`)).toEqual([
      { kind: "text", text: "ab" },
      { kind: "paste", text: "x\ny\nz" },
      { kind: "text", text: "\r" },
    ]);
  });

  it("标记与正文跨 chunk 拆开", () => {
    const state = new PasteState();
    const all = `${PASTE_START}line1\nline2${PASTE_END}\r`;
    const pieces = [];
    for (const ch of all) pieces.push(...state.feed(ch));
    expect(pieces).toEqual([
      { kind: "paste", text: "line1\nline2" },
      { kind: "text", text: "\r" },
    ]);
    const split = new PasteState();
    expect(split.feed("hi\x1b[20")).toEqual([{ kind: "text", text: "hi" }]);
    expect(split.pasting).toBe(false);
    expect(split.feed("0~abc\x1b[2")).toEqual([]);
    expect(split.pasting).toBe(true);
    expect(split.feed("01~")).toEqual([{ kind: "paste", text: "abc" }]);
  });

  it("flush 交出单独的 ESC；粘贴中途不交", () => {
    const state = new PasteState();
    expect(state.feed("\x1b")).toEqual([]);
    expect(state.flush()).toEqual([{ kind: "text", text: "\x1b" }]);
    state.feed(`${PASTE_START}part`);
    expect(state.flush()).toEqual([]);
  });
});
