import { afterEach, describe, expect, it, vi } from "vitest";
import { StdinBuffer, defaultEscTimeout } from "./stdin-buffer.js";

function collect(escTimeoutMs = 10) {
  const events: Array<{ type: "data" | "paste"; value: string }> = [];
  const buffer = new StdinBuffer({
    onData: (value) => events.push({ type: "data", value }),
    onPaste: (value) => events.push({ type: "paste", value }),
    escTimeoutMs,
  });
  return { buffer, events, data: () => events.map((e) => e.value) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("StdinBuffer 切分", () => {
  it("一个块里的多个键逐个发出", () => {
    const { buffer, data } = collect();
    buffer.process("ab\x1b[A\r\x03中");
    expect(data()).toEqual(["a", "b", "\x1b[A", "\r", "\x03", "中"]);
  });

  it("字素簇不被拆开", () => {
    const { buffer, data } = collect();
    buffer.process("👨‍👩‍👧é");
    expect(data()).toEqual(["👨‍👩‍👧", "é"]);
  });

  it("跨块的转义序列攒齐再发", () => {
    const { buffer, data } = collect();
    buffer.process("\x1b[");
    buffer.process("1;5");
    expect(data()).toEqual([]);
    buffer.process("Cx");
    expect(data()).toEqual(["\x1b[1;5C", "x"]);
  });

  it("Alt 前缀与 ESC ESC 序列", () => {
    const { buffer, data } = collect();
    buffer.process("\x1bb\x1b\x1b[A\x1b\r");
    expect(data()).toEqual(["\x1bb", "\x1b\x1b[A", "\x1b\r"]);
  });

  it("SS3 与 OSC", () => {
    const { buffer, data } = collect();
    buffer.process("\x1bOA\x1b]11;rgb:0/0/0\x07z");
    expect(data()).toEqual(["\x1bOA", "\x1b]11;rgb:0/0/0\x07", "z"]);
  });

  it("孤立 ESC 在超时后作为 Escape 发出", () => {
    vi.useFakeTimers();
    const { buffer, data } = collect(50);
    buffer.process("\x1b");
    vi.advanceTimersByTime(49);
    expect(data()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(data()).toEqual(["\x1b"]);
  });

  it("超时内到达的后续数据合成完整序列", () => {
    vi.useFakeTimers();
    const { buffer, data } = collect(50);
    buffer.process("\x1b");
    vi.advanceTimersByTime(20);
    buffer.process("[B");
    vi.advanceTimersByTime(100);
    expect(data()).toEqual(["\x1b[B"]);
  });
});

describe("StdinBuffer 括号粘贴", () => {
  it("一次块内的粘贴", () => {
    const { buffer, events } = collect();
    buffer.process("\x1b[200~hello\r\nworld\x1b[201~");
    expect(events).toEqual([{ type: "paste", value: "hello\r\nworld" }]);
  });

  it("跨多个 data 块累积为一次 paste 事件", () => {
    const { buffer, events } = collect();
    buffer.process("x\x1b[20");
    buffer.process("0~line1\nline2\n");
    buffer.process("line3 \x1b[A not a key\x1b");
    buffer.process("[20");
    expect(events).toEqual([{ type: "data", value: "x" }]);
    buffer.process("1~\r");
    expect(events).toEqual([
      { type: "data", value: "x" },
      { type: "paste", value: "line1\nline2\nline3 \x1b[A not a key" },
      { type: "data", value: "\r" },
    ]);
  });

  it("粘贴内的 \\r 是数据，粘贴后的 \\r 是 Enter", () => {
    const { buffer, events } = collect();
    buffer.process("\x1b[200~a\rb\x1b[201~\r");
    expect(events).toEqual([
      { type: "paste", value: "a\rb" },
      { type: "data", value: "\r" },
    ]);
  });

  it("粘贴期间不触发 ESC 超时", () => {
    vi.useFakeTimers();
    const { buffer, events } = collect(10);
    buffer.process("\x1b[200~abc\x1b");
    vi.advanceTimersByTime(1000);
    expect(events).toEqual([]);
    expect(buffer.inPaste).toBe(true);
    buffer.process("[201~");
    expect(events).toEqual([{ type: "paste", value: "abc" }]);
  });

  it("flush 时未结束的粘贴按已收正文发出", () => {
    const { buffer, events } = collect();
    buffer.process("\x1b[200~partial");
    buffer.flush();
    expect(events).toEqual([{ type: "paste", value: "partial" }]);
  });
});

describe("defaultEscTimeout", () => {
  it("环境变量优先，其次 SSH / tmux 100 ms，本地 10 ms", () => {
    expect(defaultEscTimeout({ AMA_TUI_ESC_TIMEOUT: "42" })).toBe(42);
    expect(defaultEscTimeout({ TMUX: "/tmp/tmux" })).toBe(100);
    expect(defaultEscTimeout({ SSH_TTY: "/dev/ttys001" })).toBe(100);
    expect(defaultEscTimeout({})).toBe(10);
    expect(defaultEscTimeout({ AMA_TUI_ESC_TIMEOUT: "bad" })).toBe(10);
  });
});
