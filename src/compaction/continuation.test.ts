import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAnthropicRequest } from "../ai/apis/anthropic-request.js";
import { buildOpenAIRequest } from "../ai/apis/openai-request.js";
import { ProviderRegistry } from "../ai/providers/registry.js";
import type {
  AssistantMessage,
  Message,
  Model,
  StreamOptions,
  TranscriptContext,
} from "../ai/types.js";
import { createHarness, isSummaryRequest } from "../agent/testing/harness.js";
import { fakeModel, stubTool } from "../agent/testing/stubs.js";
import type { ContextItem } from "../session/projection.js";
import {
  SUMMARIZATION_SYSTEM_PROMPT,
  SUMMARY_CONTINUATION_PREAMBLE,
  SUMMARY_CONTINUATION_TAIL,
  SUMMARY_MAX_TOKENS,
  completeByContinuation,
  countLlmMessages,
  excerptOf,
  prepareCompaction,
  type StreamFn,
} from "./summarize-tier.js";

const dirs: string[] = [];
afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});
function dir(): string {
  const path = mkdtempSync(join(tmpdir(), "ama-c1b-cont-"));
  dirs.push(path);
  return path;
}

const registry = new ProviderRegistry({ keys: { useEnv: false, userAuthFile: null } });
const anthropic = registry.get("anthropic")?.models[0] as Model;
const openai = registry.get("openai")?.models[0] as Model;
const signal = new AbortController().signal;

type Json = Record<string, unknown>;
function strip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null), (key, v) =>
    key === "cache_control" ? undefined : v,
  );
}

function lastUser(context: TranscriptContext): string {
  const last = context.messages.at(-1);
  return last?.role === "user" && typeof last.content === "string" ? last.content : "";
}

const isContinuation = (context: TranscriptContext): boolean =>
  lastUser(context).startsWith(SUMMARY_CONTINUATION_PREAMBLE);

