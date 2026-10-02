import { describe, expect, it } from "vitest";
import type { AssistantMessage, Message, ToolResultMessage } from "../ai/types.js";
import { replaySystem } from "../session/projection.js";
import { PendingMessageQueue } from "./queue.js";
import { classifyFailure, retryDelayMs, resolveRetrySettings, sleep } from "./retry.js";
import { assembleSections, definedSections, diffSystem, toolDecls } from "./system-prompt.js";
import { stubTool } from "./testing/stubs.js";
import { ORPHAN_TOOL_RESULT_TEXT, convertToLlm, repairTranscript } from "./transform.js";

const assistant = (extra: Partial<AssistantMessage>): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "fake",
  provider: "fake",
  model: "echo",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  stopReason: "stop",
  timestamp: 0,
  ...extra,
});
const result = (id: string): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "read",
  content: "r",
  isError: false,
  timestamp: 0,
});

describe("repairTranscript", () => {
  it("跳过 error / aborted 助手消息及其结果，孤儿结果丢弃", () => {
    const messages: Message[] = [
      { role: "user", content: "q", timestamp: 0 },
      assistant({
        stopReason: "aborted",
        content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }],
      }),
      result("a"),
      result("ghost"),
      { role: "user", content: "again", timestamp: 0 },
    ];
    expect(repairTranscript(messages).map((m) => m.role)).toEqual(["user", "user"]);
  });

  it("孤儿 tool_call 补错误结果，紧跟已有结果之后，按调用顺序", () => {
    const messages: Message[] = [
      assistant({
        stopReason: "toolUse",
        content: [
          { type: "toolCall", id: "x", name: "read", arguments: {} },
          { type: "toolCall", id: "y", name: "grep", arguments: {} },
        ],
      }),
      result("y"),
      { role: "user", content: "next", timestamp: 0 },
    ];
    const out = repairTranscript(messages);
    expect(out.map((m) => (m.role === "toolResult" ? `r:${m.toolCallId}` : m.role))).toEqual([
      "assistant",
      "r:x",
      "r:y",
      "user",
    ]);
    expect(out[1]).toMatchObject({
      isError: true,
      content: ORPHAN_TOOL_RESULT_TEXT,
      toolName: "read",
    });
  });

  it("tool id 归一化且全局唯一（同一原 id 跨消息不撞车）", () => {
    const messages: Message[] = [
      assistant({
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call:0|x", name: "read", arguments: {} }],
      }),
      { ...result("call:0|x") },
      assistant({
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call:0|x", name: "read", arguments: {} }],
      }),
      { ...result("call:0|x") },
    ];
    const out = repairTranscript(messages);
    const ids = out.map((m) =>
      m.role === "assistant"
        ? (m.content[0] as { id: string }).id
        : m.role === "toolResult"
          ? m.toolCallId
          : "",
    );
    expect(ids[0]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).toBe(ids[3]);
    expect(ids[0]).not.toBe(ids[2]);
  });

  it("跨模型：thinking 转文本、redacted 丢弃、签名去掉；同模型原样", () => {
    const message = assistant({
      provider: "other",
      model: "m2",
      content: [
        { type: "thinking", thinking: "plan", thinkingSignature: "sig" },
        { type: "thinking", thinking: "secret", redacted: true },
        { type: "text", text: "hi", textSignature: "t" },
        { type: "toolCall", id: "c", name: "read", arguments: {}, thoughtSignature: "s" },
      ],
      stopReason: "toolUse",
    });
    const cross = repairTranscript([message, result("c")], { provider: "fake", model: "echo" });
    expect((cross[0] as AssistantMessage).content).toEqual([
      { type: "text", text: "plan" },
      { type: "text", text: "hi" },
      { type: "toolCall", id: "c", name: "read", arguments: {} },
    ]);
    const same = repairTranscript([message, result("c")], { provider: "other", model: "m2" });
    expect((same[0] as AssistantMessage).content).toEqual(message.content);
  });

  it("convertToLlm：扩展角色转 user", () => {
    const out = convertToLlm([
      { role: "compactionSummary", summary: "S", tokensBefore: 1, timestamp: 0 },
      { role: "branchSummary", summary: "B", fromId: "x", timestamp: 0 },
      {
        role: "custom",
        customType: "ama.aborted",
        content: "aborted",
        display: false,
        timestamp: 0,
      },
    ]);
    expect(out.map((m) => m.role)).toEqual(["user", "user", "user"]);
    expect(out[0]?.role === "user" && out[0].content).toMatch(/<summary>\nS\n<\/summary>/);
  });
});

