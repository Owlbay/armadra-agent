import { afterEach, describe, expect, it, vi } from "vitest";
import { isAmaError } from "../../errors.js";
import { isContextOverflow } from "../overflow.js";
import type { AssistantMessage, Model, StreamOptions, TranscriptContext } from "../types.js";
import { BASIC_CONTEXT, runFixture } from "../../../test/ai/golden.js";
import {
  loadFixture,
  stubFetchHanging,
  stubFetchWithFixture,
} from "../../../test/ai/fixture-fetch.js";
import { assertStreamContract } from "../../../test/ai/contract.js";
import { openAICompletionsApi } from "./openai-completions.js";
import { buildOpenAIRequest, isStrictCompatible } from "./openai-request.js";

const API = "openai-completions";

function makeModel(provider: string, id: string, extra: Partial<Model> = {}): Model {
  const baseUrls: Record<string, string> = {
    openai: "https://api.openai.com/v1",
    deepseek: "https://api.deepseek.com",
    moonshot: "https://api.moonshot.cn/v1",
    zhipu: "https://open.bigmodel.cn/api/paas/v4",
    dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    openrouter: "https://openrouter.ai/api/v1",
    groq: "https://api.groq.com/openai/v1",
    mistral: "https://api.mistral.ai/v1",
    ollama: "http://127.0.0.1:11434/v1",
  };
  return {
    id,
    name: id,
    provider,
    api: API,
    baseUrl: baseUrls[provider] ?? "https://example.test/v1",
    input: ["text"],
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 8192,
    cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 },
    ...extra,
  };
}

const openai = makeModel("openai", "gpt-5.4", { reasoning: true, input: ["text", "image"] });
const deepseek = makeModel("deepseek", "deepseek-v4-pro", { reasoning: true });

afterEach(() => vi.unstubAllGlobals());

const opts = (extra: Partial<StreamOptions> = {}): StreamOptions => ({
  signal: new AbortController().signal,
  apiKey: "sk-test",
  ...extra,
});