describe("压缩摘要走会话前缀续写（§1.8）", () => {
  it("/compact：请求体前缀（含 tools）与上一次真实请求逐字节一致，不发 tool_choice、purpose summary、short", async () => {
    const read = stubTool({
      name: "read",
      run: async () => ({ content: "file body ".repeat(40) }),
    });
    const h = createHarness({
      model: fakeModel({ contextWindow: 100_000 }),
      compaction: { keepRecentTokens: 50 },
      tools: [read],
      cache: { warming: "off" },
      script: (call) => {
        if (isSummaryRequest(call.context)) return { text: "## Goal\ncontinued" };
        if (call.index === 0) return { toolCalls: [{ name: "read", args: { path: "a" } }] };
        return { text: "y".repeat(400) };
      },
    });
    await h.session.prompt("x".repeat(800));
    await h.session.prompt("z".repeat(800));
    const turn = h.scripted.calls.at(-1)!;
    const result = await h.session.compact("keep ids");
    expect(result.summary).toContain("continued");
    const summaries = h.scripted.calls.slice(turn.index + 1);
    expect(summaries.every((c) => isContinuation(c.context))).toBe(true);
    const summary = summaries[0]!;
    expect(isContinuation(summary.context)).toBe(true);
    expect(summary.options).not.toHaveProperty("toolChoice");
    expect(summary.options).toMatchObject({
      purpose: "summary",
      cacheRetention: "short",
      sessionId: turn.options.sessionId,
    });
    const prompt = lastUser(summary.context);
    expect(prompt).toMatch(/messages 1–\d+ of the conversation above/);
    expect(prompt).toContain("keep ids");
    expect(prompt).toContain("## Goal");
    expect(prompt).toContain("do not call any tools");
    expect(prompt.endsWith(SUMMARY_CONTINUATION_TAIL)).toBe(true);
    // 逐字节：上一次真实请求的全部消息是摘要请求的前缀（两种协议的请求体）
    const n = turn.context.messages.length;
    expect(JSON.stringify(summary.context.messages.slice(0, n))).toBe(
      JSON.stringify(turn.context.messages),
    );
    const { signal: _s, ...summaryOptions } = summary.options;
    for (const build of [
      (c: TranscriptContext, o = {}) => buildAnthropicRequest(anthropic, c, { signal, ...o }).body,
      (c: TranscriptContext, o = {}) => buildOpenAIRequest(openai, c, { signal, ...o }).body,
    ]) {
      const a = build(turn.context);
      const b = build(summary.context, summaryOptions);
      expect(b).not.toHaveProperty("tool_choice");
      expect(strip(a["tools"])).not.toEqual([]);
      expect(JSON.stringify(strip(b["system"]))).toBe(JSON.stringify(strip(a["system"])));
      expect(JSON.stringify(strip(b["tools"]))).toBe(JSON.stringify(strip(a["tools"])));
      const am = strip(a["messages"]) as Json[];
      const bm = strip(b["messages"]) as Json[];
      // 回合请求的最后一条 user 带断点（Anthropic 把字符串内容写成 text 块），只比较文本
      const text = (m: Json | undefined) =>
        JSON.stringify(m?.["content"]).replace(/^\[\{"type":"text","text":(.*)\}\]$/, "$1");
      expect(JSON.stringify(bm.slice(0, am.length - 1))).toBe(JSON.stringify(am.slice(0, -1)));
      expect(text(bm[am.length - 1])).toBe(text(am.at(-1)));
    }
    expect(h.manager.entries().some((e) => e.type === "compaction")).toBe(true);
  });

  it("续写失败（含工具调用 / 空 / 截断 / 出错）回落独立请求并记 warning", async () => {
    for (const bad of [
      { toolCalls: [{ name: "read", args: {} }] },
      { text: "" },
      { text: "partial", stopReason: "length" as const },
      { kind: "error" as const, message: "boom" },
    ]) {
      const logs: string[] = [];
      const h = createHarness({
        model: fakeModel({ contextWindow: 100_000 }),
        compaction: { keepRecentTokens: 50 },
        cache: { warming: "off" },
        log: (_level, message) => logs.push(message),
        script: (call) => {
          if (isContinuation(call.context)) return bad;
          if (isSummaryRequest(call.context)) return { text: "## Goal\nfallback" };
          return { text: "y".repeat(400) };
        },
      });
      await h.session.prompt("x".repeat(800));
      await h.session.prompt("z".repeat(800));
      const result = await h.session.compact();
      expect(result.summary).toContain("fallback");
      // split turn 的两份摘要并行发出（C9）：续写在前、回落的独立请求在后，但不一定相邻
      const calls = h.scripted.calls;
      const independent = calls.at(-1);
      const cont = calls.findLast((c) => isContinuation(c.context));
      expect(cont).toBeDefined();
      expect(calls.indexOf(cont!)).toBeLessThan(calls.length - 1);
      const first = independent!.context.messages[0];
      expect(first?.role === "system" && first.sections["preamble"]).toBe(
        SUMMARIZATION_SYSTEM_PROMPT,
      );
      expect(independent!.options).toMatchObject({ cacheRetention: "none", purpose: "summary" });
      expect(logs.some((l) => l.includes("prefix continuation failed"))).toBe(true);
    }
  });

  it("前缀不再一致（档一裁剪 / 换模型）或放不进窗口 → 直接独立请求", async () => {
    const h = createHarness({
      model: fakeModel({ contextWindow: 100_000 }),
      compaction: { keepRecentTokens: 50 },
      cache: { warming: "off" },
      script: (call) =>
        isSummaryRequest(call.context) ? { text: "## Goal\nx" } : { text: "y".repeat(400) },
    });
    await h.session.prompt("x".repeat(800));
    await h.session.prompt("z".repeat(800));
    const target = h.manager
      .entries()
      .find((e) => e.type === "message" && e.message.role === "user")!;
    h.session.appendEntry({
      type: "context_edit",
      targetId: target.id,
      replacement: "x",
      reason: "manual",
    });
    h.session.reloadMessages();
    expect(h.session.cache.summaryContinuation()).toBeUndefined();
    await h.session.compact();
    expect(isContinuation(h.scripted.calls.at(-1)!.context)).toBe(false);

    const tight = createHarness({
      model: fakeModel({ contextWindow: 7000 }),
      cache: { warming: "off" },
      script: [{ text: "ok", usage: { input: 2000 } }],
    });
    await tight.session.prompt("q");
    expect(tight.session.cache.summaryContinuation()).toBeUndefined();
  });

  it("[ME-B] 思考开启（非预算型协议）：续写的输出上限 = 摘要上限 + 思考预算，不超过模型上限", async () => {
    const make = (maxTokens: number) => {
      const h = createHarness({
        model: fakeModel({ reasoning: true, maxTokens }),
        thinkingLevel: "medium",
        compaction: { keepRecentTokens: 50 },
        cache: { warming: "off" },
        script: (call) =>
          isSummaryRequest(call.context) ? { text: "## Goal\nx" } : { text: "y".repeat(400) },
      });
      return h;
    };
    for (const [max, expected] of [
      [64_000, SUMMARY_MAX_TOKENS + 8192],
      [8192, 8192],
    ] as const) {
      const h = make(max);
      await h.session.prompt("x".repeat(800));
      await h.session.prompt("z".repeat(800));
      const continuation = h.session.cache.summaryContinuation();
      expect(continuation?.streamOptions?.maxTokens).toBe(expected);
      await h.session.compact();
      const summary = h.scripted.calls.find((c) => isContinuation(c.context))!;
      expect(summary.options.maxTokens).toBe(expected);
    }
    const off = createHarness({
      model: fakeModel({ reasoning: true }),
      thinkingLevel: "off",
      cache: { warming: "off" },
      script: [{ text: "ok" }],
    });
    await off.session.prompt("q");
    expect(off.session.cache.summaryContinuation()?.streamOptions).not.toHaveProperty("maxTokens");
  });

  it("分支摘要同样续写：只摘要被离开的最后 K 条", async () => {
    const h = createHarness({
      dir: dir(),
      cache: { warming: "off" },
      script: (call) =>
        isSummaryRequest(call.context) ? { text: "## Goal\nbranch" } : { text: `r${call.index}` },
    });
    await h.session.prompt("first");
    await h.session.prompt("second");
    const firstAssistant = h.manager
      .entries()
      .find((e) => e.type === "message" && e.message.role === "assistant")!;
    await h.session.navigate(firstAssistant.id, { summarize: true });
    const summary = h.scripted.calls.at(-1)!;
    expect(isContinuation(summary.context)).toBe(true);
    expect(lastUser(summary.context)).toContain("Messages 3–4 are the branch being left");
    expect(summary.options).not.toHaveProperty("toolChoice");
  });
});

