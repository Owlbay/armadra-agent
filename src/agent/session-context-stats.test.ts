/**
 * `getStats().context`：上下文量的来源（启动前缀基线 / usage / 全量估算）与自动压缩阈值；
 * 启动基线只统计，不改请求体。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { sharedCacheReporting } from "../ai/cache/reporting.js";
import type { SystemMessage } from "../ai/types.js";
import { estimateMessageTokens } from "../compaction/estimate.js";
import { buildProjection } from "../session/projection.js";
import type { ScriptCall, ScriptStep } from "./testing/scripted-api.js";
import { createHarness, isSummaryRequest } from "./testing/harness.js";
import { fakeModel, stubTool } from "./testing/stubs.js";

beforeEach(() => sharedCacheReporting.clear());

/** 窗口 60k、预留 10k → 档二 50k、档一 35k。 */
const model = fakeModel({ contextWindow: 60_000 });
const compaction = { reserveTokens: 10_000 };
const readTool = stubTool({
  name: "read",
  properties: { path: { type: "string" } },
  run: () => ({ content: "x" }),
});

const reply = (call: ScriptCall): ScriptStep =>
  isSummaryRequest(call.context)
    ? { text: "## Goal\nsummary" }
    : {
        text: "ok",
        usage: { input: 3_000, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 3_050 },
      };

const systemOf = (h: ReturnType<typeof createHarness>): SystemMessage =>
  h.manager
    .branch()
    .flatMap((e) => (e.type === "message" && e.message.role === "system" ? [e.message] : []))[0]!;

describe("getStats().context", () => {
  it("0 条消息：系统提示 + 工具声明的前缀基线（与随后落盘的 system 消息同口径），附阈值", async () => {
    const h = createHarness({ model, compaction, tools: [readTool], script: reply });
    const before = h.session.getStats();
    expect(before.contextTokens).toBeGreaterThan(0);
    expect(before.contextPercent).toBeGreaterThan(0);
    expect(before.context).toEqual({
      source: "prefix",
      usageTokens: 0,
      trailingTokens: before.contextTokens,
      autoCompactAt: 50_000,
      pruneAt: 35_000,
    });
    expect(h.manager.branch().some((e) => e.type === "message")).toBe(false);
    await h.session.prompt("hi");
    expect(before.contextTokens).toBe(estimateMessageTokens(systemOf(h)));
  });

  it("宿主后补的系统提示（updateSystem）计入基线", () => {
    const h = createHarness({ model, compaction, script: reply });
    const base = h.session.getStats().contextTokens!;
    h.session.updateSystem({ hostInstructions: ["x".repeat(4_000)] });
    expect(h.session.getStats().contextTokens).toBeGreaterThanOrEqual(base + 1_000);
  });

  it("有 usage：source usage；压缩之后、新 usage 之前：estimate；下一轮回到 usage", async () => {
    const h = createHarness({ model, compaction, script: reply });
    await h.session.prompt("one");
    await h.session.prompt("two");
    const used = h.session.getStats();
    expect(used.context).toMatchObject({ source: "usage", usageTokens: 3_050, trailingTokens: 0 });
    expect(used.contextTokens).toBe(3_050);
    await h.session.compact();
    const after = h.session.getStats().context!;
    expect(after.source).toBe("estimate");
    expect(after.usageTokens).toBe(0);
    expect(after.trailingTokens).toBe(h.session.getStats().contextTokens);
    await h.session.prompt("three");
    expect(h.session.getStats().context?.source).toBe("usage");
  });

  it("自动压缩关闭或模型没有窗口：不给阈值", () => {
    const h = createHarness({ model, compaction, script: reply });
    h.session.setAutoCompaction(false);
    const off = h.session.getStats().context!;
    expect(off.autoCompactAt).toBeUndefined();
    expect(off.pruneAt).toBeUndefined();
    const { contextWindow: _w, ...windowless } = model;
    const w = createHarness({ model: windowless, compaction, script: reply });
    const stats = w.session.getStats();
    expect(stats.contextWindow).toBeUndefined();
    expect(stats.contextPercent).toBeUndefined();
    expect(stats.context).toEqual({
      source: "prefix",
      usageTokens: 0,
      trailingTokens: stats.contextTokens,
    });
  });

  it("前缀稳定：请求前读统计不改变发出的请求", async () => {
    const strip = (call: ScriptCall): string =>
      JSON.stringify(call.context, (key, value: unknown) => (key === "timestamp" ? 0 : value));
    const quiet = createHarness({ model, compaction, tools: [readTool], script: reply });
    await quiet.session.prompt("hi");
    const watched = createHarness({ model, compaction, tools: [readTool], script: reply });
    for (let i = 0; i < 3; i++) watched.session.getStats();
    await watched.session.prompt("hi");
    expect(strip(watched.scripted.calls[0]!)).toBe(strip(quiet.scripted.calls[0]!));
  });

  it("[ME-B] 中途有补丁时压缩：检查点 + 合成补丁都算 system，压缩后的投影估算不比压缩前大", async () => {
    const h = createHarness({
      model,
      compaction: { ...compaction, keepRecentTokens: 50 },
      script: reply,
    });
    const projected = () =>
      buildProjection(h.manager.branch()).items.reduce(
        (sum, item) => sum + estimateMessageTokens(item.message),
        0,
      );
    await h.session.prompt("a ".repeat(4000));
    h.session.updateSystem({ hostInstructions: ["host rules"] });
    await h.session.prompt("b ".repeat(4000));
    const before = projected();
    await h.session.compact();
    const systems = buildProjection(h.manager.branch()).items.filter(
      (item) => item.message.role === "system",
    );
    expect(systems).toHaveLength(2);
    expect(projected()).toBeLessThanOrEqual(before);
    expect(h.session.getStats().contextTokens).toBeLessThanOrEqual(before);
  });
});
