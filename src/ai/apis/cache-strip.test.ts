/**
 * 400 自动剥离（第三波 §1.3）：fake HTTP 400 体 → 第二次请求不带缓存参数、仍只一个终止事件、
 * `strippedCacheParams` 命中、之后的请求直接剥离。400 体取自中转实测。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertStreamContract } from "../../../test/ai/contract.js";
import { bodyStream, loadFixture, type Fixture } from "../../../test/ai/fixture-fetch.js";
import { BASIC_CONTEXT } from "../../../test/ai/golden.js";
import { collectEvents } from "../event-stream.js";
import { HttpError } from "../http.js";
import type { ApiImplementation, Model } from "../types.js";
import { anthropicMessagesApi } from "./anthropic-messages.js";
import {
  isCacheParamRejection,
  setCacheParamWarn,
  stripCacheParams,
  strippedCacheParams,
} from "./cache-params.js";
import { openAICompletionsApi } from "./openai-completions.js";
import { openAIResponsesApi } from "./openai-responses.js";

const REJECT_RETENTION =
  '{"error":{"message":"json: unknown field \\"prompt_cache_retention\\" Request id: x","type":"packy_BadRequest","param":"","code":"InvalidParameter"}}';

interface Sent {
  url: string;
  body: Record<string, unknown>;
}

/** 依次返回 responses 里的响应（最后一个重复使用），记录每次请求体。 */
function stubSequence(responses: Fixture[]): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    const fixture = responses[Math.min(sent.length - 1, responses.length - 1)] as Fixture;
    return new Response(bodyStream(fixture.body), {
      status: fixture.status,
      headers: fixture.headers,
    });
  });
  return sent;
}

const reject = (body: string): Fixture => ({
  status: 400,
  headers: { "content-type": "application/json" },
  body,
  errorAfterBody: false,
});

function model(api: string, provider: string, compat?: Model["compat"]): Model {
  return {
    id: `m-${provider}`,
    name: "m",
    provider,
    api,
    baseUrl: "https://www.packyapi.com/v1",
    input: ["text"],
    reasoning: false,
    maxTokens: 1024,
    ...(compat ? { compat } : {}),
  };
}

const warnings: string[] = [];
let restore: (message: string) => void;
beforeEach(() => {
  warnings.length = 0;
  restore = setCacheParamWarn((message) => warnings.push(message));
});
afterEach(() => {
  setCacheParamWarn(restore);
  strippedCacheParams.clear();
  vi.unstubAllGlobals();
});

async function run(api: ApiImplementation, m: Model) {
  const stream = api.stream(m, BASIC_CONTEXT, {
    signal: new AbortController().signal,
    apiKey: "sk-test",
    sessionId: "sess-1",
    cacheRetention: "long",
  });
  const events = await collectEvents(stream);
  const final = await stream.result();
  return { events, final, terminal: assertStreamContract(events, final) };
}

describe("isCacheParamRejection / stripCacheParams", () => {
  it("只认 400 且错误体点名缓存参数", () => {
    expect(isCacheParamRejection(new HttpError(400, "400 x", REJECT_RETENTION))).toBe(
      "prompt_cache_retention",
    );
    expect(isCacheParamRejection(new HttpError(400, "400 Unknown CACHE_CONTROL", ""))).toBe(
      "cache_control",
    );
    expect(isCacheParamRejection(new HttpError(429, "429", REJECT_RETENTION))).toBeUndefined();
    expect(isCacheParamRejection(new HttpError(400, "400 bad", "max_tokens"))).toBeUndefined();
    expect(isCacheParamRejection(new Error("prompt_cache_key"))).toBeUndefined();
  });

  it("去掉顶层 prompt_cache_* 与任意层级 cache_control；工具 schema 原样；不改入参", () => {
    const body = {
      model: "m",
      prompt_cache_key: "s",
      prompt_cache_retention: "24h",
      prompt_cache_options: { ttl: "30m" },
      system: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "t", input_schema: { properties: { cache_control: { type: "string" } } } }],
    };
    const copy = structuredClone(body);
    expect(stripCacheParams(body)).toEqual({
      model: "m",
      system: [{ type: "text", text: "x" }],
      tools: [{ name: "t", input_schema: { properties: { cache_control: { type: "string" } } } }],
    });
    expect(body).toEqual(copy);
  });
});

describe("协议 run() 的 400 自动剥离", () => {
  it("Responses：400 点名 prompt_cache_retention → 剥离重发一次、一个终止事件、记入集合、提示一次", async () => {
    const m = model("openai-responses", "packy", {
      sendPromptCacheKey: true,
      supportsLongCacheRetention: true,
    });
    const sent = stubSequence([reject(REJECT_RETENTION), loadFixture("openai-responses", "text")]);
    const first = await run(openAIResponsesApi, m);
    expect(first.terminal.type).toBe("done");
    expect(first.events.filter((e) => e.type === "start")).toHaveLength(1);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.body["prompt_cache_retention"]).toBe("24h");
    expect(sent[1]?.body).not.toHaveProperty("prompt_cache_retention");
    expect(sent[1]?.body).not.toHaveProperty("prompt_cache_key");
    expect(strippedCacheParams.has("packy/m-packy")).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/prompt_cache_retention.*supportsLongCacheRetention: false/);
    // 之后同一模型直接剥离，一次请求、不再提示
    await run(openAIResponsesApi, m);
    expect(sent).toHaveLength(3);
    expect(sent[2]?.body).not.toHaveProperty("prompt_cache_key");
    expect(warnings).toHaveLength(1);
  });

  it("Completions：同一机制；请求里没有可剥离字段时不重发，原样报错", async () => {
    const withKey = model("openai-completions", "a", { sendPromptCacheKey: true });
    const sent = stubSequence([
      reject('{"error":{"message":"Unrecognized request argument supplied: prompt_cache_key"}}'),
      loadFixture("openai-completions", "text"),
    ]);
    expect((await run(openAICompletionsApi, withKey)).terminal.type).toBe("done");
    expect(sent[1]?.body).not.toHaveProperty("prompt_cache_key");
    vi.unstubAllGlobals();
    const bare = stubSequence([reject(REJECT_RETENTION)]);
    const failed = await run(openAICompletionsApi, model("openai-completions", "b"));
    expect(bare).toHaveLength(1);
    expect(failed.terminal).toMatchObject({ type: "error", reason: "error" });
    expect(failed.final.errorMessage).toMatch(/prompt_cache_retention/);
    expect(strippedCacheParams.has("b/m-b")).toBe(false);
  });

  it("Anthropic：拒收 cache_control 也剥离重发；重发仍 400 → 一个 error 终止事件", async () => {
    const m = model("anthropic-messages", "relay");
    const sent = stubSequence([
      reject(
        '{"type":"error","error":{"type":"invalid_request_error","message":"cache_control: Extra inputs are not permitted"}}',
      ),
    ]);
    const result = await run(anthropicMessagesApi, m);
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[0]?.body)).toContain("cache_control");
    expect(JSON.stringify(sent[1]?.body)).not.toContain("cache_control");
    expect(result.terminal).toMatchObject({ type: "error", reason: "error" });
    expect(result.events.filter((e) => e.type === "start")).toHaveLength(0);
  });
});
