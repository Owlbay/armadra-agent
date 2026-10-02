import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import type { AssistantMessage, Message, ToolResultMessage } from "../ai/types.js";
import { createScriptedApi } from "../agent/testing/scripted-api.js";
import { fakeModel } from "../agent/testing/stubs.js";
import { SessionManager } from "../session/manager.js";
import { buildProjection } from "../session/projection.js";
import { CompactionBreaker } from "./breaker.js";
import { prepareBranchSummary, runBranchSummary } from "./branch-summary.js";
import { findCutPoint, summarizableStart } from "./cut-point.js";
import {
  calculateContextTokens,
  estimateContextTokens,
  estimateMessageTokens,
  estimateProjectedTokens,
} from "./estimate.js";
import { serializeConversation } from "./serialize.js";
import { prepareCompaction, runCompaction } from "./summarize-tier.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
const assistant = (text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "fake",
  provider: "fake",
  model: "echo",
  usage: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  stopReason: "stop",
  timestamp: 0,
  ...extra,
});
const call = (id: string, name: string, args: Record<string, unknown>): AssistantMessage =>
  assistant("", {
    content: [{ type: "toolCall", id, name, arguments: args }],
    stopReason: "toolUse",
  });
const result = (id: string, text: string, toolName = "read"): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName,
  content: text,
  isError: false,
  timestamp: 0,
});

describe("estimate", () => {
  it("usage 含 output；error / aborted 的 usage 不采信", () => {
    expect(
      calculateContextTokens({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 0 }),
    ).toBe(10);
    const messages = [user("x".repeat(400)), assistant("ok"), user("y".repeat(40))];
    const est = estimateContextTokens(messages);
    expect(est.usageTokens).toBe(140);
    expect(est.trailingTokens).toBe(10);
    expect(est.tokens).toBe(150);
    const failed = [
      ...messages,
      assistant("", {
        stopReason: "error",
        usage: { input: 9999, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 9999 },
      }),
    ];
    expect(estimateContextTokens(failed).usageTokens).toBe(140);
    expect(
      estimateMessageTokens({
        role: "user",
        content: [{ type: "image", data: "", mimeType: "image/png" }],
        timestamp: 0,
      }),
    ).toBe(1600);
  });

  it("usage 之后有 context_edit → 按投影全量重估", () => {
    const m = SessionManager.inMemory("/w");
    m.append({ type: "message", message: user("q") });
    const a = m.append({
      type: "message",
      message: assistant("a", {
        usage: { input: 5000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 5000 },
      }),
    });
    let branch = m.branch();
    expect(estimateProjectedTokens(buildProjection(branch).items, branch).tokens).toBe(5000);
    m.append({ type: "context_edit", targetId: a.id, replacement: "tiny", reason: "prune" });
    branch = m.branch();
    expect(estimateProjectedTokens(buildProjection(branch).items, branch).tokens).toBeLessThan(10);
  });
});

describe("cut point", () => {
  function items(messages: Message[]) {
    const m = SessionManager.inMemory("/w");
    for (const message of messages) m.append({ type: "message", message });
    return buildProjection(m.branch()).items;
  }

  it("永不切在 toolResult；回合起点不算 split", () => {
    const list = items([
      user("u1".repeat(200)),
      call("c1", "read", { path: "x" }),
      result("c1", "r".repeat(2000)),
      user("u2".repeat(200)),
      assistant("final".repeat(50)),
    ]);
    const cut = findCutPoint(list, summarizableStart(list), 300);
    expect(list[cut.firstKeptIndex]?.message.role).toBe("user");
    expect(cut.isSplitTurn).toBe(false);
    for (let keep = 1; keep < 2000; keep += 37) {
      const c = findCutPoint(list, 0, keep);
      expect(list[c.firstKeptIndex]?.message.role).not.toBe("toolResult");
    }
  });

  it("单回合超预算 → split turn，切在回合内的 assistant", () => {
    const list = items([
      user("old"),
      assistant("old answer"),
      user("big task"),
      call("c1", "read", { path: "x" }),
      result("c1", "r".repeat(4000)),
      call("c2", "read", { path: "y" }),
      result("c2", "s".repeat(4000)),
    ]);
    const cut = findCutPoint(list, 0, 1200);
    expect(cut.isSplitTurn).toBe(true);
    expect(list[cut.firstKeptIndex]?.message.role).toBe("assistant");
    expect(list[cut.turnStartIndex]?.message).toMatchObject({ role: "user", content: "big task" });
  });
});

