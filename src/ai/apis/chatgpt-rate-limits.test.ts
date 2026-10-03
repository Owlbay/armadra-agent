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

  it("[W7] 只有周窗口的套餐：primary 是 10080 分钟，secondary 全 0（没有这个窗口）→ 只解析出 primary", () => {
    const week = { usedPercent: 0, windowMinutes: 10_080, resetsAt: 1_790_500_000_000 };
    expect(
      parseQuotaHeaders(
        new Headers({
          "x-codex-primary-used-percent": "0",
          "x-codex-primary-window-minutes": "10080",
          "x-codex-primary-reset-at": "1790500000",
          "x-codex-secondary-used-percent": "0",
          "x-codex-secondary-window-minutes": "0",
        }),
      ),
    ).toEqual({ primary: week });
    expect(
      parseRateLimitEvent({
        type: "codex.rate_limits",
        plan_type: "free",
        rate_limits: {
          primary: { used_percent: 0, window_minutes: 10_080, reset_at: 1_790_500_000 },
          secondary: { used_percent: 0, window_minutes: 0, reset_at: 0 },
        },
      }),
    ).toEqual({ planType: "free", primary: week });
    expect(
      parseUsagePayload({
        plan_type: "free",
        rate_limit: {
          primary_window: {
            used_percent: 0,
            limit_window_seconds: 604_800,
            reset_at: 1_790_500_000,
          },
          secondary_window: { used_percent: 0, limit_window_seconds: 0, reset_at: 0 },
        },
      }),
    ).toEqual({ planType: "free", primary: week });
  });

  it("[W7] 时长 ≤ 0 视同缺失；有用量或重置时间的窗口即使缺时长也保留", () => {
    expect(
      parseQuotaHeaders(
        new Headers({
          "x-codex-secondary-used-percent": "4",
          "x-codex-secondary-window-minutes": "0",
        }),
      ),
    ).toEqual({ secondary: { usedPercent: 4 } });
    expect(
      parseQuotaHeaders(
        new Headers({ "x-codex-primary-used-percent": "0", "x-codex-primary-reset-at": "10" }),
      ),
    ).toEqual({ primary: { usedPercent: 0, resetsAt: 10_000 } });
    expect(
      parseQuotaHeaders(
        new Headers({
          "x-codex-primary-used-percent": "0",
          "x-codex-primary-window-minutes": "0",
        }),
      ),
    ).toBeUndefined();
  });

  it("429 体", () => {
    expect(quotaFromLimitError({ resets_at: 10, limit_window_minutes: 300 })).toEqual({
      primary: { usedPercent: 100, resetsAt: 10_000, windowMinutes: 300 },
    });
  });
});
