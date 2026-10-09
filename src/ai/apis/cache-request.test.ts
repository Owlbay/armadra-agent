/**
 * 第三波 §1.3 协议层缓存字段的请求体 / 请求头快照（C1a）。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { BASIC_CONTEXT } from "../../../test/ai/golden.js";
import { loadFixture, stubFetchWithFixture } from "../../../test/ai/fixture-fetch.js";
import type { Api, Model, StreamOptions, TranscriptContext } from "../types.js";
import { anthropicMessagesApi } from "./anthropic-messages.js";
import {
  anthropicMessagesUrl,
  buildAnthropicRequest,
  enforceCacheTtlOrder,
} from "./anthropic-request.js";
import { buildGoogleRequest } from "./google-request.js";
import { buildOpenAIRequest } from "./openai-request.js";
import { openAICompletionsApi } from "./openai-completions.js";
import { buildResponsesRequest } from "./openai-responses-request.js";
import { openAIResponsesApi } from "./openai-responses.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const OFFICIAL = "https://api.openai.com/v1";
const RELAY = "https://www.packyapi.com/v1";

function model(api: Api, baseUrl: string, compat?: Model["compat"]): Model {
  return {
    id: "m1",
    name: "m1",
    provider: "p",
    api,
    baseUrl,
    input: ["text"],
    reasoning: false,
    maxTokens: 1024,
    ...(compat ? { compat } : {}),
  };
}

const opts = (extra: Partial<StreamOptions> = {}): StreamOptions => ({
  signal: new AbortController().signal,
  apiKey: "sk-test",
  sessionId: "sess-1",
  ...extra,
});

const CACHE_FIELDS = ["prompt_cache_key", "prompt_cache_retention", "prompt_cache_options"];
const cacheFields = (body: Record<string, unknown>) =>
  Object.fromEntries(CACHE_FIELDS.filter((k) => k in body).map((k) => [k, body[k]]));

describe("openai-completions 缓存字段", () => {
  const build = (m: Model, o: Partial<StreamOptions> = {}) =>
    cacheFields(buildOpenAIRequest(m, BASIC_CONTEXT, opts(o)).body);

  it("prompt_cache_key 只在 sendPromptCacheKey 时发（官方缺省开、中转缺省关、可显式开）", () => {
    expect(build(model("openai-completions", OFFICIAL))).toEqual({ prompt_cache_key: "sess-1" });
    expect(build(model("openai-completions", RELAY))).toEqual({});
    expect(build(model("openai-completions", RELAY, { sendPromptCacheKey: true }))).toEqual({
      prompt_cache_key: "sess-1",
    });
    expect(build(model("openai-completions", OFFICIAL, { sendPromptCacheKey: false }))).toEqual({});
    expect(build(model("openai-completions", OFFICIAL), { cacheRetention: "none" })).toEqual({});
    expect(build(model("openai-completions", OFFICIAL), { sessionId: "x".repeat(80) })).toEqual({
      prompt_cache_key: "x".repeat(64),
    });
  });

  it("long → prompt_cache_retention 24h（仅 supportsLongCacheRetention）；AMA_CACHE_RETENTION 生效", () => {
    expect(build(model("openai-completions", OFFICIAL), { cacheRetention: "long" })).toEqual({
      prompt_cache_key: "sess-1",
      prompt_cache_retention: "24h",
    });
    expect(build(model("openai-completions", RELAY), { cacheRetention: "long" })).toEqual({});
    const relayLong = model("openai-completions", RELAY, { supportsLongCacheRetention: true });
    expect(build(relayLong, { cacheRetention: "long" })).toEqual({ prompt_cache_retention: "24h" });
    vi.stubEnv("AMA_CACHE_RETENTION", "long");
    expect(build(model("openai-completions", OFFICIAL))).toEqual({
      prompt_cache_key: "sess-1",
      prompt_cache_retention: "24h",
    });
    vi.stubEnv("AMA_CACHE_RETENTION", "none");
    expect(build(model("openai-completions", OFFICIAL))).toEqual({});
  });

  it("OpenRouter anthropic/*：long 未声明长保留时 cache_control 不带 ttl，声明后带 1h", () => {
    const router = (compat?: Model["compat"]) => ({
      ...model("openai-completions", "https://openrouter.ai/api/v1", compat),
      provider: "openrouter",
      id: "anthropic/claude-sonnet-5.5",
    });
    const short = buildOpenAIRequest(router(), BASIC_CONTEXT, opts({ cacheRetention: "long" }));
    expect(JSON.stringify(short.body)).toContain('"cache_control":{"type":"ephemeral"}');
    expect(short.body["prompt_cache_retention"]).toBeUndefined();
    const long = buildOpenAIRequest(
      router({ supportsLongCacheRetention: true }),
      BASIC_CONTEXT,
      opts({ cacheRetention: "long" }),
    );
    expect(JSON.stringify(long.body)).toContain('"ttl":"1h"');
    expect(long.body["prompt_cache_retention"]).toBeUndefined();
  });

  it("亲和头：开关打开才发，随请求一起出去", async () => {
    const captured = stubFetchWithFixture(loadFixture("openai-completions", "text"));
    await openAICompletionsApi
      .stream(model("openai-completions", RELAY), BASIC_CONTEXT, opts())
      .result();
    const on = model("openai-completions", RELAY, { sendSessionAffinityHeaders: true });
    await openAICompletionsApi.stream(on, BASIC_CONTEXT, opts()).result();
    expect(captured[0]?.headers["x-session-affinity"]).toBeUndefined();
    expect(captured[1]?.headers["x-session-affinity"]).toBe("sess-1");
    expect(captured[1]?.headers["x-client-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("openai-responses 缓存字段", () => {
  const build = (m: Model, o: Partial<StreamOptions> = {}) =>
    cacheFields(buildResponsesRequest(m, BASIC_CONTEXT, opts(o)).body);

  it("prompt_cache_key 同 completions 规则", () => {
    expect(build(model("openai-responses", OFFICIAL))).toEqual({ prompt_cache_key: "sess-1" });
    expect(build(model("openai-responses", RELAY))).toEqual({});
    expect(build(model("openai-responses", RELAY, { sendPromptCacheKey: true }))).toEqual({
      prompt_cache_key: "sess-1",
    });
  });

  it("long：显式缓存模式 → prompt_cache_options 30m；否则长保留 → 24h；都不支持 → 不发", () => {
    expect(build(model("openai-responses", OFFICIAL), { cacheRetention: "long" })).toEqual({
      prompt_cache_key: "sess-1",
      prompt_cache_retention: "24h",
    });
    const explicit = model("openai-responses", OFFICIAL, { supportsExplicitPromptCacheMode: true });
    expect(build(explicit, { cacheRetention: "long" })).toEqual({
      prompt_cache_key: "sess-1",
      prompt_cache_options: { ttl: "30m" },
    });
    expect(build(explicit)).toEqual({ prompt_cache_key: "sess-1" });
    expect(build(model("openai-responses", RELAY), { cacheRetention: "long" })).toEqual({});
  });

  it("亲和头", async () => {
    const captured = stubFetchWithFixture(loadFixture("openai-responses", "text"));
    const on = model("openai-responses", RELAY, { sendSessionAffinityHeaders: true });
    await openAIResponsesApi.stream(on, BASIC_CONTEXT, opts()).result();
    expect(captured[0]?.headers["x-session-affinity"]).toBe("sess-1");
  });
});

describe("toolChoice: none 四协议映射（有工具才发）", () => {
  const TOOLS_CONTEXT: TranscriptContext = {
    messages: [
      {
        role: "system",
        sections: { preamble: "Be brief." },
        toolsAdded: [
          { name: "read", description: "Read", parameters: { type: "object", properties: {} } },
        ],
        timestamp: 1,
      },
      { role: "user", content: "summarize", timestamp: 2 },
    ],
  };
  const none = opts({ toolChoice: "none" });

  it("Anthropic tool_choice:{type:none}、Completions / Responses tool_choice:none、Google NONE", () => {
    const anthropic = buildAnthropicRequest(model("anthropic-messages", "x"), TOOLS_CONTEXT, none);
    expect(anthropic.body["tool_choice"]).toEqual({ type: "none" });
    const chat = buildOpenAIRequest(model("openai-completions", RELAY), TOOLS_CONTEXT, none);
    expect(chat.body["tool_choice"]).toBe("none");
    const responses = buildResponsesRequest(model("openai-responses", RELAY), TOOLS_CONTEXT, none);
    expect(responses.body["tool_choice"]).toBe("none");
    const google = buildGoogleRequest(model("google-generative-ai", "x"), TOOLS_CONTEXT, none);
    expect(google.body["toolConfig"]).toEqual({ functionCallingConfig: { mode: "NONE" } });
  });

  it("缺省不发；没有工具时也不发", () => {
    const plain = opts();
    expect(
      buildAnthropicRequest(model("anthropic-messages", "x"), TOOLS_CONTEXT, plain).body,
    ).not.toHaveProperty("tool_choice");
    expect(
      buildOpenAIRequest(model("openai-completions", RELAY), TOOLS_CONTEXT, plain).body,
    ).not.toHaveProperty("tool_choice");
    expect(
      buildGoogleRequest(model("google-generative-ai", "x"), TOOLS_CONTEXT, plain).body,
    ).not.toHaveProperty("toolConfig");
    for (const body of [
      buildAnthropicRequest(model("anthropic-messages", "x"), BASIC_CONTEXT, none).body,
      buildOpenAIRequest(model("openai-completions", RELAY), BASIC_CONTEXT, none).body,
      buildResponsesRequest(model("openai-responses", RELAY), BASIC_CONTEXT, none).body,
      buildGoogleRequest(model("google-generative-ai", "x"), BASIC_CONTEXT, none).body,
    ]) {
      expect(body).not.toHaveProperty("tool_choice");
      expect(body).not.toHaveProperty("toolConfig");
    }
  });
});

describe("anthropic-messages：长保留降级、TTL 顺序、/v1 去重", () => {
  const OFFICIAL_ANTHROPIC = "https://api.anthropic.com";
  const anthropic = (baseUrl: string, compat?: Model["compat"]) =>
    model("anthropic-messages", baseUrl, compat);
  const ttls = (body: Record<string, unknown>) =>
    JSON.stringify(body).match(/"cache_control":\{[^}]*\}/g) ?? [];

  it("long：官方端点 1h；中转缺省降为 5m；中转声明 supportsLongCacheRetention 后 1h", () => {
    const long = opts({ cacheRetention: "long" });
    const official = buildAnthropicRequest(anthropic(OFFICIAL_ANTHROPIC), BASIC_CONTEXT, long);
    expect(ttls(official.body).every((m) => m.includes('"ttl":"1h"'))).toBe(true);
    const relay = buildAnthropicRequest(anthropic(RELAY), BASIC_CONTEXT, long);
    expect(ttls(relay.body).length).toBeGreaterThan(0);
    expect(JSON.stringify(relay.body)).not.toContain("ttl");
    const declared = buildAnthropicRequest(
      anthropic(RELAY, { supportsLongCacheRetention: true }),
      BASIC_CONTEXT,
      long,
    );
    expect(JSON.stringify(declared.body)).toContain('"ttl":"1h"');
  });

  it("AMA_CACHE_RETENTION：未指定时生效；none 不打断点", () => {
    vi.stubEnv("AMA_CACHE_RETENTION", "long");
    const env = buildAnthropicRequest(anthropic(OFFICIAL_ANTHROPIC), BASIC_CONTEXT, opts());
    expect(JSON.stringify(env.body)).toContain('"ttl":"1h"');
    vi.stubEnv("AMA_CACHE_RETENTION", "none");
    const none = buildAnthropicRequest(anthropic(OFFICIAL_ANTHROPIC), BASIC_CONTEXT, opts());
    expect(JSON.stringify(none.body)).not.toContain("cache_control");
  });

  it("TTL 顺序：tools → system → messages 里 5m 之后出现 1h → 全部降为 5m；顺序正确不动", () => {
    const h1 = () => ({ type: "ephemeral", ttl: "1h" });
    const m5 = () => ({ type: "ephemeral" });
    const bad: Record<string, unknown> = {
      tools: [{ name: "t", cache_control: m5() }],
      system: [{ type: "text", text: "s", cache_control: h1() }],
      messages: [{ role: "user", content: [{ type: "text", text: "u", cache_control: h1() }] }],
    };
    expect(enforceCacheTtlOrder(bad)).toBe(true);
    expect(JSON.stringify(bad)).not.toContain("ttl");
    expect(ttls(bad)).toHaveLength(3);
    const good: Record<string, unknown> = {
      tools: [{ name: "t", cache_control: h1() }],
      system: [{ type: "text", text: "s", cache_control: h1() }],
      messages: [{ role: "user", content: [{ type: "text", text: "u", cache_control: m5() }] }],
    };
    expect(enforceCacheTtlOrder(good)).toBe(false);
    expect(JSON.stringify(good).match(/"ttl":"1h"/g)).toHaveLength(2);
  });

  it("/v1 去重：baseUrl 以 /v1 结尾时拼 /messages，否则 /v1/messages", async () => {
    expect(anthropicMessagesUrl("https://api.anthropic.com")).toBe(
      "https://api.anthropic.com/v1/messages",
    );
    expect(anthropicMessagesUrl("https://www.packyapi.com/v1/")).toBe(
      "https://www.packyapi.com/v1/messages",
    );
    expect(anthropicMessagesUrl("https://relay.test/anthropic")).toBe(
      "https://relay.test/anthropic/v1/messages",
    );
    expect(anthropicMessagesUrl("https://relay.test/v1beta")).toBe(
      "https://relay.test/v1beta/v1/messages",
    );
    const captured = stubFetchWithFixture(loadFixture("anthropic-messages", "text"));
    await anthropicMessagesApi.stream(anthropic(RELAY), BASIC_CONTEXT, opts()).result();
    expect(captured[0]?.url).toBe("https://www.packyapi.com/v1/messages");
  });
});

describe("[ME-C] anthropic 第 4 断点（D7）", () => {
  const anthropic = model("anthropic-messages", "https://api.anthropic.com");
  const tool = (name: string) => ({
    name,
    description: name,
    parameters: { type: "object" as const },
  });
  const call = (id: string): TranscriptContext["messages"][number] => ({
    role: "assistant",
    content: [{ type: "toolCall", id, name: "read", arguments: { path: id } }],
    api: "anthropic-messages",
    provider: "p",
    model: "m1",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "toolUse",
    timestamp: 1,
  });
  const result = (id: string): TranscriptContext["messages"][number] => ({
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: `body of ${id}`,
    isError: false,
    timestamp: 2,
  });
  const turns: TranscriptContext[] = [];
  const head: TranscriptContext["messages"] = [
    {
      role: "system",
      sections: { base: "P", rules: "R" },
      toolsAdded: [tool("ls"), tool("read")],
      timestamp: 0,
    },
    { role: "user", content: "question", timestamp: 1 },
  ];
  turns.push({ messages: head });
  turns.push({ messages: [...head, call("a"), result("a")] });
  turns.push({ messages: [...head, call("a"), result("a"), call("b"), result("b")] });

  type Body = Record<string, unknown> & {
    system: Record<string, unknown>[];
    tools: Record<string, unknown>[];
    messages: { role: string; content: Record<string, unknown>[] | string }[];
  };
  const build = (context: TranscriptContext, compat?: Model["compat"]): Body =>
    buildAnthropicRequest(compat ? { ...anthropic, compat } : anthropic, context, opts())
      .body as Body;
  const marks = (body: unknown): number =>
    JSON.stringify(body).match(/cache_control/g)?.length ?? 0;
  const lastBlock = (message: Body["messages"][number] | undefined) =>
    Array.isArray(message?.content) ? message.content[message.content.length - 1] : undefined;
  const strip = (body: Body): string =>
    JSON.stringify({ system: body.system, tools: body.tools }).replace(
      /,"cache_control":\{"type":"ephemeral"\}/g,
      "",
    );

  it("3 回合：恰 4 处，位置 = 最后 user、倒数第二 user、system 末、最后工具；相邻回合 system + tools 逐字节相同", () => {
    const bodies = turns.map((context) => build(context));
    expect(marks(bodies[0])).toBe(3); // 只有一条 user 时第 ③ 个位置空缺
    const body = bodies[2] as Body;
    expect(marks(body)).toBe(4);
    const users = body.messages.filter((m) => m.role === "user");
    expect(lastBlock(users[2])?.["cache_control"]).toEqual({ type: "ephemeral" });
    expect(lastBlock(users[1])?.["cache_control"]).toEqual({ type: "ephemeral" });
    expect(users[0]?.content).toBe("question");
    expect(body.system.at(-1)?.["cache_control"]).toEqual({ type: "ephemeral" });
    expect(body.tools.at(-1)?.["cache_control"]).toEqual({ type: "ephemeral" });
    expect(strip(bodies[1] as Body)).toBe(strip(bodies[0] as Body));
    expect(strip(bodies[2] as Body)).toBe(strip(bodies[1] as Body));
  });

  it("maxCacheBreakpoints: 3 → 按优先级打 ① ② ③，最后一个工具不打", () => {
    const body = build(turns[2] as TranscriptContext, { maxCacheBreakpoints: 3 });
    expect(marks(body)).toBe(3);
    const users = body.messages.filter((m) => m.role === "user");
    expect(lastBlock(users[1])?.["cache_control"]).toEqual({ type: "ephemeral" });
    expect(body.system.at(-1)?.["cache_control"]).toEqual({ type: "ephemeral" });
    expect(body.tools.at(-1)?.["cache_control"]).toBeUndefined();
  });
});

describe("[ME-C] rawArguments 回放（D14）", () => {
  const assistant = (rawArguments?: string): TranscriptContext => ({
    messages: [
      { role: "user", content: "q", timestamp: 0 },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_1",
            name: "read",
            arguments: { a: 1 },
            ...(rawArguments === undefined ? {} : { rawArguments }),
          },
        ],
        api: "openai-completions",
        provider: "p",
        model: "m1",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "toolUse",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: "ok",
        isError: false,
        timestamp: 2,
      },
    ],
  });
  const completionsArgs = (context: TranscriptContext): unknown => {
    const body = buildOpenAIRequest(model("openai-completions", RELAY), context, opts()).body;
    const messages = body["messages"] as { tool_calls?: { function: { arguments: string } }[] }[];
    return messages.find((m) => m.tool_calls)?.tool_calls?.[0]?.function.arguments;
  };
  const responsesArgs = (context: TranscriptContext): unknown => {
    const body = buildResponsesRequest(model("openai-responses", RELAY), context, opts()).body;
    const input = body["input"] as { type?: string; arguments?: string }[];
    return input.find((item) => item.type === "function_call")?.arguments;
  };

  it("有 rawArguments 原样发回（保留模型输出的空格）；旧消息回落 JSON.stringify", () => {
    expect(completionsArgs(assistant('{"a": 1}'))).toBe('{"a": 1}');
    expect(responsesArgs(assistant('{"a": 1}'))).toBe('{"a": 1}');
    expect(completionsArgs(assistant())).toBe('{"a":1}');
    expect(responsesArgs(assistant())).toBe('{"a":1}');
  });
});
