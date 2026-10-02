import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import { sessionDirForCwd } from "../session/store.js";
import type { SessionEntry } from "../session/types.js";
import { createHarness, toolResultCounts, userTexts } from "./testing/harness.js";
import { stubTool, waitOrAbort } from "./testing/stubs.js";
import { ABORTED_TOOL_TEXT } from "./tool-runner.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

function dir(): string {
  home = createTmpHome("ama-b2-loop-");
  return sessionDirForCwd(home.dataDir, home.cwd);
}

const messageRoles = (entries: readonly SessionEntry[]): string[] =>
  entries
    .filter((e) => e.type === "message")
    .map((e) => (e.type === "message" ? e.message.role : ""));

describe("基本 run", () => {
  it("事件顺序、首条 system 在首次请求前落盘（此时才建文件）", async () => {
    const h = createHarness({ script: [{ text: "hello" }], dir: dir() });
    expect(h.manager.file()).toBeUndefined();
    await h.session.prompt("hi");
    expect(h.types()).toEqual([
      "entry_appended", // model_change
      "entry_appended", // thinking_level_change
      "entry_appended", // system
      "before_agent_start",
      "agent_start",
      "turn_start",
      "message_start",
      "entry_appended",
      "message_end",
      "message_start",
      "message_update",
      "message_update",
      "message_update",
      "entry_appended",
      "message_end",
      "turn_end",
      "agent_end",
      "agent_before_settle",
      "agent_settled",
    ]);
    expect(existsSync(h.manager.file() as string)).toBe(true);
    const lines = h.fileLines();
    expect(lines.map((l) => l.type)).toEqual([
      "session",
      "model_change",
      "thinking_level_change",
      "message",
      "message",
      "message",
    ]);
    expect(messageRoles(h.fileEntries())).toEqual(["system", "user", "assistant"]);
    expect(h.session.getLastAssistantText()).toBe("hello");
    expect(h.events.find((e) => e.type === "agent_end")).toMatchObject({
      willRetry: false,
      stopReason: "stop",
    });
    const sent = h.scripted.calls[0]?.context.messages.map((m) => m.role);
    expect(sent).toEqual(["system", "user"]);
  });

  it("运行中 prompt 无 streamingBehavior → busy；有则入队", async () => {
    const slow = stubTool({
      name: "slow",
      run: async (_i, ctx) => (await waitOrAbort(30, ctx.signal), { content: "s" }),
    });
    const h = createHarness({
      script: [{ toolCalls: [{ name: "slow", args: {} }] }, { text: "one" }, { text: "two" }],
      tools: [slow],
    });
    const running = h.session.prompt("go");
    await expect(h.session.prompt("again")).rejects.toMatchObject({ code: "busy" });
    await expect(h.session.prompt("later", { streamingBehavior: "followUp" })).resolves.toBe(
      "queued",
    );
    await expect(running).resolves.toBe("started");
    expect(userTexts(h.scripted.calls[2]!.context)).toEqual(["go", "later"]);
  });
});

