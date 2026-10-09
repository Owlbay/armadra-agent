import { describe, expect, expectTypeOf, it } from "vitest";
import { record } from "../../agent/testing/cache-records.js";
import { detectMiss } from "./miss.js";
import {
  CacheReportingTracker,
  SILENT_STREAK,
  endpointKey,
  inferGranularity,
} from "./reporting.js";
import type { LastRequest } from "./types.js";

const MIN = 1024;
const TTL = 300_000;

describe("CacheReportingTracker（§1.6 三态）", () => {
  it("键 = provider | 主机名 | model；路径与协议不影响", () => {
    const a = record({ provider: "packy", model: "kimi", baseUrl: "https://relay.example/v1" });
    const b = record({ provider: "packy", model: "kimi", baseUrl: "http://relay.example/other" });
    expect(endpointKey(a)).toBe("packy|relay.example|kimi");
    expect(endpointKey(b)).toBe(endpointKey(a));
  });

  it("出现读或写 → reported，之后的 0 不改变（那是未命中）", () => {
    const t = new CacheReportingTracker();
    expect(t.observe(record({ input: 5000 }), MIN, TTL)).toBe("unknown");
    expect(t.observe(record({ input: 100, cacheWrite: 4900, at: 1 }), MIN, TTL)).toBe("reported");
    for (let i = 0; i < 5; i++) {
      expect(t.observe(record({ input: 5000, at: 2 + i }), MIN, TTL)).toBe("reported");
    }
  });

  it(`字段存在但恒为 0：连续 ${SILENT_STREAK} 个可比请求 → silent；首条无可比对象不计票`, () => {
    const t = new CacheReportingTracker();
    const zero = (at: number) => record({ input: 5000, at, cacheReported: true });
    expect(t.observe(zero(0), MIN, TTL)).toBe("unknown");
    expect(t.observe(zero(1000), MIN, TTL)).toBe("unknown");
    expect(t.observe(zero(2000), MIN, TTL)).toBe("unknown");
    expect(t.observe(zero(3000), MIN, TTL)).toBe("silent");
    const key = endpointKey(zero(0));
    expect(t.get(key)).toBe("silent");
    expect(t.observe(record({ input: 100, cacheRead: 4900, at: 4000 }), MIN, TTL)).toBe("reported");
  });

  it("字段缺失（cacheReported false）每条直接计一票", () => {
    const t = new CacheReportingTracker();
    const missing = (at: number, system = "s") =>
      record({ input: 5000, at, cacheReported: false, fingerprint: { system } });
    expect(t.observe(missing(0, "a"), MIN, TTL)).toBe("unknown");
    expect(t.observe(missing(10 ** 7, "b"), MIN, TTL)).toBe("unknown");
    expect(t.observe(missing(2 * 10 ** 7, "c"), MIN, TTL)).toBe("silent");
  });

  it("不可比（指纹变、超过 ttl、前缀太小）不投票也不清零", () => {
    const t = new CacheReportingTracker();
    const z = (at: number, extra: Parameters<typeof record>[0] = {}) =>
      record({ input: 5000, at, ...extra });
    t.observe(z(0), MIN, TTL);
    t.observe(z(1), MIN, TTL); // 1 票
    t.observe(z(2, { fingerprint: { tools: "x" } }), MIN, TTL); // 指纹变：不计
    t.observe(z(3, { fingerprint: { tools: "x" } }), MIN, TTL); // 2 票
    t.observe(z(3 + TTL, { fingerprint: { tools: "x" } }), MIN, TTL); // 超时：不计
    t.observe(record({ input: 500, at: 3 + TTL + 1 }), MIN, TTL); // 太小：不计
    expect(t.get(endpointKey(z(0)))).toBe("unknown");
    expect(t.observe(z(3 + TTL + 2, { fingerprint: { tools: "x" } }), MIN, TTL)).toBe("unknown");
    expect(t.observe(z(3 + TTL + 3, { fingerprint: { tools: "x" } }), MIN, TTL)).toBe("silent");
  });

  it("compat.cacheReporting 强制；auto 按观测", () => {
    const t = new CacheReportingTracker();
    const r = record({ input: 5000 });
    expect(t.observe(r, MIN, TTL, "silent")).toBe("silent");
    expect(t.observe(record({ input: 1, cacheRead: 5000, at: 1 }), MIN, TTL, "silent")).toBe(
      "silent",
    );
    expect(t.get(endpointKey(r), "auto")).toBe("reported");
    expect(t.get(endpointKey(r), "reported")).toBe("reported");
    expect(t.get("nope")).toBe("unknown");
    t.clear();
    expect(t.get(endpointKey(r))).toBe("unknown");
  });

  it("端点表只留上一条的摘要，不持有转录与回调（L2）", () => {
    const t = new CacheReportingTracker();
    const r = record({ input: 5000, at: 7 });
    t.observe(r, MIN, TTL);
    const endpoints = (t as unknown as { endpoints: Map<string, { last?: LastRequest }> })
      .endpoints;
    const last = endpoints.get(endpointKey(r))?.last;
    expect(last).toEqual({ at: 7, promptTokens: r.promptTokens, fingerprint: r.fingerprint });
    expect(last).not.toHaveProperty("options");
    expect(last).not.toHaveProperty("contextRef");
    expectTypeOf<LastRequest>().not.toHaveProperty("options");
    expectTypeOf<LastRequest>().not.toHaveProperty("contextRef");
    expectTypeOf({ at: 0, promptTokens: 0, fingerprint: r.fingerprint }).toExtend<LastRequest>();
  });
});

