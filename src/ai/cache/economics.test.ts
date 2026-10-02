import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "../providers/registry.js";
import type { Model } from "../types.js";
import { evaluateWarm, expectedSavings, priceTokens, warmBreakEven } from "./economics.js";

const registry = new ProviderRegistry({ keys: { useEnv: false, userAuthFile: null } });

function catalog(ref: string): Model {
  const lookup = registry.findModel(ref);
  if (!lookup.ok) throw new Error(`missing ${ref}`);
  return lookup.model;
}

const MIN = 0.05;

describe("保温经济性（§1.7 盈亏表）", () => {
  it.each([
    ["anthropic/claude-fable-5-1", "streaming", 4.17e3],
    ["anthropic/claude-fable-5-1", "idle", 31.5e3],
    ["anthropic/claude-sonnet-5-5", "streaming", 23.8e3],
    ["anthropic/claude-sonnet-5-5", "idle", 345e3],
    ["moonshot/kimi-k3", "streaming", 20.8e3],
    ["moonshot/kimi-k3", "idle", 476e3],
    ["deepseek/deepseek-flash", "streaming", 174e3],
  ] as const)("%s %s 盈亏点 ≈ %d token", (ref, phase, expected) => {
    const model = catalog(ref);
    const point = warmBreakEven(model, phase, MIN) as number;
    expect(Math.abs(point - expected) / expected).toBeLessThan(0.01);
    expect(evaluateWarm(model, Math.ceil(point * 1.01), phase, MIN).action).toBe("warm");
    expect(evaluateWarm(model, Math.floor(point * 0.99), phase, MIN)).toMatchObject({
      action: "stop",
      reason: "below_min_savings",
    });
  });

  it("DeepSeek Flash 空闲相永不划算（盈亏点超过窗口）", () => {
    const model = catalog("deepseek/deepseek-flash");
    expect(warmBreakEven(model, "idle", MIN)).toBeUndefined();
    expect(evaluateWarm(model, 900_000, "idle", MIN).action).toBe("stop");
  });

  it("决策字段：hit / miss / warm 价与概率；无价或价格为 0 → no_price", () => {
    const sonnet = catalog("anthropic/claude-sonnet-5-5");
    const d = evaluateWarm(sonnet, 100_000, "streaming", MIN);
    expect(d).toMatchObject({ action: "warm", phase: "streaming", probability: 1 });
    expect(d.missCost).toBeCloseTo((100_000 * (2.5 - 0.2)) / 1e6, 10);
    expect(d.warmCost).toBeCloseTo((100_000 * 0.2 + 10) / 1e6, 10);
    expect(expectedSavings(d)).toBeCloseTo((d.missCost as number) - (d.warmCost as number), 10);
    expect(evaluateWarm(sonnet, 100_000, "idle", MIN).probability).toBe(0.15);
    const free = { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    expect(evaluateWarm(free, 10 ** 6, "streaming", MIN)).toMatchObject({
      action: "stop",
      reason: "no_price",
      warmCost: undefined,
    });
    expect(evaluateWarm({}, 10 ** 6, "streaming", MIN).reason).toBe("no_price");
    expect(expectedSavings(evaluateWarm({}, 1, "idle", MIN))).toBeUndefined();
    expect(priceTokens({}, { input: 1 })).toBeUndefined();
    expect(priceTokens(sonnet, { input: 1000, output: 1000 })).toBeCloseTo(0.012, 10);
  });
});
