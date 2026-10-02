import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import { MemoryTerminal, plainTheme } from "../tui.js";
import { createRuntimeDeps, defaultStartupUi } from "./compose.js";

let h: ComposeHarness | undefined;
afterEach(() => h?.cleanup());

const tty = { stdinIsTTY: true, stdoutIsTTY: true, env: { TERM: "xterm-256color" } };

async function until<T>(get: () => T | undefined): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = get();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timeout");
}

/** 先建一个会话，返回它的 id。 */
async function seedSession(harness: ComposeHarness): Promise<string> {
  const runtime = await harness.boot(["--model", "fake/echo"]);
  await runtime.session.prompt("第一个会话");
  const id = runtime.sessionManager.id;
  await runtime.dispose();
  return id;
}

describe("启动期问答接线（A1）", () => {
  it("stdin 非 TTY 不装 ui；SDK 不传 io 也不装", () => {
    expect(defaultStartupUi({ ...tty, stdinIsTTY: false })).toBeUndefined();
    expect(createRuntimeDeps().ui).toBeUndefined();
    expect(createRuntimeDeps({ io: tty }).ui?.pickSession).toBeTypeOf("function");
  });

  it("TTY 下 --resume 无 id 走迷你 TUI（MemoryTerminal），选中后恢复该会话", async () => {
    h = composeHarness(undefined, tty);
    const id = await seedSession(h);
    let terminal: MemoryTerminal | undefined;
    const ui = defaultStartupUi(tty, {
      tui: {
        theme: plainTheme(),
        terminal: () => (terminal = new MemoryTerminal({ columns: 60, rows: 12 })),
      },
    });
    const booting = h.boot(["--model", "fake/echo", "--resume"], ui ? { ui } : {});
    const t = await until(() => terminal);
    await until(() => (t.viewport().join("\n").includes("第一个会话") ? true : undefined));
    t.sendInput("\r");
    const runtime = await booting;
    expect(runtime.sessionManager.id).toBe(id);
    await runtime.dispose();
  });

  it("stdout 非 TTY（管道）走文本问答：问题写 stderr，按编号选会话", async () => {
    h = composeHarness(undefined, { ...tty, stdoutIsTTY: false });
    const id = await seedSession(h);
    const stdin = new PassThrough();
    const written: string[] = [];
    const ui = defaultStartupUi(
      { ...tty, stdoutIsTTY: false },
      { text: { stdin, write: (text) => void written.push(text) } },
    );
    const booting = h.boot(["--model", "fake/echo", "--resume"], ui ? { ui } : {});
    await until(() => (written.join("").includes("编号或 id") ? true : undefined));
    expect(written.join("")).toContain(`1. ${id.slice(0, 8)}  第一个会话`);
    stdin.write("1\n");
    const runtime = await booting;
    expect(runtime.sessionManager.id).toBe(id);
    await runtime.dispose();
  });

  it("--no-tui 在终端里也走文本问答", async () => {
    const stdin = new PassThrough();
    const written: string[] = [];
    const ui = defaultStartupUi(tty, {
      noTui: true,
      text: { stdin, write: (text) => void written.push(text) },
    });
    const pending = ui?.askCwd?.("/gone");
    await until(() => (written.length > 0 ? true : undefined));
    stdin.write("\n");
    expect(await pending).toBeUndefined();
    expect(written.join("")).toContain("/gone");
  });
});
