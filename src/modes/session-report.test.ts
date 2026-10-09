import { describe, expect, it } from "vitest";
import type {
  AgentSession,
  SessionCacheStats,
  SessionState,
  SessionStats,
} from "../agent/types.js";
import {
  cacheMissNotice,
  contextPressureNotice,
  describeCache,
  describeSession,
  formatDuration,
  formatTokenCount,
  shouldNotifyMiss,
  warmingText,
} from "./session-report.js";

const NOW = 1_000_000;

function fakeSession(stats: Partial<SessionStats>): AgentSession {
  const full: SessionStats = {
    sessionId: "0193abcd-0000-7000-8000-000000000001",
    sessionFile: undefined,
    userMessages: 9,
    assistantMessages: 12,
    toolCalls: 30,
    toolResults: 30,
    tokens: { input: 60_000, output: 40_000, cacheRead: 1_050_000, cacheWrite: 90_000, total: 0 },
    cost: 1.2345,
    contextTokens: 720_000,
    contextWindow: 1_000_000,
    contextPercent: 72,
    ...stats,
  };
  return {
    state: {
      sessionId: full.sessionId,
      sessionFile: undefined,
      model: { provider: "packy", id: "kimi-k2.5" },
      thinkingLevel: "medium",
      permissionMode: "default",
    } as SessionState,
    getStats: () => full,
  } as unknown as AgentSession;
}

const CACHE: SessionCacheStats = {
  reporting: "reported",
  lastHitRate: 0.83,
  hitRate: 0.87,
  reBilledTokens: 61_000,
  reBilledUsd: 0.18,
  misses: { count: 3, byReason: { idle: 2, prefix_changed: 1 } },
  warming: {
    mode: "streaming",
    state: "scheduled",
    phase: "streaming",
    nextWarmAt: NOW + 130_000,
    expectedSavingsUsd: 0.18,
    sent: 2,
    costUsd: 0.012,
  },
  contextRemainingTokens: 280_000,
  estimatedTurnsLeft: 9,
  subagents: { count: 2, hitRate: 0.71, reBilledTokens: 0 },
};

