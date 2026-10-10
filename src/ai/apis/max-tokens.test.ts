/**
 * max_tokens 主动收紧与被动修正（docs/model-efficiency-plan.md D9）。[ME-C]
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../http.js";
import { isOverflowErrorText } from "../overflow.js";
import {
  MIN_OUTPUT_TOKENS,
  OUTPUT_HEADROOM_TOKENS,
  clampGoogleMaxTokens,
  clampMaxTokens,
  clampRequestMaxTokens,
  maxTokensCaps,
  parseMaxTokensRejection,
  postWithMaxTokensFallback,
} from "./max-tokens.js";

afterEach(() => {
  vi.unstubAllGlobals();
  maxTokensCaps.clear();
});

const http400 = (text: string): HttpError => new HttpError(400, `400 ${text}`, text);

describe("clampMaxTokens", () => {
  it("窗口已知：min(请求值, max(1024, 窗口 − 输入 − 2048))", () => {
    expect(clampMaxTokens(262144, 262144, 20000, false)).toBe(
      262144 - 20000 - OUTPUT_HEADROOM_TOKENS,
    );
    expect(clampMaxTokens(8192, 262144, 20000, false)).toBe(8192);
    expect(clampMaxTokens(8192, 32768, 32000, false)).toBe(MIN_OUTPUT_TOKENS);
    expect(clampMaxTokens(512, 32768, 32000, false)).toBe(512);
  });

  it("窗口未知或预算型思考（fixed）时原值", () => {
    expect(clampMaxTokens(262144, undefined, 20000, false)).toBe(262144);
    expect(clampMaxTokens(262144, 262144, 250000, true)).toBe(262144);
  });

  it("就地改请求体：按 JSON 字符 / 4 估算输入；Google 带思考预算时不动", () => {
    const body: Record<string, unknown> = { max_tokens: 100_000, prompt: "x".repeat(40_000) };
    clampRequestMaxTokens(body, "max_tokens", 100_000);
    expect(body["max_tokens"]).toBeLessThanOrEqual(100_000 - 10_000 - OUTPUT_HEADROOM_TOKENS);
    expect(body["max_tokens"]).toBeGreaterThan(100_000 - 10_100 - OUTPUT_HEADROOM_TOKENS);
    const fixed: Record<string, unknown> = { max_tokens: 100_000 };
    clampRequestMaxTokens(fixed, "max_tokens", 1000, true);
    expect(fixed["max_tokens"]).toBe(100_000);
    const google = {
      contents: [],
      generationConfig: { maxOutputTokens: 65536 } as Record<string, unknown>,
    };
    clampGoogleMaxTokens(google, 32768);
    expect(google.generationConfig["maxOutputTokens"]).toBeLessThan(32768);
    const thinking = {
      generationConfig: { maxOutputTokens: 65536, thinkingConfig: { thinkingBudget: 8192 } },
    };
    clampGoogleMaxTokens(thinking, 32768);
    expect(thinking.generationConfig.maxOutputTokens).toBe(65536);
  });
});

describe("parseMaxTokensRejection", () => {
  it("三种文案：范围、上限、Anthropic 输入 + max_tokens 超出上下文", () => {
    expect(
      parseMaxTokensRejection(
        http400("invalid_request_error: Range of max_tokens should be [1, 98304]"),
      ),
    ).toEqual({ cap: 98304 });
    expect(
      parseMaxTokensRejection(
        http400("Invalid max_tokens value, the valid range of max_tokens is [1, 8192]"),
      ),
    ).toEqual({ cap: 8192 });
    expect(
      parseMaxTokensRejection(
        http400(
          "max_tokens is too large: 300000. This model supports at most 128000 completion tokens",
        ),
      ),
    ).toEqual({ cap: 128000 });
    expect(
      parseMaxTokensRejection(
        http400("`max_completion_tokens` must be less than or equal to `65536`"),
      ),
    ).toEqual({ cap: 65536 });
    expect(
      parseMaxTokensRejection(
        http400("input length and `max_tokens` exceed context limit: 180000 + 64000 > 200000"),
      ),
    ).toEqual({ cap: 20000 });
  });

  it("Anthropic 可用值 < 1024 → 溢出（overflow.ts 也认得）；其它错误 undefined", () => {
    const text = "input length and `max_tokens` exceed context limit: 199500 + 8192 > 200000";
    expect(parseMaxTokensRejection(http400(text))).toEqual({ overflow: true });
    expect(isOverflowErrorText(`400 invalid_request_error: ${text}`)).toBe(true);
    expect(parseMaxTokensRejection(http400("prompt is too long: 250000 tokens"))).toBeUndefined();
    expect(parseMaxTokensRejection(http400("max_tokens must be at least 1"))).toBeUndefined();
    const busy = new HttpError(429, "429 Range of max_tokens should be [1, 98304]", "");
    expect(parseMaxTokensRejection(busy)).toBeUndefined();
  });
});

describe("Anthropic 官方文案（按官方文档与公开 issue 文本录制，未经官方端点取样，#151）", () => {
  const tail = ", decrease input length or max_tokens and try again";
  const official = (input: number, max: number) =>
    JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: `input length and \`max_tokens\` exceed context limit: ${input} + ${max} > 200000${tail}`,
      },
    });

  it("带尾句：可用值 1 → 溢出；可用值 50000 → 可重发", () => {
    const overflow = official(199999, 21333);
    expect(parseMaxTokensRejection(http400(overflow))).toEqual({ overflow: true });
    expect(isOverflowErrorText(`400 ${overflow}`)).toBe(true);
    const plain = `input length and max_tokens exceed context limit: 199999 + 21333 > 200000${tail}`;
    expect(parseMaxTokensRejection(http400(plain))).toEqual({ overflow: true });
    expect(parseMaxTokensRejection(http400(official(150000, 60000)))).toEqual({ cap: 50000 });
  });

  it("可用值 50000：以 50000 重发一次，transient 不记入 maxTokensCaps", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(official(150000, 60000), { status: 400 }))
      .mockResolvedValue(new Response("data: {}\n\n", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await postWithMaxTokensFallback(
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      "https://api.anthropic.test/v1/messages",
      { headers: {}, body: { max_tokens: 60000 }, signal: new AbortController().signal },
      "max_tokens",
    );
    const bodies = fetch.mock.calls.map(([, init]) =>
      JSON.parse((init as RequestInit).body as string),
    );
    expect(bodies.map((b: { max_tokens: number }) => b.max_tokens)).toEqual([60000, 50000]);
    expect(maxTokensCaps.size).toBe(0);
  });
});

describe("postWithMaxTokensFallback", () => {
  const model = { provider: "packy", id: "kimi-k2.5" };
  const ok = () => new Response("data: {}\n\n", { status: 200 });
  const reject = (text: string) =>
    new Response(JSON.stringify({ error: { type: "invalid_request_error", message: text } }), {
      status: 400,
    });
  const post = (body: Record<string, unknown>, field = "max_tokens" as const) =>
    postWithMaxTokensFallback(
      model,
      "https://relay.test/v1/chat/completions",
      { headers: {}, body, signal: new AbortController().signal },
      field,
    );
  const sent = (fetch: ReturnType<typeof vi.fn>): unknown[] =>
    fetch.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));

  it("400 范围文案 → 以上限重发一次并记入 maxTokensCaps；之后直接用上限", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reject("Range of max_tokens should be [1, 98304]"))
      .mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetch);
    await post({ model: "kimi-k2.5", max_tokens: 262144 });
    expect(sent(fetch).map((b) => (b as { max_tokens: number }).max_tokens)).toEqual([
      262144, 98304,
    ]);
    expect(maxTokensCaps.get("packy/kimi-k2.5")).toBe(98304);
    await post({ model: "kimi-k2.5", max_tokens: 262144 });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sent(fetch)[2]).toMatchObject({ max_tokens: 98304 });
  });

  it("Anthropic 超出上下文：按本次输入算出的值重发，不记为模型上限", async () => {
    const text = "input length and `max_tokens` exceed context limit: 150000 + 64000 > 200000";
    const fetch = vi.fn().mockResolvedValueOnce(reject(text)).mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetch);
    await post({ max_tokens: 64000 });
    expect(sent(fetch)[1]).toMatchObject({ max_tokens: 50000 });
    expect(maxTokensCaps.size).toBe(0);
  });

  it("溢出、上限不小于发出值、预算放不下时不重发，原错误抛出", async () => {
    const overflow = "input length and `max_tokens` exceed context limit: 199500 + 8192 > 200000";
    const fetch = vi.fn().mockImplementation(async () => reject(overflow));
    vi.stubGlobal("fetch", fetch);
    await expect(post({ max_tokens: 8192 })).rejects.toThrow(/exceed context limit/);
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockImplementation(async () => reject("Range of max_tokens should be [1, 98304]"));
    await expect(post({ max_tokens: 4096 })).rejects.toThrow(/Range of max_tokens/);
    expect(fetch).toHaveBeenCalledTimes(2);
    const budgeted = { max_tokens: 200_000, thinking: { type: "enabled", budget_tokens: 100_000 } };
    await expect(post(budgeted)).rejects.toThrow(/Range of max_tokens/);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("max_output_tokens 字段同样处理", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reject("max_output_tokens must be at most 32768"))
      .mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetch);
    await postWithMaxTokensFallback(
      { provider: "relay", id: "gpt" },
      "https://relay.test/v1/responses",
      { headers: {}, body: { max_output_tokens: 128000 }, signal: new AbortController().signal },
      "max_output_tokens",
    );
    expect(sent(fetch)[1]).toMatchObject({ max_output_tokens: 32768 });
  });
});
