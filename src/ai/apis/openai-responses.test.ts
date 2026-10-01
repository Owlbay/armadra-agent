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
import { openAIResponsesApi, mapResponsesStatus } from "./openai-responses.js";
import { parseReasoningItem } from "./openai-responses-request.js";

const API = "openai-responses";

function model(provider: string, id: string, extra: Partial<Model> = {}): Model {
  return {
    id,
    name: id,
    provider,
    api: API,
    baseUrl: provider === "xai" ? "https://api.x.ai/v1" : "https://api.openai.com/v1",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 272_000,
    maxTokens: 128_000,
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
    thinkingLevelMap: { off: "none", minimal: null, xhigh: "xhigh" },
    ...extra,
  };
}

const gpt = model("openai", "gpt-5.5");

afterEach(() => vi.unstubAllGlobals());

const opts = (extra: Partial<StreamOptions> = {}): StreamOptions => ({
  signal: new AbortController().signal,
  apiKey: "sk-test",
  ...extra,
});

describe("openai-responses：SSE 样本黄金", () => {
  it("text：message item → 文本块，textSignature 记 item id；usage", async () => {
    const run = await runFixture(openAIResponsesApi, API, "text", gpt);
    expect(run.terminal).toMatchObject({ type: "done", reason: "stop" });
    expect(run.final.content).toEqual([
      { type: "text", text: "Hello, 世界 👋", textSignature: '{"v":1,"id":"msg_text1"}' },
    ]);
    expect(run.final.responseId).toBe("resp_text1");
    expect(run.final.rawStopReason).toBe("completed");
    expect(run.final.usage).toMatchObject({ input: 30, output: 6, cacheRead: 0, totalTokens: 36 });
  });

  it("reasoning-summary：两段 summary 空行相接；思考块签名是完整 reasoning item；phase 记入文本签名", async () => {
    const run = await runFixture(openAIResponsesApi, API, "reasoning-summary", gpt);
    const [thinking, text] = run.final.content;
    expect(thinking).toMatchObject({
      type: "thinking",
      thinking: "**Comparing**\n\n9.11 vs 9.9.\n\n0.90 > 0.11, so 9.9 wins.",
    });
    expect(
      parseReasoningItem(thinking?.type === "thinking" ? thinking.thinkingSignature : ""),
    ).toMatchObject({ id: "rs_think1", encrypted_content: "gAAAAABpZW5jcnlwdGVkLXRoaW5r" });
    expect(text).toEqual({
      type: "text",
      text: "9.9 is larger.",
      textSignature: '{"v":1,"id":"msg_think1","phase":"final_answer"}',
    });
    expect(run.final.usage).toMatchObject({
      input: 276,
      cacheRead: 1024,
      output: 120,
      reasoning: 96,
    });
  });

  it("reasoning-encrypted：无 summary 的推理也成块（空文本 + 加密 item），随后工具调用", async () => {
    const run = await runFixture(openAIResponsesApi, API, "reasoning-encrypted", gpt);
    expect(run.terminal).toMatchObject({ type: "done", reason: "toolUse" });
    expect(run.final.content).toEqual([
      {
        type: "thinking",
        thinking: "",
        thinkingSignature:
          '{"id":"rs_enc1","type":"reasoning","summary":[],"encrypted_content":"gAAAAABpZW5jLW9ubHk="}',
      },
      {
        type: "toolCall",
        id: "call_enc1",
        name: "ls",
        arguments: { dir: "src" },
        thoughtSignature: "fc_enc1",
      },
    ]);
  });

  it("tool-single：参数跨块拼接；id 是 call_id，fc id 记在 thoughtSignature", async () => {
    const run = await runFixture(openAIResponsesApi, API, "tool-single", gpt);
    expect(run.terminal).toMatchObject({ type: "done", reason: "toolUse" });
    expect(run.final.content).toEqual([
      {
        type: "toolCall",
        id: "call_DdmNjhvTr1LwHJ8bCzKAxqPa",
        name: "read",
        arguments: { path: "README.md" },
        thoughtSignature: "fc_tool1",
      },
    ]);
  });

  it("tool-multi：按 output_index 交错拼接；done 的全文补齐未流出的尾巴", async () => {
    const run = await runFixture(openAIResponsesApi, API, "tool-multi", gpt);
    expect(run.final.content).toEqual([
      {
        type: "text",
        text: "Checking both files.",
        textSignature: '{"v":1,"id":"msg_multi1","phase":"commentary"}',
      },
      {
        type: "toolCall",
        id: "call_a",
        name: "read",
        arguments: { path: "a.ts" },
        thoughtSignature: "fc_a",
      },
      {
        type: "toolCall",
        id: "call_b",
        name: "read",
        arguments: { path: "b.ts" },
        thoughtSignature: "fc_b",
      },
    ]);
    expect(run.final.usage).toMatchObject({ input: 256, cacheRead: 256 });
  });

  it("length：incomplete + max_output_tokens → length", async () => {
    const run = await runFixture(openAIResponsesApi, API, "length", gpt);
    expect(run.terminal).toMatchObject({ type: "done", reason: "length" });
    expect(run.final.rawStopReason).toBe("max_output_tokens");
    expect(run.final.content).toEqual([
      { type: "text", text: "Once upon a time, a lighthouse keeper named" },
    ]);
  });

  it("usage-cache：input_tokens_details.cached_tokens → cacheRead，成本按缓存价", async () => {
    const run = await runFixture(openAIResponsesApi, API, "usage-cache", gpt);
    expect(run.final.usage).toMatchObject({ input: 808, cacheRead: 8192, output: 4 });
    expect(run.final.usage.cost?.cacheRead).toBeCloseTo((8192 * 0.5) / 1e6);
  });

  it("rate-limit-429：error 文案以 429 开头，不算溢出", async () => {
    const run = await runFixture(openAIResponsesApi, API, "rate-limit-429", gpt);
    expect(run.events).toHaveLength(1);
    expect(run.final.errorMessage).toMatch(/^429 tokens: Rate limit reached/);
    expect(isContextOverflow(run.final)).toBe(false);
  });

  it("overflow-400：context_length_exceeded 识别为溢出", async () => {
    const run = await runFixture(openAIResponsesApi, API, "overflow-400", gpt);
    expect(run.final.errorMessage).toMatch(/^400 invalid_request_error: Your input exceeds/);
    expect(isContextOverflow(run.final)).toBe(true);
  });

  it("failed-overflow：流内 response.failed（context_length_exceeded）也识别为溢出", async () => {
    const run = await runFixture(openAIResponsesApi, API, "failed-overflow", gpt);
    expect(run.final.errorMessage).toMatch(/^context_length_exceeded: Your input exceeds/);
    expect(run.final.rawStopReason).toBe("failed");
    expect(isContextOverflow(run.final)).toBe(true);
  });

  it("disconnect：无终止事件 → 断流错误，块已关闭", async () => {
    const run = await runFixture(openAIResponsesApi, API, "disconnect", gpt);
    expect(run.final.errorMessage).toBe("Stream ended before completion");
    expect(run.final.content[1]).toMatchObject({ arguments: { path: "x.md", content: "par" } });
  });

  it("stream-error：error 事件 → code: message", async () => {
    const run = await runFixture(openAIResponsesApi, API, "stream-error", gpt);
    expect(run.final.errorMessage).toBe(
      "server_error: The server had an error while processing your request.",
    );
    expect(run.final.content).toEqual([{ type: "text", text: "Start" }]);
  });

  it("content-filter：其它 incomplete 原因 → error", async () => {
    const run = await runFixture(openAIResponsesApi, API, "content-filter", gpt);
    expect(run.final.errorMessage).toBe("Response incomplete: content_filter");
    expect(run.final.rawStopReason).toBe("content_filter");
  });

  it("mapResponsesStatus", () => {
    expect(mapResponsesStatus("completed")).toEqual({ reason: "stop" });
    expect(mapResponsesStatus("incomplete", "max_output_tokens")).toEqual({ reason: "length" });
    expect(mapResponsesStatus("cancelled").reason).toBe("error");
  });
});

