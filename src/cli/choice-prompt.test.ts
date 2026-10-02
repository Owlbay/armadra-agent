import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { VirtualScreen } from "../tui.js";
import {
  canPromptChoice,
  confirmContinue,
  promptChoice,
  splitKeys,
  type ChoiceInput,
} from "./choice-prompt.js";

/** 伪 TTY：记录 raw 切换，`send` 模拟按键。 */
class FakeTty extends EventEmitter implements ChoiceInput {
  isTTY = true;
  isRaw = false;
  rawLog: boolean[] = [];
  paused = false;
  setRawMode(raw: boolean): this {
    this.isRaw = raw;
    this.rawLog.push(raw);
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
  send(data: string): void {
    this.emit("data", Buffer.from(data));
  }
}

const OPTIONS = [
  { label: "继续", keys: "y" },
  { label: "取消", keys: "n Esc" },
];

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function run(keys: string[], env: NodeJS.ProcessEnv = { NO_COLOR: "1", AMA_ASCII: "0" }) {
  const tty = new FakeTty();
  let out = "";
  const answer = promptChoice({
    question: "继续？",
    options: OPTIONS,
    selected: 1,
    input: tty,
    write: (t) => void (out += t),
    env,
    outputIsTTY: true,
  });
  for (const key of keys) tty.send(key);
  return { tty, answer, out: () => out };
}

describe("CLI 方向键选择", () => {
  it("切键：转义序列整体、其余逐字符", () => {
    expect(splitKeys("\x1b[Ay\r")).toEqual(["\x1b[A", "y", "\r"]);
    expect(splitKeys("\x1b")).toEqual(["\x1b"]);
    expect(splitKeys("\x1bOB2")).toEqual(["\x1bOB", "2"]);
  });

  it("Enter 取缺省（取消）；↑ / ↓ Enter 选继续；数字与 y / n 直选", async () => {
    expect(await run(["\r"]).answer).toBe(1);
    expect(await run(["\x1b[A", "\r"]).answer).toBe(0);
    expect(await run(["\x1b[B\r"]).answer).toBe(0);
    expect(await run(["1"]).answer).toBe(0);
    expect(await run(["2"]).answer).toBe(1);
    expect(await run(["Y"]).answer).toBe(0);
    expect(await run(["n"]).answer).toBe(1);
    expect(await run(["9", "x", "\r"]).answer).toBe(1);
  });

  it("Esc / Ctrl+C / stdin 结束 = 取消；退出时恢复 raw 与光标、暂停输入", async () => {
    for (const key of ["\x1b", "\x03"]) {
      const r = run([key]);
      expect(await r.answer).toBeUndefined();
      expect(r.tty.rawLog).toEqual([true, false]);
      expect(r.tty.paused).toBe(true);
      expect(r.out().endsWith("\x1b[?25h")).toBe(true);
      expect(r.tty.listenerCount("data")).toBe(0);
    }
    const r = run([]);
    r.tty.emit("end");
    expect(await r.answer).toBeUndefined();
  });

  it("画面：编号选项、选中行 ›、按键提示；结束后收成一行；NO_COLOR 无转义色", async () => {
    const r = run(["\x1b[A", "\r"]);
    await r.answer;
    const screen = new VirtualScreen(60, 8);
    screen.write(r.out().replace(/\n/g, "\r\n"));
    const lines = screen.viewport().map((l) => l.trimEnd());
    expect(lines.filter((l) => l !== "")).toEqual(["? 继续？ 继续"]);
    // NO_COLOR 只去颜色（前景 / 背景），粗体保留
    expect(r.out()).not.toMatch(/\x1b\[(?:3|4|9|10)[0-9;]*m/);
    const first = run([]);
    const frame = plain(first.out()).split("\n");
    expect(frame.slice(1, 4).map((l) => l.trimEnd())).toEqual([
      "  1. 继续  y",
      "› 2. 取消  n Esc",
      "↑↓ 选择 · Enter 确认 · 1-2 直接选 · Esc 取消",
    ]);
    first.tty.send("\x1b");
    await first.answer;
  });

  it("ASCII 字形：AMA_ASCII=1 时提示符 > 与 ^v", async () => {
    const r = run([], { NO_COLOR: "1", AMA_ASCII: "1" });
    const frame = plain(r.out()).split("\n");
    expect(frame[2]).toMatch(/^> 2\. 取消/);
    expect(frame[3]).toMatch(/^\^v 选择/);
    r.tty.send("n");
    expect(await r.answer).toBe(1);
  });

  it("confirmContinue：TTY 走方向键（缺省取消）；非 TTY 回落文本 y/N", async () => {
    const tty = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(raw: boolean) {
        tty.isRaw = raw;
        return tty;
      },
    });
    expect(canPromptChoice(tty)).toBe(true);
    const sink = (): void => undefined;
    const yes = confirmContinue({ input: tty, write: sink, env: {}, outputIsTTY: false });
    tty.write("y");
    expect(await yes).toBe(true);
    const no = confirmContinue({ input: tty, write: sink, env: {}, outputIsTTY: false });
    tty.write("\r");
    expect(await no).toBe(false);

    const pipe = new PassThrough();
    expect(canPromptChoice(pipe as ChoiceInput)).toBe(false);
    const piped = confirmContinue({ input: pipe, output: new PassThrough() });
    pipe.write("yes\n");
    expect(await piped).toBe(true);
    const pipe2 = new PassThrough();
    const declined = confirmContinue({ input: pipe2, output: new PassThrough() });
    pipe2.write("\n");
    expect(await declined).toBe(false);
  });
});