describe("openai-completions：SSE 样本黄金", () => {
  it("text：usage 的 prompt_tokens_details.cached_tokens（OpenAI）", async () => {
    const run = await runFixture(openAICompletionsApi, API, "text", openai);
    expect(run.terminal).toMatchObject({ type: "done", reason: "stop" });
    expect(run.final.content).toEqual([{ type: "text", text: "Hello, 世界 👋" }]);
    expect(run.final.responseId).toBe("chatcmpl-text1");
    expect(run.final.usage).toMatchObject({ input: 176, output: 9, cacheRead: 1024, reasoning: 0 });
    expect(run.final.usage.totalTokens).toBe(1209);
  });

  it("reasoning-deepseek：reasoning_content → 思考块（记字段名），prompt_cache_hit_tokens", async () => {
    const run = await runFixture(openAICompletionsApi, API, "reasoning-deepseek", deepseek);
    expect(run.final.content).toEqual([
      {
        type: "thinking",
        thinking: "用户问 9.11 和 9.9哪个大。9.9 更大。",
        thinkingSignature: "reasoning_content",
      },
      { type: "text", text: "9.9 更大。" },
    ]);
    expect(run.final.usage).toMatchObject({ input: 32, cacheRead: 768, output: 60, reasoning: 40 });
  });

  it("tool-single：首块带 id/name，参数跨块拼接", async () => {
    const run = await runFixture(openAICompletionsApi, API, "tool-single", openai);
    expect(run.terminal).toMatchObject({ type: "done", reason: "toolUse" });
    expect(run.final.content).toEqual([
      {
        type: "toolCall",
        id: "call_DdmNjhvTr1LwHJ8bCzKAxqPa",
        name: "read",
        arguments: { path: "README.md" },
      },
    ]);
  });

  it("tool-multi：按 index 交错拼接；先有的文本块在工具开始时关闭", async () => {
    const run = await runFixture(
      openAICompletionsApi,
      API,
      "tool-multi",
      makeModel("zhipu", "glm-5.3"),
    );
    expect(run.final.content).toEqual([
      { type: "text", text: "Checking both files." },
      { type: "toolCall", id: "call_a", name: "read", arguments: { path: "a.ts" } },
      { type: "toolCall", id: "call_b", name: "read", arguments: { path: "b.ts" } },
    ]);
    const textEnd = run.events.findIndex((e) => e.type === "text_end");
    const firstTool = run.events.findIndex((e) => e.type === "toolcall_start");
    expect(textEnd).toBeLessThan(firstTool);
    expect(run.final.usage).toMatchObject({ input: 256, cacheRead: 256 });
  });

  it("tool-noindex：缺 index 时按 id 拼接", async () => {
    const run = await runFixture(
      openAICompletionsApi,
      API,
      "tool-noindex",
      makeModel("custom", "local-model"),
    );
    expect(run.final.content).toEqual([
      { type: "toolCall", id: "call_x1", name: "glob", arguments: { pattern: "src/**/*.ts" } },
      { type: "toolCall", id: "call_x2", name: "ls", arguments: {} },
    ]);
  });

  it("stop-with-tools：finish=stop 但有工具调用 → toolUse；reasoning 字段", async () => {
    const run = await runFixture(
      openAICompletionsApi,
      API,
      "stop-with-tools",
      makeModel("ollama", "qwen3:8b"),
    );
    expect(run.terminal).toMatchObject({ type: "done", reason: "toolUse" });
    expect(run.final.content[0]).toMatchObject({
      type: "thinking",
      thinkingSignature: "reasoning",
    });
    expect(run.final.rawStopReason).toBe("stop");
  });

  it("length：finish=length；Moonshot 的 choices[0].usage 与顶层 cached_tokens", async () => {
    const run = await runFixture(
      openAICompletionsApi,
      API,
      "length",
      makeModel("moonshot", "kimi-k2.6"),
    );
    expect(run.terminal).toMatchObject({ type: "done", reason: "length" });
    expect(run.final.usage).toMatchObject({ input: 36, cacheRead: 64, output: 32 });
  });

  it("usage-moonshot：choices[0].usage + cached_tokens", async () => {
    const run = await runFixture(
      openAICompletionsApi,
      API,
      "usage-moonshot",
      makeModel("moonshot", "kimi-k2.7-code"),
    );
    expect(run.final.usage).toMatchObject({ input: 904, cacheRead: 4096, output: 12 });
    expect(run.final.content.map((b) => b.type)).toEqual(["thinking", "text"]);
  });

  it("usage-groq：x_groq.usage", async () => {
    const run = await runFixture(
      openAICompletionsApi,
      API,
      "usage-groq",
      makeModel("groq", "llama-3.3-70b-versatile"),
    );
    expect(run.final.usage).toMatchObject({ input: 48, output: 4, cacheRead: 0, totalTokens: 52 });
  });

  it("rate-limit-429：error 文案以 429 开头，不算溢出", async () => {
    const run = await runFixture(openAICompletionsApi, API, "rate-limit-429", openai);
    expect(run.events).toHaveLength(1);
    expect(run.final.errorMessage).toMatch(/^429 tokens: Rate limit reached/);
    expect(isContextOverflow(run.final)).toBe(false);
  });

  it("overflow-400：识别为上下文溢出", async () => {
    const run = await runFixture(openAICompletionsApi, API, "overflow-400", openai);
    expect(run.final.errorMessage).toMatch(
      /^400 invalid_request_error: This model's maximum context length/,
    );
    expect(isContextOverflow(run.final)).toBe(true);
  });

  it("stream-error：流内 error 对象（OpenRouter），附带 metadata.raw", async () => {
    const run = await runFixture(
      openAICompletionsApi,
      API,
      "stream-error",
      makeModel("openrouter", "anthropic/claude-sonnet-5.5"),
    );
    expect(run.terminal.type).toBe("error");
    expect(run.final.errorMessage).toBe(
      "502: Provider returned error\noverloaded_error: Overloaded",
    );
    expect(run.final.content).toEqual([{ type: "text", text: "Start" }]);
  });

  it("disconnect：既无 finish_reason 也无 [DONE] → 断流错误", async () => {
    const run = await runFixture(
      openAICompletionsApi,
      API,
      "disconnect",
      makeModel("dashscope", "qwen3.8-max"),
    );
    expect(run.final.errorMessage).toBe("Stream ended before completion");
    expect(run.final.content[1]).toMatchObject({ arguments: { path: "x.md", content: "par" } });
  });

  it("supportsFinishReason=false：忽略 finish_reason，按内容推断", async () => {
    const model = makeModel("custom", "m", { compat: { supportsFinishReason: false } });
    const run = await runFixture(
      openAICompletionsApi,
      API,
      "length",
      model,
      {},
      BASIC_CONTEXT,
      null,
    );
    expect(run.terminal).toMatchObject({ type: "done", reason: "stop" });
  });
});