describe("system prompt", () => {
  it("属性值转义与 skills 索引同一个 escapeXml（含引号）", () => {
    const sections = assembleSections({
      tools: [],
      cwd: "/w",
      contextFiles: [{ path: '/w/a "b".md', content: "x" }],
      skills: [{ name: "s", description: "it's <ok>", location: "/s" }],
    });
    expect(sections.project_context).toContain('<file path="/w/a &quot;b&quot;.md">');
    expect(sections.skills).toContain(">it&apos;s &lt;ok&gt;</skill>");
  });

  it("节顺序固定、补丁只含变化、工具表差异", () => {
    const read = stubTool({ name: "read", permission: "read" });
    const bash = stubTool({ name: "bash", permission: "execute" });
    const sections = definedSections(
      assembleSections({
        tools: [read, bash],
        cwd: "/w",
        hostInstructions: ["host rules"],
        hookContext: "hook ctx",
      }),
    );
    expect(Object.keys(sections)).toEqual(["preamble", "tools", "rules", "hooks", "cwd", "host"]);
    const full = diffSystem(undefined, sections, toolDecls([read, bash]));
    expect(full?.toolsAdded?.map((t) => t.name)).toEqual(["bash", "read"]);
    const state = replaySystem([full!]);
    expect(diffSystem(state, sections, toolDecls([read, bash]))).toBeUndefined();
    const next = definedSections(assembleSections({ tools: [read], cwd: "/w" }));
    const patch = diffSystem(state, next, toolDecls([read]));
    expect(patch?.sections).toEqual({ tools: next["tools"], hooks: null, host: null });
    expect(patch?.toolsRemoved).toEqual(["bash"]);
    expect(patch?.toolsAdded).toBeUndefined();
    expect(replaySystem([full!, patch!])).toEqual({ sections: next, tools: toolDecls([read]) });
  });
});

describe("retry", () => {
  const failed = (errorMessage: string): AssistantMessage =>
    assistant({ stopReason: "error", errorMessage });

  it("溢出 → 不可重试 → 可重试 → 其它", () => {
    expect(classifyFailure(failed("prompt is too long: 210000 tokens > 200000"))).toBe("overflow");
    expect(classifyFailure(failed("429 insufficient_quota"))).toBe("fatal");
    expect(classifyFailure(failed("401 invalid api key"))).toBe("fatal");
    expect(classifyFailure(failed("429 Too Many Requests"))).toBe("retryable");
    expect(classifyFailure(failed("529 overloaded_error"))).toBe("retryable");
    expect(classifyFailure(failed("fetch failed: ECONNRESET"))).toBe("retryable");
    expect(classifyFailure(failed("weird"))).toBe("other");
    // 缺省用 ai/overflow.ts 的同一张表：Kimi 文案算溢出，限流文案不算
    expect(classifyFailure(failed("exceeded model token limit: 262144"))).toBe("overflow");
    expect(classifyFailure(failed("429 rate limit: token limit exceeded"))).toBe("retryable");
    expect(
      classifyFailure(assistant({ stopReason: "length", content: [{ type: "text", text: "…" }] })),
    ).toBe("overflow");
    expect(
      classifyFailure(failed("custom overflow text"), {
        isContextOverflow: (t) => t.includes("custom overflow"),
      }),
    ).toBe("overflow");
  });

  it("退避 2 s ×2，上限 60 s；sleep 可被 abort 打断", async () => {
    const settings = resolveRetrySettings();
    expect([1, 2, 3, 10].map((n) => retryDelayMs(n, settings))).toEqual([2000, 4000, 8000, 60000]);
    const controller = new AbortController();
    const pending = sleep(10_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });
});

describe("queue", () => {
  it("one-at-a-time 每次一条，all 一次取空", () => {
    const q = new PendingMessageQueue();
    const msg = (t: string) => ({ role: "user" as const, content: t, timestamp: 0 });
    q.enqueue(msg("a"));
    q.enqueue(msg("b"));
    expect(q.drain()).toHaveLength(1);
    q.mode = "all";
    q.enqueue(msg("c"));
    expect(q.drain()).toHaveLength(2);
    expect(q.hasItems()).toBe(false);
  });
});
