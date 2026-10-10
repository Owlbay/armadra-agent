/**
 * 会话层重试的分类与退避（docs/history/model-efficiency-plan.md D8）。[ME-C]
 */

import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../ai/types.js";
import {
  classifyFailure,
  isRetryableKind,
  maxRetriesFor,
  resolveRetrySettings,
  retryDelayMs,
} from "./retry.js";

const failed = (errorMessage: string): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "fake",
  provider: "fake",
  model: "echo",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "error",
  errorMessage,
  timestamp: 0,
});

const settings = resolveRetrySettings();
const mid = (): number => 0.5;

describe("retryDelayMs", () => {
  it("Retry-After 比退避长时取 Retry-After", () => {
    expect(retryDelayMs(1, settings, 30_000, mid)).toBe(30_000);
    expect(retryDelayMs(3, settings, 1_000, mid)).toBe(8_000);
  });

  it("截到 maxDelayMs 后再抖动 U(0.8, 1.2)，取整", () => {
    expect(retryDelayMs(1, settings, 120_000, mid)).toBe(60_000);
    expect(retryDelayMs(1, settings, undefined, () => 0)).toBe(1_600);
    expect(retryDelayMs(1, settings, undefined, () => 0.999_999)).toBe(2_400);
    expect(retryDelayMs(1, settings, 20_000, () => 0)).toBe(16_000);
    for (let i = 0; i < 50; i++) {
      const delay = retryDelayMs(2, settings);
      expect(delay).toBeGreaterThanOrEqual(3_200);
      expect(delay).toBeLessThanOrEqual(4_800);
      expect(Number.isInteger(delay)).toBe(true);
    }
  });
});

describe("classifyFailure", () => {
  it("5xx 只认开头的状态码或 status / HTTP 后的", () => {
    // 文案中间的「500 tokens」不是状态码（HttpError 的文案以状态码开头）
    expect(classifyFailure(failed("output limited to 500 tokens"))).toBe("other");
    expect(classifyFailure(failed("500 api_error: Internal server error"))).toBe("retryable");
    expect(classifyFailure(failed("upstream said HTTP 503"))).toBe("retryable");
    expect(classifyFailure(failed("relay error (status: 502)"))).toBe("retryable");
    expect(classifyFailure(failed("503 Service Unavailable"))).toBe("retryable");
  });

  it("429 / 529 / rate limit → rate_limited，上限 maxRetries + 2", () => {
    expect(classifyFailure(failed("429 rate_limit_error: slow down"))).toBe("rate_limited");
    expect(classifyFailure(failed("529 overloaded_error: Overloaded"))).toBe("rate_limited");
    expect(classifyFailure(failed("Too Many Requests"))).toBe("rate_limited");
    expect(classifyFailure(failed("429 insufficient_quota"))).toBe("fatal");
    expect(maxRetriesFor("rate_limited", settings)).toBe(5);
    expect(maxRetriesFor("retryable", settings)).toBe(3);
    expect(
      ["rate_limited", "retryable", "fatal", "other"].map((k) => isRetryableKind(k as never)),
    ).toEqual([true, true, false, false]);
  });
});
