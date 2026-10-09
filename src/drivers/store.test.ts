import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import type { SessionEntry } from "../session/types.js";
import {
  AGENT_SESSION_CUSTOM,
  AGENT_USAGE_CUSTOM,
  aggregateExternal,
  createAgentStore,
} from "./store.js";

function backend() {
  const entries: SessionEntry[] = [];
  return {
    entries,
    appendCustom(customType: string, data: unknown) {
      entries.push({
        type: "custom",
        id: String(entries.length),
        parentId: null,
        timestamp: "",
        customType,
        data,
      } as unknown as SessionEntry);
    },
  };
}

describe("外部 Agent 会话引用与记账", () => {
  it("写 ama.agent-session / ama.agent-usage；美元合计与最近会话引用", () => {
    const b = backend();
    const store = createAgentStore({ appendCustom: b.appendCustom, entries: () => b.entries });
    store.recordSession({
      agent: "claude",
      runner: "claude-stream",
      sessionId: "s1",
      taskId: "t1",
    });
    store.recordSession({
      agent: "claude",
      runner: "claude-stream",
      sessionId: "s2",
      taskId: "t2",
    });
    store.recordUsage({ agent: "claude", sessionId: "s1", unit: "usd", amount: 0.25 });
    store.recordUsage({
      agent: "codex",
      sessionId: "c1",
      unit: "tokens",
      amount: 900,
      tokens: 900,
      contextTokens: 900,
      contextWindow: 272000,
    });
    store.recordUsage({ agent: "claude", sessionId: "s2", unit: "usd", amount: 0.5 });
    expect(b.entries.map((e) => (e as { customType: string }).customType)).toEqual([
      AGENT_SESSION_CUSTOM,
      AGENT_SESSION_CUSTOM,
      AGENT_USAGE_CUSTOM,
      AGENT_USAGE_CUSTOM,
      AGENT_USAGE_CUSTOM,
    ]);
    expect(store.totalUsd()).toBeCloseTo(0.75);
    expect(store.lastSession("claude")?.sessionId).toBe("s2");
    expect(store.lastSession("claude", "t1")?.sessionId).toBe("s1");
    expect(store.lastSession("codex")).toBeUndefined();
    expect(aggregateExternal(b.entries)).toEqual({
      byAgent: {
        claude: { runs: 2, unit: "usd", amount: 0.75 },
        codex: {
          runs: 1,
          unit: "tokens",
          amount: 900,
          tokens: 900,
          contextTokens: 900,
          contextWindow: 272000,
        },
      },
    });
  });

  it("没有外部运行时 external 缺省", () => {
    expect(aggregateExternal([])).toBeUndefined();
  });
});

describe("SessionStats.external（组装表扩展）", () => {
  let h: ComposeHarness;
  afterEach(() => h?.cleanup());

  it("主会话 getStats() 汇总活动分支上的 ama.agent-usage", async () => {
    h = composeHarness([]);
    const runtime = await h.boot(["--model", "fake/echo"]);
    expect(runtime.session.getStats().external).toBeUndefined();
    runtime.sessionManager.append({
      type: "custom",
      customType: AGENT_USAGE_CUSTOM,
      data: { agent: "claude", sessionId: "s", unit: "usd", amount: 0.1 },
    });
    expect(runtime.session.getStats().external).toEqual({
      byAgent: { claude: { runs: 1, unit: "usd", amount: 0.1 } },
    });
    await runtime.dispose();
  });
});