describe("summarize tier", () => {
  it("模板请求、cacheRetention none、文件列表累计、上一份摘要作为迭代上下文", async () => {
    const m = SessionManager.inMemory("/w");
    m.append({ type: "message", message: user("fix the bug ".repeat(100)) });
    m.append({ type: "message", message: call("c1", "edit", { path: "src/a.ts" }) });
    m.append({ type: "message", message: result("c1", "ok", "edit") });
    m.append({ type: "message", message: call("c2", "read", { path: "src/b.ts" }) });
    m.append({ type: "message", message: result("c2", "content".repeat(300)) });
    m.append({ type: "message", message: user("next ".repeat(100)) });
    m.append({ type: "message", message: assistant("answer ".repeat(100)) });
    const plan = prepareCompaction(buildProjection(m.branch()), 300);
    expect(plan).toBeDefined();
    const scripted = createScriptedApi([{ text: "## Goal\nfix" }]);
    const draft = await runCompaction(plan!, {
      stream: scripted.api.stream,
      model: fakeModel(),
      signal: new AbortController().signal,
      customInstructions: "focus on tests",
    });
    expect(draft.summary).toContain("## Goal");
    expect(draft.summary).toContain("<modified-files>\nsrc/a.ts");
    expect(draft.summary).toContain("<read-files>\nsrc/b.ts");
    const sent = scripted.calls[0];
    expect(sent?.options.cacheRetention).toBe("none");
    expect(sent?.options.maxTokens).toBe(4096);
    const prompt = sent?.context.messages[1];
    expect(prompt?.role === "user" && typeof prompt.content === "string" && prompt.content).toMatch(
      /focus on tests/,
    );
    m.append({
      type: "compaction",
      summary: draft.summary,
      firstKeptEntryId: draft.firstKeptEntryId,
      tokensBefore: 1,
      details: draft.details,
    });
    m.append({ type: "message", message: user("more ".repeat(200)) });
    m.append({ type: "message", message: assistant("x ".repeat(200)) });
    const again = prepareCompaction(buildProjection(m.branch()), 100);
    expect(again?.previousSummary).toBe(draft.summary);
    expect(again?.previousDetails?.modifiedFiles).toEqual(["src/a.ts"]);
  });

  it("模型报错 → compaction_failed；序列化截断工具结果 2000 字符", async () => {
    const m = SessionManager.inMemory("/w");
    m.append({ type: "message", message: user("a ".repeat(500)) });
    m.append({ type: "message", message: assistant("b ".repeat(500)) });
    m.append({ type: "message", message: user("c ".repeat(500)) });
    const plan = prepareCompaction(buildProjection(m.branch()), 100)!;
    const scripted = createScriptedApi([{ kind: "error", message: "500 boom" }]);
    await expect(
      runCompaction(plan, {
        stream: scripted.api.stream,
        model: fakeModel(),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "compaction_failed" });
    const text = serializeConversation([result("c", "z".repeat(5000))]);
    expect(text.length).toBeLessThan(2100);
  });
});

describe("branch summary", () => {
  it("收集离开的分支并摘要", async () => {
    const m = SessionManager.inMemory("/w");
    const u = m.append({ type: "message", message: user("root") });
    m.append({ type: "message", message: assistant("tried A") });
    const leaf = m.append({ type: "message", message: call("c", "write", { path: "x.ts" }) });
    const plan = prepareBranchSummary(new Map(m.entries().map((e) => [e.id, e])), leaf.id, u.id);
    expect(plan?.messages).toHaveLength(2);
    const scripted = createScriptedApi([{ text: "## Goal\nA" }]);
    const draft = await runBranchSummary(plan!, {
      stream: scripted.api.stream,
      model: fakeModel(),
      signal: new AbortController().signal,
    });
    expect(draft.fromId).toBe(leaf.id);
    expect(draft.details.modifiedFiles).toEqual(["x.ts"]);
    expect(
      prepareBranchSummary(new Map(m.entries().map((e) => [e.id, e])), u.id, leaf.id),
    ).toBeUndefined();
  });
});

describe("breaker", () => {
  it("每 run 一次、连续两次失败跳闸、无窗口关闭、0.8 重试门槛", () => {
    const breaker = new CompactionBreaker(true, 1000);
    expect(breaker.canSummarize()).toBe(true);
    breaker.recordSummary(false);
    expect(breaker.blockReason()).toBe("run_limit");
    breaker.startRun();
    breaker.recordSummary(false);
    expect(breaker.tripped).toBe(true);
    breaker.startRun();
    expect(breaker.blockReason()).toBe("tripped");
    breaker.reset();
    expect(breaker.canSummarize()).toBe(true);
    expect(breaker.shouldRetryAfterCompaction(800)).toBe(true);
    expect(breaker.shouldRetryAfterCompaction(801)).toBe(false);
    expect(new CompactionBreaker(true, undefined).blockReason()).toBe("no_window");
    expect(new CompactionBreaker(false, 10).autoEnabled).toBe(false);
  });
});
