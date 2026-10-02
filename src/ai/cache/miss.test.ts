import { describe, expect, it } from "vitest";
import { SONNET_COST, record } from "../../agent/testing/cache-records.js";
import { detectMiss, isNotableMiss, missRatioThreshold, missedCostOf, noiseFloor } from "./miss.js";

const TTL = 300_000;

describe("detectMiss：不计的情形（§1.5 第 1 步）", () => {
  it("没有 prev、本条无输入、读写为 0 且端点未报告、prev 低于最小可缓存长度", () => {
    const prev = record({ input: 50_000 });
    expect(detectMiss(undefined, record({ input: 50_000 }), TTL)).toBeUndefined();
    expect(detectMiss(prev, record(), TTL)).toBeUndefined();
    const zero = record({ at: 10, input: 50_000 });
    expect(detectMiss(prev, zero, TTL)).toBeUndefined();
    expect(detectMiss(prev, zero, TTL, { reporting: "silent" })).toBeUndefined();
    expect(detectMiss(prev, zero, TTL, { reporting: "reported" })).toMatchObject({
      missedTokens: 50_000,
    });
    const small = record({ input: 1500 });
    expect(
      detectMiss(small, record({ input: 1500, cacheWrite: 1 }), TTL, { minTokens: 2048 }),
    ).toBeUndefined();
  });
});

describe("噪声下限与规模自适应（§1.5 第 2–3 步）", () => {
  it("noiseFloor = max(1024, minTokens)", () => {
    expect(noiseFloor(undefined)).toBe(1024);
    expect(noiseFloor(512)).toBe(1024);
    expect(noiseFloor(4096)).toBe(4096);
    const prev = record({ cacheRead: 3000 });
    expect(detectMiss(prev, record({ input: 1000, cacheRead: 2000 }), TTL)).toBeUndefined();
    expect(detectMiss(prev, record({ input: 1100, cacheRead: 1900 }), TTL)).toMatchObject({
      missedTokens: 1100,
    });
    expect(
      detectMiss(prev, record({ input: 1100, cacheRead: 1900 }), TTL, { minTokens: 2048 }),
    ).toBeUndefined();
  });

  it("门槛 clamp(0.10 × √(100k / prev), 2%, 30%)；≥ 20k 无论比例都算", () => {
    expect(missRatioThreshold(100_000)).toBeCloseTo(0.1);
    expect(missRatioThreshold(1000)).toBe(0.3);
    expect(missRatioThreshold(10_000_000)).toBe(0.02);
    const prev = record({ cacheRead: 100_000 });
    expect(detectMiss(prev, record({ input: 9000, cacheRead: 91_000 }), TTL)).toBeUndefined();
    expect(detectMiss(prev, record({ input: 11_000, cacheRead: 89_000 }), TTL)).toBeDefined();
    const big = record({ cacheRead: 1_000_000 });
    expect(missRatioThreshold(1_000_000)).toBeCloseTo(0.0316, 3);
    expect(detectMiss(big, record({ input: 19_000, cacheRead: 981_000 }), TTL)).toBeUndefined();
    expect(detectMiss(big, record({ input: 20_000, cacheRead: 980_000 }), TTL)).toBeDefined();
  });

  it("本条比 prev 短时按较短者算", () => {
    const prev = record({ cacheRead: 100_000 });
    const cur = record({ input: 2000, cacheRead: 58_000 });
    expect(detectMiss(prev, cur, TTL)).toBeUndefined();
  });
});

describe("成本反推（§1.5 第 4 步）", () => {
  it("实付单价（含写入溢价）减读价；无读时用目录读价；无价格 undefined", () => {
    const cur = record({ input: 20_000, cacheRead: 80_000 });
    expect(missedCostOf(cur, 20_000)).toBeCloseTo((20_000 * (2 - 0.2)) / 1e6, 10);
    const write = record({ input: 1000, cacheWrite: 19_000, cacheRead: 0 });
    const paid = (1000 * 2 + 19_000 * 2.5) / 20_000 / 1e6;
    expect(missedCostOf(write, 20_000, SONNET_COST)).toBeCloseTo(20_000 * (paid - 0.2e-6), 10);
    expect(missedCostOf(write, 20_000)).toBeUndefined();
    expect(missedCostOf(record({ input: 100, cost: null }), 100)).toBeUndefined();
    const prev = record({ cacheRead: 100_000 });
    const miss = detectMiss(prev, record({ input: 100_000, cost: null, cacheWrite: 1 }), TTL);
    expect(miss).toBeDefined();
    expect(miss?.missedCost).toBeUndefined();
  });
});

describe("五种归因（§1.5 第 6 步）", () => {
  const prev = record({ at: 0, cacheRead: 50_000 });
  const cold = (spec: Parameters<typeof record>[0] = {}) =>
    record({ input: 1000, cacheWrite: 49_000, at: 60_000, ...spec });

  it("prefix_changed:system / tools 优先于模型与空闲", () => {
    expect(
      detectMiss(prev, cold({ fingerprint: { system: "s2" }, at: 10 ** 7 }), TTL),
    ).toMatchObject({ reason: "prefix_changed", detail: "system" });
    expect(detectMiss(prev, cold({ fingerprint: { tools: "t2" } }), TTL)).toMatchObject({
      reason: "prefix_changed",
      detail: "tools",
    });
  });

  it("model_changed；idle（ttl 缺省按 600 s）；subtask（task 占间隔 ≥ 80%）；其余 evicted", () => {
    expect(detectMiss(prev, cold({ model: "other" }), TTL)?.reason).toBe("model_changed");
    expect(detectMiss(prev, cold({ at: 400_000 }), TTL)).toMatchObject({
      reason: "idle",
      idleMs: 400_000,
    });
    expect(detectMiss(prev, cold({ at: 400_000 }), undefined)?.reason).toBe("evicted");
    expect(detectMiss(prev, cold({ at: 700_000 }), undefined)?.reason).toBe("idle");
    expect(detectMiss(prev, cold({ at: 100_000 }), TTL, { subtaskMs: 85_000 })?.reason).toBe(
      "subtask",
    );
    expect(detectMiss(prev, cold({ at: 100_000 }), TTL, { subtaskMs: 50_000 })?.reason).toBe(
      "evicted",
    );
  });

  it("提示门槛：≥ 20k token 或 ≥ $0.10", () => {
    expect(isNotableMiss({ missedTokens: 20_000, reason: "idle", idleMs: 0 })).toBe(true);
    expect(isNotableMiss({ missedTokens: 5000, missedCost: 0.12, reason: "idle", idleMs: 0 })).toBe(
      true,
    );
    expect(isNotableMiss({ missedTokens: 5000, reason: "idle", idleMs: 0 })).toBe(false);
  });
});
