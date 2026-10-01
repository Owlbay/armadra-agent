import { describe, expect, it } from "vitest";
import { calculateCost, emptyUsage, finalizeUsage } from "./cost.js";

const cost = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite: 3.75,
  tiers: [
    { inputTokensAbove: 200_000, input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5 },
    { inputTokensAbove: 100_000, input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
  ],
};

describe("calculateCost", () => {
  it("基础价；Usage.input 不含缓存", () => {
    const usage = { ...emptyUsage(), input: 1000, output: 500, cacheRead: 2000, cacheWrite: 100 };
    const result = calculateCost({ cost }, usage);
    expect(result?.input).toBeCloseTo(0.003, 12);
    expect(result?.output).toBeCloseTo(0.0075, 12);
    expect(result?.cacheRead).toBeCloseTo(0.0006, 12);
    expect(result?.cacheWrite).toBeCloseTo(0.000375, 12);
    expect(usage.cost?.total).toBeCloseTo(0.003 + 0.0075 + 0.0006 + 0.000375, 12);
  });

  it("阶梯按全部输入（含缓存）选严格超过阈值的最高档，整单计价", () => {
    const atThreshold = { ...emptyUsage(), input: 100_000, output: 1 };
    expect(calculateCost({ cost }, atThreshold)?.input).toBeCloseTo(0.3, 12);
    const mid = { ...emptyUsage(), input: 50_000, cacheRead: 60_000, output: 1000 };
    const r = calculateCost({ cost }, mid);
    expect(r?.input).toBeCloseTo(0.2, 12);
    expect(r?.output).toBeCloseTo(0.02, 12);
    const high = { ...emptyUsage(), input: 250_000 };
    expect(calculateCost({ cost }, high)?.input).toBeCloseTo(1.5, 12);
  });

  it("1h 缓存写按 2× 基础输入价", () => {
    const usage = { ...emptyUsage(), cacheWrite: 3000, cacheWrite1h: 1000 };
    expect(calculateCost({ cost }, usage)?.cacheWrite).toBeCloseTo(
      (2000 * 3.75 + 1000 * 6) / 1e6,
      12,
    );
  });

  it("无价格：删除 usage.cost；finalizeUsage 重算 totalTokens", () => {
    const usage = finalizeUsage(
      {},
      {
        ...emptyUsage(),
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 },
      },
    );
    expect(usage.totalTokens).toBe(10);
    expect(usage.cost).toBeUndefined();
  });
});
