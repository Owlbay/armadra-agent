import { afterEach, describe, expect, it, vi } from "vitest";
import { isAmaError } from "../../errors.js";
import { isContextOverflow } from "../overflow.js";
import type { Model, StreamOptions, TranscriptContext } from "../types.js";
import { BASIC_CONTEXT, checkGolden, runFixture } from "../../../test/ai/golden.js";
import {
  loadFixture,
  stubFetchHanging,
  stubFetchWithFixture,
} from "../../../test/ai/fixture-fetch.js";
import { assertStreamContract } from "../../../test/ai/contract.js";
import { googleGenerativeAiApi, mapGoogleFinishReason } from "./google-generative-ai.js";

const API = "google-generative-ai";

function gemini(id: string, extra: Partial<Model> = {}): Model {
  return {
    id,
    name: id,
    provider: "google",
    api: API,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high" },
    authHeader: "x-goog-api-key",
    ...extra,
  };
}

const pro = gemini("gemini-3.1-pro-preview");

afterEach(() => vi.unstubAllGlobals());

const opts = (extra: Partial<StreamOptions> = {}): StreamOptions => ({
  signal: new AbortController().signal,
  apiKey: "g-test",
  ...extra,
});

describe("google-generative-ai：SSE 样本黄金", () => {
  it("text：相邻文本 part 并入一块；空文本 part 不开块；usage", async () => {
    const run = await runFixture(googleGenerativeAiApi, API, "text", pro);
    expect(run.terminal).toMatchObject({ type: "done", reason: "stop" });
    expect(run.final.content).toEqual([{ type: "text", text: "Hello, 世界 👋" }]);
    expect(run.final.responseId).toBe("rsp-text1");
    expect(run.final.rawStopReason).toBe("STOP");
    expect(run.final.usage).toMatchObject({ input: 12, output: 5, cacheRead: 0, totalTokens: 17 });
  });

  it("thinking：thought part → 思考块；末尾空文本 part 的签名挂到文本块；thoughtsTokenCount 计入输出", async () => {
    const run = await runFixture(googleGenerativeAiApi, API, "thinking", pro);
    expect(run.final.content).toEqual([
      {
        type: "thinking",
        thinking: "**Comparing numbers**\n\n9.11 vs 9.9: 0.90 > 0.11, so 9.9 is larger.",
      },
      { type: "text", text: "9.9 is larger.", textSignature: "Q2lRQ0FkSE1zaWduYXR1cmUx" },
    ]);
    expect(run.final.usage).toMatchObject({ input: 20, output: 54, reasoning: 48 });
  });

  it("tool-single：functionCall 整块到达，缺 id 时按 responseId 生成，签名记在工具调用上", async () => {
    const run = await runFixture(googleGenerativeAiApi, API, "tool-single", pro);
    expect(run.terminal).toMatchObject({ type: "done", reason: "toolUse" });
    expect(run.final.rawStopReason).toBe("STOP");
    expect(run.final.content).toEqual([
      {
        type: "toolCall",
        id: "call_rsp-tool1_0",
        name: "read",
        arguments: { path: "README.md" },
        thoughtSignature: "Q2lRQ0FkSE10b29sc2ln",
      },
    ]);
    expect(run.events.map((e) => e.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
  });

  it("tool-multi：文本块在工具前关闭；并行两个调用，给了 id 的原样用", async () => {
    const run = await runFixture(googleGenerativeAiApi, API, "tool-multi", pro);
    expect(run.final.content).toEqual([
      { type: "text", text: "Checking both files." },
      {
        type: "toolCall",
        id: "call_rsp-multi1_1",
        name: "read",
        arguments: { path: "a.ts" },
        thoughtSignature: "c2lnLW11bHRp",
      },
      { type: "toolCall", id: "fc-b", name: "read", arguments: { path: "b.ts" } },
    ]);
  });

  it("length：MAX_TOKENS → length", async () => {
    const run = await runFixture(googleGenerativeAiApi, API, "length", pro);
    expect(run.terminal).toMatchObject({ type: "done", reason: "length" });
    expect(run.final.rawStopReason).toBe("MAX_TOKENS");
  });

  it("usage-cache：cachedContentTokenCount → cacheRead，input 去掉缓存部分，成本按缓存价", async () => {
    const run = await runFixture(googleGenerativeAiApi, API, "usage-cache", pro);
    expect(run.final.usage).toMatchObject({
      input: 1104,
      cacheRead: 4096,
      output: 4,
      totalTokens: 5204,
    });
    expect(run.final.usage.cost?.cacheRead).toBeCloseTo((4096 * 0.2) / 1e6);
  });

  it("rate-limit-429：错误体重排为 status: message，不算溢出", async () => {
    const run = await runFixture(googleGenerativeAiApi, API, "rate-limit-429", pro);
    expect(run.events).toHaveLength(1);
    expect(run.final.errorMessage).toBe(
      "429 RESOURCE_EXHAUSTED: You exceeded your current quota, please check your plan and billing details.",
    );
    expect(isContextOverflow(run.final)).toBe(false);
  });

  it("overflow-400：识别为上下文溢出", async () => {
    const run = await runFixture(googleGenerativeAiApi, API, "overflow-400", pro);
    expect(run.final.errorMessage).toMatch(/^400 INVALID_ARGUMENT: The input token count/);
    expect(isContextOverflow(run.final)).toBe(true);
  });

  it("disconnect：没有 finishReason → 断流错误，已开块关闭", async () => {
    const run = await runFixture(googleGenerativeAiApi, API, "disconnect", pro);
    expect(run.final.errorMessage).toBe("Stream ended before completion");
    expect(run.final.content.map((b) => b.type)).toEqual(["thinking", "text"]);
  });

  it("safety：SAFETY 等非正常结束 → error，保留原始 finishReason", async () => {
    const run = await runFixture(googleGenerativeAiApi, API, "safety", pro);
    expect(run.terminal).toMatchObject({ type: "error", reason: "error" });
    expect(run.final.errorMessage).toBe("Provider finish reason: SAFETY");
    expect(run.final.rawStopReason).toBe("SAFETY");
  });

  it("stream-error：流内 error 对象", async () => {
    const run = await runFixture(googleGenerativeAiApi, API, "stream-error", pro);
    expect(run.final.errorMessage).toBe(
      "UNAVAILABLE: The model is overloaded. Please try again later.",
    );
    expect(run.final.content).toEqual([{ type: "text", text: "Start" }]);
  });

  it("mapGoogleFinishReason", () => {
    expect(mapGoogleFinishReason("STOP")).toEqual({ reason: "stop" });
    expect(mapGoogleFinishReason("MAX_TOKENS")).toEqual({ reason: "length" });
    expect(mapGoogleFinishReason("MALFORMED_FUNCTION_CALL").reason).toBe("error");
  });
});

const REPLAY_CONTEXT: TranscriptContext = {
  messages: [
    {
      role: "system",
      sections: { preamble: "Be brief." },
      toolsAdded: [
        {
          name: "read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
      ],
      timestamp: 0,
    },
    { role: "user", content: "read README", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "need file", thinkingSignature: "c2lnLXRoaW5r" },
        {
          type: "toolCall",
          id: "call_rsp-tool1_0",
          name: "read",
          arguments: { path: "README.md" },
          thoughtSignature: "Q2lRQ0FkSE10b29sc2ln",
        },
      ],
      api: API,
      provider: "google",
      model: "gemini-3.1-pro-preview",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "call_rsp-tool1_0",
      toolName: "read",
      content: "# Title",
      isError: false,
      timestamp: 3,
    },
  ],
};

describe("google-generative-ai：请求", () => {
  it("请求体快照（onPayload）：thoughtSignature 回放、functionResponse、thinkingConfig", async () => {
    let payload: unknown;
    const captured = stubFetchWithFixture(loadFixture(API, "text"));
    await googleGenerativeAiApi
      .stream(
        pro,
        REPLAY_CONTEXT,
        opts({
          thinkingLevel: "high",
          sessionId: "s1",
          onPayload: (body) => {
            payload = body;
            return undefined;
          },
        }),
      )
      .result();
    checkGolden(API, "request-replay", payload);
    expect(captured[0]?.body).toEqual(payload);
  });

  it("URL、鉴权头（x-goog-api-key）、onPayload 替换；结果记录思考级别", async () => {
    const captured = stubFetchWithFixture(loadFixture(API, "text"));
    const final = await googleGenerativeAiApi
      .stream(
        gemini("models/gemini-2.5-flash", { thinkingLevelMap: {} }),
        BASIC_CONTEXT,
        opts({ thinkingLevel: "medium", onPayload: () => ({ replaced: true }) }),
      )
      .result();
    expect(captured[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
    );
    expect(captured[0]?.headers["x-goog-api-key"]).toBe("g-test");
    expect(captured[0]?.headers["authorization"]).toBeUndefined();
    expect(captured[0]?.body).toEqual({ replaced: true });
    expect(final).toMatchObject({ thinkingLevel: "medium", providerThinkingLevel: "8192" });
    let thrown: unknown;
    try {
      googleGenerativeAiApi.stream(pro, BASIC_CONTEXT, { signal: new AbortController().signal });
    } catch (error) {
      thrown = error;
    }
    expect(isAmaError(thrown) && thrown.code).toBe("no_api_key");
  });

  it("流式中途 abort → error{aborted}", async () => {
    stubFetchHanging(
      'data: {"candidates":[{"content":{"parts":[{"text":"hmm","thought":true}],"role":"model"}}],"responseId":"r"}\n\n',
    );
    const controller = new AbortController();
    const stream = googleGenerativeAiApi.stream(
      pro,
      BASIC_CONTEXT,
      opts({ signal: controller.signal }),
    );
    const events = [];
    for await (const event of stream) {
      events.push(event);
      if (event.type === "thinking_delta") controller.abort();
    }
    const final = await stream.result();
    expect(assertStreamContract(events, final)).toMatchObject({ type: "error", reason: "aborted" });
  });

  it("promptFeedback.blockReason 且无候选 → error", async () => {
    stubFetchWithFixture({
      status: 200,
      headers: {},
      body: 'data: {"promptFeedback":{"blockReason":"PROHIBITED_CONTENT"},"responseId":"b"}\n\n',
      errorAfterBody: false,
    });
    const final = await googleGenerativeAiApi.stream(pro, BASIC_CONTEXT, opts()).result();
    expect(final.stopReason).toBe("error");
    expect(final.errorMessage).toBe("Prompt blocked: PROHIBITED_CONTENT");
  });
});
