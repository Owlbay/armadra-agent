import { describe, expect, it } from "vitest";
import { stripAnsi } from "../ansi.js";
import type { Component } from "../component.js";
import { createTheme } from "../theme.js";
import { Box } from "./box.js";
import { Container } from "./container.js";
import { Loader, formatElapsed } from "./loader.js";
import { compositeOverlays } from "./overlay.js";
import { Spacer } from "./spacer.js";
import { Text, TruncatedText } from "./text.js";

const fixed = (lines: string[]): Component => ({ render: () => lines, invalidate() {} });

describe("Container / Spacer / Text", () => {
  it("纵向拼接、增删子组件", () => {
    const c = new Container();
    const a = new Text("a");
    const b = new Text("b");
    c.addChild(a);
    c.addChild(new Spacer(2));
    c.addChild(b);
    expect(c.render(10)).toEqual(["a", "", "", "b"]);
    c.insertBefore(new Text("x"), b);
    c.removeChild(a);
    expect(c.render(10)).toEqual(["", "", "x", "b"]);
    c.clear();
    expect(c.render(10)).toEqual([]);
  });

  it("Text 换行 + 内边距 + 缓存", () => {
    const t = new Text("hello world foo", { paddingX: 1, paddingY: 1 });
    const first = t.render(10);
    expect(first).toEqual(["", " hello", " world", " foo", ""]);
    expect(t.render(10)).toBe(first);
    t.setText("x");
    expect(t.render(10)).toEqual(["", " x", ""]);
  });

  it("TruncatedText 只取首行并截断", () => {
    expect(new TruncatedText("abcdefgh\nsecond").render(5)).toEqual(["abcd…"]);
  });
});

describe("Box", () => {
  it("圆角边框、标题、内边距", () => {
    const box = new Box(new Text("hi there"), { title: "Approve", paddingX: 1 });
    expect(box.render(16)).toEqual(["╭─ Approve ────╮", "│ hi there     │", "╰──────────────╯"]);
  });
  it("焦点与输入透传给子组件", () => {
    const seen: string[] = [];
    const child = {
      focused: false,
      render: () => ["c"],
      invalidate() {},
      handleInput: (d: string) => seen.push(d),
    };
    const box = new Box(child);
    box.focused = true;
    box.handleInput("y");
    expect(child.focused).toBe(true);
    expect(box.focused).toBe(true);
    expect(seen).toEqual(["y"]);
  });
  it("无边框只加内边距", () => {
    expect(new Box(new Text("x"), { border: false, paddingX: 2 }).render(6)).toEqual(["  x   "]);
  });
  it("带主题时边框着色，可见文本不变", () => {
    const theme = createTheme("dark", { caps: { colors: 16 } });
    const lines = new Box(new Text("x"), { theme }).render(5);
    expect(lines.map(stripAnsi)).toEqual(["╭───╮", "│ x │", "╰───╯"]);
    expect(lines[0]).toContain("\x1b[");
  });
});

describe("Loader", () => {
  it("帧推进、消息、已用时", () => {
    let now = 0;
    let renders = 0;
    const loader = new Loader(() => renders++, { message: "Working", now: () => now });
    expect(loader.render(40)).toEqual(["⠋ Working (0s)"]);
    loader.tick();
    now = 65_000;
    expect(loader.render(40)).toEqual(["⠙ Working (1m05s)"]);
    expect(renders).toBe(1);
    loader.start();
    expect(loader.running).toBe(true);
    loader.stop();
    expect(loader.running).toBe(false);
  });
  it("formatElapsed", () => {
    expect(formatElapsed(999)).toBe("0s");
    expect(formatElapsed(59_000)).toBe("59s");
    expect(formatElapsed(600_000)).toBe("10m00s");
  });
});

describe("覆盖层合成", () => {
  const base = ["0123456789", "abcdefghij", "ABCDEFGHIJ", "klmnopqrst"];

  it("center：视口内居中，左右保留底层内容", () => {
    const out = compositeOverlays(
      base,
      [{ component: fixed(["**", "##"]), options: { width: 2 } }],
      10,
      4,
    );
    expect(out).toEqual(["0123456789", "abcd**ghij", "ABCD##GHIJ", "klmnopqrst"]);
  });

  it("bottom：贴底整宽", () => {
    const out = compositeOverlays(
      base,
      [{ component: fixed(["dialog"]), options: { anchor: "bottom" } }],
      10,
      4,
    );
    expect(out.at(-1)).toBe("dialog    ");
    expect(out).toHaveLength(4);
  });

  it("内容比视口长：只在最后一屏内定位", () => {
    const long = Array.from({ length: 20 }, (_, i) => `row${i}`.padEnd(10, "."));
    const out = compositeOverlays(
      long,
      [{ component: fixed(["XX"]), options: { width: 2 } }],
      10,
      4,
    );
    expect(out.findIndex((l) => l.includes("XX"))).toBe(17);
  });

  it("内容比覆盖层短：补空行", () => {
    const out = compositeOverlays(
      ["x"],
      [{ component: fixed(["a", "b", "c"]), options: { anchor: "bottom" } }],
      4,
      10,
    );
    expect(out).toEqual(["a   ", "b   ", "c   "]);
  });

  it("宽字符被覆盖层切开时补空格，宽度保持", () => {
    const out = compositeOverlays(
      ["中文中文中"],
      [{ component: fixed(["|"]), options: { width: 1 } }],
      10,
      1,
    );
    expect(out).toEqual(["中文| 文中"]);
  });
});
