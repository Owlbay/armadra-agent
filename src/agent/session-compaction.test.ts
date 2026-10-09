import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sharedCacheReporting } from "../ai/cache/reporting.js";
import type { ScriptCall, ScriptStep } from "./testing/scripted-api.js";
import { createHarness, isSummaryRequest } from "./testing/harness.js";
import { fakeModel, stubHooks, stubTool } from "./testing/stubs.js";
import type { SessionEntry } from "../session/types.js";

beforeEach(() => sharedCacheReporting.clear());
afterEach(() => vi.useRealTimers());

/** 窗口 60k、预留 10k → 预算 50k：档一触发 35k、目标 25k、保护 10k。 */
const model = fakeModel({ contextWindow: 60_000 });
const readTool = stubTool({
  name: "read",
  properties: { path: { type: "string" } },
  run: (input) => ({ content: `${String(input["path"])}\n${"x".repeat(4000)}` }), // ≈ 1 000 token
});

/** 单条提示里连续 n 次 read，之后回文本。 */
function toolLoop(n: number): (call: ScriptCall) => ScriptStep {
  let made = 0;
  return (call) => {
    if (isSummaryRequest(call.context)) return { text: "## Goal\nsummary" };
    if (made >= n) return { text: "done" };
    made++;
    return { toolCalls: [{ name: "read", args: { path: `f${made}.ts` } }] };
  };
}

const prunes = (entries: readonly SessionEntry[]) =>
  entries.filter((e) => e.type === "context_edit" && e.reason === "prune");

describe("档一在会话里（C1 / C2）", () => {
  it("单 user 消息 + 50 次工具调用触发档一；一次清到目标，之后回合不再逐回合推进（回差）", async () => {
    const h = createHarness({
      model,
      tools: [readTool],
      compaction: { reserveTokens: 10_000, prune: { clearAtLeast: 2000 } } as never,
      script: toolLoop(50),
    });
    await h.session.prompt("只有这一条用户消息：把 50 个文件都读一遍");
    const edits = prunes(h.manager.branch());
    expect(edits.length).toBeGreaterThan(0);
    // 按 context_edit 的追加位置分批：同一批连续出现
    const batches: number[] = [];
    let last = -2;
    h.manager.branch().forEach((entry, i) => {
      if (entry.type !== "context_edit" || entry.reason !== "prune") return;
      if (i !== last + 1) batches.push(0);
      batches[batches.length - 1]!++;
      last = i;
    });
    // 每批至少省 clearAtLeast（≈ 2 个结果），而不是每回合 1 个
    expect(batches.every((n) => n >= 2)).toBe(true);
    // 50 次调用跨过阈值多次，但裁剪批次远少于回合数
    expect(batches.length).toBeLessThanOrEqual(3);
    expect(h.events.some((e) => e.type === "compaction_start")).toBe(false);
  });

  it("config compaction.pruneExclude 接到会话：列出的工具结果不裁", async () => {
    const h = createHarness({
      model,
      tools: [readTool],
      compaction: {
        reserveTokens: 10_000,
        prune: { clearAtLeast: 2000 },
        pruneExclude: ["read"],
      } as never,
      script: toolLoop(50),
    });
    await h.session.prompt("读 50 个文件");
    expect(prunes(h.manager.branch())).toEqual([]);
  });

  it("没到 0.7 不裁", async () => {
    const h = createHarness({
      model,
      tools: [readTool],
      compaction: { reserveTokens: 10_000, prune: { clearAtLeast: 0 } } as never,
      script: toolLoop(20),
    });
    await h.session.prompt("读 20 个文件");
    expect(prunes(h.manager.branch())).toEqual([]);
  });
});

