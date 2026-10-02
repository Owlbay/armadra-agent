import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sharedCacheReporting } from "../ai/cache/reporting.js";
import type { Usage } from "../ai/types.js";
import { SONNET_COST } from "./testing/cache-records.js";
import { createHarness, type Harness } from "./testing/harness.js";
import type { ScriptStep } from "./testing/scripted-api.js";
import { fakeModel, stubTool } from "./testing/stubs.js";
import { cacheKeyOf, cacheTtlMs, resolveCacheSettings } from "./session-cache.js";
import type { CacheSettings, SessionEvent } from "./types.js";

const dirs: string[] = [];
function dir(): string {
  const path = mkdtempSync(join(tmpdir(), "ama-c1b-cache-"));
  dirs.push(path);
  return path;
}

beforeEach(() => sharedCacheReporting.clear());
afterEach(() => {
  vi.useRealTimers();
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

const priced = fakeModel({ cost: SONNET_COST, promptCache: { short: 300 } });

function of<T extends SessionEvent["type"]>(h: Harness, type: T) {
  return h.events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);
}

function step(usage: Partial<Usage>, text = "ok"): ScriptStep {
  return { text, usage: { output: 10, ...usage } };
}

/** 每回合前缀增长 1k；第 `missAt` 回合 cacheRead 0（服务端淘汰）。 */
function growing(rounds: number, missAt: number): ScriptStep[] {
  return Array.from({ length: rounds }, (_, i) => {
    const prompt = 30_000 + i * 1000;
    if (i === 0) return step({ input: 0, cacheWrite: prompt });
    if (i === missAt) return step({ input: 1000, cacheWrite: prompt - 1000 });
    return step({ input: 1000, cacheRead: prompt - 1000 });
  });
}

describe("SessionCacheController：未命中与统计", () => {
  it("20 回合里第 7 回合 cacheRead 0 → 一次 cache_miss{evicted}；统计与三态", async () => {
    const h = createHarness({ model: priced, cache: { warming: "off" }, script: growing(20, 7) });
    for (let i = 0; i < 20; i++) await h.session.prompt(`q${i}`);
    const misses = of(h, "cache_miss");
    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatchObject({ reason: "evicted", missedTokens: 36_000 });
    const cache = h.session.getStats().cache!;
    expect(cache.reporting).toBe("reported");
    expect(cache.misses).toEqual({ count: 1, byReason: { evicted: 1 } });
    expect(cache.reBilledTokens).toBe(36_000);
    expect(cache.reBilledUsd).toBeUndefined(); // 脚本流不算价
    expect(cache.lastHitRate).toBeCloseTo(48_000 / 49_000);
    expect(cache.hitRate).toBeGreaterThan(0.8);
    expect(cache.warming).toEqual({ mode: "off", state: "inactive" });
    expect(cache.contextRemainingTokens).toBeGreaterThan(0);
    expect(cache.estimatedTurnsLeft).toBeGreaterThan(0);
  });

  it("不报缓存的端点：4 个可比请求后 silent，命中率不给、不判未命中", async () => {
    const h = createHarness({
      model: priced,
      cache: { warming: "off" },
      script: Array.from({ length: 5 }, () => step({ input: 30_000 })),
    });
    for (let i = 0; i < 5; i++) await h.session.prompt(`q${i}`);
    const cache = h.session.getStats().cache!;
    expect(cache.reporting).toBe("silent");
    expect(cache.lastHitRate).toBeUndefined();
    expect(cache.hitRate).toBeUndefined();
    expect(cache.misses.count).toBe(0);
  });

  it("归因：宿主中途加工具 → prefix_changed:tools；换模型 → model_changed；压缩后首个请求是重置点", async () => {
    const other = fakeModel({ id: "other", promptCache: { short: 300 } });
    const steps = [
      step({ cacheWrite: 30_000 }),
      step({ input: 1000, cacheRead: 30_000 }),
      step({ input: 31_000, cacheWrite: 1000 }), // 加工具后
      step({ input: 32_000, cacheWrite: 1000 }), // 换模型
    ];
    const h = createHarness({ model: priced, cache: { warming: "off" }, script: steps });
    h.session.addTool(stubTool({ name: "zz_late" }), false);
    await h.session.prompt("a");
    await h.session.prompt("b");
    h.session.setActiveTools([...h.session.getTools().map((t) => t.name), "zz_late"]);
    await h.session.prompt("c");
    const registry = h.session.options.providers;
    const lookup = registry.findModel("fake/echo");
    if (!lookup.ok) throw new Error("stub registry");
    registry.findModel = () => ({ ...lookup, model: other });
    await h.session.setModel("fake/other");
    await h.session.prompt("d");
    expect(of(h, "cache_miss").map((m) => [m.reason, m.detail])).toEqual([
      ["prefix_changed", "tools"],
      ["model_changed", undefined],
    ]);

    const c = createHarness({
      model: fakeModel({ contextWindow: 100_000 }),
      cache: { warming: "off" },
      compaction: { keepRecentTokens: 50 },
      script: (call) =>
        call.options.purpose === "summary"
          ? { text: "## Goal\nx" }
          : call.index === 0
            ? step({ cacheWrite: 30_000 }, "y".repeat(400))
            : step({ input: 31_000 }, "y".repeat(400)),
    });
    await c.session.prompt("x".repeat(800));
    await c.session.prompt("z".repeat(800));
    expect(of(c, "cache_miss")).toHaveLength(1);
    await c.session.compact();
    await c.session.prompt("after");
    expect(of(c, "cache_miss")).toHaveLength(1);
  });

  it("context_pressure：跨越 70% / 90% 各一次", async () => {
    const h = createHarness({
      model: fakeModel({ contextWindow: 100_000 }),
      cache: { warming: "off" },
      script: [
        step({ input: 50_000 }),
        step({ input: 72_000 }),
        step({ input: 75_000 }),
        step({ input: 91_000 }),
        step({ input: 92_000 }),
      ],
    });
    for (let i = 0; i < 5; i++) await h.session.prompt(`q${i}`);
    expect(of(h, "context_pressure").map((e) => e.threshold)).toEqual([70, 90]);
    expect(of(h, "context_pressure")[1]).toMatchObject({ percent: 91, remainingTokens: 8990 });
  });
});

describe("保温接线（fake 计时器）", () => {
  it("工具长时间运行：发出前缀重放（maxTokens 1、purpose warm、同一上下文引用），追加 usage 条目", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let finish: () => void = () => undefined;
    const slow = stubTool({
      name: "slow",
      run: () => new Promise((resolve) => (finish = () => resolve({ content: "done" }))),
    });
    const h = createHarness({
      model: priced,
      tools: [slow],
      script: (call) =>
        call.options.purpose === "warm"
          ? step({ input: 1, cacheRead: 40_000 })
          : call.index === 0
            ? { toolCalls: [{ name: "slow", args: {} }], usage: { cacheWrite: 40_000 } }
            : step({ input: 100, cacheRead: 40_000 }),
    });
    const run = h.session.prompt("go");
    await vi.advanceTimersByTimeAsync(0);
    expect(of(h, "cache_warm")[0]).toMatchObject({ phase: "scheduled" });
    await vi.advanceTimersByTimeAsync(270_000);
    const warm = h.scripted.calls.find((c) => c.options.purpose === "warm")!;
    expect(warm.options).toMatchObject({ maxTokens: 1, purpose: "warm" });
    expect(warm.context).toBe(h.scripted.calls[0]!.context);
    expect(of(h, "cache_warm").map((e) => e.phase)).toEqual(["scheduled", "sent", "scheduled"]);
    expect(h.manager.entries().filter((e) => e.type === "usage")).toHaveLength(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    await run;
    const cache = h.session.getStats().cache!;
    expect(cache.warming).toMatchObject({ mode: "streaming", state: "inactive", sent: 1 });
    expect(cache.misses.count).toBe(0);
    expect(h.session.getStats().tokens.cacheRead).toBe(80_000); // 保温读计入统计
    expect(h.session.messages.filter((m) => m.role === "assistant")).toHaveLength(2);
  });

  it("宿主否决钩子 stop → 不发，cache_warm{stopped, declined}", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let finish: () => void = () => undefined;
    const slow = stubTool({
      name: "slow",
      run: () => new Promise((resolve) => (finish = () => resolve({ content: "done" }))),
    });
    const seen: unknown[] = [];
    const h = createHarness({
      model: priced,
      tools: [slow],
      warmingDecider: () => (decision) => {
        seen.push(decision);
        return "stop";
      },
      script: [
        { toolCalls: [{ name: "slow", args: {} }], usage: { input: 0, cacheWrite: 40_000 } },
        step({ cacheRead: 40_000 }),
      ],
    });
    const run = h.session.prompt("go");
    await vi.advanceTimersByTimeAsync(270_000);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ action: "warm", phase: "streaming", promptTokens: 40_000 });
    expect(of(h, "cache_warm").at(-1)).toMatchObject({ phase: "stopped", reason: "declined" });
    expect(h.scripted.calls).toHaveLength(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    await run;
  });

  it("小前缀 / 无 TTL / 子会话缺省 off：不排期，状态给出原因", async () => {
    const small = createHarness({ model: priced, script: [step({ cacheWrite: 2000 })] });
    await small.session.prompt("q");
    expect(of(small, "cache_warm")).toEqual([]);
    const noTtl = createHarness({
      model: fakeModel({ cost: SONNET_COST }),
      script: [step({ cacheWrite: 90_000 })],
    });
    await noTtl.session.prompt("q");
    expect(noTtl.session.getStats().cache?.warming).toMatchObject({
      state: "stopped",
      reason: "no_ttl",
    });
    const child = createHarness({
      model: priced,
      depth: 1,
      script: [step({ cacheWrite: 90_000 })],
    });
    expect(child.session.cache.mode()).toBe("off");
    const opted = createHarness({
      model: priced,
      depth: 1,
      cache: { warmSubagents: true },
      script: [],
    });
    expect(opted.session.cache.mode()).toBe("streaming");
    opted.session.cache.setWarming("idle");
    expect(opted.session.cache.mode()).toBe("idle");
  });
});

