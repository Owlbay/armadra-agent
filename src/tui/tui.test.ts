import { describe, expect, it } from "vitest";
import { CURSOR_MARKER, type Component } from "./component.js";
import { MemoryTerminal } from "./terminal.js";
import { SYNC_BEGIN, SYNC_END, TUI, WRITE_CHUNK_SIZE } from "./tui.js";
import { Text } from "./components/text.js";

class Lines implements Component {
  constructor(public lines: string[]) {}
  render(width: number): string[] {
    return this.lines.map((l) => l.slice(0, width));
  }
  invalidate(): void {}
}

class Cursorful implements Component {
  focused = false;
  received: string[] = [];
  constructor(public text: string) {}
  render(): string[] {
    return [this.focused ? `${this.text}${CURSOR_MARKER}` : this.text];
  }
  handleInput(data: string): void {
    this.received.push(data);
  }
  invalidate(): void {}
}

function setup(columns = 40, rows = 10, lines: string[] = []) {
  const terminal = new MemoryTerminal({ columns, rows });
  const tui = new TUI(terminal);
  const body = new Lines(lines);
  tui.addChild(body);
  tui.start();
  tui.renderNow();
  return { terminal, tui, body };
}

function numbered(n: number, prefix = "line"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i}`);
}

/** 去掉同步包裹与光标控制后，取本帧写出的可见文本片段。 */
function writtenText(frame: string): string[] {
  return frame.split(/\x1b\[[0-9;?]*[A-Za-z]|\r\n|\r/).filter((s) => s !== "");
}

describe("TUI 首帧与同步输出", () => {
  it("首帧全量，包在同步输出里", () => {
    const { terminal, tui } = setup(40, 10, ["hello", "world"]);
    const frame = terminal.output;
    expect(frame).toContain(SYNC_BEGIN);
    expect(frame.lastIndexOf(SYNC_END)).toBeGreaterThan(frame.indexOf(SYNC_BEGIN));
    expect(terminal.viewport().slice(0, 2)).toEqual(["hello", "world"]);
    expect(tui.stats.fullRedraws).toBe(1);
    expect(terminal.screen.modes.bracketedPaste).toBe(true);
    expect(terminal.screen.modes.synchronized).toBe(false);
  });

  it("内容不变时不重写任何行", () => {
    const { terminal, tui } = setup(40, 10, ["a", "b"]);
    terminal.takeWrites();
    tui.renderNow();
    const frame = terminal.takeWrites();
    expect(writtenText(frame)).toEqual([]);
  });
});

describe("TUI 差分", () => {
  it("只重写变化的那一行", () => {
    const { terminal, tui, body } = setup(40, 10, numbered(6));
    terminal.takeWrites();
    body.lines[3] = "CHANGED";
    tui.renderNow();
    const frame = terminal.takeWrites();
    expect(frame.startsWith(SYNC_BEGIN)).toBe(true);
    expect(frame.endsWith(SYNC_END)).toBe(true);
    expect(writtenText(frame)).toEqual(["CHANGED"]);
    expect(terminal.viewport().slice(0, 6)).toEqual([
      "line 0",
      "line 1",
      "line 2",
      "CHANGED",
      "line 4",
      "line 5",
    ]);
    expect(tui.stats.fullRedraws).toBe(1);
  });

  it("只重写首末变化行之间的区间", () => {
    const { terminal, tui, body } = setup(40, 10, numbered(8));
    terminal.takeWrites();
    body.lines[2] = "X2";
    body.lines[5] = "X5";
    tui.renderNow();
    const frame = terminal.takeWrites();
    expect(writtenText(frame)).toEqual(["X2", "line 3", "line 4", "X5"]);
    expect(terminal.viewport().slice(0, 8)).toEqual([
      "line 0",
      "line 1",
      "X2",
      "line 3",
      "line 4",
      "X5",
      "line 6",
      "line 7",
    ]);
  });

  it("追加行只写新行", () => {
    const { terminal, tui, body } = setup(40, 10, numbered(3));
    terminal.takeWrites();
    body.lines.push("new A", "new B");
    tui.renderNow();
    expect(writtenText(terminal.takeWrites())).toEqual(["new A", "new B"]);
    expect(terminal.viewport().slice(0, 6)).toEqual([
      "line 0",
      "line 1",
      "line 2",
      "new A",
      "new B",
      "",
    ]);
  });

  it("内容变短时清掉多余的旧行", () => {
    const { terminal, tui, body } = setup(40, 10, numbered(5));
    body.lines = ["line 0", "line 1"];
    tui.renderNow();
    expect(terminal.viewport().slice(0, 5)).toEqual(["line 0", "line 1", "", "", ""]);
    body.lines.push("again");
    tui.renderNow();
    expect(terminal.viewport().slice(0, 4)).toEqual(["line 0", "line 1", "again", ""]);
  });

  it("小终端（高 10）：内容超过一屏，历史进回滚，视口内差分", () => {
    const { terminal, tui, body } = setup(40, 10, numbered(30));
    expect(terminal.screen.scrollback()).toEqual(numbered(20));
    expect(terminal.viewport()).toEqual(numbered(30).slice(20));
    terminal.takeWrites();
    body.lines[25] = "edited 25";
    tui.renderNow();
    expect(writtenText(terminal.takeWrites())).toEqual(["edited 25"]);
    expect(terminal.viewport()[5]).toBe("edited 25");
    expect(tui.stats.fullRedraws).toBe(1);
  });

  it("小终端：继续追加时滚屏，回滚完整", () => {
    const { terminal, tui, body } = setup(40, 10, numbered(12));
    for (let i = 12; i < 25; i++) {
      body.lines.push(`line ${i}`);
      tui.renderNow();
    }
    expect(terminal.transcript()).toEqual(numbered(25));
    expect(tui.stats.fullRedraws).toBe(1);
  });

  it("首变化行已滚出视口 → 全量重画视口，回滚里的旧行不重绘", () => {
    const { terminal, tui, body } = setup(40, 10, numbered(30));
    body.lines[5] = "edited 5";
    body.lines[29] = "edited 29";
    terminal.takeWrites();
    tui.renderNow();
    const frame = terminal.takeWrites();
    expect(tui.stats.fullRedraws).toBe(2);
    expect(frame.startsWith(SYNC_BEGIN) && frame.endsWith(SYNC_END)).toBe(true);
    expect(frame).not.toContain("edited 5");
    expect(terminal.viewport()).toEqual([...numbered(29).slice(20), "edited 29"]);
    expect(terminal.screen.scrollback()).toEqual(numbered(20));
  });

  it("内容大幅缩短（缩到视口之上）后视口正确", () => {
    const { terminal, tui, body } = setup(40, 10, numbered(30));
    body.lines = numbered(4, "short");
    tui.renderNow();
    expect(terminal.viewport().slice(0, 5)).toEqual([...numbered(4, "short"), ""]);
    body.lines.push("tail");
    tui.renderNow();
    expect(terminal.viewport().slice(0, 5)).toEqual([...numbered(4, "short"), "tail"]);
  });
});

describe("TUI resize", () => {
  it("宽度变化全量重画（按新宽度重新渲染）", () => {
    const terminal = new MemoryTerminal({ columns: 40, rows: 10 });
    const tui = new TUI(terminal);
    tui.addChild(new Text("alpha beta gamma delta epsilon zeta eta theta"));
    tui.start();
    tui.renderNow();
    expect(terminal.viewport()[0]).toBe("alpha beta gamma delta epsilon zeta eta");
    terminal.resize(20, 10);
    tui.renderNow();
    expect(tui.stats.fullRedraws).toBe(2);
    expect(terminal.viewport().slice(0, 3)).toEqual([
      "alpha beta gamma",
      "delta epsilon zeta",
      "eta theta",
    ]);
  });

  it("高度变化全量重画，只画最后一屏", () => {
    const { terminal, tui } = setup(40, 10, numbered(15));
    terminal.resize(40, 6);
    tui.renderNow();
    expect(tui.stats.fullRedraws).toBe(2);
    expect(terminal.viewport()).toEqual(numbered(15).slice(9));
    terminal.resize(40, 12);
    tui.renderNow();
    expect(tui.stats.fullRedraws).toBe(3);
    expect(terminal.viewport().slice(0, 12)).toEqual(numbered(15).slice(3));
  });

  it("resize 回调触发立即渲染", async () => {
    const { terminal, tui } = setup(40, 10, ["x"]);
    terminal.resize(30, 10);
    await new Promise((resolve) => process.nextTick(resolve));
    expect(tui.stats.fullRedraws).toBe(2);
  });
});

describe("TUI 分块写入", () => {
  it("超过 64 KiB 的帧分块写，首块以 ?2026h 开头、末块以 ?2026l 结尾", () => {
    const terminal = new MemoryTerminal({ columns: 200, rows: 50 });
    const tui = new TUI(terminal);
    tui.addChild(new Lines(Array.from({ length: 1000 }, (_, i) => `${i}`.padEnd(150, "x"))));
    tui.start();
    terminal.takeWrites();
    tui.renderNow();
    const writes = terminal.writes;
    expect(writes.length).toBeGreaterThan(2);
    for (const w of writes) expect(w.length).toBeLessThanOrEqual(WRITE_CHUNK_SIZE);
    expect(writes[0]!.startsWith(SYNC_BEGIN)).toBe(true);
    expect(writes[writes.length - 1]!.endsWith(SYNC_END)).toBe(true);
    expect(terminal.viewport().at(-1)).toBe("999".padEnd(150, "x"));
  });
});

describe("TUI 光标、焦点与输入", () => {
  it("把硬件光标摆到 CURSOR_MARKER 处，并剔除标记", () => {
    const terminal = new MemoryTerminal({ columns: 40, rows: 10 });
    const tui = new TUI(terminal);
    const input = new Cursorful("prompt> 中文");
    tui.addChild(new Lines(["header"]));
    tui.addChild(input);
    tui.addChild(new Lines(["footer"]));
    tui.start();
    tui.setFocus(input);
    tui.renderNow();
    expect(terminal.output).not.toContain(CURSOR_MARKER);
    expect(terminal.screen.cursor).toEqual({ row: 1, col: 12 });
    expect(terminal.screen.modes.cursorVisible).toBe(false);
  });

  it("showHardwareCursor 时显示光标", () => {
    const terminal = new MemoryTerminal({ columns: 40, rows: 10 });
    const tui = new TUI(terminal, { showHardwareCursor: true });
    const input = new Cursorful("ab");
    tui.addChild(input);
    tui.start();
    tui.setFocus(input);
    tui.renderNow();
    expect(terminal.screen.modes.cursorVisible).toBe(true);
    expect(terminal.screen.cursor).toEqual({ row: 0, col: 2 });
  });

  it("输入：监听器先处理，返回 true 时不再交给获焦组件", () => {
    const terminal = new MemoryTerminal({ columns: 40, rows: 10 });
    const tui = new TUI(terminal);
    const input = new Cursorful("");
    tui.addChild(input);
    tui.start();
    tui.setFocus(input);
    const seen: string[] = [];
    const off = tui.addInputListener((data) => {
      seen.push(data);
      return data === "\x03";
    });
    terminal.sendInput("a\x03b");
    expect(seen).toEqual(["a", "\x03", "b"]);
    expect(input.received).toEqual(["a", "b"]);
    off();
    terminal.sendInput("c");
    expect(seen).toHaveLength(3);
  });

  it("stop：光标移到内容末尾下一行，关括号粘贴，不清屏", () => {
    const { terminal, tui } = setup(40, 10, ["one", "two"]);
    tui.stop();
    expect(terminal.viewport().slice(0, 3)).toEqual(["one", "two", ""]);
    expect(terminal.screen.cursor).toEqual({ row: 2, col: 0 });
    expect(terminal.screen.modes.bracketedPaste).toBe(false);
    expect(terminal.screen.modes.cursorVisible).toBe(true);
    expect(terminal.output).not.toContain("\x1b[2J");
    expect(terminal.started).toBe(false);
  });

  it("首帧把当前行滚到屏幕顶，原有内容进入回滚而不是被清掉", () => {
    const terminal = new MemoryTerminal({ columns: 20, rows: 5 });
    terminal.write("$ old 1\r\n$ old 2\r\n$ ama\r\n");
    const tui = new TUI(terminal);
    tui.addChild(new Lines(["ui"]));
    tui.start();
    tui.renderNow();
    expect(terminal.viewport()[0]).toBe("ui");
    expect(terminal.screen.scrollback()).toEqual(["$ old 1", "$ old 2", "$ ama"]);
  });
});

describe("TUI 渲染调度", () => {
  it("同一 tick 内多次 requestRender 合并为一帧", async () => {
    const { tui } = setup(40, 10, ["x"]);
    const before = tui.stats.renders;
    tui.requestRender(true);
    tui.requestRender(true);
    tui.requestRender();
    await new Promise((resolve) => process.nextTick(resolve));
    expect(tui.stats.renders).toBe(before + 1);
  });

  it("16 ms 节流；键盘输入绕过节流", async () => {
    let now = 1000;
    const terminal = new MemoryTerminal({ columns: 40, rows: 10 });
    const tui = new TUI(terminal, { now: () => now });
    tui.addChild(new Lines(["x"]));
    tui.start();
    tui.renderNow();
    const base = tui.stats.renders;
    now += 5;
    tui.requestRender();
    await new Promise((resolve) => process.nextTick(resolve));
    expect(tui.stats.renders).toBe(base);
    terminal.sendInput("k");
    await new Promise((resolve) => process.nextTick(resolve));
    expect(tui.stats.renders).toBe(base + 1);
    tui.stop();
  });

  it("节流后由定时器补渲染", async () => {
    let now = 1000;
    const terminal = new MemoryTerminal({ columns: 40, rows: 10 });
    const tui = new TUI(terminal, { now: () => now, minRenderIntervalMs: 5 });
    tui.addChild(new Lines(["x"]));
    tui.start();
    tui.renderNow();
    const base = tui.stats.renders;
    now += 1;
    tui.requestRender();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tui.stats.renders).toBe(base + 1);
    tui.stop();
  });
});
