import { describe, expect, it } from "vitest";
import { record } from "../../agent/testing/cache-records.js";
import { CacheReportingTracker, SILENT_STREAK, endpointKey } from "./reporting.js";

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
});