describe("设置、TTL 与缓存键", () => {
  it("resolveCacheSettings 缺省值；cacheTtlMs 按保留档", () => {
    expect(resolveCacheSettings()).toEqual({
      warming: "streaming",
      retention: "short",
      minSavingsUsd: 0.05,
      missNotices: true,
      warmSubagents: false,
    });
    expect(
      resolveCacheSettings({
        warming: "idle",
        retention: undefined,
      } as unknown as Partial<CacheSettings>).retention,
    ).toBe("short");
    const m = fakeModel({ promptCache: { short: 300, long: 3600 } });
    expect(cacheTtlMs(m)).toBe(300_000);
    expect(cacheTtlMs(m, "long")).toBe(3_600_000);
    expect(cacheTtlMs(fakeModel())).toBeUndefined();
  });

  it("turn 请求带 cache.retention；fork 会话沿用根会话 id 作缓存键，task 子会话不沿用", async () => {
    const h = createHarness({
      dir: dir(),
      cache: { warming: "off", retention: "long" },
      script: () => step({}),
    });
    await h.session.prompt("first");
    expect(h.scripted.calls[0]!.options).toMatchObject({
      cacheRetention: "long",
      sessionId: h.manager.id,
    });
    const anchor = h.manager
      .entries()
      .find((e) => e.type === "message" && e.message.role === "assistant")!;
    const forked = await h.session.fork(anchor.id);
    expect(cacheKeyOf(forked.manager)).toBe(h.manager.id);
    await forked.prompt("again");
    expect(h.scripted.calls.at(-1)!.options.sessionId).toBe(h.manager.id);
    const anchor2 = forked.manager.entries().at(-1)!;
    const second = await forked.fork(anchor2.id);
    expect(cacheKeyOf(second.manager)).toBe(h.manager.id);
    await second.dispose();
    await forked.dispose();
  });
});
