import { afterEach, describe, expect, it, vi } from "vitest";
import { isAmaError } from "../../errors.js";
import { collectEvents } from "../event-stream.js";
import { isContextOverflow } from "../overflow.js";
import type { Model, StreamOptions, TranscriptContext } from "../types.js";
import { BASIC_CONTEXT, runFixture } from "../../../test/ai/golden.js";
import {
  loadFixture,
  stubFetchHanging,
  stubFetchWithFixture,
} from "../../../test/ai/fixture-fetch.js";
import { assertStreamContract } from "../../../test/ai/contract.js";
import { anthropicMessagesApi } from "./anthropic-messages.js";
import { buildAnthropicRequest, INTERLEAVED_THINKING_BETA } from "./anthropic-request.js";

const API = "anthropic-messages";

const model: Model = {
  id: "claude-sonnet-4-6",
  name: "Claude Sonnet 4.6",
  provider: "anthropic",
  api: API,
  baseUrl: "https://api.anthropic.com",
  input: ["text", "image"],
  reasoning: true,
  contextWindow: 200_000,
  maxTokens: 64_000,
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  authHeader: "x-api-key",
  requiresApiKey: true,
};

/** 中转站上的 MiniMax（Anthropic Messages 同主机；`test/fixtures/sse/README.md`「实录」）。 */
const relayModel: Model = {
  ...model,
  id: "MiniMax-M2.7",
  name: "MiniMax M2.7",
  provider: "packy",
  baseUrl: "https://relay.example.test",
  cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
};

const adaptive: Model = { ...model, id: "claude-opus-4-7", compat: { adaptiveThinking: true } };

afterEach(() => vi.unstubAllGlobals());

const opts = (extra: Partial<StreamOptions> = {}): StreamOptions => ({
  signal: new AbortController().signal,
  apiKey: "sk-ant-test",
  ...extra,
});