describe("工具执行", () => {
  it("并行执行：end 按完成顺序，结果按原序入转录", async () => {
    const a = stubTool({
      name: "a",
      run: async (_i, ctx) => (await waitOrAbort(40, ctx.signal), { content: "A" }),
    });
    const b = stubTool({ name: "b", run: async () => ({ content: "B" }) });
    const h = createHarness({
      script: [
        {
          toolCalls: [
            { name: "a", args: {}, id: "ca" },
            { name: "b", args: {}, id: "cb" },
          ],
        },
        { text: "ok" },
      ],
      tools: [a, b],
    });
    await h.session.prompt("go");
    const ends = h.events
      .filter((e) => e.type === "tool_execution_end")
      .map((e) => (e.type === "tool_execution_end" ? e.toolCallId : ""));
    expect(ends).toEqual(["cb", "ca"]);
    const results = h.session.messages
      .filter((m) => m.role === "toolResult")
      .map((m) => (m.role === "toolResult" ? m.toolCallId : ""));
    expect(results).toEqual(["ca", "cb"]);
  });

  it("sequential 传染：批内有一个 sequential 则整批串行", async () => {
    let running = 0;
    let peak = 0;
    const make = (name: string, mode?: "sequential") =>
      stubTool({
        name,
        ...(mode === undefined ? {} : { executionMode: mode }),
        run: async (_i, ctx) => {
          running++;
          peak = Math.max(peak, running);
          await waitOrAbort(10, ctx.signal);
          running--;
          return { content: name };
        },
      });
    const h = createHarness({
      script: [
        {
          toolCalls: [
            { name: "p1", args: {} },
            { name: "p2", args: {} },
          ],
        },
        {
          toolCalls: [
            { name: "p1", args: {} },
            { name: "s1", args: {} },
          ],
        },
        { text: "done" },
      ],
      tools: [make("p1"), make("p2"), make("s1", "sequential")],
    });
    await h.session.prompt("go");
    expect(peak).toBe(1 + 1); // 第一批并行到 2
    peak = 0;
    const h2 = createHarness({
      script: [
        {
          toolCalls: [
            { name: "p1", args: {} },
            { name: "s1", args: {} },
          ],
        },
        { text: "done" },
      ],
      tools: [make("p1"), make("s1", "sequential")],
    });
    await h2.session.prompt("go");
    expect(peak).toBe(1);
  });

  it("length 且有 tool_call：整批判失败不执行", async () => {
    let executed = 0;
    const t = stubTool({ name: "t", run: async () => (executed++, { content: "x" }) });
    const h = createHarness({
      script: [
        {
          toolCalls: [
            { name: "t", args: {} },
            { name: "t", args: {} },
          ],
          stopReason: "length",
        },
        { text: "redo" },
      ],
      tools: [t],
    });
    await h.session.prompt("go");
    expect(executed).toBe(0);
    const results = h.session.messages.filter((m) => m.role === "toolResult");
    expect(results).toHaveLength(2);
    expect(
      results.every(
        (r) => r.role === "toolResult" && r.isError && String(r.content).includes("truncated"),
      ),
    ).toBe(true);
    expect(h.scripted.calls).toHaveLength(2);
  });

  it("schema 不通过 → 错误结果不执行；未知工具 → 错误结果", async () => {
    let executed = 0;
    const t = stubTool({
      name: "t",
      properties: { path: { type: "string" } },
      required: ["path"],
      run: async () => (executed++, { content: "x" }),
    });
    const h = createHarness({
      script: [
        {
          toolCalls: [
            { name: "t", args: { path: 3 } },
            { name: "nope", args: {} },
          ],
        },
        { text: "ok" },
      ],
      tools: [t],
    });
    await h.session.prompt("go");
    expect(executed).toBe(0);
    const texts = h.session.messages.flatMap((m) =>
      m.role === "toolResult" ? [String(m.content)] : [],
    );
    expect(texts[0]).toMatch(/Invalid arguments.*\n\$\.path: expected string/);
    expect(texts[1]).toBe("Tool nope not found");
  });

  it("terminate 整批为真才提前结束", async () => {
    const stop = stubTool({ name: "stop", run: async () => ({ content: "bye", terminate: true }) });
    const go = stubTool({ name: "go", run: async () => ({ content: "go" }) });
    const h = createHarness({
      script: [{ toolCalls: [{ name: "stop", args: {} }] }, { text: "never" }],
      tools: [stop, go],
    });
    await h.session.prompt("x");
    expect(h.scripted.calls).toHaveLength(1);
    const h2 = createHarness({
      script: [
        {
          toolCalls: [
            { name: "stop", args: {} },
            { name: "go", args: {} },
          ],
        },
        { text: "after" },
      ],
      tools: [stop, go],
    });
    await h2.session.prompt("x");
    expect(h2.scripted.calls).toHaveLength(2);
  });

  it("超出 maxToolResultChars 截断并把全文写到 outputs/", async () => {
    const big = stubTool({ name: "big", run: async () => ({ content: "z".repeat(500) }) });
    const h = createHarness({
      script: [{ toolCalls: [{ name: "big", args: {}, id: "cbig" }] }, { text: "ok" }],
      tools: [big],
      maxToolResultChars: 100,
      dir: dir(),
    });
    await h.session.prompt("x");
    const result = h.session.messages.find((m) => m.role === "toolResult");
    expect(result?.role === "toolResult" && String(result.content)).toMatch(
      /输出过长已截断：共 500 字符，全文 .*outputs.*cbig\.txt/,
    );
  });
});

describe("steer / followUp", () => {
  it("steer 投递点：本轮工具全部结束、下一次模型调用前；one-at-a-time 每个投递点一条", async () => {
    const order: string[] = [];
    let h!: ReturnType<typeof createHarness>;
    const slow = stubTool({
      name: "slow",
      run: async (_i, ctx) => {
        order.push("tool-start");
        void h.session.steer("STEER");
        await waitOrAbort(20, ctx.signal);
        order.push("tool-end");
        return { content: "slow done" };
      },
    });
    const script = [
      {
        toolCalls: [
          { name: "slow", args: {} },
          { name: "slow", args: {} },
        ],
      },
      { text: "seen one" },
      { text: "seen two" },
    ];
    h = createHarness({ script, tools: [slow] });
    await h.session.prompt("go");
    const roles = (n: number) =>
      h.scripted.calls[n]!.context.messages.map((m) =>
        m.role === "user" ? `user:${typeof m.content === "string" ? m.content : ""}` : m.role,
      );
    expect(roles(1)).toEqual([
      "system",
      "user:go",
      "assistant",
      "toolResult",
      "toolResult",
      "user:STEER",
    ]);
    expect(roles(2).slice(-2)).toEqual(["assistant", "user:STEER"]);
    expect(order).toEqual(["tool-start", "tool-start", "tool-end", "tool-end"]);
    expect(h.events.filter((e) => e.type === "agent_start")).toHaveLength(1);

    h = createHarness({ script, tools: [slow], steeringMode: "all" });
    await h.session.prompt("go");
    expect(roles(1).slice(-2)).toEqual(["user:STEER", "user:STEER"]);
    expect(h.scripted.calls).toHaveLength(2);
  });

  it("followUp 只在本会停下时投递（steer 优先）", async () => {
    let h!: ReturnType<typeof createHarness>;
    const t = stubTool({
      name: "t",
      run: async () => {
        void h.session.followUp("FOLLOW");
        void h.session.steer("STEER");
        return { content: "t" };
      },
    });
    h = createHarness({
      script: [
        { toolCalls: [{ name: "t", args: {} }] },
        { text: "after steer" },
        { text: "after follow" },
      ],
      tools: [t],
    });
    await h.session.prompt("go");
    expect(userTexts(h.scripted.calls[1]!.context)).toEqual(["go", "STEER"]);
    expect(userTexts(h.scripted.calls[2]!.context)).toEqual(["go", "STEER", "FOLLOW"]);
    expect(h.events.filter((e) => e.type === "agent_start")).toHaveLength(1);
  });

  it("空闲时 steer / followUp 直接开始一个周期", async () => {
    const h = createHarness({ script: [{ text: "a" }] });
    await expect(h.session.steer("now")).resolves.toBe("handled");
    expect(h.session.messages.find((m) => m.role === "user")).toMatchObject({ origin: "steer" });
  });
});

