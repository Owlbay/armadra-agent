/**
 * `Usage.cacheReported` 真值表（第三波 §1.6）：字段缺失 → false；出现但为 0 → true；> 0 → true。
 * 用例里的 usage 形状取自 2026-10-02 对中转的实测（docs/guides/providers.md「缓存」）。
 */

import { describe, expect, it } from "vitest";
import { emptyUsage } from "../cost.js";
import { applyAnthropicUsage } from "./anthropic-messages.js";
import { parseGoogleUsage } from "./google-generative-ai.js";
import { parseOpenAIUsage } from "./openai-completions.js";
import { parseResponsesUsage } from "./openai-responses.js";

describe("cacheReported：openai-completions", () => {
  it.each([
    ["缺失", { prompt_tokens: 100, completion_tokens: 2 }, false, 0],
    [
      "details.cached_tokens 为 0（MiniMax / GLM 中转首个请求）",
      { prompt_tokens: 9700, prompt_tokens_details: { cached_tokens: 0 } },
      true,
      0,
    ],
    [
      "details.cached_tokens > 0（Kimi 中转）",
      { prompt_tokens: 8597, prompt_tokens_details: { cached_tokens: 8576, text_tokens: 8597 } },
      true,
      8576,
    ],
    [
      "DeepSeek 官方 prompt_cache_hit / miss",
      { prompt_tokens: 100, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 },
      true,
      0,
    ],
    ["Moonshot 顶层 cached_tokens", { prompt_tokens: 100, cached_tokens: 64 }, true, 64],
    [
      "只有 cache_write_tokens",
      { prompt_tokens: 100, prompt_tokens_details: { cache_write_tokens: 80 } },
      true,
      0,
    ],
    [
      "details 存在但无缓存字段",
      { prompt_tokens: 100, prompt_tokens_details: { text_tokens: 100 } },
      false,
      0,
    ],
  ])("%s", (_name, raw, reported, cacheRead) => {
    const usage = parseOpenAIUsage(raw);
    expect(usage.cacheReported).toBe(reported);
    expect(usage.cacheRead).toBe(cacheRead);
  });
});

describe("cacheReported：openai-responses", () => {
  it.each([
    ["缺失", { input_tokens: 100, output_tokens: 1 }, false],
    [
      "为 0（DeepSeek 中转）",
      { input_tokens: 9767, input_tokens_details: { cached_tokens: 0 } },
      true,
    ],
    [
      "> 0（Qwen 中转）",
      { input_tokens: 10432, input_tokens_details: { cached_tokens: 10240 } },
      true,
    ],
  ])("%s", (_name, raw, reported) => {
    expect(parseResponsesUsage(raw).cacheReported).toBe(reported);
  });
});

describe("cacheReported：anthropic-messages（逐事件累积）", () => {
  it("缺失 → false；后续事件出现缓存字段 → true，且不会被不带字段的事件改回", () => {
    const usage = emptyUsage();
    applyAnthropicUsage(usage, { input_tokens: 10, output_tokens: 1 });
    expect(usage.cacheReported).toBe(false);
    applyAnthropicUsage(usage, { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    expect(usage.cacheReported).toBe(true);
    applyAnthropicUsage(usage, { output_tokens: 16 });
    expect(usage.cacheReported).toBe(true);
  });

  it("为 0（MiniMax 中转首个请求）与 > 0（Kimi 中转，仅 5m 写入）", () => {
    const zero = emptyUsage();
    applyAnthropicUsage(zero, {
      input_tokens: 9698,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    expect([zero.cacheReported, zero.cacheRead, zero.cacheWrite]).toEqual([true, 0, 0]);
    const kimi = emptyUsage();
    applyAnthropicUsage(kimi, {
      input_tokens: 12,
      cache_creation_input_tokens: 9464,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 9464 },
    });
    expect(kimi.cacheReported).toBe(true);
    expect(kimi.cacheWrite).toBe(9464);
    expect(kimi.cacheWrite1h).toBeUndefined();
  });

  it("没有任何 usage 事件 → 保持未定义", () => {
    const usage = emptyUsage();
    applyAnthropicUsage(usage, undefined);
    expect(usage.cacheReported).toBeUndefined();
  });
});

describe("cacheReported：google-generative-ai", () => {
  it.each([
    ["缺失（隐式缓存未命中常见）", { promptTokenCount: 100 }, false],
    ["为 0", { promptTokenCount: 100, cachedContentTokenCount: 0 }, true],
    ["> 0", { promptTokenCount: 100, cachedContentTokenCount: 64 }, true],
  ])("%s", (_name, raw, reported) => {
    expect(parseGoogleUsage(raw).cacheReported).toBe(reported);
  });
});