describe("anthropic-messages：SSE 样本黄金", () => {
  it("text（中转 MiniMax 实录）：ping 被忽略；空签名思考块；message_delta 的 usage 覆盖 message_start", async () => {
    const run = await runFixture(anthropicMessagesApi, API, "text", relayModel);
    expect(run.terminal.type).toBe("done");
    expect(run.final.content.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect(run.final.content[1]).toEqual({ type: "text", text: "\n\n你好，世界！" });
    expect(run.final.responseId).toBe("db3432e7-dd2d-4b7c-9eaf-beae41efe757");
    expect(run.final.usage).toMatchObject({ input: 36, output: 96, cacheRead: 0, cacheWrite: 0 });
    expect(run.final.usage.cost?.total).toBeCloseTo((36 * 0.3 + 96 * 1.2) / 1e6, 12);
    expect(run.final.rawStopReason).toBe("end_turn");
  });

  it("thinking：思考块带签名，之后是文本", async () => {
    const run = await runFixture(anthropicMessagesApi, API, "thinking", model);
    expect(run.final.content[0]).toEqual({
      type: "thinking",
      thinking: "The user wants 27 * 453.\n27 * 453 = 12231.",
      thinkingSignature: "EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds-part2==",
    });
    expect(run.final.content[1]).toEqual({ type: "text", text: "27 × 453 = 12,231" });
  });

  it("redacted-thinking：保留不透明数据以便回放", async () => {
    const run = await runFixture(anthropicMessagesApi, API, "redacted-thinking", model);
    const block = run.final.content[0];
    expect(block).toMatchObject({ type: "thinking", redacted: true });
    expect(block?.type === "thinking" && block.thinkingSignature?.startsWith("EmwK")).toBe(true);
    expect(run.final.content[1]).toEqual({ type: "text", text: "Done." });
  });

  it("tool-single（中转 MiniMax 实录）：参数增量拼接为对象，stopReason toolUse", async () => {
    const run = await runFixture(anthropicMessagesApi, API, "tool-single", relayModel);
    expect(run.terminal).toMatchObject({ type: "done", reason: "toolUse" });
    expect(run.final.content[1]).toEqual({
      type: "toolCall",
      id: "toolu_function_3t97y4a8pst6_1",
      name: "read",
      arguments: { path: "README.md" },
    });
    const deltas = run.events.filter((e) => e.type === "toolcall_delta");
    expect(deltas.length).toBe(1); // 空增量不发事件
  });

  it("tool-multi：三个工具调用，空参数为 {}，转义正确", async () => {
    const run = await runFixture(anthropicMessagesApi, API, "tool-multi", model);
    const calls = run.final.content.filter((b) => b.type === "toolCall");
    expect(calls.map((c) => c.type === "toolCall" && c.arguments)).toEqual([
      { pattern: "TODO\\(", glob: "**/*.ts" },
      {},
      { command: 'echo "hi"\n' },
    ]);
  });

  it("length（中转 MiniMax 实录）：思考中途 max_tokens → length", async () => {
    const run = await runFixture(anthropicMessagesApi, API, "length", relayModel);
    expect(run.terminal).toMatchObject({ type: "done", reason: "length" });
    expect(run.final.usage).toMatchObject({ input: 30, output: 16 });
  });

  it("usage-cache：缓存读写与 1h 写入计价；delta 的 null 不覆盖", async () => {
    const run = await runFixture(anthropicMessagesApi, API, "usage-cache", model);
    expect(run.final.usage).toMatchObject({
      input: 12,
      output: 5,
      cacheRead: 30_000,
      cacheWrite: 2048,
      cacheWrite1h: 1024,
      totalTokens: 12 + 5 + 30_000 + 2048,
    });
    const expected = (12 * 3 + 5 * 15 + 30_000 * 0.3 + 1024 * 3.75 + 1024 * 3 * 2) / 1e6;
    expect(run.final.usage.cost?.total).toBeCloseTo(expected, 12);
  });

  it("proxy-thinking（中转实录）：思考块的签名为空串——保留为空，不当成 redacted", async () => {
    const run = await runFixture(anthropicMessagesApi, API, "proxy-thinking", relayModel);
    const block = run.final.content[0];
    expect(block?.type).toBe("thinking");
    expect(block).not.toHaveProperty("redacted");
    expect(run.final.content[1]).toEqual({ type: "text", text: "\n\n9.9 is larger." });
  });

  it("proxy-tool-multi（中转实录）：思考 + 文本 + 三个工具调用", async () => {
    const run = await runFixture(anthropicMessagesApi, API, "proxy-tool-multi", relayModel);
    expect(run.terminal).toMatchObject({ type: "done", reason: "toolUse" });
    const calls = run.final.content.flatMap((b) =>
      b.type === "toolCall" ? [{ name: b.name, arguments: b.arguments }] : [],
    );
    expect(calls).toEqual([
      { name: "read", arguments: { path: "a.ts" } },
      { name: "read", arguments: { path: "b.ts" } },
      { name: "ls", arguments: { dir: "src" } },
    ]);
  });

  it("proxy-usage-cache（中转实录）：同一前缀第二次请求，cache_read_input_tokens 为读", async () => {
    const run = await runFixture(anthropicMessagesApi, API, "proxy-usage-cache", relayModel);
    expect(run.final.usage).toMatchObject({
      input: 32,
      cacheRead: 4475,
      cacheWrite: 0,
      output: 16,
      cacheReported: true,
    });
  });

  it("rate-limit-429：只有一个 error 事件，文案含状态码与类型", async () => {
    const run = await runFixture(anthropicMessagesApi, API, "rate-limit-429", model);
    expect(run.events).toHaveLength(1);
    expect(run.terminal).toMatchObject({ type: "error", reason: "error" });
    expect(run.final.errorMessage).toMatch(/^429 rate_limit_error: /);
    expect(isContextOverflow(run.final)).toBe(false);
  });

  it("overflow-400：识别为上下文溢出", async () => {
    const run = await runFixture(anthropicMessagesApi, API, "overflow-400", model);
    expect(run.final.errorMessage).toContain("prompt is too long");
    expect(isContextOverflow(run.final)).toBe(true);
  });

  it("stream-error：流内 error 事件，已产出的块被关闭", async () => {
    const run = await runFixture(anthropicMessagesApi, API, "stream-error", model);
    expect(run.terminal.type).toBe("error");
    expect(run.final.errorMessage).toBe("overloaded_error: Overloaded");
    expect(run.final.content).toEqual([{ type: "text", text: "Let me" }]);
  });

  it("disconnect：缺 message_stop → 断流错误，半截工具参数仍是对象", async () => {
    const run = await runFixture(anthropicMessagesApi, API, "disconnect", model);
    expect(run.final.errorMessage).toBe("Stream ended before completion");
    expect(run.final.content[1]).toMatchObject({
      type: "toolCall",
      arguments: { path: "a.txt", content: "hal" },
    });
  });
});

describe("anthropic-messages：请求", () => {
  it("URL、头与鉴权；onPayload 可替换请求体", async () => {
    const captured = stubFetchWithFixture(loadFixture(API, "text"));
    const seen: unknown[] = [];
    const stream = anthropicMessagesApi.stream(
      model,
      BASIC_CONTEXT,
      opts({
        headers: { "x-extra": "1", "user-agent": null },
        onPayload: (payload) => {
          seen.push(payload);
          return { ...(payload as object), metadata: { user_id: "u" } };
        },
      }),
    );
    await stream.result();
    const request = captured[0];
    expect(request?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request?.headers["x-api-key"]).toBe("sk-ant-test");
    expect(request?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(request?.headers["x-extra"]).toBe("1");
    expect(request?.headers["user-agent"]).toBeUndefined();
    expect(request?.headers["authorization"]).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(request?.body).toMatchObject({ metadata: { user_id: "u" }, stream: true });
  });

  it("三断点缓存：system 末、最后一个工具、最后一条 user（含工具结果）", () => {
    const context: TranscriptContext = {
      messages: [
        {
          role: "system",
          sections: { preamble: "P", rules: "R" },
          toolsAdded: [
            { name: "read", description: "r", parameters: { type: "object", properties: {} } },
            { name: "ls", description: "l", parameters: { type: "object" } },
          ],
          timestamp: 1,
        },
        { role: "user", content: "first", timestamp: 2 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call|weird id", name: "read", arguments: { p: 1 } }],
          api: API,
          provider: "anthropic",
          model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          stopReason: "toolUse",
          timestamp: 3,
        },
        {
          role: "toolResult",
          toolCallId: "call|weird id",
          toolName: "read",
          content: "file body",
          isError: false,
          timestamp: 4,
        },
      ],
    };
    const { body } = buildAnthropicRequest(model, context, opts());
    const system = body["system"] as Record<string, unknown>[];
    expect(system.map((s) => s["text"])).toEqual(["P", "R"]);
    expect(system[1]?.["cache_control"]).toEqual({ type: "ephemeral" });
    expect(system[0]?.["cache_control"]).toBeUndefined();
    const tools = body["tools"] as Record<string, unknown>[];
    expect(tools[1]?.["cache_control"]).toEqual({ type: "ephemeral" });
    expect(tools[0]?.["cache_control"]).toBeUndefined();
    const messages = body["messages"] as { role: string; content: Record<string, unknown>[] }[];
    expect(messages[0]?.content).toBe("first");
    expect(messages[1]?.content[0]).toMatchObject({ type: "tool_use", id: "call_weird_id" });
    expect(messages[2]?.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "call_weird_id",
      content: "file body",
      cache_control: { type: "ephemeral" },
    });
  });

  it("cacheRetention：none 不打断点，long 加 1h；maxCacheBreakpoints 限制数量", () => {
    const none = buildAnthropicRequest(model, BASIC_CONTEXT, opts({ cacheRetention: "none" }));
    expect(JSON.stringify(none.body)).not.toContain("cache_control");
    const long = buildAnthropicRequest(model, BASIC_CONTEXT, opts({ cacheRetention: "long" }));
    expect(JSON.stringify(long.body)).toContain('"ttl":"1h"');
    const limited = buildAnthropicRequest(
      { ...model, compat: { maxCacheBreakpoints: 1 } },
      BASIC_CONTEXT,
      opts(),
    );
    expect(JSON.stringify(limited.body).match(/cache_control/g)).toHaveLength(1);
    const messages = limited.body["messages"] as { content: Record<string, unknown>[] }[];
    expect(messages[0]?.content[0]?.["cache_control"]).toBeDefined();
  });

  it("thinking：预算型计入 max_tokens，有工具时加 interleaved beta，不发 temperature", () => {
    const withTools: TranscriptContext = {
      messages: [
        {
          role: "system",
          sections: {},
          toolsAdded: [{ name: "t", description: "", parameters: { type: "object" } }],
          timestamp: 0,
        },
        { role: "user", content: "x", timestamp: 1 },
      ],
    };
    const req = buildAnthropicRequest(
      model,
      withTools,
      opts({ thinkingLevel: "medium", maxTokens: 4000, temperature: 0.2 }),
    );
    expect(req.body["thinking"]).toEqual({
      type: "enabled",
      budget_tokens: 8192,
      display: "summarized",
    });
    expect(req.body["max_tokens"]).toBe(12_192);
    expect(req.body["temperature"]).toBeUndefined();
    expect(req.betas).toContain(INTERLEAVED_THINKING_BETA);
    expect(req.providerThinkingLevel).toBe("8192");
  });

  it("thinking：adaptive 用 effort；off 发 disabled 并允许 temperature；非推理模型不发", () => {
    const high = buildAnthropicRequest(adaptive, BASIC_CONTEXT, opts({ thinkingLevel: "minimal" }));
    expect(high.body["thinking"]).toEqual({ type: "adaptive", display: "summarized" });
    expect(high.body["output_config"]).toEqual({ effort: "low" });
    const xhigh = buildAnthropicRequest(
      { ...adaptive, thinkingLevelMap: { xhigh: "xhigh" } },
      BASIC_CONTEXT,
      opts({ thinkingLevel: "xhigh" }),
    );
    expect(xhigh.body["output_config"]).toEqual({ effort: "xhigh" });
    const clamped = buildAnthropicRequest(
      adaptive,
      BASIC_CONTEXT,
      opts({ thinkingLevel: "xhigh" }),
    );
    expect(clamped.thinkingLevel).toBe("high");
    const off = buildAnthropicRequest(model, BASIC_CONTEXT, opts({ temperature: 0.5 }));
    expect(off.body["thinking"]).toEqual({ type: "disabled" });
    expect(off.body["temperature"]).toBe(0.5);
    const plain = buildAnthropicRequest(
      { ...model, reasoning: false },
      BASIC_CONTEXT,
      opts({ thinkingLevel: "high" }),
    );
    expect(plain.body["thinking"]).toBeUndefined();
    expect(plain.thinkingLevel).toBe("off");
  });

  it("回放：签名思考原样、无签名思考降级为文本、redacted 回 redacted_thinking、图片", () => {
    const context: TranscriptContext = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
          ],
          timestamp: 0,
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "signed", thinkingSignature: "sig" },
            { type: "thinking", thinking: "unsigned" },
            {
              type: "thinking",
              thinking: "[redacted]",
              thinkingSignature: "opaque",
              redacted: true,
            },
            { type: "text", text: "  " },
          ],
          api: API,
          provider: "anthropic",
          model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          stopReason: "stop",
          timestamp: 1,
        },
      ],
    };
    const { body } = buildAnthropicRequest(model, context, opts({ cacheRetention: "none" }));
    const messages = body["messages"] as { content: unknown }[];
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ]);
    expect(messages[1]?.content).toEqual([
      { type: "thinking", thinking: "signed", signature: "sig" },
      { type: "text", text: "unsigned" },
      { type: "redacted_thinking", data: "opaque" },
    ]);
  });

  it("缺 key 同步抛 no_api_key；requiresApiKey=false 或头里自带鉴权时放行", async () => {
    let thrown: unknown;
    try {
      anthropicMessagesApi.stream(model, BASIC_CONTEXT, { signal: new AbortController().signal });
    } catch (error) {
      thrown = error;
    }
    expect(isAmaError(thrown) && thrown.code).toBe("no_api_key");
    stubFetchWithFixture(loadFixture(API, "text"));
    const local = anthropicMessagesApi.stream({ ...model, requiresApiKey: false }, BASIC_CONTEXT, {
      signal: new AbortController().signal,
    });
    expect((await local.result()).stopReason).toBe("stop");
    const header = anthropicMessagesApi.stream(model, BASIC_CONTEXT, {
      signal: new AbortController().signal,
      headers: { authorization: "Bearer x" },
    });
    expect((await header.result()).stopReason).toBe("stop");
  });

  it("流式中途 abort → error{reason:aborted}，已开的块被关闭", async () => {
    stubFetchHanging(
      [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"par"}}\n\n',
      ].join(""),
    );
    const controller = new AbortController();
    const stream = anthropicMessagesApi.stream(
      model,
      BASIC_CONTEXT,
      opts({ signal: controller.signal }),
    );
    const events = [];
    for await (const event of stream) {
      events.push(event);
      if (event.type === "text_delta") controller.abort();
    }
    const final = await stream.result();
    const terminal = assertStreamContract(events, final);
    expect(terminal).toMatchObject({ type: "error", reason: "aborted" });
    expect(final.stopReason).toBe("aborted");
    expect(final.content).toEqual([{ type: "text", text: "par" }]);
  });

  it("请求前就已 abort → 只有 error{aborted}", async () => {
    stubFetchWithFixture(loadFixture(API, "text"));
    const controller = new AbortController();
    controller.abort();
    const stream = anthropicMessagesApi.stream(
      model,
      BASIC_CONTEXT,
      opts({ signal: controller.signal }),
    );
    const events = await collectEvents(stream);
    expect(events.map((e) => e.type)).toEqual(["error"]);
    expect((await stream.result()).stopReason).toBe("aborted");
  });

  it("timeoutMs：拿到响应头之前超时 → error", async () => {
    vi.stubGlobal(
      "fetch",
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const stream = anthropicMessagesApi.stream(model, BASIC_CONTEXT, opts({ timeoutMs: 20 }));
    const final = await stream.result();
    expect(final.stopReason).toBe("error");
    expect(final.errorMessage).toMatch(/timed out after 20 ms/);
  });
});
