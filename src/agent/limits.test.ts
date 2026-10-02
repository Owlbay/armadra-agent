import { describe, expect, it } from "vitest";
import type { SessionLimits } from "./types.js";
import { LIMIT_REACHED, budgetOf, createLimitsExtension, resolveLimits } from "./limits.js";
import { createHarness, type HarnessOptions } from "./testing/harness.js";
import type { ScriptStep } from "./testing/scripted-api.js";
import { stubHooks, stubTool } from "./testing/stubs.js";

const ls = stubTool({ name: "ls" });
const cost = (total: number) => ({
  usage: { cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total } },
});
const toolStep = (usd = 0): ScriptStep => ({
  toolCalls: [{ name: "ls", args: {} }],
  ...(usd > 0 ? cost(usd) : {}),
});

function limited(limits: SessionLimits, script: ScriptStep[], extra: Partial<HarnessOptions> = {}) {
  return createHarness({
    script,
    tools: [ls],
    limits,
    extensions: [({ core }) => createLimitsExtension(core, core.options.limits)],
    ...extra,
  });
}

describe("resolveLimits", () => {
  it("命令行覆盖 config；全空 → undefined", () => {
    expect(resolveLimits(undefined)).toBeUndefined();
    expect(resolveLimits({}, { maxTurns: undefined })).toBeUndefined();
    expect(resolveLimits({ maxTurns: 9, maxCostUsd: 1 }, { maxCostUsd: 2 })).toEqual({
      maxTurns: 9,
      maxCostUsd: 2,
    });
    expect(resolveLimits({ maxTurns: 9 }, { maxTurns: 3 })).toEqual({ maxTurns: 3 });
  });

  it("没有上限时不装扩展", () => {
    const h = createHarness({ script: [{ text: "ok" }] });
    expect(createLimitsExtension(h.session, undefined)).toBeUndefined();
    expect(createLimitsExtension(h.session, {})).toBeUndefined();
  });
});

describe("limits 扩展（W5-H2 H2）", () => {
  it("回合到限：本轮工具照常执行后结束，limit_reached 一次，agent_settled 带 warning", async () => {
    const h = limited({ maxTurns: 2 }, [toolStep(), toolStep(), toolStep(), { text: "x" }]);
    await h.session.prompt("go");
    expect(h.scripted.calls).toHaveLength(2);
    expect(h.session.messages.filter((m) => m.role === "toolResult")).toHaveLength(2);
    expect(h.events.filter((e) => e.type === "limit_reached")).toEqual([
      { type: "limit_reached", kind: "turns", value: 2, limit: 2 },
    ]);
    expect(h.events.find((e) => e.type === "agent_settled")).toEqual({
      type: "agent_settled",
      warning: LIMIT_REACHED,
    });
  });

  it("第 N 次回复自然结束不算到限；回合按周期重新计数", async () => {
    const h = limited({ maxTurns: 2 }, [toolStep(), { text: "a" }, toolStep(), { text: "b" }]);
    await h.session.prompt("one");
    await h.session.prompt("two");
    expect(h.scripted.calls).toHaveLength(4);
    expect(h.events.some((e) => e.type === "limit_reached")).toBe(false);
    expect(h.events.filter((e) => e.type === "agent_settled")).toEqual([
      { type: "agent_settled" },
      { type: "agent_settled" },
    ]);
  });

  it("费用到限：本周期累计 ≥ 上限且还要调工具 → 结束；新提示重新计费", async () => {
    const h = limited({ maxCostUsd: 1 }, [
      toolStep(0.6),
      toolStep(0.6),
      toolStep(0.6),
      { text: "b" },
    ]);
    await h.session.prompt("go");
    expect(h.scripted.calls).toHaveLength(2);
    expect(budgetOf(h.session)?.spentUsd).toBeCloseTo(1.2);
    expect(h.events.filter((e) => e.type === "limit_reached")).toEqual([
      { type: "limit_reached", kind: "cost", value: 1.2, limit: 1 },
    ]);
    h.events.length = 0;
    await h.session.prompt("again");
    expect(h.scripted.calls).toHaveLength(4);
    expect(h.events.some((e) => e.type === "limit_reached")).toBe(false);
  });

  it("本周期已超预算时，后续请求（这里是 Stop Hook 续跑）不发出、不重试", async () => {
    const hooks = stubHooks({
      Stop: (p) => (p.stopHookActive ? undefined : { decision: "block", reason: "keep going" }),
    });
    const h = limited({ maxCostUsd: 1 }, [{ text: "a", ...cost(1.5) }, { text: "never" }], {
      hooks,
    });
    await h.session.prompt("go");
    expect(h.scripted.calls).toHaveLength(1);
    expect(h.events.some((e) => e.type === "auto_retry_start")).toBe(false);
    expect(h.events.find((e) => e.type === "agent_settled")).toEqual({
      type: "agent_settled",
      warning: LIMIT_REACHED,
    });
    const last = h.session.messages.at(-1);
    expect(last?.role === "assistant" && last.errorMessage).toMatch(/^limit_reached: session cost/);
  });

  it("子 Agent 的用量计入本会话费用", async () => {
    const h = limited({ maxCostUsd: 1 }, [{ text: "ok" }]);
    h.session.emit({
      type: "subagent_end",
      taskId: "t1",
      status: "completed",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        ...cost(0.4).usage,
      },
    });
    expect(budgetOf(h.session)?.spentUsd).toBeCloseTo(0.4);
  });

  it("dispose 后不再登记预算", async () => {
    const h = limited({ maxTurns: 3 }, [{ text: "ok" }]);
    expect(budgetOf(h.session)).toMatchObject({ maxTurns: 3, turns: 0 });
    await h.session.dispose();
    expect(budgetOf(h.session)).toBeUndefined();
  });
});