describe("abort", () => {
  function assertEveryCallHasOneResult(entries: readonly SessionEntry[]): void {
    const counts = toolResultCounts(entries);
    expect(counts.size).toBeGreaterThan(0);
    for (const [id, count] of counts) expect([id, count]).toEqual([id, 1]);
  }

  it("工具执行中 abort：每个 tool_call 恰有一个 result，落 ama.aborted，回到 idle，不清队列", async () => {
    let h!: ReturnType<typeof createHarness>;
    const hang = stubTool({
      name: "hang",
      run: async (_i, ctx) => {
        void h.session.followUp("queued later");
        await waitOrAbort(60_000, ctx.signal);
        return { content: "interrupted", isError: true };
      },
    });
    const quick = stubTool({ name: "quick", run: async () => ({ content: "q" }) });
    h = createHarness({
      script: [
        {
          toolCalls: [
            { name: "quick", args: {} },
            { name: "hang", args: {} },
            { name: "quick", args: {} },
          ],
        },
        { text: "never" },
      ],
      tools: [hang, quick],
      dir: dir(),
    });
    const running = h.session.prompt("go");
    await new Promise((r) => setTimeout(r, 30));
    await h.session.abort();
    await running;
    expect(h.session.state.isStreaming).toBe(false);
    const entries = h.fileEntries();
    assertEveryCallHasOneResult(entries);
    expect(entries.some((e) => e.type === "custom_message" && e.customType === "ama.aborted")).toBe(
      true,
    );
    expect(h.scripted.calls).toHaveLength(1);
    expect(h.session.state.pendingMessageCount).toBe(1);
    expect(h.events.find((e) => e.type === "agent_end")).toMatchObject({
      stopReason: "aborted",
      willRetry: false,
    });
  });

  it("流式中（tool_call 已产出）abort：补 aborted 结果；忽略 signal 的工具在宽限期后记 aborted", async () => {
    const h = createHarness({
      script: [
        {
          kind: "hang",
          text: "thinking",
          toolCalls: [
            { name: "x", args: {} },
            { name: "y", args: {} },
          ],
        },
      ],
      dir: dir(),
    });
    const running = h.session.prompt("go");
    await new Promise((r) => setTimeout(r, 20));
    await h.session.abort();
    await running;
    assertEveryCallHasOneResult(h.fileEntries());
    const results = h
      .fileEntries()
      .flatMap((e) => (e.type === "message" && e.message.role === "toolResult" ? [e.message] : []));
    expect(results.every((r) => r.isError && r.content === ABORTED_TOOL_TEXT)).toBe(true);

    const stubborn = stubTool({ name: "stubborn", run: () => new Promise(() => {}) });
    const h2 = createHarness({
      script: [{ toolCalls: [{ name: "stubborn", args: {} }] }],
      tools: [stubborn],
      dir: dir(),
      abortGraceMs: 20,
    });
    const run2 = h2.session.prompt("go");
    await new Promise((r) => setTimeout(r, 20));
    await h2.session.abort();
    await run2;
    assertEveryCallHasOneResult(h2.fileEntries());
  });

  it("回放：被中断的助手消息不进下一次请求，ama.aborted 进上下文", async () => {
    const h = createHarness({ script: [{ kind: "hang", text: "partial" }, { text: "fresh" }] });
    const running = h.session.prompt("go");
    await new Promise((r) => setTimeout(r, 10));
    await h.session.abort();
    await running;
    await h.session.prompt("again");
    const roles = h.scripted.calls[1]!.context.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "user", "user"]);
    expect(userTexts(h.scripted.calls[1]!.context)[1]).toMatch(/interrupted/);
  });
});