function assistant(
  content: AssistantMessage["content"],
  extra: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: API,
    provider: "deepseek",
    model: "deepseek-v4-pro",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "stop",
    timestamp: 0,
    ...extra,
  };
}

const TOOL_CONTEXT: TranscriptContext = {
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
        {
          name: "ls",
          description: "List",
          parameters: { type: "object", properties: { dir: { type: "string" } } },
        },
      ],
      timestamp: 0,
    },
    { role: "user", content: "read a", timestamp: 1 },
    assistant([
      { type: "thinking", thinking: "need file", thinkingSignature: "reasoning_content" },
      { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a" } },
    ]),
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [
        { type: "text", text: "contents" },
        { type: "image", data: "QUJD", mimeType: "image/png" },
      ],
      isError: false,
      timestamp: 3,
    },
    { role: "user", content: "thanks", timestamp: 4 },
  ],
};

type Msg = Record<string, unknown>;

describe("openai-completions：请求体与 compat 开关", () => {
  it("OpenAI 官方：developer 角色、max_completion_tokens、store、stream_options、strict、prompt_cache_key", () => {
    const { body } = buildOpenAIRequest(
      openai,
      TOOL_CONTEXT,
      opts({ sessionId: "sess-1", thinkingLevel: "high" }),
    );
    const messages = body["messages"] as Msg[];
    expect(messages[0]).toEqual({ role: "developer", content: "Be brief." });
    expect(body["max_completion_tokens"]).toBe(8192);
    expect(body["max_tokens"]).toBeUndefined();
    expect(body["store"]).toBe(false);
    expect(body["stream_options"]).toEqual({ include_usage: true });
    expect(body["prompt_cache_key"]).toBe("sess-1");
    expect(body["reasoning_effort"]).toBe("high");
    const tools = body["tools"] as { function: Msg }[];
    expect(tools[0]?.function["strict"]).toBe(true);
    expect(tools[1]?.function["strict"]).toBeUndefined(); // 非严格 schema 不发 strict
    // 工具结果的图片在模型支持图片时作为随后的 user 消息附上
    const imageMsg = messages.find(
      (m) => Array.isArray(m["content"]) && JSON.stringify(m).includes("image_url"),
    );
    expect(imageMsg?.["role"]).toBe("user");
  });

  it("DeepSeek：max_tokens、system 角色、thinking.type、推理模型回放 reasoning_content", () => {
    const { body } = buildOpenAIRequest(deepseek, TOOL_CONTEXT, opts({ thinkingLevel: "high" }));
    const messages = body["messages"] as Msg[];
    expect(messages[0]?.["role"]).toBe("system");
    expect(body["max_tokens"]).toBe(8192);
    expect(body["store"]).toBeUndefined();
    expect(body["prompt_cache_key"]).toBeUndefined();
    expect(body["thinking"]).toEqual({ type: "enabled" });
    expect(body["reasoning_effort"]).toBe("high");
    const asst = messages.find((m) => m["role"] === "assistant");
    expect(asst?.["reasoning_content"]).toBe("need file");
    expect(asst?.["content"]).toBeNull();
    expect(asst?.["tool_calls"]).toEqual([
      { id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } },
    ]);
    // 无思考的推理助手消息也补空 reasoning_content
    const ctx: TranscriptContext = { messages: [assistant([{ type: "text", text: "plain" }])] };
    const second = buildOpenAIRequest(deepseek, ctx, opts());
    expect((second.body["messages"] as Msg[])[0]).toEqual({
      role: "assistant",
      content: "plain",
      reasoning_content: "",
    });
    expect(second.body["thinking"]).toEqual({ type: "disabled" });
    // 模型不收图片：工具结果图片不附加
    expect(JSON.stringify(body)).not.toContain("image_url");
  });

  it("thinkingFormat：zai / qwen（预算字段）/ openrouter / none", () => {
    const zai = buildOpenAIRequest(
      makeModel("zhipu", "glm-5.3", { reasoning: true }),
      BASIC_CONTEXT,
      opts({ thinkingLevel: "low" }),
    );
    expect(zai.body["thinking"]).toEqual({ type: "enabled" });
    expect(zai.body["reasoning_effort"]).toBeUndefined();
    const qwen = buildOpenAIRequest(
      makeModel("dashscope", "qwen3.8-max", { reasoning: true }),
      BASIC_CONTEXT,
      opts({ thinkingLevel: "medium", maxTokens: 20_000 }),
    );
    expect(qwen.body["enable_thinking"]).toBe(true);
    expect(qwen.body["thinking_budget"]).toBe(8192);
    expect(qwen.providerThinkingLevel).toBe("8192");
    const qwenOff = buildOpenAIRequest(
      makeModel("dashscope", "q", { reasoning: true }),
      BASIC_CONTEXT,
      opts(),
    );
    expect(qwenOff.body["enable_thinking"]).toBe(false);
    expect(qwenOff.body["thinking_budget"]).toBeUndefined();
    const router = buildOpenAIRequest(
      makeModel("openrouter", "openai/gpt-6-sol", { reasoning: true }),
      BASIC_CONTEXT,
      opts({ thinkingLevel: "medium" }),
    );
    expect(router.body["reasoning"]).toEqual({ effort: "medium" });
    const routerOff = buildOpenAIRequest(
      makeModel("openrouter", "x/y", { reasoning: true }),
      BASIC_CONTEXT,
      opts(),
    );
    expect(routerOff.body["reasoning"]).toEqual({ effort: "none" });
    const mistral = buildOpenAIRequest(
      makeModel("mistral", "magistral", { reasoning: true }),
      BASIC_CONTEXT,
      opts({ thinkingLevel: "high" }),
    );
    expect(JSON.stringify(mistral.body)).not.toMatch(/reasoning|thinking/);
  });

  it("thinkingLevelMap：映射值优先，null 级别被钳位", () => {
    const model = makeModel("openai", "o", {
      reasoning: true,
      thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: null, high: "high" },
    });
    expect(
      buildOpenAIRequest(model, BASIC_CONTEXT, opts({ thinkingLevel: "medium" })).body[
        "reasoning_effort"
      ],
    ).toBe("high");
    expect(buildOpenAIRequest(model, BASIC_CONTEXT, opts()).body["reasoning_effort"]).toBe("none");
  });

  it("Mistral：tool 消息带 name；requiresAssistantAfterToolResult 插入桥接助手消息", () => {
    const mistral = buildOpenAIRequest(
      makeModel("mistral", "mistral-large-latest"),
      TOOL_CONTEXT,
      opts(),
    );
    const tool = (mistral.body["messages"] as Msg[]).find((m) => m["role"] === "tool");
    expect(tool).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "contents\n[image omitted: the model does not accept image input]",
      name: "read",
    });
    const bridged = buildOpenAIRequest(
      makeModel("custom", "m", { compat: { requiresAssistantAfterToolResult: true } }),
      TOOL_CONTEXT,
      opts(),
    );
    const roles = (bridged.body["messages"] as Msg[]).map((m) => m["role"]);
    expect(roles).toEqual(["system", "user", "assistant", "tool", "assistant", "user"]);
  });

  it("OpenRouter anthropic/*：cache_control 打在 system、最后一个工具、最后一条 user/tool", () => {
    const model = makeModel("openrouter", "anthropic/claude-sonnet-5.5");
    const { body } = buildOpenAIRequest(model, TOOL_CONTEXT, opts());
    const messages = body["messages"] as Msg[];
    expect(messages[0]?.["content"]).toEqual([
      { type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } },
    ]);
    const tools = body["tools"] as Msg[];
    expect(tools[1]?.["cache_control"]).toEqual({ type: "ephemeral" });
    expect(tools[0]?.["cache_control"]).toBeUndefined();
    const last = messages[messages.length - 1];
    expect(last?.["content"]).toEqual([
      { type: "text", text: "thanks", cache_control: { type: "ephemeral" } },
    ]);
    const none = buildOpenAIRequest(model, TOOL_CONTEXT, opts({ cacheRetention: "none" }));
    expect(JSON.stringify(none.body)).not.toContain("cache_control");
    const other = buildOpenAIRequest(
      makeModel("openrouter", "openai/gpt-5.5"),
      TOOL_CONTEXT,
      opts(),
    );
    expect(JSON.stringify(other.body)).not.toContain("cache_control");
  });

  it("supportsMidConvoSystemMessages：后续 system 补丁按位置插回", () => {
    const context: TranscriptContext = {
      messages: [
        { role: "system", sections: { preamble: "A" }, timestamp: 0 },
        { role: "user", content: "1", timestamp: 1 },
        { role: "system", sections: { cwd: "/tmp" }, timestamp: 2 },
        { role: "user", content: "2", timestamp: 3 },
      ],
    };
    const inline = buildOpenAIRequest(makeModel("moonshot", "kimi-k3"), context, opts());
    expect((inline.body["messages"] as Msg[]).map((m) => m["role"])).toEqual([
      "system",
      "user",
      "system",
      "user",
    ]);
    expect((inline.body["messages"] as Msg[])[0]?.["content"]).toBe("A");
    const collapsed = buildOpenAIRequest(makeModel("deepseek", "d"), context, opts());
    expect((collapsed.body["messages"] as Msg[])[0]).toEqual({
      role: "system",
      content: "A\n\n/tmp",
    });
  });

  it("samplingParams 最后合并；isStrictCompatible", () => {
    const { body } = buildOpenAIRequest(
      makeModel("custom", "m", { samplingParams: { top_p: 0.9, max_tokens: 10 } }),
      BASIC_CONTEXT,
      opts(),
    );
    expect(body["top_p"]).toBe(0.9);
    expect(body["max_tokens"]).toBe(10);
    expect(
      isStrictCompatible({
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
        additionalProperties: false,
      }),
    ).toBe(true);
    expect(isStrictCompatible({ type: "object", properties: { a: { type: "string" } } })).toBe(
      false,
    );
  });

  it("鉴权头：缺省 Bearer；authHeader 自定义；缺 key 同步抛；本地服务无 key 放行", async () => {
    const captured = stubFetchWithFixture(loadFixture(API, "text"));
    await openAICompletionsApi
      .stream({ ...openai, authHeader: { header: "api-key" } }, BASIC_CONTEXT, opts())
      .result();
    await openAICompletionsApi.stream(openai, BASIC_CONTEXT, opts()).result();
    await openAICompletionsApi
      .stream({ ...makeModel("ollama", "llama3"), requiresApiKey: false }, BASIC_CONTEXT, {
        signal: new AbortController().signal,
      })
      .result();
    expect(captured[0]?.headers["api-key"]).toBe("sk-test");
    expect(captured[0]?.headers["authorization"]).toBeUndefined();
    expect(captured[1]?.headers["authorization"]).toBe("Bearer sk-test");
    expect(captured[1]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(captured[2]?.headers["authorization"]).toBeUndefined();
    expect(captured[2]?.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    let thrown: unknown;
    try {
      openAICompletionsApi.stream(openai, BASIC_CONTEXT, { signal: new AbortController().signal });
    } catch (error) {
      thrown = error;
    }
    expect(isAmaError(thrown) && thrown.code).toBe("no_api_key");
  });

  it("流式中途 abort → error{aborted}", async () => {
    stubFetchHanging(
      'data: {"id":"x","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{\\"pa"}}]}}]}\n\n',
    );
    const controller = new AbortController();
    const stream = openAICompletionsApi.stream(
      openai,
      BASIC_CONTEXT,
      opts({ signal: controller.signal }),
    );
    const events = [];
    for await (const event of stream) {
      events.push(event);
      if (event.type === "toolcall_delta") controller.abort();
    }
    const final = await stream.result();
    expect(assertStreamContract(events, final)).toMatchObject({ type: "error", reason: "aborted" });
    expect(final.content[0]).toMatchObject({ type: "toolCall", arguments: {} });
  });

  it("响应体网络错误（连接被重置）→ error", async () => {
    const fixture = loadFixture(API, "disconnect");
    fixture.errorAfterBody = true;
    stubFetchWithFixture(fixture);
    const stream = openAICompletionsApi.stream(openai, BASIC_CONTEXT, opts());
    const final = await stream.result();
    expect(final.stopReason).toBe("error");
    expect(final.errorMessage).toMatch(/terminated/);
  });
});
