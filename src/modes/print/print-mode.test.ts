import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../../test/helpers/compose-harness.js";
import { sharedCacheReporting } from "../../ai/cache/reporting.js";
import type { FakeResponse } from "../../ai/fake/fake-script.js";
import type { CliIo, StdinKind } from "../../cli/deps.js";
import { joinPrompt, readPromptStdin, stdinWaitMs } from "./print-mode.js";

function stdinIo(kind: StdinKind, read: () => Promise<string>, err: string[]): CliIo {
  return {
    stdout: () => undefined,
    stderr: (t) => void err.push(t),
    stdinIsTTY: kind === "tty",
    stdoutIsTTY: false,
    env: {},
    cwd: "/",
    readStdin: read,
    stdinKind: () => kind,
  };
}

let h: ComposeHarness;
afterEach(() => h?.cleanup());

function lines(): Record<string, unknown>[] {
  return h
    .stdout()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("print 模式：何时读 stdin", () => {
  const never = () => new Promise<string>(() => undefined);

  it("等首字节的上限：缺省 2000，AMA_STDIN_WAIT_MS 覆盖，非法值回落", () => {
    expect(stdinWaitMs({})).toBe(2000);
    expect(stdinWaitMs({ AMA_STDIN_WAIT_MS: "0" })).toBe(0);
    expect(stdinWaitMs({ AMA_STDIN_WAIT_MS: "500" })).toBe(500);
    expect(stdinWaitMs({ AMA_STDIN_WAIT_MS: "x" })).toBe(2000);
  });

  it("有提示参数且是管道：上限内收到就拼接；一个字节都没有 → 忽略并提示一行", async () => {
    for (const kind of ["fifo", "socket", "other"] as const) {
      const err: string[] = [];
      const io = { ...stdinIo(kind, never, err), env: { AMA_STDIN_WAIT_MS: "30" } };
      expect(await readPromptStdin(io, "hi", "auto")).toBe("");
      expect(err).toEqual(["ama: 未在 30 毫秒内收到管道输入，已忽略；需要等待请在末尾加 -\n"]);
    }
    const err: string[] = [];
    const quick = () => new Promise<string>((resolve) => setTimeout(() => resolve("diff"), 5));
    const io = { ...stdinIo("fifo", quick, err), env: { AMA_STDIN_WAIT_MS: "200" } };
    expect(await readPromptStdin(io, "hi", "auto")).toBe("diff");
    expect(err).toEqual([]);
  });

  it("首字节读取交给 io.readStdinFirstByte（收到首字节后不再超时由它保证）；0 = 不等待", async () => {
    const asked: number[] = [];
    const io: CliIo = {
      ...stdinIo("fifo", never, []),
      readStdinFirstByte: async (ms) => {
        asked.push(ms);
        return "piped";
      },
    };
    expect(await readPromptStdin(io, "hi", "auto")).toBe("piped");
    expect(asked).toEqual([2000]);
    expect(await readPromptStdin({ ...io, env: { AMA_STDIN_WAIT_MS: "0" } }, "hi", "auto")).toBe(
      "",
    );
    expect(asked).toEqual([2000]);
  });

  it("显式 -、普通文件 / 空设备：读到 EOF；TTY 不读", async () => {
    const err: string[] = [];
    const read = async () => "body";
    expect(await readPromptStdin(stdinIo("fifo", read, err), "hi", "explicit")).toBe("body");
    expect(await readPromptStdin(stdinIo("file", read, err), "hi", "auto")).toBe("body");
    expect(
      await readPromptStdin(
        stdinIo("null", async () => "", err),
        "hi",
        "auto",
      ),
    ).toBe("");
    expect(await readPromptStdin(stdinIo("tty", read, err), undefined, "explicit")).toBe("");
    expect(err).toEqual([]);
  });

  it("没有提示参数：读到 EOF；等太久 stderr 提示一次", async () => {
    const err: string[] = [];
    const slow = () => new Promise<string>((resolve) => setTimeout(() => resolve("late"), 80));
    expect(await readPromptStdin(stdinIo("fifo", slow, err), undefined, "auto", 20)).toBe("late");
    expect(err.join("")).toContain("正在等待 stdin");
    expect(err).toHaveLength(1);
  });

  it("--no-stdin：不读 stdin，也不等待", async () => {
    let reads = 0;
    h = composeHarness([{ text: "ok" }], {
      readStdin: () => {
        reads++;
        return never();
      },
      stdinKind: () => "fifo",
    });
    expect(await h.run(["-p", "hi", "--no-stdin", "--model", "fake/echo"])).toBe(0);
    expect(reads).toBe(0);
    expect(h.stderr()).toBe("");
    expect(
      await readPromptStdin(
        stdinIo("file", async () => "x", []),
        undefined,
        "off",
      ),
    ).toBe("");
  });

  it("组装后：有提示参数、管道保持打开且不写 → 上限到了照常运行并提示", async () => {
    h = composeHarness([{ text: "ok" }], {
      readStdin: never,
      stdinKind: () => "socket",
      env: { AMA_STDIN_WAIT_MS: "50" },
    });
    expect(await h.run(["-p", "hi", "--model", "fake/echo"])).toBe(0);
    expect(h.stdout()).toBe("ok\n");
    expect(h.stderr()).toContain("未在 50 毫秒内收到管道输入，已忽略");
  });
});

describe("print 模式", () => {
  it("text：只输出最后的助手文本，退出 0", async () => {
    h = composeHarness([{ text: "hello there" }]);
    expect(await h.run(["-p", "hi", "--model", "fake/echo"])).toBe(0);
    expect(h.stdout()).toBe("hello there\n");
  });

  it("text：去掉前导空行、保留首行缩进；json 的 text 原样", async () => {
    h = composeHarness([{ text: "\n\n  indented\nnext" }]);
    expect(await h.run(["-p", "hi", "--model", "fake/echo"])).toBe(0);
    expect(h.stdout()).toBe("  indented\nnext\n");
    h.cleanup();
    h = composeHarness([{ text: "\n \n" }]);
    expect(await h.run(["-p", "hi", "--model", "fake/echo"])).toBe(0);
    expect(h.stdout()).toBe("");
    h.cleanup();
    h = composeHarness([{ text: "\n\nraw" }]);
    expect(await h.run(["-p", "hi", "--model", "fake/echo", "--output-format", "json"])).toBe(0);
    expect(lines()[0]).toMatchObject({ text: "\n\nraw" });
  });

  it("stdin 管道与参数拼接（自动，与 0.3.0 一致；显式 - 同样）；两者都没有 → 2", async () => {
    h = composeHarness(undefined, {
      readStdin: async () => "piped text\n",
      stdinKind: () => "fifo",
    });
    expect(await h.run(["-p", "question", "--model", "fake/echo"])).toBe(0);
    expect(h.fake.calls[0]?.context.messages.at(-1)).toMatchObject({
      role: "user",
      content: "question\n\npiped text",
    });
    h.cleanup();
    h = composeHarness(undefined, { readStdin: async () => "piped text\n" });
    expect(await h.run(["-p", "question", "-", "--model", "fake/echo"])).toBe(0);
    expect(h.fake.calls[0]?.context.messages.at(-1)).toMatchObject({
      role: "user",
      content: "question\n\npiped text",
    });
    expect(joinPrompt(undefined, "")).toBe("");
    h.cleanup();
    h = composeHarness(undefined, { readStdin: async () => "" });
    expect(await h.run(["-p", "--model", "fake/echo"])).toBe(2);
    expect(h.stderr()).toContain("需要提示");
  });

  it("json：一个结果对象，含停止原因、用量与条目", async () => {
    h = composeHarness([{ text: "done", usage: { input: 10, output: 2, cacheRead: 30 } }]);
    expect(await h.run(["-p", "hi", "--model", "fake/echo", "--output-format", "json"])).toBe(0);
    const [result] = lines();
    expect(result).toMatchObject({ type: "result", stopReason: "stop", text: "done" });
    expect(result?.["cacheHitRate"]).toBe(0.75);
    expect((result?.["entries"] as unknown[]).length).toBeGreaterThan(2);
  });

  it("stream-json：逐事件一行，重试事件可见，message_update 无 partial", async () => {
    h = composeHarness([
      { error: { kind: "rate_limit" } },
      { error: { kind: "overloaded" } },
      { text: "Recovered after retries." },
    ]);
    h.home.write("home/.config/ama/config.json", {
      version: 1,
      retry: { baseDelayMs: 1, maxDelayMs: 2 },
    });
    expect(
      await h.run(["-p", "hi", "--model", "fake/echo", "--output-format", "stream-json"]),
    ).toBe(0);
    const types = lines().map((e) => e["type"]);
    expect(h.stderr()).not.toContain("↻");
    expect(types).toContain("auto_retry_start");
    expect(types).toContain("auto_retry_end");
    expect(types.at(-1)).toBe("agent_settled");
    expect(h.stdout()).not.toContain('"partial"');
  });

  it("text：重试期间 stderr 每次一行 ↻，stdout 只有最终回答", async () => {
    h = composeHarness([{ error: { kind: "overloaded" } }, { text: "ok" }]);
    h.home.write("home/.config/ama/config.json", {
      version: 1,
      retry: { baseDelayMs: 1, maxDelayMs: 2 },
    });
    expect(await h.run(["-p", "hi", "--model", "fake/echo"])).toBe(0);
    expect(h.stdout()).toBe("ok\n");
    expect(h.stderr()).toMatch(/^ama: ↻ 重试 1\/3（0s 后）：.+\n$/);
  });

  it("最终错误 → 退出 1，stderr 给原因；工具 ask 在 print 下被拒", async () => {
    h = composeHarness([{ error: { kind: "auth" } }]);
    expect(await h.run(["-p", "hi", "--model", "fake/echo"])).toBe(1);
    expect(h.stderr()).toMatch(/ama: .+/);
    h.cleanup();
    h = composeHarness([
      { steps: [{ toolCall: { name: "bash", arguments: { command: "echo x" } } }] },
      { text: "after" },
    ]);
    expect(await h.run(["-p", "run", "--model", "fake/echo"])).toBe(7);
    const result = h.fake.calls[1]?.context.messages.find((m) => m.role === "toolResult");
    expect(result).toMatchObject({ isError: true });
    expect(h.stdout()).toBe("after\n");
    expect(h.stderr()).toMatch(/ama: 1 次工具调用被拒：bash ×1（.*no one is available/);
    expect(h.stderr()).toContain("--permission-mode auto-edit|auto 或 --allow");
  });

  it("[S-A] minimal 预设下 bash grep 被拒：被拒汇总后补一行怎么加回 grep / glob；default 预设不补", async () => {
    const grepCall = {
      steps: [{ toolCall: { name: "bash", arguments: { command: "grep -rn process.env ." } } }],
    };
    h = composeHarness([grepCall, { text: "after" }]);
    expect(await h.run(["-p", "go", "--model", "fake/echo", "--tools-preset", "minimal"])).toBe(7);
    const err = h.stderr().split("\n");
    expect(err[0]).toMatch(/^ama: 1 次工具调用被拒：bash ×1/);
    expect(err[1]).toBe(
      'ama: minimal 预设没有 grep / glob，可用 tools.default: ["+grep","+glob"] 加上',
    );
    h.cleanup();
    h = composeHarness([grepCall, { text: "after" }]);
    expect(await h.run(["-p", "go", "--model", "fake/echo"])).toBe(7);
    expect(h.stderr()).not.toContain("tools.default");
    h.cleanup();
    h = composeHarness([
      { steps: [{ toolCall: { name: "bash", arguments: { command: "echo x" } } }] },
      { text: "after" },
    ]);
    expect(await h.run(["-p", "go", "--model", "fake/echo", "--tools-preset", "minimal"])).toBe(7);
    expect(h.stderr()).not.toContain("tools.default");
  });

  it("被拒可见：json 带 deniedTools，stream-json 的 tool_execution_end 带 denied；放行后退出 0", async () => {
    const writeCall = {
      steps: [{ toolCall: { name: "write", arguments: { path: "out.txt", content: "x" } } }],
    };
    h = composeHarness([writeCall, { text: "done" }]);
    expect(await h.run(["-p", "w", "--model", "fake/echo", "--output-format", "json"])).toBe(7);
    const [result] = lines();
    expect(result?.["deniedTools"]).toEqual([
      { toolCallId: expect.any(String), toolName: "write", reason: expect.any(String) },
    ]);
    h.cleanup();
    h = composeHarness([writeCall, { text: "done" }]);
    expect(await h.run(["-p", "w", "--model", "fake/echo", "--output-format", "stream-json"])).toBe(
      7,
    );
    expect(lines().find((e) => e["type"] === "tool_execution_end")).toMatchObject({
      toolName: "write",
      denied: true,
    });
    h.cleanup();
    h = composeHarness([writeCall, { text: "done" }]);
    expect(await h.run(["-p", "w", "--model", "fake/echo", "--permission-mode", "auto-edit"])).toBe(
      0,
    );
    expect(h.stderr()).not.toContain("被拒");
  });

  it("[W5-H2] --max-turns：到上限还在调工具 → 提前结束、退出 8、json 带 limitReached / maxTurnsReached；上限够用则正常", async () => {
    const readCall = { steps: [{ toolCall: { name: "read", arguments: { path: "notes.txt" } } }] };
    h = composeHarness([readCall, readCall, { text: "finished" }]);
    h.home.write("work/notes.txt", "x\n");
    expect(
      await h.run([
        "-p",
        "go",
        "--model",
        "fake/echo",
        "--max-turns",
        "1",
        "--output-format",
        "json",
      ]),
    ).toBe(8);
    expect(h.fake.calls).toHaveLength(1);
    expect(lines()[0]).toMatchObject({
      stopReason: "toolUse",
      maxTurnsReached: true,
      limitReached: { kind: "turns", value: 1, limit: 1 },
    });
    expect(h.stderr()).toContain("已达到回合上限 1");
    h.cleanup();
    h = composeHarness([readCall, readCall, { text: "finished" }]);
    h.home.write("work/notes.txt", "x\n");
    expect(await h.run(["-p", "go", "--model", "fake/echo", "--max-turns", "3"])).toBe(0);
    expect(h.stdout()).toBe("finished\n");
  });

  it("[W5-H2] plan 待审批（plan.unattended 缺省 stop）：stderr 给计划文件与审批办法、json 带 planPending、退出码 9", async () => {
    const plan = [
      "<proposed_plan>",
      "# Greet",
      "## Steps",
      "- [ ] S1 Add it",
      "</proposed_plan>",
    ].join("\n");
    h = composeHarness([{ text: plan }]);
    const code = await h.run([
      "-p",
      "--model",
      "fake/echo",
      "--permission-mode",
      "plan",
      "--output-format",
      "json",
      "plan it",
    ]);
    expect(code).toBe(9);
    const result = lines()[0] as { planPending?: { version: number; filePath?: string } };
    expect(result.planPending?.version).toBe(1);
    expect(result.planPending?.filePath).toMatch(/-v1\.md$/);
    expect(h.stderr()).toContain("计划 v1 已落盘、待审批（未执行）");
    expect(h.stderr()).toContain("plan.unattended: approve");
  });

  it("[W5-H2] --image 按 config images.resize：off 时超限直接用法错误并写明", async () => {
    h = composeHarness([{ text: "never" }]);
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(9000, 16);
    png.writeUInt32BE(10, 20);
    writeFileSync(join(h.home.cwd, "wide.png"), png);
    h.home.write(
      "home/.config/ama/config.json",
      JSON.stringify({ version: 1, images: { resize: "off" } }),
    );
    expect(await h.run(["-p", "look", "--model", "fake/echo", "--image", "wide.png"])).toBe(2);
    expect(h.stderr()).toContain("（images.resize 为 off）");
    expect(h.fake.calls).toHaveLength(0);
  });

  it("[W5-H2] --max-cost：累计费用到限且还要调工具 → 结束、退出 8；config limits.maxTurns 同样生效", async () => {
    const readCall = {
      steps: [{ toolCall: { name: "read", arguments: { path: "notes.txt" } } }],
      usage: { input: 600_000, output: 0 },
    };
    h = composeHarness([readCall, readCall, readCall, { text: "finished" }]);
    h.home.write("work/notes.txt", "x\n");
    expect(
      await h.run([
        "-p",
        "go",
        "--model",
        "fake/echo",
        "--max-cost",
        "1",
        "--output-format",
        "json",
      ]),
    ).toBe(8);
    const turns = () => h.fake.calls.filter((c) => (c.options.purpose ?? "turn") === "turn");
    expect(turns()).toHaveLength(2); // $0.6 → $1.2 ≥ $1
    expect(lines()[0]).toMatchObject({ limitReached: { kind: "cost", limit: 1 } });
    expect(h.stderr()).toContain("已达到费用上限 $1.00");
    expect(h.stderr()).not.toContain("尚未实现");
    h.cleanup();
    h = composeHarness([readCall, readCall, readCall, { text: "finished" }]);
    h.home.write("work/notes.txt", "x\n");
    h.home.write(
      "home/.config/ama/config.json",
      JSON.stringify({ version: 1, limits: { maxTurns: 2 } }),
    );
    expect(await h.run(["-p", "go", "--model", "fake/echo"])).toBe(8);
    expect(turns()).toHaveLength(2);
  });

  it("[W3-C2] json 结果带 cache 统计；stream-json 含 cache_miss / cache_warm / context_pressure", async () => {
    sharedCacheReporting.clear();
    const config = {
      version: 1,
      // fake 供应商不读 modelOverrides（它在配置之后才补进注册表）：整条声明一个带缓存 TTL 的 echo
      providers: {
        fake: {
          api: "fake",
          baseUrl: "fake://local",
          requiresApiKey: false,
          models: [
            {
              id: "echo",
              contextWindow: 200_000,
              cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
              promptCache: { short: 300 },
            },
          ],
        },
      },
    };
    h = composeHarness(CACHE_RUN);
    h.home.write("home/.config/ama/config.json", config);
    h.home.write("work/notes.txt", "x\n");
    expect(await h.run(["-p", "hi", "--model", "fake/echo", "--output-format", "json"])).toBe(0);
    const cache = lines()[0]?.["cache"] as Record<string, unknown>;
    expect(cache).toMatchObject({
      reporting: "reported",
      lastHitRate: 0,
      reBilledTokens: 142_000,
      misses: { count: 1, byReason: { evicted: 1 } },
      warming: { mode: "streaming", state: "inactive" },
    });
    expect(cache["reBilledUsd"]).toBeCloseTo(0.1278, 4);
    h.cleanup();

    sharedCacheReporting.clear();
    h = composeHarness(CACHE_RUN);
    h.home.write("home/.config/ama/config.json", config);
    h.home.write("work/notes.txt", "x\n");
    expect(
      await h.run(["-p", "hi", "--model", "fake/echo", "--output-format", "stream-json"]),
    ).toBe(0);
    const events = lines();
    expect(events.find((e) => e["type"] === "context_pressure")).toMatchObject({
      percent: 71,
      threshold: 70,
      remainingTokens: 57_990,
    });
    expect(events.find((e) => e["type"] === "cache_warm")).toMatchObject({ phase: "scheduled" });
    expect(events.find((e) => e["type"] === "cache_miss")).toMatchObject({
      reason: "evicted",
      missedTokens: 142_000,
    });
  });
});

const CACHE_RUN: FakeResponse[] = [
  {
    steps: [{ toolCall: { name: "read", arguments: { path: "notes.txt" } } }],
    usage: { input: 2_000, output: 10, cacheRead: 140_000 },
  },
  { text: "done", usage: { input: 150_000, output: 10 } },
];
