import { describe, expect, it } from "vitest";
import type {
  AgentSession,
  SessionCacheStats,
  SessionState,
  SessionStats,
} from "../../agent/types.js";
import { plainTheme, visibleWidth, type Theme } from "../../tui.js";
import { StatusBar, abbreviateModel, cacheText, formatCost, formatTokens } from "./status-bar.js";
import { golden, lines } from "./test-support.js";

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

  it("无用量：左区模式 + 切换提示，右区模型 · 思考 · ctx ?；预设 default 不显示", () => {
    const bar = new StatusBar(
      { session: () => fakeSession({}, {}), preset: () => "default" },
      plainTheme(),
    );
    const [line] = lines(bar, 100);
    expect(line).toMatch(
      /^Manual · shift\+tab 切换 {4,}anthropic\/claude-sonnet · medium · ctx \?$/,
    );
    expect(visibleWidth(line!)).toBe(100);
  });

  it("模型名缩写：< 100 去供应商，< 60 去渠道，< 48 去版本后缀", () => {
    const ref = "anthropic/claude-sonnet-4-5@messages";
    expect(abbreviateModel(ref, 120)).toBe(ref);
    expect(abbreviateModel(ref, 80)).toBe("claude-sonnet-4-5@messages");
    expect(abbreviateModel(ref, 50)).toBe("claude-sonnet-4-5");
    expect(abbreviateModel(ref, 40)).toBe("claude-sonnet");
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
    expect(lines(bar, 200)[0]).toMatch(
      /^Bypass permissions · shift\+tab 切换 +anthropic\/claude-sonnet · medium · ↑10k ↓1\.2k · cache 80% · \$0\.12 · ctx ▮▮▮▯▯▯▯▯▯▯ 34% · queue 2 · preset codemode · \[画布已连接 · 网络未隔离\]$/,
    );
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
    expect(lines(bar, 40)).toEqual(["Manual · claude-sonnet · medium · ctx 5%"]);
    expect(lines(bar, 60)[0]).toMatch(
      /^Manual {4,}claude-sonnet · medium · ↑100 ↓10 · \$\? · ctx 5%$/,
    );
    expect(lines(bar, 31)).toEqual(["Manual · claude-sonnet · ctx 5%"]);
    expect(lines(bar, 90)[0]).toMatch(
      /^Manual · shift\+tab 切换 {4,}claude-sonnet@?.* · ctx 5% · \[x\]$/,
    );
    expect(lines(bar, 10)[0]).toBe("Manual");
    expect(lines(bar, 24)).toEqual(["Manual     claude-sonnet"]);
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

  const cache = (partial: Partial<SessionCacheStats>): SessionCacheStats => ({
    reporting: "reported",
    reBilledTokens: 0,
    misses: { count: 0, byReason: {} },
    warming: { mode: "streaming", state: "inactive" },
    ...partial,
  });
  const used = {
    tokens: { input: 2_000, output: 1_200, cacheRead: 8_000, cacheWrite: 300, total: 0 },
    cost: 0.1234,
    contextPercent: 34.4,
    cacheHitRate: 0.8,
  };

  it("[W3-C2] cache 三态：最近一次命中率 / — / 未报告；保温中 ♨；会话累计不进状态栏", () => {
    expect(cacheText(cache({ lastHitRate: 0.834, hitRate: 0.5 }))).toBe("cache 83%");
    expect(cacheText(cache({ reporting: "unknown" }))).toBe("cache —");
    expect(cacheText(cache({ reporting: "silent" }))).toBe("cache 未报告");
    expect(cacheText(cache({ reporting: "reported" }))).toBe("cache —");
    expect(
      cacheText(
        cache({
          lastHitRate: 0.9,
          warming: { mode: "streaming", state: "scheduled", nextWarmAt: 1 },
        }),
      ),
    ).toBe("cache 90% ♨");
    const bar = new StatusBar(
      {
        session: () => fakeSession({}, { ...used, cache: cache({ reporting: "silent" }) }),
        preset: () => "default",
      },
      plainTheme(),
    );
    expect(lines(bar, 200)[0]).toContain("· ↑10k ↓1.2k · cache 未报告 · $0.12 · ctx ");
  });

  it("[W3-C2] rebill（有价显示金额、无价显示 token）、codemode 项与 net!，窄屏丢弃顺序", () => {
    const stats = {
      ...used,
      cache: cache({
        lastHitRate: 0.83,
        reBilledTokens: 38_200,
        reBilledUsd: 0.11,
        warming: { mode: "streaming", state: "scheduled", nextWarmAt: 1 },
      }),
    };
    const make = (strict: boolean, s: Partial<SessionStats> = stats): StatusBar =>
      new StatusBar(
        {
          session: () => fakeSession({}, s),
          preset: () => "codemode",
          codemode: () => "only",
          sandboxStrict: () => strict,
          hostStatus: () => new Map([["armadra", "画布已连接"]]),
        },
        plainTheme(),
      );
    const full = lines(make(false), 200)[0]!;
    expect(full).toContain(
      "↑10k ↓1.2k · cache 83% ♨ · $0.12 · rebill $0.11 · ctx ▮▮▮▯▯▯▯▯▯▯ 34% · codemode only net! · preset codemode · [画布已连接]",
    );
    expect(lines(make(true), 200)[0]).toContain("· codemode only · preset");
    const { reBilledUsd: _usd, ...unpriced } = stats.cache;
    const noPrice = { ...stats, cache: unpriced };
    expect(lines(make(true, noPrice), 200)[0]).toContain("· rebill 38k tok ·");
    const bar = make(false);
    // 先丢切换提示、宿主、预设、rebill、费用、cache……codemode 比队列以外的项都晚丢
    const at = (w: number): string => lines(bar, w)[0]!.replace(/ {4,}/, " ‖ ");
    expect(at(100)).toBe(
      "Manual ‖ anthropic/claude-sonnet · medium · ↑10k ↓1.2k · cache 83% ♨ · ctx 34% · codemode only net!",
    );
    expect(at(70)).toBe("Manual ‖ claude-sonnet · medium · ctx 34% · codemode only net!");
    expect(at(50)).toBe("Manual ‖ claude-sonnet · ctx 34%");
    expect(at(53)).toBe("Manual · claude-sonnet · ctx 34% · codemode only net!");
  });

  it("着色：模式名正文色、模型 accent、ctx 按阈值、其余 dim", () => {
    const tagged = Object.assign(Object.create(plainTheme()) as Theme, {
      fg: (c: string, t: string) => `<${c}>${t}`,
    });
    const bar = new StatusBar(
      {
        session: () => fakeSession({ permissionMode: "plan" }, { contextPercent: 75 }),
        preset: () => "default",
      },
      tagged,
    );
    const [line] = bar.render(300);
    expect(line).toContain("<accent>Plan");
    expect(line).toContain("<accent>anthropic/claude-sonnet");
    expect(line).toContain("<dim>shift+tab 切换");
    expect(line).toContain("<warning>▮▮▮▮▮▮▮▮");
  });

  it("帧黄金：40 / 60 / 80 / 110 列", () => {
    const session = fakeSession(
      {
        permissionMode: "auto-edit",
        model: { provider: "anthropic", id: "claude-sonnet-4-5" } as never,
      },
      {
        ...used,
        cache: cache({
          lastHitRate: 0.8,
          warming: { mode: "streaming", state: "scheduled", nextWarmAt: 1 },
        }),
      },
    );
    const bar = new StatusBar({ session: () => session, preset: () => "default" }, plainTheme());
    const rows = [40, 60, 80, 110].map((w) => `# ${w}\n|${bar.render(w)[0]}|`);
    golden("status-widths", rows.join("\n") + "\n");
  });
});
