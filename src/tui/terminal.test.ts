import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  BRACKETED_PASTE_OFF,
  BRACKETED_PASTE_ON,
  MemoryTerminal,
  ProcessTerminal,
} from "./terminal.js";

class FakeStdin extends EventEmitter {
  isTTY = true;
  isRaw = false;
  rawCalls: boolean[] = [];
  paused = true;
  setRawMode(value: boolean): this {
    this.isRaw = value;
    this.rawCalls.push(value);
    return this;
  }
  setEncoding(): this {
    return this;
  }
  resume(): this {
    this.paused = false;
    return this;
  }
  pause(): this {
    this.paused = true;
    return this;
  }
}

class FakeStdout extends EventEmitter {
  columns = 90;
  rows = 30;
  written: string[] = [];
  write(data: string): boolean {
    this.written.push(data);
    return true;
  }
}

describe("ProcessTerminal", () => {
  it("raw 模式、括号粘贴开关、输入切分、resize、停止恢复", () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const terminal = new ProcessTerminal({
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      escTimeoutMs: 5,
    });
    const inputs: string[] = [];
    let resized = 0;
    terminal.start(
      (d) => inputs.push(d),
      () => resized++,
    );
    expect(stdin.isRaw).toBe(true);
    expect(stdin.paused).toBe(false);
    expect(stdout.written).toEqual([BRACKETED_PASTE_ON]);
    expect(terminal.columns).toBe(90);
    expect(terminal.rows).toBe(30);

    stdin.emit("data", "a\x1b[200~x\ny");
    stdin.emit("data", "\x1b[201~\r");
    expect(inputs).toEqual(["a", "\x1b[200~x\ny\x1b[201~", "\r"]);
    stdout.emit("resize");
    expect(resized).toBe(1);

    terminal.stop();
    expect(stdin.isRaw).toBe(false);
    expect(stdin.paused).toBe(true);
    expect(stdout.written.at(-1)).toContain(BRACKETED_PASTE_OFF);
    expect(stdout.written.join("")).not.toContain("\x1b[2J");
    stdin.emit("data", "late");
    expect(inputs).toHaveLength(3);
  });
});

describe("MemoryTerminal", () => {
  it("记录写入、还原屏幕、模拟输入与 resize", () => {
    const terminal = new MemoryTerminal({ columns: 10, rows: 3 });
    const inputs: string[] = [];
    let resized = 0;
    terminal.start(
      (d) => inputs.push(d),
      () => resized++,
    );
    terminal.write("hi\r\nthere");
    expect(terminal.viewport()).toEqual(["hi", "there", ""]);
    terminal.sendInput("\x1b[A\x1b");
    terminal.flushInput();
    expect(inputs).toEqual(["\x1b[A", "\x1b"]);
    terminal.resize(5, 2);
    expect(resized).toBe(1);
    expect(terminal.columns).toBe(5);
    expect(terminal.takeWrites()).toContain("there");
    expect(terminal.writes).toEqual([]);
    terminal.stop();
    expect(terminal.screen.modes.bracketedPaste).toBe(false);
  });
});
