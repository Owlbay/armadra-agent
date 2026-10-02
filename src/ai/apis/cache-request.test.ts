/**
 * 第三波 §1.3 协议层缓存字段的请求体 / 请求头快照（C1a）。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { BASIC_CONTEXT } from "../../../test/ai/golden.js";
import { loadFixture, stubFetchWithFixture } from "../../../test/ai/fixture-fetch.js";
import type { Api, Model, StreamOptions } from "../types.js";
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