describe("会话报告文本", () => {
  it("数字格式：token 多一位精度、时长", () => {
    expect(formatTokenCount(950)).toBe("950");
    expect(formatTokenCount(38_200)).toBe("38.2k");
    expect(formatTokenCount(90_000)).toBe("90k");
    expect(formatTokenCount(150_400)).toBe("150k");
    expect(formatTokenCount(1_050_000)).toBe("1.05M");
    expect(formatTokenCount(1_200_000)).toBe("1.2M");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(130_000)).toBe("2m 10s");
    expect(formatDuration(120_000)).toBe("2m");
    expect(formatDuration(25 * 60_000)).toBe("25m");
  });

  it("/session 面板黄金：会话五行 + 缓存段（报告状态、命中率、未命中按原因、保温、余量、子任务）", () => {
    const context = {
      source: "usage" as const,
      usageTokens: 700_000,
      trailingTokens: 20_000,
      autoCompactAt: 983_616,
      pruneAt: 688_531,
    };
    expect(describeSession(fakeSession({ cache: CACHE, context }), NOW)).toBe(
      [
        "会话      0193abcd-0000-7000-8000-000000000001（未落盘）",
        "模型      packy/kimi-k2.5 · 思考 medium · 权限 default",
        "消息      用户 9 · 助手 12 · 工具调用 30",
        "累计用量  输入 60000 · 输出 40000 · 缓存读 1050000 · 缓存写 90000 · $1.2345",
        "上下文    720000 / 1000000（72%） · 距自动压缩 ≈ 264k",
        "缓存",
        "  输入      1.2M = 缓存读 1.05M（88%）+ 未缓存 150k（其中写入 90k）",
        "  报告状态  reported",
        "  命中率    最近 83% · 会话 87%",
        "  未命中    3 次，重计费 61k token ≈ $0.18（空闲超时 2 · 前缀变化 1）",
        "  保温      streaming · 下次 2m 10s · 期望节省 $0.18 · 已发 2 次 $0.01",
        "  上下文    72%，余量 ≈ 280k token ≈ 9 回合",
        "  子任务    2 个会话，命中率 71%",
      ].join("\n"),
    );
  });

  it("上下文行：估算值带 ≈；自动压缩关闭时注明；窗口未知或没有明细时不加说明", () => {
    const row = (stats: Partial<SessionStats>): string =>
      describeSession(fakeSession(stats), NOW)
        .split("\n")
        .find((line) => line.startsWith("上下文"))!;
    const estimate = { source: "estimate" as const, usageTokens: 0, trailingTokens: 720_000 };
    expect(row({ context: estimate })).toBe("上下文    ≈720000 / 1000000（72%） · 自动压缩关闭");
    expect(row({ context: { ...estimate, source: "prefix", autoCompactAt: 983_616 } })).toBe(
      "上下文    ≈720000 / 1000000（72%） · 距自动压缩 ≈ 264k",
    );
    expect(row({ context: estimate, contextWindow: undefined, contextPercent: undefined })).toBe(
      "上下文    ≈720000 / ?（?%）",
    );
    expect(row({})).toBe("上下文    720000 / 1000000（72%）");
  });

  it("三态：未报告 / 未知不显示命中率；无价重计费 $?；保温停止原因与 off", () => {
    const silent = describeCache(
      fakeSession({
        cache: {
          reporting: "silent",
          reBilledTokens: 0,
          misses: { count: 0, byReason: {} },
          warming: { mode: "streaming", state: "stopped", reason: "reporting_silent" },
        },
      }),
      NOW,
    );
    expect(silent).toContain("报告状态  未报告");
    expect(silent).not.toContain("命中率");
    expect(silent).toContain("未命中    0 次");
    expect(silent).toContain("保温      streaming · 已停止：端点不报缓存");
    const unknown = describeCache(
      fakeSession({
        cache: {
          reporting: "unknown",
          reBilledTokens: 25_000,
          misses: { count: 1, byReason: { evicted: 1 } },
          warming: { mode: "off", state: "inactive" },
        },
      }),
      NOW,
    );
    expect(unknown).toContain("报告状态  未知");
    expect(unknown).toContain("1 次，重计费 25k token ≈ $?（服务端淘汰 1）");
    expect(unknown).toContain("保温      off");
    // 控制器未接线（非 AgentSessionImpl 的会话）：只有输入拆分与会话命中率
    expect(describeCache(fakeSession({ cacheHitRate: 0.5 }), NOW)).toContain("命中率  会话 50%");
  });

  it("保温文本：待下一次请求、带门槛", () => {
    expect(warmingText({ mode: "idle", state: "inactive" }, NOW, 0.05)).toBe("idle · 待下一次请求");
    expect(
      warmingText(
        { mode: "streaming", state: "scheduled", nextWarmAt: NOW + 45_000, expectedSavingsUsd: 1 },
        NOW,
        0.05,
      ),
    ).toBe("streaming · 下次 45s · 期望节省 $1.00 ≥ $0.05");
  });

  it("未命中提示：门槛 20k token 或 $0.10；原因短语", () => {
    const idle = {
      missedTokens: 38_200,
      missedCost: 0.11,
      reason: "idle",
      idleMs: 420_000,
    } as const;
    expect(shouldNotifyMiss(idle)).toBe(true);
    expect(cacheMissNotice(idle)).toBe(
      "缓存未命中（空闲 7 分钟后）：重计费 38.2k token（约 $0.11）",
    );
    expect(shouldNotifyMiss({ missedTokens: 5_000, missedCost: 0.02 })).toBe(false);
    expect(shouldNotifyMiss({ missedTokens: 5_000, missedCost: 0.1 })).toBe(true);
    expect(shouldNotifyMiss({ missedTokens: 19_999 })).toBe(false);
    expect(
      cacheMissNotice({
        missedTokens: 30_000,
        reason: "prefix_changed",
        detail: "tools",
        idleMs: 0,
      }),
    ).toBe("缓存未命中（工具表变化）：重计费 30k token");
    expect(cacheMissNotice({ missedTokens: 30_000, reason: "model_changed", idleMs: 0 })).toContain(
      "切换模型后",
    );
  });

  it("上下文余量提示：有回合估计 / 只有余量", () => {
    expect(
      contextPressureNotice({
        type: "context_pressure",
        percent: 72.4,
        threshold: 70,
        remainingTokens: 55_000,
        estimatedTurnsLeft: 9,
      }),
    ).toBe("上下文已用 72%，约剩 9 回合（按最近 5 回合均值）");
    expect(
      contextPressureNotice({
        type: "context_pressure",
        percent: 91,
        threshold: 90,
        remainingTokens: 18_000,
      }),
    ).toBe("上下文已用 91%，余量 18k token");
  });
});

describe("/session 第五波段（W5-U）", () => {
  it("子 Agent 汇总与外部 Agent 用量（按各自单位）", () => {
    const session = fakeSession({
      tasks: { total: 3, running: 1, byStatus: { completed: 1, failed: 1 } },
      external: {
        byAgent: {
          codex: { runs: 2, unit: "tokens", amount: 51_200 },
          claude: { runs: 1, unit: "usd", amount: 0.42, tokens: 12_000 },
        },
      },
    });
    const text = describeSession(session, NOW);
    expect(text).toContain("子 Agent  3 个任务 · 运行中 1 · 完成 1 · 失败 1（/tasks）");
    expect(text).toContain(
      "外部 Agent\n  claude  1 次运行 · $0.42 · 12k token\n  codex   2 次运行 · 51.2k token",
    );
    expect(describeSession(fakeSession({}), NOW)).not.toContain("外部 Agent");
  });
});