describe("缓存冷时提前裁（C3）", () => {
  const priced = fakeModel({ contextWindow: 60_000, promptCache: { short: 300 } });

  it("isCold：reported 端点上次请求距今超过 TTL 才算冷；silent / unknown 永远 false", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const reported = createHarness({
      model: priced,
      cache: { warming: "off" },
      script: [
        { text: "a", usage: { input: 0, cacheWrite: 30_000 } },
        { text: "b", usage: { input: 1000, cacheRead: 30_000 } },
      ],
    });
    expect(reported.session.cache.isCold()).toBe(false); // 无请求记录
    await reported.session.prompt("q1");
    await reported.session.prompt("q2");
    expect(reported.session.cache.isCold()).toBe(false);
    vi.setSystemTime(1_000_000 + 299_000);
    expect(reported.session.cache.isCold()).toBe(false);
    vi.setSystemTime(1_000_000 + 301_000);
    expect(reported.session.cache.isCold()).toBe(true);

    sharedCacheReporting.clear();
    vi.setSystemTime(1_000_000);
    const silent = createHarness({
      model: fakeModel({ contextWindow: 60_000, promptCache: { short: 300 }, baseUrl: "http://s" }),
      cache: { warming: "off" },
      script: [{ text: "a" }, { text: "b" }, { text: "c" }],
    });
    for (const q of ["q1", "q2", "q3"]) await silent.session.prompt(q);
    vi.setSystemTime(1_000_000 + 3_600_000);
    expect(silent.session.cache.isCold()).toBe(false);
  });

  it("isCold：目录没有承诺 TTL 时不按猜测的寿命判冷（隐式缓存可能存活数小时）", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const implicit = createHarness({
      model: fakeModel({ contextWindow: 60_000 }),
      cache: { warming: "off" },
      script: [
        { text: "a", usage: { input: 0, cacheWrite: 30_000 } },
        { text: "b", usage: { input: 1000, cacheRead: 30_000 } },
      ],
    });
    await implicit.session.prompt("q1");
    await implicit.session.prompt("q2");
    vi.setSystemTime(1_000_000 + 24 * 3_600_000);
    expect(implicit.session.cache.isCold()).toBe(false);
  });

  it("冷时未到 0.7 也裁、一次换掉全部候选；热时不裁", async () => {
    const make = () =>
      createHarness({
        model,
        tools: [readTool],
        compaction: { reserveTokens: 10_000, prune: { clearAtLeast: 2000 } } as never,
        script: toolLoop(20),
      });
    const warm = make();
    await warm.session.prompt("读 20 个文件");
    await warm.session.prompt("继续");
    expect(prunes(warm.manager.branch())).toEqual([]);

    const cold = make();
    await cold.session.prompt("读 20 个文件");
    vi.spyOn(cold.session.cache, "isCold").mockReturnValue(true);
    await cold.session.prompt("继续");
    const edits = prunes(cold.manager.branch());
    // 20 个结果 ≈ 20k token：最近 5 个 + 10k 内受保护，其余全部换掉
    expect(edits.length).toBeGreaterThanOrEqual(9);
    expect(edits.length).toBeLessThanOrEqual(15);
  });
});

describe("熔断在会话里（C5）", () => {
  it("每回合都重新填满：连续 3 次快速回填后停止自动摘要并告警一次", async () => {
    const logs: string[] = [];
    const bigRead = stubTool({
      name: "read",
      properties: { path: { type: "string" } },
      run: () => ({ content: "y".repeat(12_000) }), // ≈ 3 000 token
    });
    const h = createHarness({
      model: fakeModel({ contextWindow: 8000 }),
      tools: [bigRead],
      compaction: { reserveTokens: 1000, pruneExclude: ["read"] } as never,
      script: toolLoop(30),
      log: (level, message) => {
        if (level === "warn") logs.push(message);
      },
    });
    await h.session.prompt("一直读");
    const compactions = h.manager.branch().filter((e) => e.type === "compaction");
    expect(compactions.length).toBeGreaterThanOrEqual(4);
    expect(compactions.length).toBeLessThanOrEqual(5);
    expect(logs.filter((m) => m.includes("refilled"))).toHaveLength(1);
    // 跳闸后仍跑完（不循环摘要）
    expect(h.scripted.calls.filter((c) => !isSummaryRequest(c.context))).toHaveLength(31);
  });

  it("固定前缀超预算：不尝试摘要，告警一次", async () => {
    const logs: string[] = [];
    const h = createHarness({
      model: fakeModel({ contextWindow: 3000 }),
      tools: [readTool],
      system: { preamble: "规".repeat(2600) },
      compaction: { reserveTokens: 500 } as never,
      script: toolLoop(3),
      log: (level, message) => {
        if (level === "warn") logs.push(message);
      },
    });
    await h.session.prompt("读三个文件");
    expect(h.events.some((e) => e.type === "compaction_start")).toBe(false);
    expect(logs.filter((m) => m.includes("system prompt"))).toHaveLength(1);
  });
});