describe("completeByContinuation", () => {
  it("调用方的 streamOptions 带 toolChoice 也不发；回复含工具调用抛 compaction_failed", async () => {
    const seen: StreamOptions[] = [];
    const reply = (content: AssistantMessage["content"]): StreamFn =>
      ((_model: Model, _context: TranscriptContext, options: StreamOptions) => {
        seen.push(options);
        return {
          result: async () => ({
            role: "assistant",
            content,
            api: "fake",
            provider: "fake",
            model: "echo",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
            stopReason: "stop",
            timestamp: 0,
          }),
        };
      }) as never;
    const input = {
      prefix: { messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] },
      keepFrom: { index: 1, excerpt: "" },
      instruction: "summarize",
    };
    const options = (stream: StreamFn) => ({
      stream,
      model: fakeModel(),
      signal,
      continuation: {
        prefix: input.prefix,
        streamOptions: { toolChoice: "none" as const, sessionId: "s1" },
      },
    });
    const ok = await completeByContinuation(
      options(reply([{ type: "text", text: "## Goal\nx" }])),
      input,
    );
    expect(ok.text).toContain("## Goal");
    expect(seen[0]).not.toHaveProperty("toolChoice");
    expect(seen[0]).toMatchObject({ sessionId: "s1", purpose: "summary", cacheRetention: "short" });
    await expect(
      completeByContinuation(
        options(reply([{ type: "toolCall", id: "c", name: "read", arguments: {} }])),
        input,
      ),
    ).rejects.toMatchObject({ code: "compaction_failed" });
  });
});

describe("续写位置（anchors）", () => {
  const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
  const assistant = (text: string, stopReason: AssistantMessage["stopReason"] = "stop") =>
    ({
      role: "assistant",
      content: [{ type: "text", text }],
      api: "fake",
      provider: "fake",
      model: "echo",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      stopReason,
      timestamp: 0,
    }) satisfies AssistantMessage;

  it("countLlmMessages 跳过 system 与失败的助手消息（连同其工具结果）；excerptOf 取首行", () => {
    const failed: AssistantMessage = {
      ...assistant("", "error"),
      content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
    };
    expect(
      countLlmMessages([
        { role: "system", sections: { a: "s" }, timestamp: 0 },
        user("a"),
        failed,
        {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "read",
          content: "x",
          isError: true,
          timestamp: 0,
        },
        assistant("b"),
      ]),
    ).toBe(2);
    expect(excerptOf(user("line one\nline two"))).toBe("line one");
    expect(excerptOf(user("x".repeat(200)))).toHaveLength(80);
    expect(excerptOf(assistant("hello"))).toBe("hello");
  });

  it("split turn：historyEnd = 回合起点之前的条数，keptStart = 保留区之前的条数", () => {
    const items: ContextItem[] = [
      user("u1 " + "a".repeat(400)),
      assistant("a1 " + "b".repeat(400)),
      user("u2 start of turn"),
      assistant("a2 " + "c".repeat(400)),
      assistant("a3 kept " + "d".repeat(200)),
    ].map((message, i) => ({
      entry: { id: `e${i}`, parentId: null, timestamp: "", type: "message", message } as never,
      message,
    }));
    const plan = prepareCompaction(
      { items, messages: items.map((i) => i.message), compaction: undefined },
      20,
    )!;
    expect(plan.cut.isSplitTurn).toBe(true);
    expect(plan.anchors).toEqual({
      historyEnd: 2,
      keptStart: 4,
      historyExcerpt: "u2 start of turn",
      keptExcerpt: expect.stringMatching(/^a3 kept/),
    });
  });
});
