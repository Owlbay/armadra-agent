import { describe, expect, it } from "vitest";
import {
  parseQuotaHeaders,
  parseRateLimitEvent,
  parseUsagePayload,
  quotaFromLimitError,
} from "./chatgpt-rate-limits.js";

describe("配额解析", () => {
  it("响应头：没有配额头 → undefined；百分比钳到 0–100", () => {
    expect(parseQuotaHeaders(new Headers())).toBeUndefined();
    expect(parseQuotaHeaders(new Headers({ "x-codex-primary-used-percent": "130" }))).toEqual({
      primary: { usedPercent: 100 },
    });
  });

  it("SSE 事件：类型不对 → undefined", () => {
    expect(parseRateLimitEvent({ type: "response.created" })).toBeUndefined();
    expect(
      parseRateLimitEvent({
        type: "codex.rate_limits",
        rate_limits: { secondary: { used_percent: 5 } },
      }),
    ).toEqual({ secondary: { usedPercent: 5 } });
  });

  it("wham/usage：窗口秒 → 分钟、reset_at 秒 → 毫秒；只有计划时只给计划；坏数据 undefined", () => {
    expect(
      parseUsagePayload({
        plan_type: "pro",
        rate_limit: {
          primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1790000000 },
          secondary_window: { used_percent: 3, limit_window_seconds: 604800, reset_at: 1790500000 },
        },
      }),
    ).toEqual({
      planType: "pro",
      primary: { usedPercent: 12, windowMinutes: 300, resetsAt: 1_790_000_000_000 },
      secondary: { usedPercent: 3, windowMinutes: 10080, resetsAt: 1_790_500_000_000 },
    });
    expect(parseUsagePayload({ plan_type: "plus" })).toEqual({ planType: "plus" });
    expect(parseUsagePayload("nope")).toBeUndefined();
  });

  it("429 体", () => {
    expect(quotaFromLimitError({ resets_at: 10, limit_window_minutes: 300 })).toEqual({
      primary: { usedPercent: 100, resetsAt: 10_000, windowMinutes: 300 },
    });
  });
});
