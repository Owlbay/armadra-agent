import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import type { ScriptStep } from "./testing/scripted-api.js";
import { sessionDirForCwd } from "../session/store.js";
import type { SessionEvent } from "./types.js";
import { createHarness, isSummaryRequest, userTexts } from "./testing/harness.js";
import { fakeModel, stubHooks, stubPermission, stubTool } from "./testing/stubs.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

function dir(): string {
  home = createTmpHome("ama-b2-session-");
  return sessionDirForCwd(home.dataDir, home.cwd);
}

const of = <T extends SessionEvent["type"]>(events: SessionEvent[], type: T) =>
  events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);

describe("会话层重试", () => {
  it("429 / 503 后成功：事件、退避、失败尝试落盘但被 context_edit 剔除", async () => {
    const h = createHarness({
      script: [
        { kind: "error", message: "429 rate limited" },
        { kind: "error", message: "503 Service Unavailable" },
        { text: "ok" },
      ],
      dir: dir(),
    });
    await h.session.prompt("hi");
    expect(
      of(h.events, "auto_retry_start").map((e) => [e.attempt, e.maxAttempts, e.delayMs]),
    ).toEqual([
      [1, 3, 1],
      [2, 3, 2],
    ]);
    expect(of(h.events, "auto_retry_end")).toEqual([
      { type: "auto_retry_end", success: true, attempt: 2 },
    ]);
    expect(of(h.events, "agent_end").map((e) => e.willRetry)).toEqual([true, true, false]);
    const edits = h.fileEntries().filter((e) => e.type === "context_edit");
    expect(edits.map((e) => e.type === "context_edit" && [e.reason, e.replacement])).toEqual([
      ["retry", null],
      ["retry", null],
    ]);
    const failed = h
      .fileEntries()
      .filter(
        (e) =>
          e.type === "message" &&
          e.message.role === "assistant" &&
          e.message.stopReason === "error",
      );
    expect(failed).toHaveLength(2);
    expect(h.scripted.calls[2]!.context.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(of(h.events, "agent_settled")).toEqual([{ type: "agent_settled" }]);
  });

  it("不可重试快速失败；重试用尽报 auto_retry_end{success:false}", async () => {
    const h = createHarness({
      script: [{ kind: "error", message: "429 insufficient_quota: billing" }],
    });
    await h.session.prompt("hi");
    expect(h.scripted.calls).toHaveLength(1);
    expect(of(h.events, "auto_retry_start")).toHaveLength(0);
    expect(of(h.events, "agent_settled")[0]?.warning).toMatch(/insufficient_quota/);

    const always429: ScriptStep = { kind: "error", message: "429" };
    const h2 = createHarness({ script: () => always429, retry: { maxRetries: 2, baseDelayMs: 1 } });
    await h2.session.prompt("hi");
    expect(h2.scripted.calls).toHaveLength(3);
    expect(of(h2.events, "auto_retry_end")).toEqual([
      { type: "auto_retry_end", success: false, attempt: 2, finalError: "429" },
    ]);
  });

  it("退避期间 abort 立即回到 idle", async () => {
    const h = createHarness({
      script: [{ kind: "error", message: "overloaded" }],
      retry: { baseDelayMs: 60_000 },
    });
    const running = h.session.prompt("hi");
    await new Promise((r) => setTimeout(r, 20));
    const started = Date.now();
    await h.session.abort();
    await running;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(of(h.events, "auto_retry_end")).toEqual([
      { type: "auto_retry_end", success: false, attempt: 1, finalError: "aborted" },
    ]);
  });
});

describe("溢出 → 压缩 → 重试一次", () => {
  const model = fakeModel({ contextWindow: 4000 });
  const compaction = { reserveTokens: 500, keepRecentTokens: 20_000 };

  it("剔除失败尝试 → PreCompact → 压缩 → 新 run 重试一次", async () => {
    const hooks = stubHooks({ PreCompact: () => ({ customInstructions: "keep names" }) });
    let calls = 0;
    const h = createHarness({
      model,
      compaction,
      hooks,
      dir: dir(),
      script: (call) => {
        calls++;
        if (isSummaryRequest(call.context)) return { text: "## Goal\nsummary of a and b" };
        const texts = userTexts(call.context);
        if (texts.at(-1) === "c" && !texts.some((t) => t.includes("<summary>"))) {
          return { kind: "error", message: "prompt is too long: 9000 tokens > 4000 maximum" };
        }
        return { text: `reply ${calls}` };
      },
    });
    await h.session.prompt("a".repeat(4000));
    await h.session.prompt("b".repeat(4000));
    const before = of(h.events, "agent_start").length;
    await h.session.prompt("c");
    expect(of(h.events, "agent_start").length - before).toBe(2);
    expect(
      of(h.events, "agent_end")
        .slice(-2)
        .map((e) => e.willRetry),
    ).toEqual([true, false]);
    const edits = h.fileEntries().filter((e) => e.type === "context_edit");
    expect(edits.map((e) => e.type === "context_edit" && e.reason)).toEqual(["overflow"]);
    expect(hooks.calls.find((c) => c.event === "PreCompact")?.payload).toMatchObject({
      trigger: "auto",
    });
    const end = of(h.events, "compaction_end")[0];
    expect(end).toMatchObject({ trigger: "overflow", aborted: false, willRetry: true });
    const summaryCall = h.scripted.calls.find((c) => isSummaryRequest(c.context));
    expect(userTexts(summaryCall!.context)[0]).toMatch(/keep names/);
    const last = h.scripted.calls.at(-1)!.context;
    expect(userTexts(last).at(-1)).toBe("c");
    expect(userTexts(last).some((t) => t.includes("summary of a and b"))).toBe(true);
    expect(last.messages.some((m) => m.role === "assistant" && m.stopReason === "error")).toBe(
      false,
    );
    expect(h.fileEntries().filter((e) => e.type === "compaction")).toHaveLength(1);
    expect(of(h.events, "agent_settled").at(-1)).toEqual({ type: "agent_settled" });
  });

  it("重试后再次溢出不再循环；PreCompact block 取消压缩并给出 warning", async () => {
    const h = createHarness({
      model,
      compaction,
      script: (call) =>
        isSummaryRequest(call.context)
          ? { text: "## Goal\nS" }
          : userTexts(call.context).at(-1) === "c"
            ? { kind: "error", message: "context_length_exceeded" }
            : { text: "r" },
    });
    await h.session.prompt("a".repeat(4000));
    await h.session.prompt("b".repeat(4000));
    await h.session.prompt("c");
    const summaries = h.scripted.calls.filter((c) => isSummaryRequest(c.context));
    expect(summaries).toHaveLength(1);
    expect(h.scripted.calls.length).toBe(2 + 1 + 1 + 1);
    expect(of(h.events, "agent_settled").at(-1)?.warning).toMatch(/context_length_exceeded/);

    const blocked = createHarness({
      model,
      compaction,
      hooks: stubHooks({ PreCompact: () => ({ decision: "block", reason: "not now" }) }),
      script: [{ text: "r" }, { kind: "error", message: "prompt is too long" }],
    });
    await blocked.session.prompt("a".repeat(4000));
    await blocked.session.prompt("c");
    expect(blocked.scripted.calls).toHaveLength(2);
    expect(of(blocked.events, "agent_settled").at(-1)?.warning).toMatch(/not now/);
    expect(
      blocked.session.messages.some((m) => m.role === "assistant" && m.stopReason === "error"),
    ).toBe(false);
  });
});

describe("长会话自动压缩", () => {
  it("> 窗口 2 倍的会话：档一 + 档二自动压缩，每次请求都在窗口内，不循环", async () => {
    const window = 8000;
    const read = stubTool({
      name: "read",
      properties: { path: { type: "string" } },
      run: async () => ({ content: "x".repeat(3000) }),
    });
    const h = createHarness({
      model: fakeModel({ contextWindow: window }),
      compaction: { reserveTokens: 1000, keepRecentTokens: 20_000 },
      tools: [read],
      dir: dir(),
      script: (call) => {
        if (isSummaryRequest(call.context)) return { text: "## Goal\nkeep going" };
        const last = call.context.messages.at(-1);
        if (last?.role === "user")
          return { toolCalls: [{ name: "read", args: { path: `f${call.index}.ts` } }] };
        return { text: "answer ".repeat(60) };
      },
    });
    const prompts = 30;
    for (let i = 0; i < prompts; i++) await h.session.prompt(`task ${i} `.repeat(100));
    const fed = h
      .fileEntries()
      .filter((e) => e.type === "message" && e.message.role !== "system")
      .reduce(
        (sum, e) => sum + (e.type === "message" ? JSON.stringify(e.message).length / 4 : 0),
        0,
      );
    expect(fed).toBeGreaterThan(2 * window);
    const compactions = h.fileEntries().filter((e) => e.type === "compaction");
    expect(compactions.length).toBeGreaterThanOrEqual(2);
    expect(h.fileEntries().some((e) => e.type === "context_edit" && e.reason === "prune")).toBe(
      true,
    );
    const work = h.scripted.calls.filter((c) => !isSummaryRequest(c.context));
    expect(work).toHaveLength(prompts * 2);
    expect(h.scripted.calls.length).toBe(prompts * 2 + compactions.length);
    const inputs = h
      .fileEntries()
      .flatMap((e) =>
        e.type === "message" && e.message.role === "assistant" ? [e.message.usage.input] : [],
      );
    expect(inputs).toHaveLength(prompts * 2);
    for (const input of inputs) expect(input).toBeLessThan(window);
    expect(of(h.events, "agent_settled").every((e) => e.warning === undefined)).toBe(true);
    const stats = h.session.getStats();
    expect(stats.contextPercent).toBeLessThan(100);
    expect(stats.assistantMessages).toBe(prompts * 2);
  });
});

describe("Hook 与权限", () => {
  it("PreToolUse deny / updatedInput；权限 ask → broker allow_session；PostToolUse 追加上下文", async () => {
    const seen: unknown[] = [];
    const danger = stubTool({
      name: "danger",
      permission: "execute",
      run: async () => ({ content: "boom" }),
    });
    const echo = stubTool({
      name: "echo",
      properties: { v: { type: "string" } },
      run: async (input) => (seen.push(input), { content: "echoed" }),
    });
    const write = stubTool({
      name: "write",
      permission: "write",
      run: async () => ({ content: "written" }),
    });
    const hooks = stubHooks({
      PreToolUse: (p) =>
        p.toolName === "danger"
          ? { decision: "deny", reason: "no danger" }
          : p.toolName === "echo"
            ? { updatedInput: { v: "patched" } }
            : undefined,
      PostToolUse: (p) =>
        p.toolName === "write" ? { additionalContext: "remember to format" } : undefined,
    });
    const permission = stubPermission((input) =>
      input.toolName === "write"
        ? { decision: "ask", step: "mode", approvalReason: "mode" }
        : undefined,
    );
    const h = createHarness({
      tools: [danger, echo, write],
      hooks,
      permission,
      brokers: [{ ask: async () => undefined }, { ask: async () => "allow_session" }],
      script: [
        {
          toolCalls: [
            { name: "danger", args: {} },
            { name: "echo", args: { v: "orig" } },
            { name: "write", args: {} },
          ],
        },
        { text: "done" },
      ],
    });
    await h.session.prompt("go");
    expect(seen).toEqual([{ v: "patched" }]);
    const results = h.session.messages.flatMap((m) =>
      m.role === "toolResult" ? [[m.toolName, m.isError, String(m.content)]] : [],
    );
    expect(results).toEqual([
      ["danger", true, "no danger"],
      ["echo", false, "echoed"],
      ["write", false, "written\n\nremember to format"],
    ]);
    expect(permission.remembered).toEqual(["write"]);
    expect(of(h.events, "permission_request")[0]).toMatchObject({
      toolName: "write",
      reason: "mode",
      timeoutMs: 600_000,
    });
    expect(of(h.events, "permission_resolved")[0]?.decision).toBe("allow_session");
    expect(of(h.events, "hook_executed").length).toBeGreaterThanOrEqual(4);
  });

  it("无人值守 + 无 broker：ask → deny", async () => {
    const write = stubTool({ name: "write", permission: "write" });
    const h = createHarness({
      tools: [write],
      unattended: true,
      hooks: stubHooks({ PreToolUse: () => ({ decision: "ask", reason: "check" }) }),
      script: [{ toolCalls: [{ name: "write", args: {} }] }, { text: "ok" }],
    });
    await h.session.prompt("go");
    const result = h.session.messages.find((m) => m.role === "toolResult");
    expect(result).toMatchObject({ isError: true });
  });

  it("审批超时 → deny（broker 不回答）", async () => {
    const write = stubTool({ name: "write", permission: "write" });
    const h = createHarness({
      tools: [write],
      approvalTimeoutMs: 20,
      permission: stubPermission(() => ({ decision: "ask", step: "mode", approvalReason: "mode" })),
      brokers: [{ ask: () => new Promise(() => {}) }],
      script: [{ toolCalls: [{ name: "write", args: {} }] }, { text: "ok" }],
    });
    await h.session.prompt("go");
    expect(of(h.events, "permission_resolved")[0]?.decision).toBe("deny");
    expect(h.session.messages.find((m) => m.role === "toolResult")).toMatchObject({
      isError: true,
    });
  });

  it("UserPromptSubmit：block 拒绝、updatedPrompt 替换、additionalContext 作为 custom_message 进上下文", async () => {
    const blocked = createHarness({
      script: [],
      hooks: stubHooks({ UserPromptSubmit: () => ({ decision: "block", reason: "nope" }) }),
    });
    await expect(blocked.session.prompt("x")).rejects.toMatchObject({
      code: "prompt_blocked",
      message: "nope",
    });
    expect(blocked.scripted.calls).toHaveLength(0);

    const h = createHarness({
      script: [{ text: "ok" }],
      hooks: stubHooks({
        UserPromptSubmit: () => ({ updatedPrompt: "rewritten", additionalContext: "extra ctx" }),
      }),
    });
    await h.session.prompt("orig");
    expect(userTexts(h.scripted.calls[0]!.context)).toEqual(["rewritten", "extra ctx"]);
    expect(
      h.manager
        .entries()
        .some((e) => e.type === "custom_message" && e.customType === "ama.hook_context"),
    ).toBe(true);
  });

  it("Stop Hook block → 以 reason 再跑一轮，stopHookActive 传给第二次", async () => {
    let n = 0;
    const hooks = stubHooks({
      Stop: (p) =>
        p.stopHookActive ? undefined : (n++, { decision: "block", reason: "also run tests" }),
    });
    const h = createHarness({ script: [{ text: "first" }, { text: "second" }], hooks });
    await h.session.prompt("go");
    expect(n).toBe(1);
    expect(userTexts(h.scripted.calls[1]!.context)).toEqual(["go", "also run tests"]);
    expect(h.session.messages.find((m) => m.role === "user" && m.origin === "hook")).toBeDefined();
    expect(of(h.events, "agent_before_settle")).toHaveLength(2);
    expect(of(h.events, "agent_settled")).toHaveLength(1);
  });
});

describe("origin", () => {
  it('prompt / steer / followUp 的 origin 落盘；"user" 等同不填', async () => {
    let h!: ReturnType<typeof createHarness>;
    const t = stubTool({
      name: "t",
      run: async () => {
        void h.session.steer("from host", { origin: "host" });
        void h.session.prompt("follow host", { streamingBehavior: "followUp", origin: "host" });
        void h.session.followUp("plain follow");
        return { content: "t" };
      },
    });
    h = createHarness({
      tools: [t],
      script: [
        { toolCalls: [{ name: "t", args: {} }] },
        { text: "a" },
        { text: "b" },
        { text: "c" },
      ],
      dir: dir(),
    });
    await h.session.prompt("hi", { origin: "host" });
    await h.session.prompt("again", { origin: "user" });
    const users = h
      .fileEntries()
      .flatMap((e) =>
        e.type === "message" && e.message.role === "user"
          ? [[e.message.content, e.message.origin]]
          : [],
      );
    expect(users).toEqual([
      ["hi", "host"],
      ["from host", "host"],
      ["follow host", "host"],
      ["plain follow", "followUp"],
      ["again", undefined],
    ]);
    expect(of(h.events, "queue_update").at(-1)).toEqual({
      type: "queue_update",
      steering: [],
      followUp: [],
    });
  });
});

describe("Stop Hook 上限", () => {
  it("一直 block 也最多续跑 3 次", async () => {
    const actives: unknown[] = [];
    const hooks = stubHooks({
      Stop: (p) => (actives.push(p.stopHookActive), { decision: "block", reason: "more" }),
    });
    const h = createHarness({ script: () => ({ text: "x" }), hooks });
    await h.session.prompt("go");
    expect(h.scripted.calls).toHaveLength(4);
    expect(actives).toEqual([false, true, true]);
    expect(of(h.events, "agent_settled")).toHaveLength(1);
  });
});

describe("子 Agent 与会话操作", () => {
  it("spawnSubagent：独立 JSONL、parentSession、ama.task、工具子集去掉 task", async () => {
    const read = stubTool({ name: "read" });
    const task = stubTool({
      name: "task",
      permission: "execute",
      run: async (_input, ctx) => {
        const sub = await ctx.spawnSubagent!({
          prompt: "sub job",
          parentToolCallId: ctx.toolCallId,
          signal: ctx.signal,
        });
        return {
          content: sub.text,
          details: { sessionFile: sub.sessionFile },
          isError: sub.isError,
        };
      },
    });
    const h = createHarness({
      tools: [read, task],
      dir: dir(),
      script: (call) => {
        const texts = userTexts(call.context);
        if (texts[0] === "sub job") return { text: "child answer" };
        return call.context.messages.at(-1)?.role === "toolResult"
          ? { text: "parent done" }
          : { toolCalls: [{ name: "task", args: {} }] };
      },
    });
    await h.session.prompt("delegate");
    const result = h.session.messages.find((m) => m.role === "toolResult");
    expect(result).toMatchObject({ content: "child answer", isError: false });
    const childFile = (result as { details: { sessionFile: string } }).details.sessionFile;
    expect(existsSync(childFile)).toBe(true);
    const lines = readFileSync(childFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ type: "session", parentSession: h.manager.file() });
    expect(lines[1]).toMatchObject({ type: "custom", customType: "ama.task" });
    const childSystem = lines.find((l) => l.type === "message" && l.message.role === "system");
    expect(childSystem.message.toolsAdded.map((t: { name: string }) => t.name)).toEqual(["read"]);
  });

  it("活动工具变化 → system 补丁；setModel 记 model_change", async () => {
    const a = stubTool({ name: "a" });
    const b = stubTool({ name: "b" });
    const other = fakeModel({ id: "other" });
    const h = createHarness({ tools: [a, b], script: [{ text: "1" }, { text: "2" }] });
    await h.session.prompt("one");
    h.session.setActiveTools(["a"]);
    await h.session.prompt("two");
    const systems = h.manager
      .entries()
      .flatMap((e) => (e.type === "message" && e.message.role === "system" ? [e.message] : []));
    expect(systems).toHaveLength(2);
    expect(systems[1]?.toolsRemoved).toEqual(["b"]);
    await expect(h.session.setModel("fake/missing")).rejects.toMatchObject({
      code: "model_not_found",
    });
    expect(() => h.session.setActiveTools(["zzz"])).toThrow(/unknown tools/);
    expect(other.id).toBe("other");
  });

  it("fork 到新文件；navigate 换叶子并写 branch_summary", async () => {
    const h = createHarness({
      dir: dir(),
      script: (call) =>
        isSummaryRequest(call.context)
          ? { text: "## Goal\nbranch work" }
          : { text: `r${call.index}` },
    });
    await h.session.prompt("first");
    await h.session.prompt("second");
    const firstAssistant = h.manager
      .entries()
      .find((e) => e.type === "message" && e.message.role === "assistant")!;
    const forked = await h.session.fork(firstAssistant.id);
    expect(forked.manager.file()).not.toBe(h.manager.file());
    expect(forked.messages.filter((m) => m.role === "user")).toHaveLength(1);
    await forked.dispose();

    const summary = await h.session.navigate(firstAssistant.id, { summarize: true });
    expect(summary).toMatchObject({ type: "branch_summary", parentId: firstAssistant.id });
    await h.session.prompt("third");
    const texts = userTexts(h.scripted.calls.at(-1)!.context);
    expect(texts).toEqual(["first", expect.stringContaining("branch work"), "third"]);
  });

  it("手动 compact；状态与统计", async () => {
    const h = createHarness({
      model: fakeModel({ contextWindow: 100_000 }),
      compaction: { keepRecentTokens: 50 },
      script: (call) =>
        isSummaryRequest(call.context) ? { text: "## Goal\nmanual" } : { text: "y".repeat(400) },
    });
    await h.session.prompt("x".repeat(800));
    await h.session.prompt("z".repeat(800));
    const result = await h.session.compact("be brief");
    expect(result.summary).toContain("manual");
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    expect(h.session.messages[1]).toMatchObject({ role: "compactionSummary" });
    const stats = h.session.getStats();
    expect(stats.userMessages).toBe(2);
    expect(stats.contextWindow).toBe(100_000);
    expect(stats.cost).toBeUndefined();
    expect(h.session.state).toMatchObject({
      isStreaming: false,
      model: { provider: "fake", id: "echo" },
      autoCompaction: true,
    });
  });
});
