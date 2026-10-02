import { describe, expect, it } from "vitest";
import type { AgentSession, SessionState, SessionStats } from "../../agent/types.js";
import { plainTheme } from "../../tui.js";
import { StatusBar, formatCost, formatTokens } from "./status-bar.js";
import { lines } from "./test-support.js";

function fakeSession(state: Partial<SessionState>, stats: Partial<SessionStats>): AgentSession {
  const fullStats: SessionStats = {
    sessionId: "s",
    sessionFile: undefined,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    contextTokens: undefined,
    contextWindow: undefined,
    contextPercent: undefined,
    ...stats,
  };
  let calls = 0;
  return {
    state: {
      model: { provider: "anthropic", id: "claude-sonnet" },
      thinkingLevel: "medium",
      permissionMode: "default",
      ...state,
    } as SessionState,
    getStats: () => {
      calls++;
      return { ...fullStats, calls } as SessionStats;
    },
  } as unknown as AgentSession;
}

describe("状态栏", () => {
  it("格式化", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(12_345)).toBe("12k");
    expect(formatTokens(1_234)).toBe("1.2k");
    expect(formatTokens(2_500_000)).toBe("2.5M");
    expect(formatCost(0.1234)).toBe("$0.12");
    expect(formatCost(0.0042)).toBe("$0.004");
  });

  it("无用量：模型 · think · ctx ? · 模式 · 预设", () => {
    const bar = new StatusBar(
      { session: () => fakeSession({}, {}), preset: () => "default" },
      plainTheme(),
    );
    expect(lines(bar, 120)).toEqual([
      "anthropic/claude-sonnet · think:medium · ctx ? · mode:default · preset:default",
    ]);
  });

  it("有用量：↑ 含缓存读写、↓ 输出、命中率、费用、ctx%、队列、宿主状态", () => {
    const session = fakeSession(
      { permissionMode: "full-auto" },
      {
        tokens: { input: 2_000, output: 1_200, cacheRead: 8_000, cacheWrite: 300, total: 0 },
        cacheHitRate: 0.8,
        cost: 0.1234,
        contextPercent: 34.4,
      },
    );
    const bar = new StatusBar(
      {
        session: () => session,
        preset: () => "codemode",
        hostStatus: () =>
          new Map([
            ["armadra", "画布已连接"],
            ["codemode", "网络未隔离"],
          ]),
      },
      plainTheme(),
    );
    bar.setQueue(1, 1);
    bar.refresh();
    expect(lines(bar, 200)).toEqual([
      "anthropic/claude-sonnet · think:medium · ↑10k ↓1.2k · cache 80% · $0.12 · ctx 34% · queue 2 · mode:full-auto · preset:codemode · [画布已连接 · 网络未隔离]",
    ]);
  });

  it("窄终端按优先级丢弃：先丢宿主、预设、费用……模型与 ctx 最后丢", () => {
    const session = fakeSession(
      {},
      {
        tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: undefined,
        contextPercent: 5,
      },
    );
    const bar = new StatusBar(
      { session: () => session, preset: () => "default", hostStatus: () => new Map([["h", "x"]]) },
      plainTheme(),
    );
    expect(lines(bar, 40)).toEqual(["anthropic/claude-sonnet · ctx 5%"]);
    expect(lines(bar, 60)).toEqual(["anthropic/claude-sonnet · ctx 5% · mode:default"]);
    expect(lines(bar, 64)).toEqual([
      "anthropic/claude-sonnet · think:medium · ctx 5% · mode:default",
    ]);
    expect(lines(bar, 10)[0]).toBe("anthropic…");
  });

  it("refresh 才重新取统计；invalidate 后下次渲染再取", () => {
    const session = fakeSession({}, {});
    const bar = new StatusBar({ session: () => session, preset: () => "default" }, plainTheme());
    bar.render(80);
    bar.render(80);
    const spy = session.getStats as unknown as () => { calls: number };
    expect(spy().calls).toBe(2);
    bar.invalidate();
    bar.render(80);
    expect(spy().calls).toBe(4);
  });
});