describe("自检在会话里（C8）", () => {
  it("自动压缩后不比压缩前小：判失败、不写 compaction 条目", async () => {
    let made = 0;
    const h = createHarness({
      model,
      tools: [readTool],
      compaction: { reserveTokens: 10_000, pruneExclude: ["read"] } as never,
      script: (call) => {
        if (isSummaryRequest(call.context)) return { text: `## Goal\n${"z".repeat(400_000)}` };
        if (made >= 52) return { text: "done" };
        made++;
        return { toolCalls: [{ name: "read", args: { path: `f${made}.ts` } }] };
      },
    });
    await h.session.prompt("读很多文件");
    const ends = h.events.filter((e) => e.type === "compaction_end");
    expect(ends.length).toBeGreaterThan(0);
    expect(ends[0]).toMatchObject({ trigger: "threshold" });
    expect(ends[0]?.type === "compaction_end" && ends[0].error).toMatch(/did not shrink/);
    expect(h.manager.branch().some((e) => e.type === "compaction")).toBe(false);
  });
});

describe("回注与 PostCompact（C6 / C13）", () => {
  it("摘要后紧跟回注块（在保留区之前）；PostCompact 拿到前后 token 与 trigger，additionalContext 追加在末尾", async () => {
    const hooks = stubHooks({
      PostCompact: () => ({ additionalContext: "外部回注：别忘了跑 lint" }),
    });
    const h = createHarness({
      model,
      tools: [readTool],
      hooks,
      compaction: { reserveTokens: 10_000, pruneExclude: ["read"] } as never,
      script: toolLoop(52),
    });
    await h.session.prompt("读很多文件");
    const compaction = h.manager.branch().find((e) => e.type === "compaction");
    expect(compaction?.type === "compaction" && compaction.summary).toMatch(
      /<\/read-files>\n\n<post-compact-state>\n[\s\S]*<recently-read-files>\nf\d+\.ts[\s\S]*<\/post-compact-state>$/,
    );
    // 下一次真实请求：system 之后第一条是摘要（含回注块），紧接着是保留区
    const next = h.scripted.calls.find(
      (c) =>
        !isSummaryRequest(c.context) &&
        c.context.messages.some(
          (m) =>
            m.role === "user" && typeof m.content === "string" && m.content.includes("<summary>"),
        ),
    )!;
    const [, first, second] = next.context.messages;
    expect(first?.role === "user" && String(first.content)).toMatch(/<post-compact-state>/);
    expect(second?.role).not.toBe("user");
    const post = hooks.calls.find((c) => c.event === "PostCompact");
    expect(post?.payload).toMatchObject({ trigger: "auto" });
    const { tokensBefore, tokensAfter } = post!.payload as {
      tokensBefore: number;
      tokensAfter: number;
    };
    expect(tokensAfter).toBeLessThan(tokensBefore);
    const at = h.manager.branch().findIndex((e) => e.type === "compaction");
    expect(h.manager.branch()[at + 1]).toMatchObject({
      type: "custom_message",
      customType: "ama.hook_context",
      content: "外部回注：别忘了跑 lint",
      display: false,
    });
  });

  it("手动 /compact：PostCompact trigger manual", async () => {
    const hooks = stubHooks({ PostCompact: () => undefined });
    const h = createHarness({
      model,
      hooks,
      compaction: { keepRecentTokens: 50 },
      script: (call) => (isSummaryRequest(call.context) ? { text: "## Goal\nm" } : { text: "ok" }),
    });
    await h.session.prompt("a ".repeat(400));
    await h.session.prompt("b ".repeat(400));
    await h.session.compact();
    expect(hooks.calls.find((c) => c.event === "PostCompact")?.payload).toMatchObject({
      trigger: "manual",
    });
    expect(h.manager.branch().some((e) => e.type === "custom_message")).toBe(false);
  });
});