describe("缓存读粒度（分块报读的端点）", () => {
  const deepseek = {
    provider: "packy",
    model: "deepseek-v4-flash",
    baseUrl: "https://relay.example/v1",
  };
  const key = endpointKey(record(deepseek));

  it("最大公约数，≥ 2 个样本且落在 [128, 8192] 才采信", () => {
    expect(inferGranularity(2048, 1)).toBeUndefined();
    expect(inferGranularity(2048, 2)).toBe(2048);
    expect(inferGranularity(64, 5)).toBeUndefined();
    expect(inferGranularity(16_384, 3)).toBeUndefined();
    const sample = (reads: number[], spec = deepseek) => {
      const t = new CacheReportingTracker();
      reads.forEach((cacheRead, at) =>
        t.observe(record({ ...spec, input: 300, cacheRead, at }), MIN),
      );
      return t.granularity(endpointKey(record(spec)));
    };
    expect(sample([0, 2048])).toBeUndefined();
    expect(sample([2048, 0, 2048])).toBe(2048);
    expect(sample([2048, 4096, 6144])).toBe(2048);
    // Kimi：128 的倍数；MiniMax / Anthropic：逐 token 报，公约数太小不采信
    expect(sample([640, 1024, 1280, 1664])).toBe(128);
    expect(sample([891, 1339, 2235])).toBeUndefined();
    // 只有相同的大值（保温重放）→ 公约数超上限不采信，之后出现不同值再收窄
    expect(sample([30_720, 30_720])).toBeUndefined();
    expect(sample([30_720, 30_720, 31_232])).toBe(512);
    expect(new CacheReportingTracker().granularity(key)).toBeUndefined();
  });

  it("2048 分块的真实序列不再报未命中；cacheRead 骤降到 0 仍报 evicted", () => {
    const t = new CacheReportingTracker();
    // E1 实测（读 / 输入）：前缀不足 2048 时读恒为 0，之后按 2048 一块
    const seq: [number, number][] = [
      [0, 1339],
      [0, 1587],
      [0, 1640],
      [0, 1873],
      [0, 2401],
      [2048, 2501],
      [2048, 2943],
      [2048, 3002],
      [2048, 3079],
      [2048, 3138],
    ];
    let prev: ReturnType<typeof record> | undefined;
    const misses: unknown[] = [];
    const step = (cacheRead: number, prompt: number, at: number) => {
      const cur = record({
        ...deepseek,
        input: prompt - cacheRead,
        cacheRead,
        at,
        cacheReported: true,
      });
      const reporting = t.observe(cur, MIN, TTL);
      const options: Parameters<typeof detectMiss>[3] = { reporting, minTokens: MIN };
      const granularity = t.granularity(key);
      if (granularity !== undefined) options.granularity = granularity;
      const miss = detectMiss(prev, cur, TTL, options);
      if (miss !== undefined) misses.push(miss);
      prev = cur;
    };
    seq.forEach(([read, prompt], i) => step(read, prompt, i * 1000));
    expect(t.granularity(key)).toBe(2048);
    expect(misses).toEqual([]);
    step(0, 3200, 11_000);
    expect(misses).toEqual([expect.objectContaining({ reason: "evicted", missedTokens: 3138 })]);
  });
});
