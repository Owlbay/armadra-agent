import { describe, expect, it } from "vitest";
import { CompactionBreaker, MAX_CONSECUTIVE_FAILURES } from "./breaker.js";

/** 推进 n 回合（每回合一次阈值检查）。 */
function ticks(breaker: CompactionBreaker, n: number): void {
  for (let i = 0; i < n; i++) breaker.tick();
}

describe("熔断（C5）", () => {
  it("不再有「每 run 一次」：同一 run 内可多次摘要", () => {
    const breaker = new CompactionBreaker(true, 1000);
    breaker.startRun();
    for (let i = 0; i < 5; i++) {
      ticks(breaker, 10);
      expect(breaker.canSummarize()).toBe(true);
      breaker.recordSummary(true);
    }
    expect(breaker.tripped).toBe(false);
  });

  it("连续 3 次失败跳闸；中间成功一次清零；reset 恢复", () => {
    const breaker = new CompactionBreaker(true, 1000);
    expect(MAX_CONSECUTIVE_FAILURES).toBe(3);
    breaker.recordSummary(false);
    breaker.recordSummary(false);
    breaker.recordSummary(true);
    breaker.recordSummary(false);
    breaker.recordSummary(false);
    expect(breaker.canSummarize()).toBe(true);
    breaker.recordSummary(false);
    expect(breaker.tripped).toBe(true);
    expect(breaker.blockReason()).toBe("tripped");
    expect(breaker.autoEnabled).toBe(false);
    breaker.reset();
    expect(breaker.canSummarize()).toBe(true);
  });

  it("快速回填：连续 3 次都在上一次摘要后 < 3 回合又摘要 → 跳闸", () => {
    const breaker = new CompactionBreaker(true, 1000);
    ticks(breaker, 1);
    breaker.recordSummary(true); // 第一次，不算回填
    for (let i = 0; i < 2; i++) {
      ticks(breaker, 2);
      breaker.recordSummary(true);
      expect(breaker.tripped).toBe(false);
    }
    ticks(breaker, 2);
    breaker.recordSummary(true);
    expect(breaker.tripped).toBe(true);
    expect(breaker.blockReason()).toBe("rapid_refill");
  });

  it("中间隔了 ≥ 3 回合就重新计数", () => {
    const breaker = new CompactionBreaker(true, 1000);
    breaker.recordSummary(true);
    ticks(breaker, 1);
    breaker.recordSummary(true);
    ticks(breaker, 1);
    breaker.recordSummary(true); // 2 次回填
    ticks(breaker, 3);
    breaker.recordSummary(true); // 隔 3 回合：清零
    ticks(breaker, 1);
    breaker.recordSummary(true);
    ticks(breaker, 1);
    breaker.recordSummary(true);
    expect(breaker.tripped).toBe(false);
  });

  it("固定前缀超预算 → prefix_overflow，不算跳闸；前缀回落后恢复", () => {
    const breaker = new CompactionBreaker(true, 1000);
    breaker.setPrefixOverflow(true);
    expect(breaker.blockReason()).toBe("prefix_overflow");
    expect(breaker.tripped).toBe(false);
    breaker.setPrefixOverflow(false);
    expect(breaker.canSummarize()).toBe(true);
  });

  it("无窗口 / 关闭；0.8 重试门槛", () => {
    const breaker = new CompactionBreaker(true, 1000);
    expect(breaker.shouldRetryAfterCompaction(800)).toBe(true);
    expect(breaker.shouldRetryAfterCompaction(801)).toBe(false);
    expect(new CompactionBreaker(true, undefined).blockReason()).toBe("no_window");
    expect(new CompactionBreaker(false, 10).autoEnabled).toBe(false);
  });
});
