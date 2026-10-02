import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../../../test/helpers/compose-harness.js";
import type { FakeResponse } from "../../../ai/fake/fake-script.js";
import { emptyArgs } from "../../../cli/args.js";
import { LineEditor } from "./line-editor.js";
import { runLineMode } from "./line-mode.js";

let h: ComposeHarness;
afterEach(() => h?.cleanup());

async function until(check: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 5000) throw new Error(`timeout: ${label}\n${h.stdout()}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const bash = (command: string): FakeResponse => ({
  steps: [{ toolCall: { name: "bash", arguments: { command } } }],
});

describe("行式界面：管道", () => {
  it("逐行执行提示与斜杠命令，stdin 结束后退出 0；没有审批 UI → ask 被拒", async () => {
    h = composeHarness([{ text: "first answer" }, bash("echo x"), { text: "after tool" }]);
    const runtime = await h.boot(["--model", "fake/echo"]);
    expect(runtime.mode).toBe("line");
    const stdin = new PassThrough();
    const done = runLineMode(
      runtime,
      { args: emptyArgs(), prompt: undefined, io: h.io },
      { stdin },
    );
    stdin.end("hello\n/session\n/permission\nrun it\n/nope-command\n");
    expect(await done).toBe(0);
    const out = h.stdout();
    expect(out).toContain("first answer\n");
    expect(out).toMatch(/^会话 {4}/m);
    expect(out).toContain("Mode（/permission <模式>）");
    expect(out).toContain("● bash  echo x");
    expect(out).toContain("after tool");
    expect(h.fake.calls).toHaveLength(4);
    const toolResult = h.fake.calls[2]?.context.messages.find((m) => m.role === "toolResult");
    expect(toolResult).toMatchObject({ isError: true });
    await runtime.dispose();
  });
});

describe("行式界面：管道里的错误", () => {
  it("重试中只显示 ↻；最终错误只打印一次；退出码 1", async () => {
    h = composeHarness([
      { error: { kind: "overloaded" } },
      { error: { kind: "overloaded" } },
      { error: { kind: "overloaded" } },
    ]);
    h.home.write("home/.config/ama/config.json", {
      version: 1,
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
    });
    const runtime = await h.boot(["--model", "fake/echo"]);
    const stdin = new PassThrough();
    const done = runLineMode(
      runtime,
      { args: emptyArgs(), prompt: undefined, io: h.io },
      { stdin },
    );
    stdin.end("hi\n");
    expect(await done).toBe(1);
    const err = h.stderr();
    expect(err.match(/↻ 重试/g)).toHaveLength(2);
    expect(err.match(/ama: 错误：/g)).toHaveLength(1);
    expect(err.split("\n").filter((l) => l.startsWith("ama:"))).toHaveLength(1);
    await runtime.dispose();
  });

  it("成功的运行之后退出码仍是 0", async () => {
    h = composeHarness([{ error: { kind: "overloaded" } }, { text: "ok" }]);
    h.home.write("home/.config/ama/config.json", {
      version: 1,
      retry: { baseDelayMs: 1, maxDelayMs: 2 },
    });
    const runtime = await h.boot(["--model", "fake/echo"]);
    const stdin = new PassThrough();
    const done = runLineMode(
      runtime,
      { args: emptyArgs(), prompt: undefined, io: h.io },
      { stdin },
    );
    stdin.end("hi\n");
    expect(await done).toBe(0);
    expect(h.stderr()).not.toContain("错误");
    await runtime.dispose();
  });
});

describe("行式界面：raw 终端", () => {
  it("回车提交、跨 chunk 括号粘贴、审批 y / n、Ctrl+D 退出", async () => {
    h = composeHarness([
      { text: "pong" },
      { text: "pasted ok" },
      bash("echo yes"),
      { text: "ran" },
      bash("echo no"),
      { text: "denied" },
    ]);
    const runtime = await h.boot(["--model", "fake/echo"]);
    const stdin = Object.assign(new PassThrough(), { setRawMode: () => undefined, isTTY: true });
    const done = runLineMode(
      runtime,
      { args: emptyArgs(), prompt: undefined, io: h.io },
      { stdin, raw: true },
    );
    stdin.write("ping\r");
    await until(() => h.stdout().includes("pong"), "pong");
    stdin.write("\x1b[200~line1\nli");
    stdin.write("ne2\x1b[201~");
    await until(() => h.stdout().includes("[粘贴 #1 +2 行]"), "paste marker");
    stdin.write("\r");
    await until(() => h.stdout().includes("pasted ok"), "pasted ok");
    expect(h.fake.calls[1]?.context.messages.at(-1)).toMatchObject({ content: "line1\nline2" });
    stdin.write("go\r");
    await until(() => h.stdout().includes("允许 bash echo yes"), "approval 1");
    stdin.write("y");
    await until(() => h.stdout().includes("ran"), "ran");
    stdin.write("again\r");
    await until(() => h.stdout().includes("允许 bash echo no"), "approval 2");
    stdin.write("n");
    await until(() => h.stdout().includes("denied"), "denied");
    const results = runtime.session.messages.filter((m) => m.role === "toolResult");
    expect(results.map((m) => (m as { isError?: boolean }).isError === true)).toEqual([
      false,
      true,
    ]);
    stdin.write("\x04");
    expect(await done).toBe(0);
    await runtime.dispose();
  });
});

describe("行式界面：执行前预览", () => {
  it("审批问句之前逐行打印预览", async () => {
    h = composeHarness([bash("rm -rf build"), { text: "kept" }]);
    mkdirSync(join(h.home.cwd, "build"));
    writeFileSync(join(h.home.cwd, "build", "a.o"), "abc");
    const runtime = await h.boot(["--model", "fake/echo"]);
    const stdin = Object.assign(new PassThrough(), { setRawMode: () => undefined, isTTY: true });
    const done = runLineMode(
      runtime,
      { args: emptyArgs(), prompt: undefined, io: h.io },
      { stdin, raw: true },
    );
    stdin.write("clean\r");
    await until(() => h.stdout().includes("允许 bash rm -rf build"), "approval");
    expect(h.stdout()).toContain("\n  删除 build/：目录，1 个文件，3 B\n允许 bash rm -rf build");
    stdin.write("n");
    await until(() => h.stdout().includes("kept"), "kept");
    stdin.write("\x04");
    expect(await done).toBe(0);
    await runtime.dispose();
  });
});

describe("LineEditor", () => {
  it("光标移动、删除词、历史、Ctrl+C / Ctrl+D", () => {
    const writes: string[] = [];
    const editor = new LineEditor({ prompt: "> ", write: (t) => void writes.push(t) });
    expect(editor.feed("hello world\x17\x1b[Dx\r")).toEqual([{ kind: "submit", text: "hellox " }]);
    editor.feed("second");
    expect(editor.feed("\x15\x1b[A\r")).toEqual([{ kind: "submit", text: "hellox " }]);
    expect(editor.feed("\x03")).toEqual([{ kind: "interrupt" }]);
    expect(editor.feed("\x04")).toEqual([{ kind: "eof" }]);
    expect(editor.feed("中文\x7f\r")).toEqual([{ kind: "submit", text: "中" }]);
  });

  it("ask：单键作答，Enter 取缺省", async () => {
    const editor = new LineEditor({ prompt: "> ", write: () => undefined });
    const first = editor.ask("? ", "n");
    editor.feed("Y");
    expect(await first).toBe("y");
    const second = editor.ask("? ", "n");
    editor.feed("\r");
    expect(await second).toBe("n");
  });
});