/** 上一轮（reasoning-encrypted 样本）原样回放。 */
const REPLAY_CONTEXT: TranscriptContext = {
  messages: [
    {
      role: "system",
      sections: { preamble: "Be brief." },
      toolsAdded: [
        {
          name: "ls",
          description: "List",
          parameters: {
            type: "object",
            properties: { dir: { type: "string" } },
            required: ["dir"],
            additionalProperties: false,
          },
        },
      ],
      timestamp: 0,
    },
    { role: "user", content: "list src", timestamp: 1 },
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "",
          thinkingSignature:
            '{"id":"rs_enc1","type":"reasoning","summary":[],"encrypted_content":"gAAAAABpZW5jLW9ubHk="}',
        },
        {
          type: "toolCall",
          id: "call_enc1",
          name: "ls",
          arguments: { dir: "src" },
          thoughtSignature: "fc_enc1",
        },
      ],
      api: API,
      provider: "openai",
      model: "gpt-5.5",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "call_enc1",
      toolName: "ls",
      content: "a.ts\nb.ts",
      isError: false,
      timestamp: 3,
    },
  ],
};

describe("openai-responses：请求", () => {
  it("请求体快照（onPayload）：加密 reasoning item 回放、function_call 带 fc id、prompt_cache_key", async () => {
    let payload: unknown;
    const captured = stubFetchWithFixture(loadFixture(API, "text"));
    await openAIResponsesApi
      .stream(
        gpt,
        REPLAY_CONTEXT,
        opts({
          thinkingLevel: "medium",
          sessionId: "sess-42",
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

  it("URL、Bearer 鉴权、onPayload 替换、思考级别记录；缺 key 同步抛", async () => {
    const captured = stubFetchWithFixture(loadFixture(API, "text"));
    const final = await openAIResponsesApi
      .stream(
        model("xai", "grok-4.7"),
        BASIC_CONTEXT,
        opts({ thinkingLevel: "high", onPayload: () => ({ replaced: true }) }),
      )
      .result();
    expect(captured[0]?.url).toBe("https://api.x.ai/v1/responses");
    expect(captured[0]?.headers["authorization"]).toBe("Bearer sk-test");
    expect(captured[0]?.body).toEqual({ replaced: true });
    expect(final).toMatchObject({ thinkingLevel: "high", providerThinkingLevel: "high" });
    let thrown: unknown;
    try {
      openAIResponsesApi.stream(gpt, BASIC_CONTEXT, { signal: new AbortController().signal });
    } catch (error) {
      thrown = error;
    }
    expect(isAmaError(thrown) && thrown.code).toBe("no_api_key");
  });

  it("流式中途 abort → error{aborted}", async () => {
    stubFetchHanging(
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"rs_1","type":"reasoning","summary":[]}}\n\nevent: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","output_index":0,"item_id":"rs_1","summary_index":0,"delta":"hmm"}\n\n',
    );
    const controller = new AbortController();
    const stream = openAIResponsesApi.stream(
      gpt,
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

  it("缺 output_item.added 时由 output_item.done 补开块；缺 output_index 时按 item_id 对应", async () => {
    const body = [
      { type: "response.created", response: { id: "r1" } },
      { type: "response.output_item.added", item: { id: "msg_1", type: "message", content: [] } },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "Hi" },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          id: "fc_9",
          type: "function_call",
          call_id: "call_9",
          name: "ls",
          arguments: '{"dir":"."}',
        },
      },
      { type: "response.completed", response: { id: "r1", status: "completed" } },
    ]
      .map((d) => `data: ${JSON.stringify(d)}\n\n`)
      .join("");
    stubFetchWithFixture({ status: 200, headers: {}, body, errorAfterBody: false });
    const stream = openAIResponsesApi.stream(gpt, BASIC_CONTEXT, opts());
    const events = [];
    for await (const event of stream) events.push(event);
    const final = await stream.result();
    expect(assertStreamContract(events, final)).toMatchObject({ type: "done", reason: "toolUse" });
    expect(final.content).toEqual([
      { type: "text", text: "Hi" },
      {
        type: "toolCall",
        id: "call_9",
        name: "ls",
        arguments: { dir: "." },
        thoughtSignature: "fc_9",
      },
    ]);
  });
});
